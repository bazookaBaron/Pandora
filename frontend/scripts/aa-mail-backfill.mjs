/**
 * One-off: re-classify existing AutoApply mail after sql/mail/02_mail_retention_interviews.sql.
 *   - finds rejections among old rows (sets category 'rejected', expires 30 days after receipt)
 *   - fills kind / company, keeps expires_at NULL for codes / important / other
 *   - creates aa_interviews rows for interview mail
 * Idempotent, safe to re-run. Uses the same env as the API (AA_MAIL_SUPABASE_URL +
 * AA_MAIL_SUPABASE_SERVICE_ROLE_KEY, else SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for fallback mode).
 *
 *   cd frontend && node scripts/aa-mail-backfill.mjs [--after-id N]
 */
import "dotenv/config";
import { getMailDb } from "../lib/autoapply/mailDb.js";
import { backfillMail } from "../lib/autoapply/mailJobs.js";

const i = process.argv.indexOf("--after-id");
const afterId = i > 0 ? Number(process.argv[i + 1]) || 0 : 0;

const stats = await backfillMail({ mailDb: getMailDb(), afterId, log: (s) => console.log("[aa-mail-backfill]", JSON.stringify(s)) });
console.log("[aa-mail-backfill] done", JSON.stringify(stats));
