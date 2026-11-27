/**
 * ONE-OFF, NOT RUN AUTOMATICALLY: convert the UNUSED credits of legacy AutoApply pack batches into wallet balance.
 *
 *   amount = floor(price_paise x unused credits / credits_total)    i.e. the price paid per credit
 *
 * Per batch (sql/55 aa_wallet_convert_pack, one transaction, idempotent by key 'pack_credit:<batch id>'):
 *   queued / shortlisted tasks are cancelled, the wallet is credited (ledger kind 'migration'), and the batch is
 *   closed ('completed' when something was used, else 'cancelled'; credits_total := credits_used).
 * A batch with an application mid-flight is skipped ('tasks_active') and picked up by the next run.
 * Free packs (price 0, e.g. a free coupon) convert to nothing and are left alone.
 *
 * Requires sql/55_autoapply_wallet.sql to be applied first. Default is a DRY RUN that only prints the plan.
 *
 *   cd frontend
 *   node scripts/migrate-pack-credits-to-wallet.mjs            # dry run: who gets how much
 *   node scripts/migrate-pack-credits-to-wallet.mjs --apply    # do it (service role key from .env)
 *   node scripts/migrate-pack-credits-to-wallet.mjs --apply --user <uuid>   # one user only
 */
import "dotenv/config";

const ELIGIBLE = ["paid", "shortlisting", "review", "running", "paused", "waiting_supply", "waiting_profile", "expired", "completed"];

/** Pure: the wallet credit for one legacy batch row (0 when there is nothing to convert). */
export function convertible(b) {
  if (!b || b.rate_paise != null || !b.purchased_at) return { unused: 0, amount_paise: 0 };
  if (!ELIGIBLE.includes(b.status)) return { unused: 0, amount_paise: 0 };
  const total = Number(b.credits_total) || 0;
  const unused = Math.max(0, total - (Number(b.credits_used) || 0));
  const price = Number(b.price_paise) || 0;
  if (!total || !unused || price <= 0) return { unused: 0, amount_paise: 0 };
  return { unused, amount_paise: Math.floor((price * unused) / total) };
}

export async function run({ db, apply = false, userId = null, log = console.log } = {}) {
  let q = db
    .from("aa_batches")
    .select("id, user_id, status, price_paise, credits_total, credits_used, purchased_at, rate_paise")
    .is("rate_paise", null)
    .not("purchased_at", "is", null)
    .in("status", ELIGIBLE)
    .order("purchased_at", { ascending: true })
    .limit(5000);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  const out = { batches: 0, skipped: 0, total_paise: 0, converted: 0, active: 0, errors: 0 };
  for (const b of data || []) {
    const c = convertible(b);
    if (!c.amount_paise) {
      out.skipped++;
      continue;
    }
    out.batches++;
    out.total_paise += c.amount_paise;
    log(`${apply ? "convert" : "would convert"} batch ${b.id} user ${b.user_id}: ${c.unused} unused credit(s) -> ${c.amount_paise} paise`);
    if (!apply) continue;
    const { data: r, error: e } = await db.rpc("aa_wallet_convert_pack", { p_batch: b.id });
    if (e) {
      out.errors++;
      log(`  failed: ${e.message || e}`);
    } else if (r && r.ok) out.converted++;
    else if (r && r.reason === "tasks_active") out.active++;
    else log(`  not converted: ${(r && r.reason) || "unknown"}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("migrate-pack-credits-to-wallet.mjs")) {
  const { supabaseAdmin } = await import("../lib/supabaseAdmin.js");
  const apply = process.argv.includes("--apply");
  const ui = process.argv.indexOf("--user");
  const userId = ui > 0 ? process.argv[ui + 1] : null;
  if (!apply) console.log("DRY RUN (add --apply to convert). Nothing is written.");
  const out = await run({ db: supabaseAdmin, apply, userId });
  console.log(JSON.stringify(out), `total ${(out.total_paise / 100).toFixed(2)} INR`);
}
