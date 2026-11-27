/**
 * AutoApply mail backfill.
 *
 *   node scripts/aa-mail-backfill.mjs [--after-id N]
 *       one-off after sql/mail/02: re-classify old rows, set kind / company / expires_at, extract interviews.
 *       Idempotent, writes.
 *
 *   node scripts/aa-mail-backfill.mjs --reverify [--apply] [--after-id N] [--limit N]
 *       re-run the two-stage rules (candidate + corroborating evidence) on mail tagged interview / assessment /
 *       offer and print the diff. DRY RUN unless --apply is given. Needs sql/mail/07_mail_kind_verify.sql for --apply.
 *
 * Env as the API: AA_MAIL_SUPABASE_URL + AA_MAIL_SUPABASE_SERVICE_ROLE_KEY (else SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 */
import "dotenv/config";
import { getMailDb } from "../lib/autoapply/mailDb.js";
import { backfillMail, reverifyMail } from "../lib/autoapply/mailJobs.js";

const argv = process.argv;
const num = (flag) => { const i = argv.indexOf(flag); return i > 0 ? Number(argv[i + 1]) || 0 : 0; };
const afterId = num("--after-id");

if (argv.includes("--reverify")) {
  const apply = argv.includes("--apply");
  const limit = num("--limit") || Infinity;
  const { stats, changes } = await reverifyMail({ mailDb: getMailDb(), apply, afterId, limit });
  for (const c of changes) console.log(`${apply ? "APPLIED" : "WOULD CHANGE"} #${c.id}  ${c.from} -> ${c.to}  | ${c.subject}`);
  console.log(`[aa-mail-backfill] reverify ${apply ? "(applied)" : "(dry run, pass --apply to write)"}`, JSON.stringify(stats));
} else {
  const stats = await backfillMail({ mailDb: getMailDb(), afterId, log: (s) => console.log("[aa-mail-backfill]", JSON.stringify(s)) });
  console.log("[aa-mail-backfill] done", JSON.stringify(stats));
}
