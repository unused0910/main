// lib/queue.js
// Manages the sending queue for campaigns.
// Features:
//   ✅ Random delay between messages (20–60s default, configurable per campaign)
//   ✅ Pause / Resume / Cancel
//   ✅ Live progress via SSE (Server-Sent Events)
//   ✅ Per-message status updates in Supabase
//   ✅ Automatic retry on transient errors (up to 2 attempts)
//   ✅ Skip invalid numbers
//   ✅ Safe for 100–500 messages/day

import supabase from './supabase.js';
import { logger } from './logger.js';

// ── Active queue state (in-memory, per campaign) ─────────────
// Map<campaignId, { status: 'running'|'paused'|'cancelled', abortController }>
const activeQueues = new Map();

// ── SSE clients: Map<campaignId, Set<response>> ──────────────
const sseClients = new Map();

export function addSseClient(campaignId, res) {
  if (!sseClients.has(campaignId)) sseClients.set(campaignId, new Set());
  sseClients.get(campaignId).add(res);
}

export function removeSseClient(campaignId, res) {
  sseClients.get(campaignId)?.delete(res);
}

function broadcastProgress(campaignId, payload) {
  const clients = sseClients.get(campaignId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

// ── Helpers ───────────────────────────────────────────────────
function randomDelay(minSec, maxSec) {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  return ms;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidPhone(phone) {
  return /^\+?\d{8,15}$/.test((phone || '').replace(/\s/g, ''));
}

// ── Load pending queue items from Supabase ────────────────────
async function loadPendingItems(campaignId) {
  const { data, error } = await supabase
    .from('message_queue')
    .select('*, lead:leads(name, phone, company, product, quantity, country, email)')
    .eq('campaign_id', campaignId)
    .eq('status', 'Pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Queue load failed: ${error.message}`);
  return data || [];
}

// ── Mark a single queue item ──────────────────────────────────
async function markItem(queueId, status, errorMsg = null) {
  const update = {
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'Sent' || status === 'Failed' ? { sent_at: new Date().toISOString() } : {}),
    ...(errorMsg ? { error_msg: errorMsg } : {}),
  };
  await supabase.from('message_queue').update(update).eq('id', queueId);
}

// ── Update campaign counts + status ──────────────────────────
async function updateCampaignCount(campaignId, field) {
  await supabase.rpc('increment_campaign_counter', {
    p_campaign_id: campaignId,
    p_field: field,
  });
}

async function setCampaignStatus(campaignId, status) {
  const update = { status, updated_at: new Date().toISOString() };
  if (status === 'Running') update.started_at = new Date().toISOString();
  if (status === 'Completed' || status === 'Cancelled') update.completed_at = new Date().toISOString();
  await supabase.from('campaigns').update(update).eq('id', campaignId);
}

// ── MAIN: Start sending a campaign ───────────────────────────
export async function startCampaign(campaignId, sock) {
  if (activeQueues.has(campaignId)) {
    const q = activeQueues.get(campaignId);
    if (q.status === 'running') return { error: 'Campaign already running' };
    if (q.status === 'paused') {
      q.status = 'running';
      broadcastProgress(campaignId, { event: 'resumed', campaignId });
      return { ok: true, message: 'Campaign resumed' };
    }
  }

  // Load all pending items
  const items = await loadPendingItems(campaignId);
  if (items.length === 0) {
    await setCampaignStatus(campaignId, 'Completed');
    return { ok: true, message: 'No pending items — campaign marked complete' };
  }

  // Get campaign config for delays
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('min_delay_sec, max_delay_sec, name')
    .eq('id', campaignId)
    .single();

  const minDelay = campaign?.min_delay_sec ?? 20;
  const maxDelay = campaign?.max_delay_sec ?? 60;

  // Register queue state
  activeQueues.set(campaignId, { status: 'running' });
  await setCampaignStatus(campaignId, 'Running');

  broadcastProgress(campaignId, {
    event: 'started',
    campaignId,
    total: items.length,
    campaignName: campaign?.name,
  });

  // ── Fire-and-forget send loop ─────────────────────────────
  (async () => {
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const qItem = items[i];
      const qState = activeQueues.get(campaignId);

      // ── Cancelled? ───────────────────────────────────────
      if (!qState || qState.status === 'cancelled') {
        await markItem(qItem.id, 'Cancelled');
        broadcastProgress(campaignId, {
          event: 'cancelled',
          campaignId,
          sent: sentCount,
          failed: failedCount,
          skipped: skippedCount,
          total: items.length,
        });
        await setCampaignStatus(campaignId, 'Cancelled');
        activeQueues.delete(campaignId);
        return;
      }

      // ── Paused? Wait until resumed or cancelled ───────────
      while (qState.status === 'paused') {
        await sleep(1000);
        const current = activeQueues.get(campaignId);
        if (!current || current.status === 'cancelled') break;
      }

      // Re-check after unpause
      const qStateAfter = activeQueues.get(campaignId);
      if (!qStateAfter || qStateAfter.status === 'cancelled') continue;

      const lead = qItem.lead;
      const phone = lead?.phone || '';

      // ── Skip invalid phone ────────────────────────────────
      if (!isValidPhone(phone)) {
        await markItem(qItem.id, 'Skipped', 'Invalid phone number');
        await updateCampaignCount(campaignId, 'skipped_count');
        skippedCount++;

        await logger.log({
          campaignId,
          leadId: qItem.lead_id,
          leadName: lead?.name,
          phone,
          messageBody: qItem.message_body,
          status: 'skipped',
          errorMsg: 'Invalid phone number',
        });

        broadcastProgress(campaignId, {
          event: 'skipped',
          campaignId,
          index: i + 1,
          total: items.length,
          leadName: lead?.name,
          phone,
          sent: sentCount,
          failed: failedCount,
          skipped: ++skippedCount - 1,
        });
        continue;
      }

      // ── Attempt send (up to 2 retries) ───────────────────
      let success = false;
      let lastError = '';
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await supabase
            .from('message_queue')
            .update({ attempt_count: attempt, status: 'Sending' })
            .eq('id', qItem.id);

          const jid = phone.replace(/[^\d]/g, '') + '@s.whatsapp.net';
          await sock.sendMessage(jid, { text: qItem.message_body });
          success = true;
          break;
        } catch (err) {
          lastError = String(err?.message || err);
          console.error(`❌ Send attempt ${attempt} failed for ${phone}:`, lastError);
          if (attempt < maxAttempts) await sleep(5000); // 5s between retries
        }
      }

      if (success) {
        await markItem(qItem.id, 'Sent');
        await updateCampaignCount(campaignId, 'sent_count');

        // Update lead status to Sent
        await supabase
          .from('leads')
          .update({ status: 'Sent', updated_at: new Date().toISOString() })
          .eq('id', qItem.lead_id);

        sentCount++;

        await logger.log({
          campaignId,
          leadId: qItem.lead_id,
          leadName: lead?.name,
          phone,
          messageBody: qItem.message_body,
          status: 'sent',
        });

        broadcastProgress(campaignId, {
          event: 'sent',
          campaignId,
          index: i + 1,
          total: items.length,
          leadName: lead?.name,
          phone,
          sent: sentCount,
          failed: failedCount,
          skipped: skippedCount,
          progress_pct: Math.round(((sentCount + failedCount + skippedCount) / items.length) * 100),
        });
      } else {
        await markItem(qItem.id, 'Failed', lastError);
        await updateCampaignCount(campaignId, 'failed_count');
        failedCount++;

        await logger.log({
          campaignId,
          leadId: qItem.lead_id,
          leadName: lead?.name,
          phone,
          messageBody: qItem.message_body,
          status: 'failed',
          errorMsg: lastError,
        });

        broadcastProgress(campaignId, {
          event: 'failed',
          campaignId,
          index: i + 1,
          total: items.length,
          leadName: lead?.name,
          phone,
          error: lastError,
          sent: sentCount,
          failed: failedCount,
          skipped: skippedCount,
        });
      }

      // ── Random delay before next message ─────────────────
      const isLast = i === items.length - 1;
      if (!isLast) {
        const delay = randomDelay(minDelay, maxDelay);
        const delaySec = Math.round(delay / 1000);

        broadcastProgress(campaignId, {
          event: 'waiting',
          campaignId,
          delay_sec: delaySec,
          next_lead: items[i + 1]?.lead?.name || 'next lead',
        });

        await sleep(delay);
      }
    }

    // ── All items processed ───────────────────────────────
    const finalStatus = failedCount === items.length ? 'Failed' : 'Completed';
    await setCampaignStatus(campaignId, finalStatus);
    activeQueues.delete(campaignId);

    broadcastProgress(campaignId, {
      event: 'completed',
      campaignId,
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      total: items.length,
      status: finalStatus,
    });

    console.log(`✅ Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed, ${skippedCount} skipped`);
  })();

  return { ok: true, message: `Campaign started — ${items.length} messages queued` };
}

// ── Pause ─────────────────────────────────────────────────────
export async function pauseCampaign(campaignId) {
  const q = activeQueues.get(campaignId);
  if (!q) return { error: 'Campaign not active' };
  q.status = 'paused';
  await setCampaignStatus(campaignId, 'Paused');
  broadcastProgress(campaignId, { event: 'paused', campaignId });
  return { ok: true };
}

// ── Resume ────────────────────────────────────────────────────
export async function resumeCampaign(campaignId) {
  const q = activeQueues.get(campaignId);
  if (!q) return { error: 'Campaign not in queue — restart it' };
  q.status = 'running';
  await setCampaignStatus(campaignId, 'Running');
  broadcastProgress(campaignId, { event: 'resumed', campaignId });
  return { ok: true };
}

// ── Cancel ────────────────────────────────────────────────────
export async function cancelCampaign(campaignId) {
  if (activeQueues.has(campaignId)) {
    activeQueues.get(campaignId).status = 'cancelled';
  }
  // Also mark any still-Pending items as Cancelled in DB
  await supabase
    .from('message_queue')
    .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .eq('status', 'Pending');

  await setCampaignStatus(campaignId, 'Cancelled');
  broadcastProgress(campaignId, { event: 'cancelled', campaignId });
  return { ok: true };
}

// ── Queue status ──────────────────────────────────────────────
export function getQueueStatus(campaignId) {
  const q = activeQueues.get(campaignId);
  return q ? q.status : null;
}

export function getAllActiveQueues() {
  const result = {};
  for (const [id, q] of activeQueues.entries()) result[id] = q.status;
  return result;
}
