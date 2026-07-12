// lib/email-queue.js
// Manages email sending queue — same pattern as WhatsApp queue.js
// Features: random delay, pause/resume/cancel, SSE live progress, retry.

import supabase from './supabase.js';
import { sendEmail } from './email.js';

// ── Active queues (in-memory) ────────────────────────────────
const activeQueues = new Map(); // campaignId → { status }

// ── SSE clients ──────────────────────────────────────────────
const sseClients = new Map(); // campaignId → Set<res>

export function addEmailSseClient(campaignId, res) {
  if (!sseClients.has(campaignId)) sseClients.set(campaignId, new Set());
  sseClients.get(campaignId).add(res);
}
export function removeEmailSseClient(campaignId, res) {
  sseClients.get(campaignId)?.delete(res);
}
function broadcast(campaignId, payload) {
  const clients = sseClients.get(campaignId);
  if (!clients?.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

// ── Helpers ──────────────────────────────────────────────────
function randomDelay(minSec, maxSec) {
  return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Load pending queue items ─────────────────────────────────
async function loadPending(campaignId) {
  const { data, error } = await supabase
    .from('email_queue')
    .select('*, lead:leads(name, email, company, product, quantity, country)')
    .eq('campaign_id', campaignId)
    .eq('status', 'Pending')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function markItem(id, status, errorMsg = null) {
  const update = {
    status,
    updated_at: new Date().toISOString(),
    error_msg: errorMsg || null,
  };
  if (status === 'Sent') update.sent_at = new Date().toISOString();
  await supabase.from('email_queue').update(update).eq('id', id);
}

async function setCampaignStatus(campaignId, status) {
  const update = { status, updated_at: new Date().toISOString() };
  if (status === 'Running')   update.started_at   = new Date().toISOString();
  if (['Completed','Cancelled','Failed'].includes(status))
    update.completed_at = new Date().toISOString();
  await supabase.from('email_campaigns').update(update).eq('id', campaignId);
}

async function logEmail({ campaignId, leadId, leadName, toEmail, subject, status, errorMsg }) {
  await supabase.from('email_logs').insert({
    campaign_id: campaignId, lead_id: leadId, lead_name: leadName,
    to_email: toEmail, subject, status, error_msg: errorMsg || null,
    sent_at: new Date().toISOString(),
  });
}

// ── START campaign ────────────────────────────────────────────
export async function startEmailCampaign(campaignId) {
  if (activeQueues.has(campaignId)) {
    const q = activeQueues.get(campaignId);
    if (q.status === 'running') return { error: 'Campaign already running' };
    if (q.status === 'paused') {
      q.status = 'running';
      broadcast(campaignId, { event: 'resumed', campaignId });
      await setCampaignStatus(campaignId, 'Running');
      return { ok: true, message: 'Campaign resumed' };
    }
  }

  const items = await loadPending(campaignId);
  if (!items.length) {
    await setCampaignStatus(campaignId, 'Completed');
    return { ok: true, message: 'No pending emails — campaign marked complete' };
  }

  const { data: campaign } = await supabase
    .from('email_campaigns')
    .select('min_delay_sec, max_delay_sec, name')
    .eq('id', campaignId).single();

  const minD = campaign?.min_delay_sec ?? 10;
  const maxD = campaign?.max_delay_sec ?? 30;

  activeQueues.set(campaignId, { status: 'running' });
  await setCampaignStatus(campaignId, 'Running');
  broadcast(campaignId, { event: 'started', campaignId, total: items.length, campaignName: campaign?.name });

  // Fire-and-forget send loop
  (async () => {
    let sentCount = 0, failedCount = 0, skippedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const qState = activeQueues.get(campaignId);

      // Cancelled?
      if (!qState || qState.status === 'cancelled') {
        await markItem(item.id, 'Cancelled');
        broadcast(campaignId, { event: 'cancelled', campaignId, sent: sentCount, failed: failedCount, skipped: skippedCount, total: items.length });
        await setCampaignStatus(campaignId, 'Cancelled');
        activeQueues.delete(campaignId);
        return;
      }

      // Paused? Wait...
      while (qState.status === 'paused') {
        await sleep(1000);
        const cur = activeQueues.get(campaignId);
        if (!cur || cur.status === 'cancelled') break;
      }
      const afterPause = activeQueues.get(campaignId);
      if (!afterPause || afterPause.status === 'cancelled') continue;

      // Skip if no email
      const toEmail = item.to_email || item.lead?.email;
      if (!toEmail || !toEmail.includes('@')) {
        await markItem(item.id, 'Skipped', 'No valid email address');
        await supabase.rpc('increment_email_counter', { p_campaign_id: campaignId, p_field: 'skipped_count' });
        skippedCount++;
        await logEmail({ campaignId, leadId: item.lead_id, leadName: item.lead?.name, toEmail, subject: item.subject, status: 'skipped', errorMsg: 'No valid email' });
        broadcast(campaignId, { event: 'skipped', campaignId, index: i+1, total: items.length, leadName: item.lead?.name, email: toEmail, sent: sentCount, failed: failedCount, skipped: skippedCount });
        continue;
      }

      // Send with retry
      let success = false, lastError = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await sendEmail({ to: toEmail, toName: item.to_name || item.lead?.name, subject: item.subject, body: item.body, isHtml: false });
          success = true;
          break;
        } catch (err) {
          lastError = String(err?.message || err);
          if (attempt < 2) await sleep(5000);
        }
      }

      if (success) {
        await markItem(item.id, 'Sent');
        await supabase.rpc('increment_email_counter', { p_campaign_id: campaignId, p_field: 'sent_count' });
        sentCount++;
        await logEmail({ campaignId, leadId: item.lead_id, leadName: item.lead?.name, toEmail, subject: item.subject, status: 'sent' });
        broadcast(campaignId, { event: 'sent', campaignId, index: i+1, total: items.length, leadName: item.lead?.name, email: toEmail, sent: sentCount, failed: failedCount, skipped: skippedCount, progress_pct: Math.round(((sentCount+failedCount+skippedCount)/items.length)*100) });
      } else {
        await markItem(item.id, 'Failed', lastError);
        await supabase.rpc('increment_email_counter', { p_campaign_id: campaignId, p_field: 'failed_count' });
        failedCount++;
        await logEmail({ campaignId, leadId: item.lead_id, leadName: item.lead?.name, toEmail, subject: item.subject, status: 'failed', errorMsg: lastError });
        broadcast(campaignId, { event: 'failed', campaignId, index: i+1, total: items.length, leadName: item.lead?.name, email: toEmail, error: lastError, sent: sentCount, failed: failedCount, skipped: skippedCount });
      }

      // Delay before next
      if (i < items.length - 1) {
        const delay = randomDelay(minD, maxD);
        const delaySec = Math.round(delay / 1000);
        broadcast(campaignId, { event: 'waiting', campaignId, delay_sec: delaySec, next_lead: items[i+1]?.lead?.name || 'next lead' });
        await sleep(delay);
      }
    }

    const finalStatus = failedCount === items.length ? 'Failed' : 'Completed';
    await setCampaignStatus(campaignId, finalStatus);
    activeQueues.delete(campaignId);
    broadcast(campaignId, { event: 'completed', campaignId, sent: sentCount, failed: failedCount, skipped: skippedCount, total: items.length, status: finalStatus });
    console.log(`✅ Email campaign ${campaignId} done: ${sentCount} sent, ${failedCount} failed, ${skippedCount} skipped`);
  })();

  return { ok: true, message: `Email campaign started — ${items.length} emails queued` };
}

export async function pauseEmailCampaign(campaignId) {
  const q = activeQueues.get(campaignId);
  if (!q) return { error: 'Campaign not active' };
  q.status = 'paused';
  await setCampaignStatus(campaignId, 'Paused');
  broadcast(campaignId, { event: 'paused', campaignId });
  return { ok: true };
}

export async function resumeEmailCampaign(campaignId) {
  const q = activeQueues.get(campaignId);
  if (!q) return { error: 'Campaign not in queue — restart it' };
  q.status = 'running';
  await setCampaignStatus(campaignId, 'Running');
  broadcast(campaignId, { event: 'resumed', campaignId });
  return { ok: true };
}

export async function cancelEmailCampaign(campaignId) {
  if (activeQueues.has(campaignId)) activeQueues.get(campaignId).status = 'cancelled';
  await supabase.from('email_queue').update({ status: 'Cancelled', updated_at: new Date().toISOString() })
    .eq('campaign_id', campaignId).eq('status', 'Pending');
  await setCampaignStatus(campaignId, 'Cancelled');
  broadcast(campaignId, { event: 'cancelled', campaignId });
  return { ok: true };
}

export function getEmailQueueStatus(campaignId) {
  return activeQueues.get(campaignId)?.status || null;
}
