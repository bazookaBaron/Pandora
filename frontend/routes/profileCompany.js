/**
 * Company ownership + work-email verification.
 *
 *   GET  /api/profile/company                 -> { company, verified, verifiedDomain }
 *   PUT  /api/profile/company {company}       -> sets company, resets verified=false
 *   POST /api/profile/company/verify-start {workEmail}  -> emails a 6-digit code
 *   POST /api/profile/company/verify-confirm {code}     -> marks company_verified=true
 *
 * Verification is OPTIONAL: it grants a "Verified" badge and a higher daily
 * accept limit (20 vs 3); nothing is blocked without it.
 * See sql/31 + sql/35_optional_company_verify.sql and lib/referralAccess.js.
 */
import { requireAuth } from "../lib/requireAuth.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import * as resend from "../services/resend.js";
import { makeLimiter } from "../lib/rateKeys.js";
import {
  emailMatchesCompany,
  generateCode,
  hashCode,
  codesEqual,
} from "../lib/companyVerify.js";

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_STARTS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const startLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const confirmLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const companyLimiter = makeLimiter({ windowMs: 60 * 1000, max: 20 });

function maskEmail(e) {
  const [u, d] = String(e).split("@");
  return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
}

function bad(res, status, error) {
  return res.status(status).json({ error });
}

/**
 * Fetch {company, company_verified}. Returns null on a missing row.
 * Throws on DB error (callers fail closed).
 */
export async function getVerifiedCompany(userId) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("company, company_verified")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  const company = String((data && data.company) || "").trim();
  return { company, verified: !!(data && data.company_verified && company) };
}

export function registerProfileCompanyRoutes(app, { fail }) {
  app.get("/api/profile/company", companyLimiter, requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("company, company_verified, company_verified_domain")
        .eq("id", req.user.id)
        .maybeSingle();
      if (error) throw error;
      res.json({
        company: (data && data.company) || null,
        verified: !!(data && data.company_verified),
        verifiedDomain: (data && data.company_verified_domain) || null,
      });
    } catch (err) {
      fail(res, err, "profile/company", "Failed to load company.");
    }
  });

  app.put("/api/profile/company", companyLimiter, requireAuth, async (req, res) => {
    try {
      const raw = req.body && req.body.company;
      const company = typeof raw === "string" ? raw.trim() : "";
      if (!company || company.length > 200) {
        return bad(res, 400, "company is required (1-200 characters).");
      }
      const cur = await getVerifiedCompany(req.user.id).catch(() => null);
      if (cur && cur.verified && cur.company.toLowerCase() === company.toLowerCase()) {
        return res.json({ company: cur.company, verified: true });
      }
      const { error } = await supabaseAdmin.from("profiles").upsert(
        {
          id: req.user.id,
          company,
          company_verified: false,
          company_verified_at: null,
          company_verified_domain: null,
        },
        { onConflict: "id" },
      );
      if (error) throw error;
      res.json({ company, verified: false });
    } catch (err) {
      fail(res, err, "profile/company/put", "Failed to save company.");
    }
  });

  app.post(
    "/api/profile/company/verify-start",
    startLimiter,
    requireAuth,
    async (req, res) => {
      try {
        const workEmail = String((req.body && req.body.workEmail) || "").trim().toLowerCase();
        if (!workEmail || workEmail.length > 254) return bad(res, 400, "invalid_email");
        if (!resend.isEnabled()) return bad(res, 503, "email_unconfigured");

        const { company, verified } = await getVerifiedCompany(req.user.id);
        if (!company) return bad(res, 400, "set_company_first");

        const match = await emailMatchesCompany(workEmail, company);
        if (!match.ok) {
          return res.status(422).json({ error: match.reason || "domain_mismatch", domain: match.domain });
        }

        const hourAgo = new Date(Date.now() - 3600_000).toISOString();
        const { data: recent, error: rErr } = await supabaseAdmin
          .from("company_verification_codes")
          .select("created_at")
          .eq("user_id", req.user.id)
          .gte("created_at", hourAgo)
          .order("created_at", { ascending: false })
          .limit(MAX_STARTS_PER_HOUR);
        if (rErr) throw rErr;
        if ((recent || []).length >= MAX_STARTS_PER_HOUR) return bad(res, 429, "too_many_codes");
        if (recent && recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESEND_COOLDOWN_MS) {
          return bad(res, 429, "wait_before_resending");
        }

        // One work address may back only one account.
        const { data: taken, error: tErr } = await supabaseAdmin
          .from("company_verification_codes")
          .select("id")
          .eq("work_email", workEmail)
          .not("consumed_at", "is", null)
          .neq("user_id", req.user.id)
          .limit(1);
        if (tErr) throw tErr;
        if (taken && taken.length) return bad(res, 409, "email_in_use");

        const code = generateCode();
        const { error: insErr } = await supabaseAdmin.from("company_verification_codes").insert({
          user_id: req.user.id,
          company,
          work_email: workEmail,
          email_domain: match.domain,
          code_hash: hashCode(req.user.id, code),
          expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
        });
        if (insErr) throw insErr;

        const r = await resend.sendEmail({
          to: workEmail,
          subject: `Your Vloombox verification code: ${code}`,
          text: `Your Vloombox code to verify you work at ${company} is ${code}. It expires in 15 minutes. If you did not request this, ignore this email.`,
          html:
            `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px">` +
            `<p>Your code to verify you work at <strong>${company.replace(/[<>&"]/g, "")}</strong>:</p>` +
            `<p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p>` +
            `<p style="color:#666">Expires in 15 minutes. If you did not request this, ignore this email.</p></div>`,
          tag: "company_verify",
        });
        if (r && r.error) return bad(res, 502, "email_send_failed");

        res.json({ ok: true, sentTo: maskEmail(workEmail), expiresInSeconds: CODE_TTL_MS / 1000, alreadyVerified: verified });
      } catch (err) {
        fail(res, err, "profile/company/verify-start", "Failed to start verification.");
      }
    },
  );

  app.post(
    "/api/profile/company/verify-confirm",
    confirmLimiter,
    requireAuth,
    async (req, res) => {
      try {
        const code = String((req.body && req.body.code) || "").trim();
        if (!/^\d{6}$/.test(code)) return bad(res, 400, "invalid_code");

        const { data: row, error } = await supabaseAdmin
          .from("company_verification_codes")
          .select("id, company, email_domain, code_hash, attempts, expires_at")
          .eq("user_id", req.user.id)
          .is("consumed_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if (!row) return bad(res, 400, "no_pending_code");
        if (new Date(row.expires_at).getTime() < Date.now()) return bad(res, 400, "code_expired");
        if (row.attempts >= MAX_ATTEMPTS) return bad(res, 429, "too_many_attempts");

        // Count the attempt BEFORE comparing (a parallel burst cannot out-guess the cap).
        const { data: bumped, error: bErr } = await supabaseAdmin
          .from("company_verification_codes")
          .update({ attempts: row.attempts + 1 })
          .eq("id", row.id)
          .eq("attempts", row.attempts)
          .select("id")
          .maybeSingle();
        if (bErr) throw bErr;
        if (!bumped) return bad(res, 429, "try_again");

        if (!codesEqual(hashCode(req.user.id, code), row.code_hash)) {
          return bad(res, 400, "wrong_code");
        }

        const { data: consumed, error: cErr } = await supabaseAdmin
          .from("company_verification_codes")
          .update({ consumed_at: new Date().toISOString() })
          .eq("id", row.id)
          .is("consumed_at", null)
          .select("id")
          .maybeSingle();
        if (cErr) throw cErr;
        if (!consumed) return bad(res, 409, "already_used");

        // The company may have been edited since the code was issued.
        const { data: upd, error: uErr } = await supabaseAdmin
          .from("profiles")
          .update({
            company_verified: true,
            company_verified_at: new Date().toISOString(),
            company_verified_domain: row.email_domain,
          })
          .eq("id", req.user.id)
          .eq("company", row.company)
          .select("company")
          .maybeSingle();
        if (uErr) throw uErr;
        if (!upd) return bad(res, 409, "company_changed");

        res.json({ ok: true, company: upd.company, verified: true });
      } catch (err) {
        fail(res, err, "profile/company/verify-confirm", "Failed to verify.");
      }
    },
  );
}
