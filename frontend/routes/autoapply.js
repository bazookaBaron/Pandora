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

import { publicQuestions, validateAnswer, isValidKey, learnedKey, LEARNED_KEY_RE } from "../lib/autoapply/questions.js";
import { decryptSecret } from "../lib/autoapply/vault.js";
import { isEligiblePlan, usageFor } from "../lib/autoapply/limits.js";
import { AAError, createAutoApplyOrder, verifyAutoApplyPayment, handleAutoApplyWebhook } from "../lib/autoapply/orders.js";
import { verifyInbound, storeInbound } from "../lib/autoapply/inbound.js";
import { mailDb as realMailDb } from "../lib/autoapply/mailDb.js";
import { sendPushForMail, vapidConfig } from "../lib/autoapply/push.js";
import { cleanupExpiredMail, sendDailyAlerts } from "../lib/autoapply/mailJobs.js";
import { NOTIFY_CATEGORIES } from "../lib/autoapply/classify.js";
import { processRefunds } from "../lib/autoapply/refunds.js";
import { profileCheck } from "../lib/autoapply/profileGate.js";
import { extractText, draftFromText, maybeEnrichWithAi } from "../lib/autoapply/resumeParse.js";

export { AAError, handleAutoApplyWebhook };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const TASK_FIELDS = "id, company, title, ats, status, reason_code, score, submitted_at, apply_url";
const MAX_JSON_BYTES = 100 * 1024;
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const mailDomain = () => process.env.AA_MAIL_DOMAIN || "apply.vloombox.in";

function sendError(res, err, where) {
  if (err instanceof AAError || (err && Number.isInteger(err.status) && typeof err.code === "string" && /^[a-z_]+$/.test(err.code))) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
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
function normPrefs(prefs) {
  if (!isPlainObject(prefs)) throw bad("prefs must be an object.");
  const out = { ...prefs };
  for (const k of ["titles", "locations", "blocked_companies"]) {
    if (out[k] === undefined) continue;
    if (!Array.isArray(out[k])) throw bad(`prefs.${k} must be an array of strings.`);
    out[k] = [...new Set(out[k].filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  }
  if (out.min_score !== undefined && !Number.isFinite(Number(out.min_score))) throw bad("prefs.min_score must be a number.");
  return out;
}

// ── supply matching ─────────────────────────────────────────────────────────
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
  if (locations.length) {
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
        patch.profile = b.profile;
      }
      if (b.prefs !== undefined) {
        const p = normPrefs(b.prefs);
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

      const { error } = await db.from("aa_profiles").upsert({ user_id: uid, resume_path: resumePath }, { onConflict: "user_id" });
      if (error) throw error;
      res.json({ resume_path: resumePath, parsed });
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
      for (const k of keys) {
        const v = validateAnswer(k, answers[k]);
        if (!v.ok) throw bad(v.message);
        if (v.value === null) deletes.push(k);
        else upserts.push({ user_id: uid, question_key: k, answer: v.value, source: "user", updated_at: now().toISOString() });
      }
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

  // GET /supply
  router.get(
    "/supply",
    wrap("supply", async (req, res) => {
      const kind = String(req.query.kind || "");
      if (!["service", "product"].includes(kind)) throw bad("kind must be 'service' or 'product'.");
      const wd = req.query.window_days === undefined ? AUTO_APPLY.window_days_default : Number(req.query.window_days);
      if (!Number.isInteger(wd) || wd < 1 || wd > AUTO_APPLY.window_days_max) throw bad(`window_days must be 1..${AUTO_APPLY.window_days_max}.`);
      const prof = await getProfile(req.user.id);
      const prefs = (prof && prof.prefs) || {};
      const since = new Date(now().getTime() - wd * 86400000).toISOString();
      const { data, error } = await db
        .from("aa_jobs")
        .select("company, title, location, posted_at, ats")
        .is("closed_at", null)
        .eq("company_kind", kind)
        .gte("posted_at", since)
        .order("posted_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      const jobs = (data || []).filter((j) => matchesPrefs(j, prefs));
      const by_ats = {};
      for (const j of jobs) by_ats[j.ats] = (by_ats[j.ats] || 0) + 1;
      res.json({
        kind,
        window_days: wd,
        count: jobs.length,
        by_ats,
        sample: jobs.slice(0, 10).map(({ company, title, location, posted_at }) => ({ company, title, location, posted_at })),
      });
    }),
  );

  // POST /orders, /orders/verify
  router.post(
    "/orders",
    checkoutLimiter,
    wrap("orders", async (req, res) => {
      res.json(await createAutoApplyOrder({ db, razorpay, getUserPlan, userId: req.user.id, body: req.body, now: now() }));
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
      res.json({ batches: data || [] });
    }),
  );

  router.get(
    "/batches/:id",
    wrap("batch", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const { data, error } = await db
        .from("aa_tasks")
        .select(TASK_FIELDS)
        .eq("batch_id", batch.id)
        .eq("user_id", req.user.id)
        .order("score", { ascending: false })
        .limit(2000);
      if (error) throw error;
      const counts = {};
      for (const t of data || []) counts[t.status] = (counts[t.status] || 0) + 1;
      res.json({ batch, counts, tasks: data || [] });
    }),
  );

  router.post(
    "/batches/:id/approve",
    writeLimiter,
    wrap("batch/approve", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const updated = await updateBatchIf(batch, ["review"], { status: "running", review_until: now().toISOString() });
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
      res.json({ batch: await updateBatchIf(batch, ["paused"], { status: inReview ? "review" : "running" }) });
    }),
  );

  router.post(
    "/batches/:id/cancel",
    writeLimiter,
    wrap("batch/cancel", async (req, res) => {
      const batch = await ownBatch(req.user.id, req.params.id);
      const allowed = ["pending_payment", "paid", "shortlisting", "review", "running", "paused", "waiting_supply", "waiting_profile"];
      let next;
      if (batch.status === "pending_payment") next = "cancelled";
      else next = Number(batch.credits_used) < Number(batch.credits_total) ? "refund_due" : "completed";
      const updated = await updateBatchIf(batch, allowed, { status: next });
      if (batch.status !== "pending_payment") {
        const { data: gone, error } = await db
          .from("aa_tasks")
          .update({ status: "cancelled", reason_code: "batch_cancelled" })
          .eq("batch_id", batch.id)
          .in("status", ["shortlisted", "queued", "failed", "needs_you"])
          .select("id");
        if (error) throw error;
        const ids = (gone || []).map((t) => t.id);
        if (ids.length) {
          const { error: nErr } = await db
            .from("aa_needs_you")
            .update({ resolved_at: now().toISOString(), resolution: "expired" })
            .in("task_id", ids)
            .is("resolved_at", null);
          if (nErr) throw nErr;
        }
      }
      if (batch.status === "waiting_profile") await closeProfileItemIfIdle(req.user.id);
      res.json({ batch: updated });
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
        if (t.status === "removed") return res.json({ task: t });
        throw new AAError(409, "invalid_state", `Task is '${t.status}'; only shortlisted jobs can be removed.`);
      }
      res.json({ task: data[0] });
    }),
  );

  // Needs-you
  router.get(
    "/needs-you",
    wrap("needs-you", async (req, res) => {
      const { data: items, error } = await db
        .from("aa_needs_you")
        .select("id, kind, payload, task_id, batch_id, created_at")
        .eq("user_id", req.user.id)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      // left join: profile items (kind 'profile') have no task
      const ids = [...new Set((items || []).map((i) => i.task_id).filter(Boolean))];
      let tasks = [];
      if (ids.length) {
        const r = await db.from("aa_tasks").select("id, company, title, apply_url").in("id", ids);
        if (r.error) throw r.error;
        tasks = r.data || [];
      }
      const byId = new Map(tasks.map((t) => [t.id, t]));
      res.json({
        items: (items || []).map((i) => {
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

  router.post(
    "/needs-you/:id",
    writeLimiter,
    wrap("needs-you/resolve", async (req, res) => {
      const uid = req.user.id;
      const id = req.params.id;
      if (!UUID_RE.test(String(id))) throw notFound("Item not found.");
      const { action, answer } = req.body || {};
      if (!["done", "answer", "dismiss"].includes(action)) throw bad("action must be 'done', 'answer' or 'dismiss'.");
      const { data: item, error } = await db.from("aa_needs_you").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
      if (error) throw error;
      if (!item) throw notFound("Item not found.");
      if (item.resolved_at) throw new AAError(409, "already_resolved", "This item is already resolved.");
      if (item.kind === "profile" && action !== "dismiss") {
        throw new AAError(409, "invalid_action", "Complete your profile; this item closes on its own once it is complete.");
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

      const resolution = { done: "done_by_user", answer: "answered", dismiss: "dismissed" }[action];
      const { data: claimed, error: cErr } = await db
        .from("aa_needs_you")
        .update({ resolved_at: now().toISOString(), resolution })
        .eq("id", id)
        .eq("user_id", uid)
        .is("resolved_at", null)
        .select("*");
      if (cErr) throw cErr;
      if (!claimed || !claimed[0]) throw new AAError(409, "already_resolved", "This item is already resolved.");

      if (action === "answer") {
        const { error: aErr } = await db
          .from("aa_answers")
          .upsert({ user_id: uid, question_key: key, answer: value, source: "user", updated_at: now().toISOString() }, { onConflict: "user_id,question_key" });
        if (aErr) throw aErr;
      }
      if (item.task_id) {
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

      const out = { ...claimed[0] };
      if (key) out.answer_key = key;
      res.json({ item: out });
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
      const { data, error } = await mailDb
        .from("aa_mail_events")
        .select("id, kind, category")
        .eq("user_id", req.user.id)
        .in("category", NOTIFY_CATEGORIES)
        .is("read_at", null)
        .order("received_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      const by_kind = {};
      for (const r of data || []) {
        const k = r.kind || (r.category === "rejected" ? "rejection" : "other");
        by_kind[k] = (by_kind[k] || 0) + 1;
      }
      res.json({ count: (data || []).length, by_kind });
    }),
  );

  router.post(
    "/inbox/read-all",
    writeLimiter,
    wrap("inbox/read-all", async (req, res) => {
      const { error } = await mailDb
        .from("aa_mail_events")
        .update({ read_at: now().toISOString() })
        .eq("user_id", req.user.id)
        .is("read_at", null);
      if (error) throw error;
      res.json({ ok: true });
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
      let okUrl = false;
      try { okUrl = typeof endpoint === "string" && new URL(endpoint).protocol === "https:"; } catch { okUrl = false; }
      if (!okUrl || endpoint.length > 2000) throw bad("endpoint must be an https URL.");
      if (typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
        throw bad("keys.p256dh and keys.auth are required.");
      }
      const { count, error: cErr } = await db.from("aa_push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", req.user.id);
      if (cErr) throw cErr;
      if ((count || 0) >= 20) throw new AAError(409, "too_many_subscriptions", "Too many devices subscribed; turn off notifications on one first.");
      const { error } = await db
        .from("aa_push_subscriptions")
        .upsert({ user_id: req.user.id, endpoint, p256dh, auth }, { onConflict: "endpoint" });
      if (error) throw error;
      res.json({ ok: true });
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
      const { event, profile, category } = await storeInbound({ db, mailDb, payload });
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

/** Daily: delete expired mail from the mail db. */
export function runMailCleanup(deps = {}) {
  return cleanupExpiredMail({ mailDb: deps.mailDb || realMailDb, now: deps.now });
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
