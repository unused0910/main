// lib/logger.js
// Writes every send attempt to the message_logs table in Supabase.
// This is the permanent audit trail — never deleted, always queryable.

import supabase from './supabase.js';

export const logger = {
  /**
   * Log a send attempt.
   * @param {object} opts
   * @param {string} opts.campaignId
   * @param {string} opts.leadId
   * @param {string} opts.leadName
   * @param {string} opts.phone
   * @param {string} opts.messageBody
   * @param {'sent'|'failed'|'skipped'} opts.status
   * @param {string=} opts.errorMsg
   */
  async log({ campaignId, leadId, leadName, phone, messageBody, status, errorMsg }) {
    const { error } = await supabase.from('message_logs').insert({
      campaign_id:  campaignId  || null,
      lead_id:      leadId      || null,
      lead_name:    leadName    || null,
      phone:        phone       || null,
      message_body: messageBody || null,
      status,
      error_msg:    errorMsg    || null,
      sent_at:      new Date().toISOString(),
    });

    if (error) {
      // Never throw — logging should never crash the send loop
      console.error('⚠️  Logger failed to write:', error.message);
    }
  },

  /**
   * Fetch logs for a campaign (latest first).
   */
  async getCampaignLogs(campaignId, limit = 200) {
    const { data, error } = await supabase
      .from('message_logs')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('sent_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    return data || [];
  },

  /**
   * Fetch all logs (latest first), with optional search.
   */
  async getAllLogs({ limit = 300, search } = {}) {
    let query = supabase
      .from('message_logs')
      .select('*')
      .order('sent_at', { ascending: false })
      .limit(limit);

    if (search) {
      query = query.or(
        `lead_name.ilike.%${search}%,phone.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  },
};
