// lib/session.js
// Replaces Baileys' useMultiFileAuthState (which uses ./auth folder on disk).
// Instead, we serialize the entire auth state to a single Supabase row.
// This means:
//   ✅ Session survives Render restarts (no disk needed)
//   ✅ QR scanned only once
//   ✅ Auto-reconnect on restart
//   ✅ No "auth" folder to manage

import supabase from './supabase.js';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

const SESSION_ID = 'main';

/**
 * Load auth state from Supabase.
 * Returns { state, saveCreds } — same interface as useMultiFileAuthState
 * so we can drop this in as a replacement with zero other code changes.
 */
export async function useSupabaseAuthState() {
  // ── Load existing creds from DB ─────────────────────────────
  async function loadCreds() {
    const { data, error } = await supabase
      .from('whatsapp_session')
      .select('creds_json')
      .eq('id', SESSION_ID)
      .maybeSingle();

    if (error) {
      console.warn('⚠️  Could not load session from Supabase:', error.message);
      return null;
    }
    return data?.creds_json ?? null;
  }

  // ── Save creds back to DB ────────────────────────────────────
  async function saveCreds() {
    const serialized = JSON.parse(JSON.stringify(state.creds, BufferJSON.replacer));
    const { error } = await supabase
      .from('whatsapp_session')
      .upsert({ id: SESSION_ID, creds_json: serialized, updated_at: new Date().toISOString() });

    if (error) {
      console.error('❌ Failed to save session to Supabase:', error.message);
    } else {
      console.log('💾 Session saved to Supabase');
    }
  }

  // ── Keys store (in-memory — they come from the socket, not persisted separately) ──
  // Baileys uses a keys store for message keys (prekeys, senderKey, etc.).
  // We keep these in memory between reconnects — they are regenerated on fresh login.
  const keysInMemory = {};

  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const value = keysInMemory[`${type}-${id}`];
        if (value) data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      for (const [type, typeData] of Object.entries(data)) {
        for (const [id, value] of Object.entries(typeData || {})) {
          if (value) {
            keysInMemory[`${type}-${id}`] = value;
          } else {
            delete keysInMemory[`${type}-${id}`];
          }
        }
      }
    }
  };

  // ── Init state ───────────────────────────────────────────────
  const storedCreds = await loadCreds();
  const creds = storedCreds
    ? JSON.parse(JSON.stringify(storedCreds), BufferJSON.reviver)
    : initAuthCreds();

  const state = { creds, keys };

  return { state, saveCreds };
}

/**
 * Delete the saved session from Supabase (forces new QR scan).
 * Call this if the account is logged out or banned.
 */
export async function deleteSession() {
  const { error } = await supabase
    .from('whatsapp_session')
    .delete()
    .eq('id', SESSION_ID);

  if (error) {
    console.error('❌ Failed to delete session:', error.message);
    return false;
  }
  console.log('🗑️  Session deleted from Supabase');
  return true;
}

/**
 * Check if a saved session exists in Supabase.
 */
export async function sessionExists() {
  const { data } = await supabase
    .from('whatsapp_session')
    .select('id')
    .eq('id', SESSION_ID)
    .maybeSingle();
  return !!data;
}
