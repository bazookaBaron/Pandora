/**
 * Supabase client for the AutoApply MAIL database (a separate free-tier project).
 * Env: AA_MAIL_SUPABASE_URL + AA_MAIL_SUPABASE_SERVICE_ROLE_KEY. When either is unset the
 * main service-role client is returned, so production keeps working before the mail
 * project exists (the main project's aa_mail_events then needs sql/21's added columns).
 */
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../supabaseAdmin.js";

let cached;

export function hasSeparateMailDb(env = process.env) {
  return Boolean(env.AA_MAIL_SUPABASE_URL && env.AA_MAIL_SUPABASE_SERVICE_ROLE_KEY);
}

export function getMailDb(env = process.env) {
  if (!hasSeparateMailDb(env)) return supabaseAdmin;
  if (!cached) {
    cached = createClient(env.AA_MAIL_SUPABASE_URL, env.AA_MAIL_SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Lazy proxy so importing this file never needs env at load time. */
export const mailDb = new Proxy(
  {},
  { get: (_t, prop) => { const c = getMailDb(); const v = c[prop]; return typeof v === "function" ? v.bind(c) : v; } },
);
