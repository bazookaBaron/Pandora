/**
 * Vloombox AutoApply HTTP API. Contract: docs/autoapply-contract.md.
 *
 *   createAutoApplyRouter(deps)  -> Express router with every /api/autoapply/* route
 *   createInboundHandler(deps)   -> POST /api/inbound/email handler (HMAC, no auth;
 *                                   mount behind express.raw so req.body is a Buffer)
 *   runAutoApplyRefunds(deps)    -> one refunds-cron pass
 *
 * Every dependency is injectable (db = Supabase service-role client, razorpay,
 * resend, getUserPlan, authenticate, limiters) so tests never touch the network.
 * Errors are always { error: { code, message } }.
 */
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";

import { AUTO_APPLY } from "../config/tiers.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { resolveUser } from "../lib/requireAuth.js";
import { getUserPlan as realGetUserPlan } from "../lib/entitlements.js";
import * as realRazorpay from "../services/razorpay.js";
import * as realResend from "../services/resend.js";

import { publicQuestions, validateAnswer, isValidKey, isRequiredKey, learnedKey, LEARNED_KEY_RE } from "../lib/autoapply/questions.js";
import { validatePrefsInput, validateProfileDraft, cleanText } from "../lib/autoapply/setupOptions.js";
import { decryptSecret } from "../lib/autoapply/vault.js";
import { engineState, liveStatus } from "../lib/autoapply/liveStatus.js";
import { isEligiblePlan, usageFor } from "../lib/autoapply/limits.js";
import { AAError, createAutoApplyOrder, quoteAutoApplyCoupon, verifyAutoApplyPayment, handleAutoApplyWebhook, expirePendingOrders } from "../lib/autoapply/orders.js";
import { verifyInbound, storeInbound } from "../lib/autoapply/inbound.js";
import { mailDb as realMailDb } from "../lib/autoapply/mailDb.js";
import { sendPushForMail, sendPushToUser, vapidConfig, isAllowedPushEndpoint } from "../lib/autoapply/push.js";
import { cleanupExpiredMail, sendDailyAlerts } from "../lib/autoapply/mailJobs.js";
import { NOTIFY_CATEGORIES } from "../lib/autoapply/classify.js";
import { processRefunds } from "../lib/autoapply/refunds.js";
import { profileCheck, profileReadiness } from "../lib/autoapply/profileGate.js";
import { normMustCompanies } from "../lib/autoapply/companies.js";
import { BROADEN_MAX, broadenPlan, evaluate as supplyEvaluate, titleKeywords, userCtx as supplyUserCtx, widenedLabel } from "../lib/autoapply/supplyMatch.js";
import { batchCounts, matchConfirmationMails, replyStats, STATS_WINDOW_DAYS } from "../lib/autoapply/insights.js";
import { healthSummary, isAdminUser } from "../lib/autoapply/health.js";
import { sendInterviewReminders } from "../lib/autoapply/reminders.js";
import { extractText, draftFromText, maybeEnrichWithAi } from "../lib/autoapply/resumeParse.js";
import { isVerifyItem, confirmSubmitted, notSubmitted } from "../lib/autoapply/verify.js";
import { readyItems, buildForm, publicForm, parseSubmission, applySubmission, notifyReadyNeedsYou, expireFinalBatchNeedsYou } from "../lib/autoapply/needsYouForm.js";

export { AAError, handleAutoApplyWebhook };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/**
 * Per-batch status histogram {batchId: {status: n}} via one GROUP BY (sql/53 aa_task_status_counts).
 * Falls back to counting a capped row scan when the RPC is not deployed yet.
 */
async function statusCountsFor(db, userId, batchIds) {
  const out = new Map(batchIds.map((id) => [id, {}]));
  if (!batchIds.length) return out;
  const { data, error } = await db.rpc("aa_task_status_counts", { p_user: userId, p_batch_ids: batchIds });
  if (!error && Array.isArray(data)) {
    for (const r of data) {
      const c = out.get(r.batch_id);
      if (c) c[r.status] = Number(r.n) || 0;
    }
    return out;
  }
  console.warn("[autoapply] status-count rpc unavailable, falling back to row scan:", (error && error.message) || error);
  const { data: rows, error: tErr } = await db.from("aa_tasks").select("batch_id, status").eq("user_id", userId).in("batch_id", batchIds).limit(10000);
  if (tErr) throw tErr;
  for (const t of rows || []) {
    const c = out.get(t.batch_id);
    if (c) c[t.status] = (c[t.status] || 0) + 1;
  }
  return out;
}

const TASK_FIELDS = "id, company, title, ats, status, reason_code, score, submitted_at, updated_at, apply_url, confirmation_text, proof_path, not_charged";
const PROOF_BUCKET = "aa-proof";
const PROOF_URL_TTL_S = 300; // signed proof URLs live 5 minutes
const EDITABLE_BATCH = ["paid", "shortlisting", "review", "running", "paused", "waiting_supply", "waiting_profile"];
const CONFIRM_MAIL_FIELDS = "id, subject, sender, from_name, company, received_at, category";

/** Task row for the client: proof_path is replaced by has_proof (the path itself is only used server-side). */
function publicTask(t) {
  const { proof_path, ...rest } = t;
  return { ...rest, has_proof: !!proof_path };
}
const MAX_JSON_BYTES = 100 * 1024;
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const mailDomain = () => process.env.AA_MAIL_DOMAIN || "apply.vloombox.in";

function sendError(res, err, where) {
  if (err instanceof AAError || (err && Number.isInteger(err.status) && typeof err.code === "string" && /^[a-z_]+$/.test(err.code))) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
  }
  console.error(`[autoapply] ${where}:`, (err && (err.message || err.details)) || String(err));
  return res.status(500).json({ error: { code: "internal", message: "Something went wrong." } });
}

const wrap = (where, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!res.headersSent) sendError(res, err, where);
  }
};

const bad = (message, code = "invalid_input") => new AAError(400, code, message);
/** 400 with per-field messages: { error: { code: 'invalid_input', message, fields: {key: message} } }. */
const badFields = (fields) => {
  const e = bad(Object.values(fields)[0] || "Check the highlighted fields.");
  e.fields = fields;
  return e;
};
const notFound = (what = "Not found.") => new AAError(404, "not_found", what);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function jsonSizeOk(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf8") <= MAX_JSON_BYTES;
  } catch {
    return false;
  }
}

/** Default auth: same verification as lib/requireAuth.js, contract error shape. */
async function defaultAuthenticate(req, res, next) {
  const h = String(req.headers.authorization || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const user = m ? await resolveUser(m[1].trim()) : null;
  if (!user) return res.status(401).json({ error: { code: "auth_required", message: "Sign in required." } });
  req.user = user;
  req.authToken = m[1].trim();
  next();
}

const passThrough = (_req, _res, next) => next();

/**
 * Seconds since the user last actually authenticated: the newest `amr[].timestamp` of the Supabase access token
 * (the token itself was verified by authenticate). Not `iat`: a session refresh re-issues the token with a fresh
 * iat but keeps amr, so only a real sign-in / reauthentication resets this. null when amr is missing / unusable.
 */
export function authAgeS(token, nowMs = Date.now()) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const stamps = (Array.isArray(claims && claims.amr) ? claims.amr : [])
      .map((a) => Number(a && a.timestamp))
      .filter((t) => Number.isFinite(t) && t > 0);
    if (!stamps.length) return null;
    return Math.floor(nowMs / 1000) - Math.max(...stamps);
  } catch {
    return null;
  }
}
export const REAUTH_MAX_AGE_S = 10 * 60;

/** Tiny per-process TTL cache (bounded; oldest entry evicted first). */
function ttlCache(ttlMs, max = 500) {
  const m = new Map();
  return {
    get(k, nowMs) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp <= nowMs) {
        m.delete(k);
        return undefined;
      }
      return e.v;
    },
    set(k, v, nowMs) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { v, exp: nowMs + ttlMs });
    },
  };
}
const SUPPLY_TTL_MS = 10 * 60 * 1000;
const SUPPLY_MAX_ROWS = 5000;
const STATS_TTL_MS = 5 * 60 * 1000;
const STATS_MAX_ROWS = 5000;

// ── alias ─────────────────────────────────────────────────────────────────────
export function slugFirstName(s) {
  const slug = String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
  return slug || "user";
}

export function randomTag(n = 4) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += abc[bytes[i] % abc.length];
  return out;
}

function firstNameFor({ bodyProfile, existing, email }) {
  const p = bodyProfile || (existing && existing.profile) || {};
  if (p.first_name) return p.first_name;
  if (p.name) return String(p.name).trim().split(/\s+/)[0];
  return String(email || "").split("@")[0].split(/[._+-]/)[0];
}

export function normAlertPrefs(v) {
  const o = v && typeof v === "object" ? v : {};
  return { email: o.email !== false, push: o.push !== false };
}

const INBOX_TABS = { important: "important", codes: "code" };
const INBOX_LIST_FIELDS = "id, sender, from_name, company, subject, codes, is_human, received_at, text_excerpt, category, kind, has_attachments, read_at, expires_at";
const INBOX_DETAIL_FIELDS = `${INBOX_LIST_FIELDS}, links`;
const INBOX_CATEGORIES = ["code", "received", "rejected", "important", "other"];
const INBOX_KINDS = ["interview", "assessment", "offer", "recruiter", "rejection"];
const INTERVIEW_FIELDS = "id, mail_event_id, company, role, starts_at, ends_at, timezone, tz_assumed, time_text, duration_min, meeting_url, meeting_provider, schedule_url, location, mode, round, interview_type, source, created_at";

/** PostgREST-safe ilike term: drop the characters that are syntax in .or() filters. */
const searchTerm = (q) => String(q || "").replace(/[%_,()*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
/** ilike body for an exact company name picked from the filter list ("Acme, Inc.", "Tata (TCS)"). It is a plain
 *  .ilike() filter (not inside .or()), so commas / parentheses are safe; wildcard and escape characters become '_'
 *  (any one character) instead of a space, so the name still matches itself. */
export const companyTerm = (q) => String(q || "").replace(/[%_*\\]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);

// ── prefs normalisation ─────────────────────────────────────────────────────
// titles / locations / min_score come from the setup dropdowns (lib/autoapply/setupOptions.js, same rules as the
// client); blocked companies and the current employer are short free text.
const COMPANY_MAX = 80;
function cleanCompany(v, field, errors) {
  const t = cleanText(v);
  if (/[<>]/.test(t)) errors[field] = "Remove < and > characters.";
  else if (t.length > COMPANY_MAX) errors[field] = `At most ${COMPANY_MAX} characters per company.`;
  return t;
}
function normPrefs(prefs, saved) {
  if (!isPlainObject(prefs)) throw bad("prefs must be an object.");
  const { prefs: out, errors } = validatePrefsInput(prefs, { saved: isPlainObject(saved) ? saved : undefined });
  if (out.blocked_companies !== undefined) {
    if (!Array.isArray(out.blocked_companies) || out.blocked_companies.some((x) => typeof x !== "string")) errors.blocked_companies = "Must be a list of company names.";
    else {
      const list = [...new Set(out.blocked_companies.map((c) => cleanCompany(c, "blocked_companies", errors)).filter(Boolean))];
      if (list.length > 50) errors.blocked_companies = "At most 50 blocked companies.";
      out.blocked_companies = list;
    }
  }
  if (out.current_employer !== undefined) {
    if (typeof out.current_employer !== "string") errors.current_employer = "Must be text.";
    else out.current_employer = cleanCompany(out.current_employer, "current_employer", errors);
  }
  if (Object.keys(errors).length) throw badFields(Object.fromEntries(Object.entries(errors).map(([k, v]) => [`prefs.${k}`, v])));
  return out;
}

// ── supply matching ─────────────────────────────────────────────────────────
const ANYWHERE_LOC = new Set(["any", "anywhere", "all", "india", "pan india", "any location", "anywhere in india"]);
export function matchesPrefs(job, prefs) {
  const t = String(job.title || "").toLowerCase();
  const loc = String(job.location || "").toLowerCase();
  const company = String(job.company || "").toLowerCase();
  const titles = (prefs && prefs.titles) || [];
  const locations = (prefs && prefs.locations) || [];
  const blocked = (prefs && prefs.blocked_companies) || [];
  if (blocked.some((b) => b && company.includes(String(b).toLowerCase()))) return false;
  if (titles.length) {
    const ok = titles.some((want) => {
      const w = String(want).toLowerCase().trim();
      if (!w) return false;
      if (t.includes(w)) return true;
      const toks = w.split(/\s+/).filter((x) => x.length > 1);
      return toks.length > 0 && toks.every((tok) => t.includes(tok));
    });
    if (!ok) return false;
  }
  // 'Pan India' (Anywhere in India) and friends match every job, as in cloud_hunter/saas/matching.py ANYWHERE
  if (locations.length && !locations.some((w) => ANYWHERE_LOC.has(String(w).toLowerCase().trim()))) {
    const ok = locations.some((want) => {
      const w = String(want).toLowerCase().trim();
      return w && (loc.includes(w) || (w === "remote" && /remote|anywhere/.test(loc)));
    });
    if (!ok) return false;
  }
  return true;
}

// ── router ──────────────────────────────────────────────────────────────────
export function createAutoApplyRouter(deps = {}) {
  const db = deps.db || supabaseAdmin;
  const mailDb = deps.mailDb || (deps.db ? deps.db : realMailDb);
  const getEnv = deps.env || process.env;
  const razorpay = deps.razorpay || realRazorpay;
  const getUserPlan = deps.getUserPlan || realGetUserPlan;
  const authenticate = deps.authenticate || defaultAuthenticate;
  const limiters = deps.limiters || {};
  const writeLimiter = limiters.write || passThrough;
  const checkoutLimiter = limiters.checkout || passThrough;
  const revealLimiter =
    limiters.reveal ||
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `aa-reveal:${req.user && req.user.id}`,
      validate: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: "rate_limited", message: "Too many password reveals; try again in an hour." } }),
    });
  const now = deps.now || (() => new Date());
  const vaultKey = deps.vaultKey; // undefined -> AA_VAULT_KEY

  const router = express.Router();
  router.use(authenticate);
  const supplyCache = ttlCache(SUPPLY_TTL_MS);
  const statsCache = ttlCache(STATS_TTL_MS);
  const reauthMaxAgeS = deps.reauthMaxAgeS ?? REAUTH_MAX_AGE_S;

  const getProfile = async (userId) => {
    const { data, error } = await db.from("aa_profiles").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    return data || null;
  };

  const getAnswers = async (userId) => {
    const { data, error } = await db.from("aa_answers").select("question_key, answer").eq("user_id", userId);
    if (error) throw error;
    return Object.fromEntries((data || []).map((r) => [r.question_key, r.answer]));
  };

  const ownBatch = async (userId, id) => {
    if (!UUID_RE.test(String(id))) throw notFound("Batch not found.");
    const { data, error } = await db.from("aa_batches").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Batch not found.");
    return data;
  };

  const updateBatchIf = async (batch, allowed, patch) => {
    if (!allowed.includes(batch.status)) {
      throw new AAError(409, "invalid_state", `Batch is '${batch.status}'; this action needs one of: ${allowed.join(", ")}.`);
    }
    const { data, error } = await db.from("aa_batches").update(patch).eq("id", batch.id).eq("status", batch.status).select("*");
    if (error) throw error;
    if (!data || !data[0]) throw new AAError(409, "invalid_state", "Batch changed meanwhile; reload and retry.");
    return data[0];
  };

  // Close the user's open needs-you item of kind 'profile' once no batch waits on the profile any more
  // (the scheduler does the same on its passes; cancel / pause move the batch out of 'waiting_profile' here).
  const closeProfileItemIfIdle = async (userId, resolution = "dismissed") => {
    const { count, error } = await db
      .from("aa_batches")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "waiting_profile");
    if (error) throw error;
    if (count) return;
    const { error: uErr } = await db
      .from("aa_needs_you")
      .update({ resolved_at: now().toISOString(), resolution })
      .eq("user_id", userId)
      .eq("kind", "profile")
      .is("resolved_at", null);
    if (uErr) throw uErr;
  };

  // GET /me
  router.get(
    "/me",
    wrap("me", async (req, res) => {
      const uid = req.user.id;
      const [plan, prof, usage, answers] = await Promise.all([getUserPlan(uid), getProfile(uid), usageFor(db, uid, now()), getAnswers(uid)]);
      const alias = prof && prof.apply_alias;
      res.json({
        eligible: isEligiblePlan(plan),
        plan,
        onboarding_done: !!(prof && prof.onboarding_done),
        profile: (prof && prof.profile) || {},
        prefs: (prof && prof.prefs) || {},
        resume_path: (prof && prof.resume_path) || null,
        consent_at: (prof && prof.consent_at) || null,
        email: {
          mode: (prof && prof.email_mode) || "inbox",
          alias: alias || null,
          address: alias ? `${alias}@${mailDomain()}` : null,
          contact_email: (prof && prof.contact_email) || req.user.email || null,
        },
        alert_prefs: normAlertPrefs(prof && prof.alert_prefs),
        review_before_apply: prof ? prof.review_before_apply !== false : true,
        usage,
        // same rules as the scheduler's gate (saas/profile_gate.py): a paid batch waits in 'waiting_profile' until ok
        profile_check: profileCheck(prof, answers),
        // same items as a percentage, each missing item with the Setup link that fixes it
        readiness: profileReadiness(prof, answers),
        is_admin: isAdminUser(req.user, getEnv),
        config: AUTO_APPLY,
      });
    }),
  );

  // PUT /profile
  router.put(
    "/profile",
    writeLimiter,
    wrap("profile", async (req, res) => {
      const uid = req.user.id;
      const b = req.body || {};
      const existing = await getProfile(uid);
      const patch = {};
      if (b.profile !== undefined) {
        if (!isPlainObject(b.profile) || !jsonSizeOk(b.profile)) throw bad("profile must be an object (max 100 KB).");
        const pErr = validateProfileDraft(b.profile);
        if (Object.keys(pErr).length) throw badFields(Object.fromEntries(Object.entries(pErr).map(([k, v]) => [`profile.${k}`, v])));
        patch.profile = b.profile;
      }
      if (b.prefs !== undefined) {
        const p = normPrefs(b.prefs, existing && existing.prefs);
        if (!jsonSizeOk(p)) throw bad("prefs is too large.");
        patch.prefs = p;
      }
      if (b.email_mode !== undefined) {
        if (!["inbox", "gmail_forward"].includes(b.email_mode)) throw bad("email_mode must be 'inbox' or 'gmail_forward'.");
        patch.email_mode = b.email_mode;
      }
      if (b.alert_prefs !== undefined) {
        if (!isPlainObject(b.alert_prefs)) throw bad("alert_prefs must be an object.");
        const cur = normAlertPrefs(existing && existing.alert_prefs);
        for (const k of ["email", "push"]) {
          if (b.alert_prefs[k] !== undefined && typeof b.alert_prefs[k] !== "boolean") throw bad(`alert_prefs.${k} must be a boolean.`);
        }
        patch.alert_prefs = { email: b.alert_prefs.email ?? cur.email, push: b.alert_prefs.push ?? cur.push };
      }
      if (b.contact_email !== undefined) {
        if (b.contact_email === null || b.contact_email === "") patch.contact_email = null;
        else if (typeof b.contact_email === "string" && EMAIL_RE.test(b.contact_email.trim()) && b.contact_email.length <= 320) {
          patch.contact_email = b.contact_email.trim();
        } else throw bad("contact_email must be a valid email address.");
      }
      if (b.review_before_apply !== undefined) {
        if (typeof b.review_before_apply !== "boolean") throw bad("review_before_apply must be a boolean.");
        patch.review_before_apply = b.review_before_apply;
      }
      if (b.onboarding_done !== undefined) {
        if (typeof b.onboarding_done !== "boolean") throw bad("onboarding_done must be a boolean.");
        patch.onboarding_done = b.onboarding_done;
      }
      if (b.consent !== undefined) {
        if (b.consent !== true) throw bad("consent must be true when given.");
        if (!(existing && existing.consent_at)) patch.consent_at = now().toISOString();
      }
      if (patch.onboarding_done === true && !(existing && existing.consent_at) && !patch.consent_at) {
        throw new AAError(400, "consent_required", "Accept the AutoApply terms before finishing onboarding.");
      }
      if (!existing && patch.contact_email === undefined && req.user.email) patch.contact_email = req.user.email;

      const needAlias = !(existing && existing.apply_alias);
      const base = slugFirstName(firstNameFor({ bodyProfile: patch.profile, existing, email: req.user.email }));
      let row = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const write = { user_id: uid, ...patch };
        if (needAlias) write.apply_alias = `${base}.${randomTag(4)}`;
        const { data, error } = await db.from("aa_profiles").upsert(write, { onConflict: "user_id" }).select("*").single();
        if (!error) {
          row = data;
          break;
        }
        const dup = error.code === "23505" || /duplicate key/i.test(String(error.message || ""));
        if (!(dup && needAlias)) throw error;
      }
      if (!row) throw new AAError(500, "alias_failed", "Could not allocate an apply address; retry.");
      res.json({ ok: true, profile: row });
    }),
  );

  // POST /resume
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: RESUME_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = RESUME_TYPES[file.mimetype] || (/\.(pdf|docx)$/i.exec(file.originalname || "") || [])[1];
      if (ext) cb(null, true);
      else cb(new AAError(400, "invalid_file", "Upload a PDF or DOCX resume."));
    },
  });
  const uploadResume = (req, res, next) =>
    upload.single("resume")(req, res, (err) => {
      if (!err) return next();
      if (err instanceof AAError) return sendError(res, err);
      if (err.code === "LIMIT_FILE_SIZE") return sendError(res, new AAError(413, "file_too_large", "Resume must be 5 MB or smaller."));
      return sendError(res, new AAError(400, "invalid_file", err.message || "Invalid upload."));
    });

  router.post(
    "/resume",
    writeLimiter,
    uploadResume,
    wrap("resume", async (req, res) => {
      const uid = req.user.id;
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) throw new AAError(400, "invalid_file", "Attach the resume as form field 'resume'.");
      const ext = RESUME_TYPES[file.mimetype] || (/\.(pdf|docx)$/i.exec(file.originalname || "") || [])[1].toLowerCase();
      const head = file.buffer.subarray(0, 4).toString("latin1");
      if ((ext === "pdf" && head !== "%PDF") || (ext === "docx" && head.slice(0, 2) !== "PK")) {
        throw new AAError(400, "invalid_file", "The file is not a valid PDF or DOCX.");
      }
      const contentType = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const resumePath = `${uid}/resume.${ext}`;
      const bucket = db.storage.from("aa-resumes");
      const { error: upErr } = await bucket.upload(resumePath, file.buffer, { contentType, upsert: true });
      if (upErr) throw upErr;
      const other = `${uid}/resume.${ext === "pdf" ? "docx" : "pdf"}`;
      Promise.resolve()
        .then(() => bucket.remove([other]))
        .catch(() => {});

      let parsed = {};
      try {
        const text = await (deps.extractText || extractText)(file.buffer, ext);
        parsed = draftFromText(text, now());
        parsed = await maybeEnrichWithAi(parsed, text);
      } catch (e) {
        console.warn("[autoapply/resume] parse failed:", (e && e.message) || String(e));
        parsed = { source: "none" };
      }

      const { data: profile, error } = await db
        .from("aa_profiles")
        .upsert({ user_id: uid, resume_path: resumePath }, { onConflict: "user_id" })
        .select("*")
        .single();
      if (error) throw error;
      res.json({ resume_path: resumePath, parsed, profile });
    }),
  );

  // GET/PUT /answers
  router.get(
    "/answers",
    wrap("answers", async (req, res) => {
      res.json({ questions: publicQuestions(), answers: await getAnswers(req.user.id) });
    }),
  );

  router.put(
    "/answers",
    writeLimiter,
    wrap("answers/put", async (req, res) => {
      const uid = req.user.id;
      const answers = req.body && req.body.answers;
      if (!isPlainObject(answers)) throw bad("answers must be an object of {key: value}.");
      const keys = Object.keys(answers);
      if (keys.length > 200) throw bad("Too many answers in one request.");
      const upserts = [];
      const deletes = [];
      const errors = {};
      const merged = { ...(await getAnswers(uid)) };
      for (const k of keys) {
        const v = validateAnswer(k, answers[k]);
        if (!v.ok) { errors[k] = v.message; continue; }
        if (v.value === null) { delete merged[k]; deletes.push(k); }
        else { merged[k] = v.value; upserts.push({ user_id: uid, question_key: k, answer: v.value, source: "user", updated_at: now().toISOString() }); }
      }
      // every setup question is mandatory: a standard answer cannot be cleared while it is still required
      for (const k of deletes) if (!errors[k] && isRequiredKey(k, merged)) errors[k] = "This answer is required.";
      if (Object.keys(errors).length) throw badFields(errors);
      if (upserts.length) {
        const { error } = await db.from("aa_answers").upsert(upserts, { onConflict: "user_id,question_key" });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await db.from("aa_answers").delete().eq("user_id", uid).in("question_key", deletes);
        if (error) throw error;
      }
      res.json({ questions: publicQuestions(), answers: await getAnswers(uid) });
    }),
  );

  // GET /supply: the jobs the scheduler would shortlist for this user right now (same hard gates as
  // saas/matching.py, ported in lib/autoapply/supplyMatch.js). When fewer than the pack size (?pack=50|100, default
  // 50) match, it walks the scheduler's broadening ladder (scheduler.broaden_plan: 60 / 90 days, + Pan India +
  // Remote, + related titles) and stops at the first step that reaches the pack size, or after the last step. The
  // scheduler applies the same ladder after purchase, so the count is what the pack really draws from.
  router.get(
    "/supply",
    wrap("supply", async (req, res) => {
      const kind = String(req.query.kind || "");
      if (!["service", "product"].includes(kind)) throw bad("kind must be 'service' or 'product'.");
      const wd = req.query.window_days === undefined ? AUTO_APPLY.window_days_default : Number(req.query.window_days);
      if (!Number.isInteger(wd) || wd < 1 || wd > AUTO_APPLY.window_days_max) throw bad(`window_days must be 1..${AUTO_APPLY.window_days_max}.`);
      const sizes = Object.keys(AUTO_APPLY.packs[kind] || {}).map(Number);
      const pack = req.query.pack === undefined ? Math.min(...sizes) : Number(req.query.pack);
      if (!sizes.includes(pack)) throw bad(`pack must be one of ${sizes.join(", ")}.`);
      const [prof, answers] = await Promise.all([getProfile(req.user.id), getAnswers(req.user.id)]);
      const prefs = (prof && prof.prefs) || {};
      // the scans below read up to SUPPLY_MAX_ROWS rows each: cached per (user, kind, window, pack, prefs)
      const cacheKey = `${req.user.id}|${kind}|${wd}|${pack}|${JSON.stringify(prefs)}`;
      const hit = supplyCache.get(cacheKey, now().getTime());
      if (hit) return res.json(hit);
      const ctxFor = (p) => supplyUserCtx(prof || {}, answers, p);
      // prefilter titles in SQL (keywords every matching title contains) so the scan stays small; none when the
      // user has no titles (the default engineering pattern) or a title has no safe keyword
      const scan = async (days, users) => {
        const kws = users.every((u) => u.titles.length) ? titleKeywords([...new Set(users.flatMap((u) => u.expanded))]) : null;
        let qb = db
          .from("aa_jobs")
          .select("company, company_key, title, location, country, posted_at, ats")
          .is("closed_at", null)
          .eq("company_kind", kind)
          .gte("posted_at", new Date(now().getTime() - days * 86400000).toISOString());
        if (kws && kws.length && kws.length <= 120) qb = qb.or(kws.map((k) => `title.ilike.%${k}%`).join(","));
        const { data, error } = await qb.order("posted_at", { ascending: false }).limit(SUPPLY_MAX_ROWS);
        if (error) throw error;
        return data || [];
      };
      const base = ctxFor(prefs);
      let rows = await scan(wd, [base]);
      let jobs = rows.filter((j) => supplyEvaluate(j, base).ok);
      const baseCount = jobs.length;
      let step = 0;
      let reached = { windowDays: wd, changed: [] };
      if (jobs.length < pack) {
        const plans = [];
        const seen = (plan) => `${plan.windowDays}|${plan.changed.filter((c) => c !== "score").join(",")}`;
        for (let s = 1, prev = seen({ windowDays: wd, changed: [] }); s <= BROADEN_MAX; s++) {
          const plan = broadenPlan(s, wd, prefs);
          // a step that changes nothing the count can see (already 90 days, already anywhere, the min_score step)
          // is skipped
          if (seen(plan) === prev) continue;
          prev = seen(plan);
          plans.push({ step: s, plan, user: ctxFor(plan.prefs) });
        }
        if (plans.length) {
          const wide = await scan(Math.max(...plans.map((p) => p.plan.windowDays)), plans.map((p) => p.user));
          for (const p of plans) {
            const since = now().getTime() - p.plan.windowDays * 86400000;
            const got = wide.filter((j) => new Date(j.posted_at).getTime() >= since && supplyEvaluate(j, p.user).ok);
            if (got.length > jobs.length) {
              jobs = got;
              rows = wide;
              step = p.step;
              reached = p.plan;
            }
            if (got.length >= pack) break;
          }
        }
      }
      const by_ats = {};
      for (const j of jobs) by_ats[j.ats] = (by_ats[j.ats] || 0) + 1;
      const out = {
        kind,
        window_days: wd,
        pack,
        count: jobs.length,
        base_count: baseCount,
        step,
        widened: step ? widenedLabel(reached.changed, reached.windowDays) : null,
        widened_parts: step ? reached.changed.filter((c) => c !== "score") : [],
        widened_window_days: reached.windowDays,
        capped: rows.length >= SUPPLY_MAX_ROWS,
        by_ats,
        sample: jobs.slice(0, 5).map(({ company, title, location, posted_at }) => ({ company, title, location, posted_at })),
      };
      supplyCache.set(cacheKey, out, now().getTime());
      res.json(out);
    }),
  );

  // POST /orders, /orders/verify
  router.post(
    "/orders",
    checkoutLimiter,
    wrap("orders", async (req, res) => {
      const must = normMustCompanies(req.body && req.body.must_companies);
      if (!must.ok) throw bad(must.message);
      const order = await createAutoApplyOrder({ db, razorpay, getUserPlan, userId: req.user.id, body: req.body, now: now() });
      if (must.value.length) {
        const { error } = await db.from("aa_batches").update({ must_companies: must.value }).eq("id", order.batch_id).eq("user_id", req.user.id);
        if (error) throw error;
      }
      res.json({ ...order, must_companies: must.value });
    }),
  );

  router.post(
    "/orders/coupon",
    checkoutLimiter,
    wrap("orders/coupon", async (req, res) => {
      res.json(await quoteAutoApplyCoupon({ db, userId: req.user.id, body: req.body }));
    }),
  );

  router.post(
    "/orders/verify",
    checkoutLimiter,
    wrap("orders/verify", async (req, res) => {
      const batch = await verifyAutoApplyPayment({ db, razorpay, userId: req.user.id, body: req.body, now: now() });
      res.json({ batch });
    }),
  );

  // Batches
  router.get(
    "/batches",
    wrap("batches", async (req, res) => {
      const { data, error } = await db
        .from("aa_batches")
        .select("*")
        .eq("user_id", req.user.id)
        .neq("status", "pending_payment")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const batches = data || [];
      // a lightweight live line per ongoing batch (same helper as the batch page; no next-run lookup)
      const LIVE = ["paid", "shortlisting", "review", "running", "paused", "waiting_supply", "waiting_profile"];
      const ongoing = batches.filter((b) => LIVE.includes(b.status)).map((b) => b.id);
      if (ongoing.length) {
        try {
          const counts = await statusCountsFor(db, req.user.id, ongoing);
          const engine = await engineState(db).catch(() => "off");
          for (const b of batches) if (counts.has(b.id)) b.live = liveStatus({ batch: b, counts: counts.get(b.id), engine, now: now() });
        } catch (tErr) {
          console.warn("[autoapply/batches] live counts failed:", (tErr && tErr.message) || tErr);
        }
      }
      res.json({ batches });
    }),
  );

  router.get(
    "/batches/:id",
    wrap("batch", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      // ?summary=1 -> counts + live line only (cheap poll); else tasks are paginated (?limit<=1000, default 500, ?offset)
      const summaryOnly = req.query.summary === "1" || req.query.summary === "true";
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 500));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      let rows = [];
      if (!summaryOnly) {
        const { data, error } = await db
          .from("aa_tasks")
          .select(TASK_FIELDS)
          .eq("batch_id", batch.id)
          .eq("user_id", req.user.id)
          .order("score", { ascending: false })
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        rows = data || [];
      }
      // not-applied rows of a finished batch are deleted after 30 days (sql/47); final_counts keeps their numbers.
      // Counts come from a GROUP BY over ALL tasks, not from the (paginated) rows above.
      const histogram = (await statusCountsFor(db, req.user.id, [batch.id])).get(batch.id) || {};
      const counts = batchCounts([], batch.final_counts);
      for (const [st, n] of Object.entries(histogram)) counts[st] = Math.max(Number(n) || 0, counts[st] || 0);
      const taskTotal = Object.values(histogram).reduce((a, n) => a + (Number(n) || 0), 0);
      // the 'received' mail that confirms each applied task, if one arrived (mail db; never fails the page)
      let confirm = new Map();
      const submits = rows.filter((t) => t.status === "applied" && t.submitted_at).map((t) => Date.parse(t.submitted_at)).filter((n) => !Number.isNaN(n));
      if (submits.length) {
        const { data: mails, error: mErr } = await mailDb
          .from("aa_mail_events")
          .select(CONFIRM_MAIL_FIELDS)
          .eq("user_id", req.user.id)
          .eq("category", "received")
          .gte("received_at", new Date(Math.min(...submits) - 10 * 60 * 1000).toISOString())
          .order("received_at", { ascending: true })
          .limit(2000);
        if (mErr) console.warn("[autoapply/batch] confirmation mail lookup failed:", mErr.message || mErr);
        else confirm = matchConfirmationMails(rows, mails || []);
      }
      const tasks = rows.map((t) => {
        const m = confirm.get(t.id);
        return { ...publicTask(t), confirmation_mail: m ? { id: m.id, subject: m.subject || null, from_name: m.from_name || null, received_at: m.received_at } : null };
      });
      // live status line: earliest queued not_before of this batch + the on-demand apply server's state
      const { data: nx } = await db
        .from("aa_tasks")
        .select("not_before")
        .eq("batch_id", batch.id)
        .eq("user_id", req.user.id)
        .eq("status", "queued")
        .order("not_before", { ascending: true })
        .limit(1);
      const live = liveStatus({ batch, counts, nextAt: (nx && nx[0] && nx[0].not_before) || null, engine: await engineState(db), now: now() });
      const { final_counts: _finalCounts, ...batchOut } = batch; // internal retention snapshot, already merged into counts
      res.json({ batch: batchOut, counts, live, tasks, task_total: taskTotal, offset, has_more: !summaryOnly && offset + rows.length < taskTotal });
    }),
  );

  router.post(
    "/batches/:id/approve",
    writeLimiter,
    wrap("batch/approve", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      // Batch first, then its tasks. If queueing fails after the flip, a retry finds the batch already approved
      // ('running' with review_until set) and only re-runs the idempotent queueing step (200, not 409).
      const retry = batch.status === "running" && !!batch.review_until;
      const updated = retry ? batch : await updateBatchIf(batch, ["review"], { status: "running", review_until: now().toISOString() });
      const { error } = await db
        .from("aa_tasks")
        .update({ status: "queued", not_before: now().toISOString() })
        .eq("batch_id", batch.id)
        .eq("status", "shortlisted");
      if (error) throw error;
      res.json({ batch: updated });
    }),
  );

  router.post(
    "/batches/:id/pause",
    writeLimiter,
    wrap("batch/pause", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const updated = await updateBatchIf(batch, ["paid", "shortlisting", "review", "running", "waiting_supply", "waiting_profile"], { status: "paused" });
      if (batch.status === "waiting_profile") await closeProfileItemIfIdle(req.user.id);
      res.json({ batch: updated });
    }),
  );

  router.post(
    "/batches/:id/resume",
    writeLimiter,
    wrap("batch/resume", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const inReview = batch.review_until && new Date(batch.review_until).getTime() > now().getTime();
      // a legacy parked cancel (before Cancel became Pause) is simply dropped: resume any time
      res.json({ batch: await updateBatchIf(batch, ["paused"], { status: inReview ? "review" : "running", cancel_requested_at: null }) });
    }),
  );

  // Cancel. Owner policy: a bought batch is never refunded; we keep going until every application is submitted.
  // So for a paid batch "Cancel" is a Pause (no task touched, resume any time, no refund). Only an unpaid order
  // (pending_payment) is really cancelled. Refunds for payment errors / legal reasons: admins only
  // (POST /admin/batches/:id/refund).
  router.post(
    "/batches/:id/cancel",
    writeLimiter,
    wrap("batch/cancel", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      if (batch.status === "pending_payment") {
        return res.json({ batch: await updateBatchIf(batch, ["pending_payment"], { status: "cancelled" }), paused: false });
      }
      // already stopped (double click / retry, or a closed batch): 200 with the row as it is
      if (["paused", "cancelled", "completed", "expired", "refund_due", "refunding", "refunded"].includes(batch.status)) {
        return res.json({ batch, paused: batch.status === "paused" });
      }
      const pausable = ["paid", "shortlisting", "review", "running", "waiting_supply", "waiting_profile"];
      const updated = await updateBatchIf(batch, pausable, { status: "paused" });
      if (batch.status === "waiting_profile") await closeProfileItemIfIdle(req.user.id);
      res.json({ batch: updated, paused: true });
    }),
  );

  // Admin-only manual refund (payment error / legal). Never user-facing. Cancels what is left of the batch and
  // queues it for the refunds cron with refund_approved_at set (the only non-payment-safety refund it processes).
  router.post(
    "/admin/batches/:id/refund",
    writeLimiter,
    wrap("admin/refund", async (req, res) => {
      if (!isAdminUser(req.user, getEnv)) throw new AAError(403, "forbidden", "Admins only.");
      if (!UUID_RE.test(String(req.params.id))) throw notFound("Batch not found.");
      const reason = typeof (req.body && req.body.reason) === "string" ? req.body.reason.replace(/\s+/g, " ").trim() : "";
      if (reason.length < 5 || reason.length > 300) throw bad("reason (5-300 characters) is required: why is this refunded?");
      if (!(req.body && req.body.confirm === true)) throw bad("Send confirm: true to queue the refund.");
      const { data: batch, error } = await db.from("aa_batches").select("*").eq("id", req.params.id).maybeSingle();
      if (error) throw error;
      if (!batch) throw notFound("Batch not found.");
      if (["refund_due", "refunding", "refunded"].includes(batch.status)) return res.json({ batch, already: true });
      if (!batch.purchased_at) throw new AAError(409, "invalid_state", "This batch was never paid; there is nothing to refund.");
      const { error: tErr } = await db
        .from("aa_tasks")
        .update({ status: "cancelled", reason_code: "batch_refunded" })
        .eq("batch_id", batch.id)
        .in("status", ["shortlisted", "queued", "failed"]);
      if (tErr) throw tErr;
      // needs_you tasks too, except 'verify_submission' (it may already be submitted: the credit count must stay honest)
      const { data: ny, error: nyErr } = await db.from("aa_tasks").select("id, reason_code").eq("batch_id", batch.id).eq("status", "needs_you");
      if (nyErr) throw nyErr;
      const nyIds = (ny || []).filter((t) => t.reason_code !== "verify_submission").map((t) => t.id);
      if (nyIds.length) {
        const { error: e2 } = await db.from("aa_tasks").update({ status: "cancelled", reason_code: "batch_refunded" }).in("id", nyIds).eq("status", "needs_you");
        if (e2) throw e2;
        const { error: e3 } = await db.from("aa_needs_you").update({ resolved_at: now().toISOString(), resolution: "expired" }).in("task_id", nyIds).is("resolved_at", null);
        if (e3) throw e3;
      }
      const { data: won, error: uErr } = await db
        .from("aa_batches")
        .update({ status: "refund_due", refund_approved_at: now().toISOString(), refund_approved_by: req.user.id, refund_reason: `admin: ${reason}`, cancel_requested_at: null })
        .eq("id", batch.id)
        .eq("status", batch.status)
        .select("*");
      if (uErr) throw uErr;
      if (!won || !won[0]) throw new AAError(409, "invalid_state", "Batch changed meanwhile; reload and retry.");
      console.warn(`[autoapply] admin ${req.user.id} queued a refund for batch ${batch.id}: ${reason}`);
      res.json({ batch: won[0] });
    }),
  );

  // Proof of application: a 5-minute signed URL for the screenshot the worker saved after submitting
  // ('aa-proof/<user_id>/<task_id>.png', private bucket, service-role storage client).
  router.get(
    "/batches/:id/tasks/:taskId/proof",
    wrap("task/proof", async (req, res) => {
      const uid = req.user.id;
      const batch = await ownBatch(uid, req.params.id);
      if (!UUID_RE.test(String(req.params.taskId))) throw notFound("Task not found.");
      const { data: task, error } = await db
        .from("aa_tasks")
        .select("id, user_id, batch_id, proof_path")
        .eq("id", req.params.taskId)
        .eq("batch_id", batch.id)
        .eq("user_id", uid)
        .maybeSingle();
      if (error) throw error;
      if (!task) throw notFound("Task not found.");
      const path = String(task.proof_path || "");
      // belt and braces: the object must sit under the owner's folder
      if (!path || !path.startsWith(`${uid}/`) || path.includes("..")) throw notFound("No proof saved for this application.");
      const { data: signed, error: sErr } = await db.storage.from(PROOF_BUCKET).createSignedUrl(path, PROOF_URL_TTL_S);
      if (sErr || !signed || !signed.signedUrl) {
        if (sErr) console.warn("[autoapply/proof] sign failed:", sErr.message || sErr);
        throw notFound("No proof saved for this application.");
      }
      res.set("Cache-Control", "no-store");
      res.json({ url: signed.signedUrl, expires_in: PROOF_URL_TTL_S });
    }),
  );

  // Must-apply companies of a batch (<= 10); the scheduler shortlists their matching jobs first.
  router.put(
    "/batches/:id/must-companies",
    writeLimiter,
    wrap("batch/must-companies", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const must = normMustCompanies(req.body && req.body.must_companies);
      if (!must.ok) throw bad(must.message);
      const updated = await updateBatchIf(batch, EDITABLE_BATCH, { must_companies: must.value });
      res.json({ batch: updated });
    }),
  );

  // Company names for the must-apply autocomplete (open jobs only).
  router.get(
    "/companies/suggest",
    wrap("companies/suggest", async (req, res) => {
      const term = companyTerm(req.query.q).slice(0, 80);
      if (term.length < 2) return res.json({ companies: [] });
      let qb = db.from("aa_jobs").select("company").is("closed_at", null).ilike("company", `%${term}%`);
      const kind = req.query.kind ? String(req.query.kind) : "";
      if (kind) {
        if (!["service", "product"].includes(kind)) throw bad("kind must be 'service' or 'product'.");
        qb = qb.eq("company_kind", kind);
      }
      // trigram index idx_aa_jobs_company_trgm (sql/27) serves the ILIKE; 200 rows are plenty for 10 names
      const { data, error } = await qb.limit(200);
      if (error) throw error;
      const seen = new Map();
      const want = term.toLowerCase();
      for (const r of data || []) {
        const c = r.company && String(r.company).trim();
        if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
      }
      const companies = [...seen.values()]
        .sort((a, b) => Number(!a.toLowerCase().startsWith(want)) - Number(!b.toLowerCase().startsWith(want)) || a.localeCompare(b))
        .slice(0, 10);
      res.json({ companies });
    }),
  );

  router.post(
    "/batches/:id/tasks/:taskId/remove",
    writeLimiter,
    wrap("task/remove", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      if (batch.status !== "review") throw new AAError(409, "invalid_state", "Jobs can only be removed while the batch is in review.");
      if (!UUID_RE.test(String(req.params.taskId))) throw notFound("Task not found.");
      const { data, error } = await db
        .from("aa_tasks")
        .update({ status: "removed", reason_code: "removed_by_user" })
        .eq("id", req.params.taskId)
        .eq("batch_id", batch.id)
        .eq("user_id", req.user.id)
        .eq("status", "shortlisted")
        .select(TASK_FIELDS);
      if (error) throw error;
      if (!data || !data[0]) {
        const { data: t } = await db.from("aa_tasks").select(TASK_FIELDS).eq("id", req.params.taskId).eq("batch_id", batch.id).maybeSingle();
        if (!t) throw notFound("Task not found.");
        if (t.status === "removed") return res.json({ task: publicTask(t) });
        throw new AAError(409, "invalid_state", `Task is '${t.status}'; only shortlisted jobs can be removed.`);
      }
      res.json({ task: publicTask(data[0]) });
    }),
  );

  // Needs-you
  // Items accumulate silently while their batch works; only "ready" ones are listed (the batch's other work is
  // done or blocked only on needs-you, the batch is not working, or the item is 3+ days old). ?all=1 lists all.
  router.get(
    "/needs-you",
    wrap("needs-you", async (req, res) => {
      const all = req.query.all === "1";
      const { items: ready, tasks: byId, accumulating } = await readyItems({ db, userId: req.user.id, now: now(), all });
      const items = [...ready].reverse().slice(0, 200); // newest first, as before
      // unique_count: what the user actually has to answer (the same question asked by 5 jobs counts once), for banners
      const uf = buildForm(ready, byId, {});
      res.json({
        accumulating,
        unique_count: uf.fields.length + uf.sites.length + uf.unconfirmed.length + (uf.profile ? 1 : 0),
        unique_questions: uf.fields.length,
        items: items.map((i) => {
          const t = (i.task_id && byId.get(i.task_id)) || null;
          return {
            id: i.id,
            kind: i.kind,
            payload: i.payload || {},
            task_id: i.task_id || null,
            batch_id: i.batch_id || (i.payload && i.payload.batch_id) || null,
            task:
              t || i.task_id
                ? { company: (t && t.company) || null, title: (t && t.title) || null, apply_url: (t && t.apply_url) || (i.payload && i.payload.apply_url) || null }
                : null,
            created_at: i.created_at,
          };
        }),
      });
    }),
  );

  // Consolidated needs-you: ONE form with everything missing across the ready items (lib/autoapply/needsYouForm.js).
  //   GET  /needs-you/form -> { fields[], sites[], unconfirmed[], profile, item_count, accumulating }
  //   POST /needs-you/form   { answers: {fieldId: value}, sites: {siteId: 'done'}, manual: {itemId: 'applied'|'skip'},
  //                            unconfirmed: {itemId: 'yes'|'no'} } -> { result, ...the form rebuilt }
  const loadNeedsYouForm = async (uid) => {
    const { items, tasks, accumulating } = await readyItems({ db, userId: uid, now: now() });
    const answers = await getAnswers(uid);
    return { items, accumulating, form: buildForm(items, tasks, answers || {}) };
  };
  const formBody = ({ items, accumulating, form }) => ({ ...publicForm(form), item_count: items.filter((i) => i.kind !== "profile").length, accumulating });

  router.get(
    "/needs-you/form",
    wrap("needs-you/form", async (req, res) => {
      res.set("Cache-Control", "no-store");
      res.json(formBody(await loadNeedsYouForm(req.user.id)));
    }),
  );

  router.post(
    "/needs-you/form",
    writeLimiter,
    wrap("needs-you/form/save", async (req, res) => {
      const uid = req.user.id;
      if (!jsonSizeOk(req.body)) throw new AAError(413, "too_large", "That form is too large.");
      const cur = await loadNeedsYouForm(uid);
      let parsed;
      try {
        parsed = parseSubmission(cur.form, req.body);
      } catch (e) {
        if (e && e.status === 400) throw bad(e.message);
        throw e;
      }
      const result = await applySubmission({ db, userId: uid, form: cur.form, parsed, items: cur.items, now: now() });
      res.json({ result, ...formBody(await loadNeedsYouForm(uid)) });
    }),
  );

  router.post(
    "/needs-you/:id",
    writeLimiter,
    wrap("needs-you/resolve", async (req, res) => {
      const uid = req.user.id;
      const id = req.params.id;
      if (!UUID_RE.test(String(id))) throw notFound("Item not found.");
      const { action, answer } = req.body || {};
      const VERIFY_ACTIONS = ["confirm_submitted", "not_submitted"];
      if (!["done", "answer", "dismiss", ...VERIFY_ACTIONS].includes(action)) {
        throw bad("action must be 'done', 'answer', 'dismiss', 'confirm_submitted' or 'not_submitted'.");
      }
      const { data: item, error } = await db.from("aa_needs_you").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
      if (error) throw error;
      if (!item) throw notFound("Item not found.");
      const resolution = { done: "done_by_user", answer: "answered", dismiss: "dismissed", confirm_submitted: "done_by_user", not_submitted: "dismissed" }[action];
      const verify = isVerifyItem(item);
      if (item.resolved_at) {
        // a retry of the same action (e.g. the response was lost) is a success, not a conflict
        if (item.resolution === resolution) return res.json({ item });
        throw new AAError(409, "already_resolved", "This item is already resolved.");
      }
      if (item.kind === "profile" && action !== "dismiss") {
        throw new AAError(409, "invalid_action", "Complete your profile; this item closes on its own once it is complete.");
      }
      // "did this application go through?" items (worker lease expired while submitting, sql/27b)
      if (VERIFY_ACTIONS.includes(action) && !(verify && item.task_id)) {
        throw new AAError(409, "invalid_action", "Only 'check this application' items take confirm_submitted / not_submitted.");
      }
      if (verify && (action === "done" || action === "answer")) {
        throw new AAError(409, "invalid_action", "Tell us whether the application went through: confirm_submitted or not_submitted.");
      }

      let key = null;
      let value = null;
      if (action === "answer") {
        const payload = item.payload || {};
        const given = [req.body.key, payload.question_key, payload.key].find((k) => typeof k === "string" && isValidKey(k));
        const label = payload.question || payload.label;
        key = given || (label ? learnedKey(label) : null);
        if (!key) throw bad("This item has no question to answer.");
        const v = validateAnswer(key, answer);
        if (!v.ok) throw bad(v.message);
        if (v.value === null) throw bad("answer is required.");
        value = v.value;
      }

      // Side effects first (each idempotent), the item's resolved flag LAST: if anything fails midway the item is
      // still open and the same request can simply be retried.
      if (action === "answer") {
        const { error: aErr } = await db
          .from("aa_answers")
          .upsert({ user_id: uid, question_key: key, answer: value, source: "user", updated_at: now().toISOString() }, { onConflict: "user_id,question_key" });
        if (aErr) throw aErr;
      }
      if (action === "confirm_submitted") {
        const r = await confirmSubmitted({ db, taskId: item.task_id, userId: uid, now: now() });
        if (!r.ok && r.error === "not_found") throw notFound("Task not found.");
        if (!r.ok) throw new AAError(409, "invalid_state", `Task is '${r.status}'; it can no longer be confirmed.`);
      } else if (action === "not_submitted") {
        const r = await notSubmitted({ db, taskId: item.task_id, userId: uid, now: now() });
        if (!r.ok) throw notFound("Task not found.");
      } else if (item.task_id) {
        const taskPatch =
          action === "answer"
            ? { status: "queued", not_before: now().toISOString(), reason_code: null, reason_detail: null }
            : { status: "skipped", reason_code: action === "done" ? "done_by_user" : "dismissed" };
        const { error: tErr } = await db
          .from("aa_tasks")
          .update(taskPatch)
          .eq("id", item.task_id)
          .eq("user_id", uid)
          .eq("status", "needs_you");
        if (tErr) throw tErr;
      }

      const { data: claimed, error: cErr } = await db
        .from("aa_needs_you")
        .update({ resolved_at: now().toISOString(), resolution })
        .eq("id", id)
        .eq("user_id", uid)
        .is("resolved_at", null)
        .select("*");
      if (cErr) throw cErr;
      let out = claimed && claimed[0];
      if (!out) {
        // resolved concurrently: same action -> success, else conflict
        const { data: again, error: rErr } = await db.from("aa_needs_you").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
        if (rErr) throw rErr;
        if (!again || again.resolution !== resolution) throw new AAError(409, "already_resolved", "This item is already resolved.");
        out = again;
      }
      out = { ...out };
      if (key) out.answer_key = key;
      let task = null;
      if (item.task_id) {
        const { data: t, error: tErr } = await db.from("aa_tasks").select(TASK_FIELDS).eq("id", item.task_id).eq("user_id", uid).maybeSingle();
        if (tErr) throw tErr;
        task = t ? publicTask(t) : null;
      }
      res.json({ item: out, task });
    }),
  );

  // Inbox (mail db). ?tab=important|all|codes &category= &kind= &company= &unread=1 &q= &before=<received_at ISO> &limit=
  router.get(
    "/inbox",
    wrap("inbox", async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
      const tab = String(req.query.tab || "all");
      if (!["important", "all", "codes"].includes(tab)) throw bad("tab must be important, all or codes.");
      let qb = mailDb.from("aa_mail_events").select(INBOX_LIST_FIELDS).eq("user_id", req.user.id);
      if (INBOX_TABS[tab]) qb = qb.eq("category", INBOX_TABS[tab]);
      if (req.query.category) {
        const c = String(req.query.category);
        if (!INBOX_CATEGORIES.includes(c)) throw bad(`category must be one of ${INBOX_CATEGORIES.join(", ")}.`);
        qb = qb.eq("category", c);
      }
      if (req.query.kind) {
        const k = String(req.query.kind);
        if (!INBOX_KINDS.includes(k)) throw bad(`kind must be one of ${INBOX_KINDS.join(", ")}.`);
        qb = qb.eq("kind", k);
      }
      const company = companyTerm(req.query.company);
      if (company) qb = qb.ilike("company", `%${company}%`);
      if (req.query.unread === "1" || req.query.unread === "true") qb = qb.is("read_at", null);
      const term = searchTerm(req.query.q);
      if (term) qb = qb.or(`subject.ilike.%${term}%,sender.ilike.%${term}%,from_name.ilike.%${term}%,company.ilike.%${term}%,text_excerpt.ilike.%${term}%`);
      if (req.query.before !== undefined && req.query.before !== "") {
        if (Number.isNaN(Date.parse(String(req.query.before)))) throw bad("before must be an ISO timestamp.");
        qb = qb.lt("received_at", new Date(String(req.query.before)).toISOString());
      }
      const { data, error } = await qb.order("received_at", { ascending: false }).limit(limit + 1);
      if (error) throw error;
      const rows = data || [];
      const mails = rows.slice(0, limit);
      res.json({ mails, next_before: rows.length > limit ? mails[mails.length - 1].received_at : null });
    }),
  );

  // Unread interview / assessment / offer / rejection / other important mail: the nav badge.
  router.get(
    "/inbox/unread",
    wrap("inbox/unread", async (req, res) => {
      const unread = () =>
        mailDb.from("aa_mail_events").select("id", { count: "exact", head: true }).eq("user_id", req.user.id).in("category", NOTIFY_CATEGORIES).is("read_at", null);
      const { count, error } = await unread();
      if (error) throw error;
      const by_kind = {};
      if (count) {
        // breakdown from the newest 200 unread only (the badge shows the total; the split is a hint)
        const { data, error: kErr } = await mailDb
          .from("aa_mail_events")
          .select("kind, category")
          .eq("user_id", req.user.id)
          .in("category", NOTIFY_CATEGORIES)
          .is("read_at", null)
          .order("received_at", { ascending: false })
          .limit(200);
        if (kErr) throw kErr;
        for (const r of data || []) {
          const k = r.kind || (r.category === "rejected" ? "rejection" : "other");
          by_kind[k] = (by_kind[k] || 0) + 1;
        }
      }
      res.json({ count: count || 0, by_kind });
    }),
  );

  router.post(
    "/inbox/read-all",
    writeLimiter,
    wrap("inbox/read-all", async (req, res) => {
      const { data, error } = await mailDb
        .from("aa_mail_events")
        .update({ read_at: now().toISOString() })
        .eq("user_id", req.user.id)
        .is("read_at", null)
        .select("id");
      if (error) throw error;
      res.json({ ok: true, count: (data || []).length });
    }),
  );

  // Distinct companies in the user's mail, for the company filter (most recent first).
  router.get(
    "/inbox/companies",
    wrap("inbox/companies", async (req, res) => {
      const { data, error } = await mailDb
        .from("aa_mail_events")
        .select("company, received_at")
        .eq("user_id", req.user.id)
        .order("received_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      const seen = new Map();
      for (const r of data || []) {
        const c = r.company && String(r.company).trim();
        if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
      }
      res.json({ companies: [...seen.values()].slice(0, 300) });
    }),
  );

  // Opening a mail marks it read.
  router.get(
    "/inbox/:id",
    wrap("inbox/detail", async (req, res) => {
      if (!/^\d{1,18}$/.test(String(req.params.id))) throw notFound("Message not found.");
      const { data, error } = await mailDb
        .from("aa_mail_events")
        .select(INBOX_DETAIL_FIELDS)
        .eq("id", Number(req.params.id))
        .eq("user_id", req.user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw notFound("Message not found.");
      if (!data.read_at) {
        const readAt = now().toISOString();
        const { error: rErr } = await mailDb.from("aa_mail_events").update({ read_at: readAt }).eq("id", data.id).eq("user_id", req.user.id).is("read_at", null);
        if (rErr) console.warn("[autoapply/inbox] mark read failed:", rErr.message || rErr);
        else data.read_at = readAt;
      }
      let interview = null;
      if (data.kind === "interview") {
        const { data: iv, error: iErr } = await mailDb.from("aa_interviews").select(INTERVIEW_FIELDS).eq("mail_event_id", data.id).eq("user_id", req.user.id).maybeSingle();
        if (iErr) console.warn("[autoapply/inbox] interview lookup failed:", iErr.message || iErr);
        else interview = iv || null;
      }
      res.json({ mail: data, interview });
    }),
  );

  // Interviews extracted from mail (mail db). Newest first; the client splits upcoming / past / time not set.
  router.get(
    "/interviews",
    wrap("interviews", async (req, res) => {
      const { data, error } = await mailDb
        .from("aa_interviews")
        .select(INTERVIEW_FIELDS)
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      const rows = data || [];
      const ids = [...new Set(rows.map((r) => r.mail_event_id))];
      const mails = new Map();
      if (ids.length) {
        const { data: ms, error: mErr } = await mailDb
          .from("aa_mail_events")
          .select("id, subject, sender, from_name, received_at, read_at")
          .eq("user_id", req.user.id)
          .in("id", ids);
        if (mErr) throw mErr;
        for (const m of ms || []) mails.set(m.id, m);
      }
      res.json({ interviews: rows.map((r) => ({ ...r, mail: mails.get(r.mail_event_id) || null })), now: now().toISOString() });
    }),
  );

  // Web push subscriptions (main db). Disabled (key: null) when VAPID env is unset.
  router.get("/push/key", (_req, res) => {
    const cfg = vapidConfig(getEnv);
    res.json({ enabled: !!cfg, key: cfg ? cfg.publicKey : null });
  });

  router.post(
    "/push/subscribe",
    writeLimiter,
    wrap("push/subscribe", async (req, res) => {
      const b = req.body || {};
      const endpoint = b.endpoint;
      const keys = b.keys || {};
      const p256dh = keys.p256dh || b.p256dh;
      const auth = keys.auth || b.auth;
      if (!isAllowedPushEndpoint(endpoint)) throw bad("endpoint must be an https URL of a browser push service.");
      if (typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
        throw bad("keys.p256dh and keys.auth are required.");
      }
      const owned = () => new AAError(409, "endpoint_owned", "This device is subscribed for another account; unsubscribe there first.");
      const { data: have, error: hErr } = await db.from("aa_push_subscriptions").select("id, user_id").eq("endpoint", endpoint).maybeSingle();
      if (hErr) throw hErr;
      if (have && have.user_id !== req.user.id) throw owned();
      let row;
      if (have) {
        // own device: refresh the keys (only where the row is still ours)
        const { data, error } = await db
          .from("aa_push_subscriptions")
          .update({ p256dh, auth })
          .eq("endpoint", endpoint)
          .eq("user_id", req.user.id)
          .select("id, endpoint, created_at");
        if (error) throw error;
        if (!data || !data[0]) throw owned();
        row = data[0];
      } else {
        const { count, error: cErr } = await db.from("aa_push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", req.user.id);
        if (cErr) throw cErr;
        if ((count || 0) >= 20) throw new AAError(409, "too_many_subscriptions", "Too many devices subscribed; turn off notifications on one first.");
        // plain insert: a concurrent insert of the same endpoint by another user fails on the unique index
        const { data, error } = await db
          .from("aa_push_subscriptions")
          .insert({ user_id: req.user.id, endpoint, p256dh, auth })
          .select("id, endpoint, created_at");
        if (error) {
          if (error.code === "23505" || /duplicate key/i.test(String(error.message || ""))) throw owned();
          throw error;
        }
        row = data && data[0];
      }
      res.json({ ok: true, subscription: row || { endpoint } });
    }),
  );

  router.post(
    "/push/unsubscribe",
    writeLimiter,
    wrap("push/unsubscribe", async (req, res) => {
      const endpoint = req.body && req.body.endpoint;
      if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2000) throw bad("endpoint is required.");
      const { error } = await db.from("aa_push_subscriptions").delete().eq("user_id", req.user.id).eq("endpoint", endpoint);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // Reply rates over the last 90 days, in total and per role family (tasks: main db; mail + interviews: mail db).
  router.get(
    "/stats/replies",
    wrap("stats/replies", async (req, res) => {
      const uid = req.user.id;
      const at = now();
      const hit = statsCache.get(uid, at.getTime());
      if (hit) return res.json(hit);
      const since = new Date(at.getTime() - STATS_WINDOW_DAYS * 86400000).toISOString();
      // bounded: newest STATS_MAX_ROWS of each (a 90-day window rarely holds more), cached 5 min per user
      const [t, m, iv] = await Promise.all([
        db.from("aa_tasks").select("id, company, title, status, submitted_at").eq("user_id", uid).eq("status", "applied").gte("submitted_at", since).order("submitted_at", { ascending: false }).limit(STATS_MAX_ROWS),
        mailDb.from("aa_mail_events").select("id, company, category, kind, received_at").eq("user_id", uid).in("category", ["rejected", "important", "other"]).gte("received_at", since).order("received_at", { ascending: false }).limit(STATS_MAX_ROWS),
        mailDb.from("aa_interviews").select("mail_event_id, company").eq("user_id", uid).gte("created_at", since).order("created_at", { ascending: false }).limit(STATS_MAX_ROWS),
      ]);
      for (const r of [t, m, iv]) if (r.error) throw r.error;
      const out = replyStats({ tasks: t.data || [], mails: m.data || [], interviews: iv.data || [], now: at });
      statsCache.set(uid, out, at.getTime());
      res.json(out);
    }),
  );

  // Admin only (AA_ADMIN_EMAILS / AA_ADMIN_USER_IDS): heartbeats of discovery / scheduler / workers (aa_health).
  router.get(
    "/admin/health",
    wrap("admin/health", async (req, res) => {
      if (!isAdminUser(req.user, getEnv)) throw new AAError(403, "forbidden", "Admins only.");
      const { data, error } = await db.from("aa_health").select("component, last_seen, status, stats, updated_at").order("component", { ascending: true }).limit(500);
      if (error) throw error;
      res.set("Cache-Control", "no-store");
      res.json(healthSummary(data || [], now()));
    }),
  );

  // Accounts
  router.get(
    "/accounts",
    wrap("accounts", async (req, res) => {
      const { data, error } = await db
        .from("aa_portal_accounts")
        .select("tenant_host, login_email, status, created_at, last_used_at")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      res.json({ accounts: data || [] });
    }),
  );

  router.post(
    "/accounts/reveal",
    revealLimiter,
    wrap("accounts/reveal", async (req, res) => {
      // recent sign-in required: the newest amr authentication must be at most 10 minutes old (the client signs
      // in again right before revealing; a plain session refresh does not count)
      const age = authAgeS(req.authToken, now().getTime());
      if (age === null || age > reauthMaxAgeS || age < -300) {
        throw new AAError(401, "reauth_required", "Confirm it's you: sign in again to reveal saved passwords.");
      }
      const host = req.body && req.body.tenant_host;
      if (typeof host !== "string" || !host.trim() || host.length > 255) throw bad("tenant_host is required.");
      const { data: acct, error } = await db
        .from("aa_portal_accounts")
        .select("tenant_host, secret_ciphertext")
        .eq("user_id", req.user.id)
        .eq("tenant_host", host.trim())
        .maybeSingle();
      if (error) throw error;
      if (!acct) throw notFound("No saved account for that site.");
      let password;
      try {
        password = decryptSecret(acct.secret_ciphertext, req.user.id, acct.tenant_host, vaultKey ? { key: vaultKey } : {});
      } catch (e) {
        if (e.code === "vault_unconfigured") throw new AAError(503, "vault_unconfigured", "Password vault is not configured.");
        throw new AAError(500, "decrypt_failed", "Could not decrypt this password.");
      }
      console.log(`[autoapply/reveal] user=${req.user.id} host=${acct.tenant_host} at=${now().toISOString()}`);
      res.set("Cache-Control", "no-store");
      res.json({ password });
    }),
  );

  // Unknown /api/autoapply/* path -> contract-shaped 404 (never the SPA HTML).
  router.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Unknown AutoApply endpoint." } }));
  return router;
}

// ── inbound mail ────────────────────────────────────────────────────────────
export function createInboundHandler(deps = {}) {
  const db = deps.db || supabaseAdmin;
  const mailDb = deps.mailDb || (deps.db ? deps.db : realMailDb);
  const getSecret = deps.getSecret || (() => process.env.AA_INBOUND_SECRET);
  const nowS = deps.nowS || (() => Math.floor(Date.now() / 1000));
  const sendPush = deps.sendPush || sendPushForMail;

  return async function inboundEmail(req, res) {
    const raw = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
    const v = verifyInbound({
      secret: getSecret(),
      timestamp: req.get("X-AA-Timestamp"),
      signature: req.get("X-AA-Signature"),
      rawBody: raw || Buffer.alloc(0),
      nowS: nowS(),
    });
    if (!v.ok) {
      const status = v.code === "inbound_unconfigured" ? 503 : 401;
      return res.status(status).json({ error: { code: v.code, message: "Inbound request rejected." } });
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return res.status(400).json({ error: { code: "invalid_json", message: "Body must be JSON." } });
    }
    try {
      const { event, profile, category, duplicate } = await storeInbound({ db, mailDb, payload });
      // A retried delivery of a mail already stored: 200 so the worker stops retrying, and no second push.
      if (duplicate) return res.status(200).json({ ok: true, duplicate: true });
      res.status(200).json({ ok: true });
      // After the response: push an alert for interview / assessment / offer / rejection / important mail.
      // Mail is never forwarded anywhere.
      if (NOTIFY_CATEGORIES.includes(category) && profile) {
        const p = sendPush({ db, event, userId: profile.user_id, prefs: normAlertPrefs(profile.alert_prefs) });
        if (deps.onAfter) deps.onAfter(p);
      }
    } catch (err) {
      if (!res.headersSent) sendError(res, err, "inbound");
    }
  };
}

export function runAutoApplyRefunds(deps = {}) {
  return processRefunds({ db: deps.db || supabaseAdmin, razorpay: deps.razorpay || realRazorpay, limit: deps.limit });
}

/** Every 15 min: needs-you hygiene for final batches, then at most ONE "a few details needed" push per batch. */
export async function runNeedsYouJobs(deps = {}) {
  const db = deps.db || supabaseAdmin;
  const now = deps.now || new Date();
  const out = {};
  try {
    out.expired = await expireFinalBatchNeedsYou({ db, now });
  } catch (e) {
    console.error("[autoapply/needs-you] hygiene:", (e && e.message) || String(e));
  }
  try {
    const send = deps.send || ((a) => sendPushToUser({ ...a, env: deps.env, webpush: deps.webpush }));
    out.notified = await notifyReadyNeedsYou({ db, send, now });
  } catch (e) {
    console.error("[autoapply/needs-you] notify:", (e && e.message) || String(e));
  }
  return out;
}

/** Hourly: pending_payment orders older than 24 h -> 'cancelled' (lib/autoapply/orders.js expirePendingOrders). */
export function runExpirePendingOrders(deps = {}) {
  return expirePendingOrders({ db: deps.db || supabaseAdmin, now: deps.now });
}

/** Daily: delete expired mail from the mail db. */
export function runMailCleanup(deps = {}) {
  return cleanupExpiredMail({ mailDb: deps.mailDb || realMailDb, now: deps.now });
}

/** Every 5 min: push reminders 24 h and 1 h before each interview (idempotent, see lib/autoapply/reminders.js). */
export function runInterviewReminders(deps = {}) {
  return sendInterviewReminders({ db: deps.db || supabaseAdmin, mailDb: deps.mailDb || realMailDb, now: deps.now, send: deps.send, env: deps.env, webpush: deps.webpush });
}

/** Daily ~7 PM IST: one short alert email per user with new important mail. */
export function runDailyMailAlerts(deps = {}) {
  const db = deps.db || supabaseAdmin;
  return sendDailyAlerts({
    db,
    mailDb: deps.mailDb || realMailDb,
    resend: deps.resend || realResend,
    getAuthEmail:
      deps.getAuthEmail ||
      (async (uid) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(uid);
        return (data && data.user && data.user.email) || null;
      }),
    baseUrl: deps.baseUrl,
    now: deps.now,
    maxSends: deps.maxSends,
  });
}
