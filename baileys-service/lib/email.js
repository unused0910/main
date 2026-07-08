// lib/email.js
// Sends emails via SMTP (Gmail, Brevo, SendGrid, any provider).
// Config comes from Supabase settings table — no hardcoded credentials.

import nodemailer from 'nodemailer';
import supabase from './supabase.js';

let _transporter = null;
let _config = null;

// Load email config from Supabase settings
async function getConfig() {
  const { data, error } = await supabase
    .from('settings')
    .select('email_host, email_port, email_user, email_pass, email_from, email_name')
    .limit(1)
    .single();

  if (error || !data) throw new Error('Could not load email settings from database');
  if (!data.email_user || !data.email_pass) throw new Error('Email not configured — go to Settings → Email Setup');
  return data;
}

// Build (or reuse) the nodemailer transporter
async function getTransporter(forceRefresh = false) {
  const config = await getConfig();

  // Rebuild if config changed or not yet built
  const configKey = `${config.email_host}:${config.email_port}:${config.email_user}`;
  if (!_transporter || forceRefresh || _config !== configKey) {
    _transporter = nodemailer.createTransport({
      host:   config.email_host || 'smtp.gmail.com',
      port:   parseInt(config.email_port) || 587,
      secure: parseInt(config.email_port) === 465,
      auth: {
        user: config.email_user,
        pass: config.email_pass,   // Gmail: use App Password, not account password
      },
      tls: { rejectUnauthorized: false },
    });
    _config = configKey;
  }
  return { transporter: _transporter, config };
}

/**
 * Send a single email.
 * @param {object} opts
 * @param {string} opts.to        Recipient email
 * @param {string} opts.toName    Recipient name (optional)
 * @param {string} opts.subject   Email subject
 * @param {string} opts.body      Email body (plain text or HTML)
 * @param {boolean} opts.isHtml   Whether body is HTML
 */
export async function sendEmail({ to, toName, subject, body, isHtml = false }) {
  const { transporter, config } = await getTransporter();

  const fromAddr = config.email_from || config.email_user;
  const fromName = config.email_name || 'Sales Team';

  const info = await transporter.sendMail({
    from:    `"${fromName}" <${fromAddr}>`,
    to:      toName ? `"${toName}" <${to}>` : to,
    subject,
    ...(isHtml ? { html: body } : { text: body }),
  });

  return info.messageId;
}

/**
 * Send a test email to verify SMTP settings.
 */
export async function sendTestEmail(toEmail) {
  return sendEmail({
    to:      toEmail,
    subject: '✅ WhatsApp CRM — Email Test',
    body:    'Your email configuration is working correctly! You can now send bulk email campaigns from your CRM.',
    isHtml:  false,
  });
}

/**
 * Verify SMTP credentials without sending.
 */
export async function verifyEmailConfig() {
  const { transporter } = await getTransporter(true);
  await transporter.verify();
  return true;
}
