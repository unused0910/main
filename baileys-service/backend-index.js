// baileys-service/index.js
// Production-ready WhatsApp backend for Render deployment.
// All config via environment variables — no hardcoded URLs.

import express from 'express';
import cors from 'cors';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import supabase from './lib/supabase.js';
import { useSupabaseAuthState, deleteSession, sessionExists } from './lib/session.js';
import {
  startCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
  getQueueStatus, getAllActiveQueues,
  addSseClient, removeSseClient,
} from './lib/queue.js';
import { logger } from './lib/logger.js';

// ── Config ────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3001;
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN  || '*';
const API_SECRET      = process.env.API_SECRET      || '';

// ── Express setup ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}));

// ── Auth middleware ───────────────────────────────────────────
// Protects all write endpoints with a shared secret set in env vars.
function requireSecret(req, res, next) {
  if (!API_SECRET) return next(); // no secret set → open (dev mode)
  const provided = req.headers['x-api-secret'];
  if (provided !== API_SECRET) {
    return res.status(401).json({ error: 'Invalid API secret' });
  }
  next();
}

// ── WhatsApp socket state ─────────────────────────────────────
let sock           = null;
let isConnected    = false;
let latestQrBase64 = null;   // QR as base64 PNG (for frontend display)
let isReconnecting = false;

// ── Pino logger (silent Baileys internals in prod) ────────────
const pinoLogger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ── Start / restart WhatsApp socket ──────────────────────────
async function startSocket() {
  if (isReconnecting) return;
  isReconnecting = true;

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useSupabaseAuthState();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pinoLogger,
      printQRInTerminal: true,   // also print in Render logs as fallback
      browser: ['WhatsApp CRM', 'Chrome', '122.0'],
      connectTimeoutMs: 60_000,
      retryRequestDelayMs: 2000,
    });

    // ── Connection updates ──────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        // Generate base64 PNG from the raw QR string for the frontend
        latestQrBase64 = await qrcode.toDataURL(qr);
        console.log('📱 QR ready — open the frontend to scan');
      }

      if (connection === 'open') {
        isConnected    = true;
        isReconnecting = false;
        latestQrBase64 = null;
        console.log('✅ WhatsApp connected');
      }

      if (connection === 'close') {
        isConnected    = false;
        isReconnecting = false;

        const statusCode  = lastDisconnect?.error?.output?.statusCode;
        const reason      = DisconnectReason[statusCode] || statusCode;
        console.warn(`⚠️  Connection closed: ${reason}`);

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          console.log('🚪 Logged out — deleting session from Supabase');
          await deleteSession();
        }

        // Auto-reconnect for everything except intentional logout
        if (!loggedOut) {
          console.log('🔄 Reconnecting in 5s…');
          setTimeout(startSocket, 5000);
        }
      }
    });

    // ── Save creds whenever they change ────────────────────
    sock.ev.on('creds.update', saveCreds);

    isReconnecting = false;
  } catch (err) {
    console.error('❌ startSocket error:', err.message);
    isReconnecting = false;
    setTimeout(startSocket, 10_000);
  }
}

// ── API ROUTES ────────────────────────────────────────────────

// ─── Health check (Render uses this to confirm service is up) ─
app.get('/', (_req, res) => {
  res.json({
    service: 'WhatsApp CRM Backend',
    status: 'ok',
    whatsapp: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// ─── WhatsApp status + QR ─────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    connected: isConnected,
    qr: isConnected ? null : latestQrBase64,
    reconnecting: isReconnecting,
  });
});

// ─── Force new QR (logout current session) ────────────────────
app.post('/api/logout', requireSecret, async (_req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch { /* ignore */ }
      sock = null;
    }
    isConnected = false;
    await deleteSession();
    setTimeout(startSocket, 1000);
    res.json({ ok: true, message: 'Logged out — scan new QR to reconnect' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Send single test message ─────────────────────────────────
app.post('/api/send', requireSecret, async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected — scan QR first' });
  }
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
    const jid = to.replace(/[^\d]/g, '') + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, id: result?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEADS ────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    let query = supabase.from('leads').select('*').order('created_at', { ascending: false });
    if (req.query.status)  query = query.eq('status', req.query.status);
    if (req.query.country) query = query.ilike('country', `%${req.query.country}%`);
    if (req.query.product) query = query.ilike('product', `%${req.query.product}%`);
    if (req.query.search) {
      const s = req.query.search;
      query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ leads: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', requireSecret, async (req, res) => {
  try {
    const lead = req.body;
    const { data, error } = await supabase.from('leads').insert(lead).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Phone number already exists' });
      throw error;
    }
    res.json({ lead: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/bulk', requireSecret, async (req, res) => {
  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }
    const { data, error } = await supabase
      .from('leads')
      .upsert(leads, { onConflict: 'phone', ignoreDuplicates: true })
      .select();
    if (error) throw error;
    res.json({ inserted: data?.length || 0, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/leads/:id', requireSecret, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ lead: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', requireSecret, async (req, res) => {
  try {
    const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TEMPLATES ────────────────────────────────────────────────
app.get('/api/templates', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('templates').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ templates: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', requireSecret, async (req, res) => {
  try {
    const { data, error } = await supabase.from('templates').insert(req.body).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/templates/:id', requireSecret, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('templates').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', requireSecret, async (req, res) => {
  try {
    const { error } = await supabase.from('templates').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CAMPAIGNS ────────────────────────────────────────────────
app.get('/api/campaigns', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_campaign_stats').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ campaigns: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create campaign + build message_queue rows
app.post('/api/campaigns', requireSecret, async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected — scan QR first' });
  }
  try {
    const { name, template_id, lead_ids, min_delay_sec = 20, max_delay_sec = 60 } = req.body;
    if (!name || !template_id || !lead_ids?.length) {
      return res.status(400).json({ error: 'name, template_id and lead_ids are required' });
    }

    // Fetch template
    const { data: template, error: tErr } = await supabase
      .from('templates').select('*').eq('id', template_id).single();
    if (tErr || !template) return res.status(404).json({ error: 'Template not found' });

    // Fetch selected leads
    const { data: leads, error: lErr } = await supabase
      .from('leads').select('*').in('id', lead_ids);
    if (lErr) throw lErr;
    const validLeads = leads.filter(l => l.phone_valid !== false);

    // Create campaign row
    const { data: campaign, error: cErr } = await supabase
      .from('campaigns')
      .insert({ name, template_id, total_leads: validLeads.length, min_delay_sec, max_delay_sec })
      .select().single();
    if (cErr) throw cErr;

    // Build queue rows with rendered messages
    const queueRows = validLeads.map(lead => ({
      campaign_id:  campaign.id,
      lead_id:      lead.id,
      message_body: renderTemplate(template.content, lead),
      status:       'Pending',
    }));

    const { error: qErr } = await supabase.from('message_queue').insert(queueRows);
    if (qErr) throw qErr;

    // Increment template times_used
    await supabase.from('templates')
      .update({ times_used: (template.times_used || 0) + validLeads.length })
      .eq('id', template_id);

    res.json({ campaign, queued: queueRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CAMPAIGN ACTIONS ─────────────────────────────────────────
app.delete('/api/campaigns/:id', requireSecret, async (req, res) => {
  try {
    // Cancel active queue first
    await cancelCampaign(req.params.id).catch(() => {});
    // Delete queue rows (cascade in schema but let's be explicit)
    await supabase.from('message_queue').delete().eq('campaign_id', req.params.id);
    await supabase.from('message_logs').delete().eq('campaign_id', req.params.id);
    const { error } = await supabase.from('campaigns').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/campaigns/:id/start', requireSecret, async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const result = await startCampaign(req.params.id, sock);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/pause', requireSecret, async (req, res) => {
  const result = await pauseCampaign(req.params.id);
  result.error ? res.status(400).json(result) : res.json(result);
});

app.post('/api/campaigns/:id/resume', requireSecret, async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  const result = await resumeCampaign(req.params.id);
  result.error ? res.status(400).json(result) : res.json(result);
});

app.post('/api/campaigns/:id/cancel', requireSecret, async (req, res) => {
  const result = await cancelCampaign(req.params.id);
  res.json(result);
});

// ─── LIVE PROGRESS (Server-Sent Events) ───────────────────────
app.get('/api/campaigns/:id/progress', (req, res) => {
  const campaignId = req.params.id;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx buffering
  res.flushHeaders();

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ event: 'connected', campaignId })}\n\n`);

  addSseClient(campaignId, res);

  // Heartbeat every 25s to keep connection alive through Render's idle timeout
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(campaignId, res);
  });
});

// ─── QUEUE ────────────────────────────────────────────────────
app.get('/api/campaigns/:id/queue', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('message_queue')
      .select('*, lead:leads(name, phone, company)')
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ queue: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGS ─────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await logger.getAllLogs({
      limit:  parseInt(req.query.limit)  || 300,
      search: req.query.search           || undefined,
    });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete single log entry
app.delete('/api/logs/:id', requireSecret, async (req, res) => {
  try {
    const { error } = await supabase.from('message_logs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/logs', async (req, res) => {
  try {
    const logs = await logger.getCampaignLogs(req.params.id);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYTICS / DASHBOARD STATS ──────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('v_dashboard_stats').select('*').single();
    if (error) throw error;
    res.json({ stats: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SETTINGS ─────────────────────────────────────────────────
app.get('/api/settings', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1).single();
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/settings', requireSecret, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('settings').select('id').limit(1).single();
    const { data, error } = await supabase
      .from('settings').update(req.body).eq('id', existing.id).select().single();
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACTIVE QUEUE STATE ────────────────────────────────────────
app.get('/api/queue-state', (_req, res) => {
  res.json({ activeQueues: getAllActiveQueues() });
});

// ── Template variable renderer ────────────────────────────────
function renderTemplate(content, lead) {
  const map = {
    name:    lead.name    || '',
    company: lead.company || '',
    product: lead.product || '',
    qty:     lead.quantity || '',
    country: lead.country || '',
    email:   lead.email   || '',
  };
  return (content || '').replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (_, k) => map[k.toLowerCase()] ?? `[${k}]`
  );
}

// ─── AUTH — OTP LOGIN ─────────────────────────────────────────
// Credentials set via Render env vars: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_PHONE
// OTP is sent to ADMIN_PHONE via WhatsApp. Expires in 5 minutes.
const otpStore = new Map(); // { username -> { otp, expires } }

app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const { username, password } = req.body;
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';
    const adminPhone = process.env.ADMIN_PHONE || '';

    if (username !== validUser || password !== validPass) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!adminPhone) {
      // No admin phone set — skip OTP, return token directly (dev mode)
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return res.json({ ok: true, token, message: 'ADMIN_PHONE not set — OTP skipped (dev mode)' });
    }

    if (!isConnected) {
      return res.status(503).json({ error: 'WhatsApp not connected — cannot send OTP. Use dev mode (remove ADMIN_PHONE env var) or connect WhatsApp first.' });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(username, { otp, expires: Date.now() + 5 * 60 * 1000 });

    // Send via WhatsApp
    const jid = adminPhone.replace(/[^\d]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, {
      text: `🔐 *WhatsApp CRM Login OTP*\n\nYour OTP is: *${otp}*\n\nExpires in 5 minutes. Do not share this with anyone.`
    });

    res.json({ ok: true, message: 'OTP sent to your WhatsApp' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { username, otp } = req.body;
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPhone = process.env.ADMIN_PHONE || '';

    // Dev mode: no phone set, no OTP needed
    if (!adminPhone) {
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return res.json({ ok: true, token });
    }

    if (username !== validUser) {
      return res.status(401).json({ error: 'Invalid username' });
    }

    const record = otpStore.get(username);
    if (!record) return res.status(401).json({ error: 'No OTP requested — request one first' });
    if (Date.now() > record.expires) {
      otpStore.delete(username);
      return res.status(401).json({ error: 'OTP expired — request a new one' });
    }
    if (record.otp !== String(otp).trim()) {
      return res.status(401).json({ error: 'Incorrect OTP' });
    }

    otpStore.delete(username); // single-use
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start everything ──────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 WhatsApp CRM Backend running on port ${PORT}`);
  console.log(`🔗 Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`🔐 API secret: ${API_SECRET ? 'set ✅' : 'NOT SET ⚠️ (open access)'}`);
  await startSocket();
});
