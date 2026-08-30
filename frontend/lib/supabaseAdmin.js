/**
 * Service-role Supabase client — SERVER ONLY.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. This key must NEVER be
 * exposed to the browser (never prefix it with VITE_). It is read from the
 * server environment only.
 *
 * If the service-role key is missing we still export a client-shaped object,
 * but every property access throws a clear error. This keeps local dev booting
 * (so the non-entitlement routes work) while failing loudly the moment an
 * entitlement path is actually hit.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

let client;

if (SUPABASE_URL && SERVICE_ROLE_KEY) {
  client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
} else {
  const missing = !SUPABASE_URL
    ? "SUPABASE_URL / VITE_SUPABASE_URL"
    : "SUPABASE_SERVICE_ROLE_KEY";
  const fail = () => {
    throw new Error(
      `[supabaseAdmin] ${missing} is not set. ` +
        "Set SUPABASE_SERVICE_ROLE_KEY (server-only, never VITE_) to use " +
        "auth verification / entitlement routes.",
    );
  };
  client = new Proxy(
    {},
    {
      get: fail,
      apply: fail,
    },
  );
}

export const supabaseAdmin = client;

export const hasServiceRole = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
