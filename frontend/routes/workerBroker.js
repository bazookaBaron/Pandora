/**
 * On-demand worker broker — POST /api/internal/worker/*.
 * Contract: AutoJobApplier cloud_hunter/saas/deploy/WORKER_CONTRACT.md (table sql/41_worker_launches.sql).
 *
 * The Vast worker is untrusted: it never sees the service-role key or AA_VAULT_KEY. It bootstraps once with a
 * one-time token (from its launch env) and gets its DB DSNs + a bearer worker token; every later call is
 * authenticated with that bearer token and scoped to tasks the worker has claimed.
 *
 *   POST /bootstrap      {launch_id, token}                -> {db_url, mail_db_url, worker_token, worker_id, expires_at}
 *   POST /task-assets    {task_id}                         -> {resume: {url, filename}|null, proof: {path, upload_url, token}}
 *   POST /portal-secret  {task_id}                         -> {login_email, password} | {none: true}
 *   POST /portal-account {task_id, login_email, password, status?} -> {ok: true}
 *   POST /heartbeat      {idle, active}                    -> {ok: true, stop}
 *
 * No session auth, own body parser (16 KB), own rate limits (per IP, and per launch after auth). Every call is
 * logged as one JSON line WITHOUT tokens, DSNs, passwords or signed URLs. Errors: {error: {code, message}}.
 */
import crypto from "node:crypto";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { encryptSecret as realEncrypt, decryptSecret as realDecrypt } from "../lib/autoapply/vault.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const IN_FLIGHT = ["claimed", "running", "waiting_code", "submitting"];
export const BOOTSTRAP_WINDOW_MS = 20 * 60 * 1000;
const RESUME_BUCKET = "aa-resumes";
const PROOF_BUCKET = "aa-proof";
const RESUME_URL_TTL_S = 30 * 60;
const PORTAL_STATUSES = ["active", "pending_verify", "locked", "user_supplied"];
// launches the bearer token is accepted for: 'stopping' too, so the worker can see stop=true on its heartbeat and
// finish its in-flight tasks (proof upload, portal secret) during the drain.
const AUTH_STATUSES = ["running", "stopping"];

class BrokerError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const unauthorized = () => new BrokerError(401, "unauthorized", "Not authorized.");
const bad = (m) => new BrokerError(400, "invalid_input", m);
const forbidden = () => new BrokerError(403, "forbidden", "This task is not claimed by this worker.");

export const sha256Hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/** Constant-time compare of two sha256 hex digests. */
export function hashEquals(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex");
  const b = Buffer.from(String(bHex || ""), "hex");
  if (a.length !== 32 || b.length !== 32) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); // keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function loadBrokerKey(b64) {
  const key = Buffer.from(String(b64 || "").trim(), "base64");
  if (key.length !== 32) {
    const e = new Error("AA_BROKER_KEY must be base64 of exactly 32 bytes.");
    e.code = "broker_unconfigured";
    throw e;
  }
  return key;
}

/** 'v1:' + base64(iv12 || ciphertext || tag16), AES-256-GCM, AAD = launch id (utf-8). */
export function encryptDsn(plaintext, launchId, key, iv = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(String(launchId), "utf8"));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}

export function decryptDsn(blob, launchId, key) {
  const s = String(blob || "");
  if (!s.startsWith("v1:")) throw Object.assign(new Error("unknown dsn format"), { code: "decrypt_failed" });
  const raw = Buffer.from(s.slice(3), "base64");
  if (raw.length < 12 + 16 + 1) throw Object.assign(new Error("dsn too short"), { code: "decrypt_failed" });
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(String(launchId), "utf8"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
  } catch {
    throw Object.assign(new Error("dsn decrypt failed"), { code: "decrypt_failed" });
  }
}

const newToken = () => crypto.randomBytes(32).toString("base64url");

/**
 * @param {object} deps  db (service-role client), env, now(), log(line), limits {ipPerMin, bootstrapPer10Min,
 *                       launchPerMin}, vault {encryptSecret, decryptSecret}
 */
export function createWorkerBroker(deps = {}) {
  const db = deps.db || supabaseAdmin;
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const log = deps.log || ((line) => console.log(line));
  const encryptSecret = (deps.vault && deps.vault.encryptSecret) || realEncrypt;
  const decryptSecret = (deps.vault && deps.vault.decryptSecret) || realDecrypt;
  const limits = { ipPerMin: 240, bootstrapPer10Min: 10, launchPerMin: 300, ...(deps.limits || {}) };

  const router = express.Router();
  const limitMsg = { error: { code: "rate_limited", message: "Too many requests." } };
  const ipKey = (req) => `ip:${ipKeyGenerator(req.ip || "")}`;
  const ipLimiter = rateLimit({ windowMs: 60_000, max: limits.ipPerMin, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: limitMsg });
  const bootstrapLimiter = rateLimit({ windowMs: 10 * 60_000, max: limits.bootstrapPer10Min, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: limitMsg });
  const launchLimiter = rateLimit({
    windowMs: 60_000,
    max: limits.launchPerMin,
    keyGenerator: (req) => `launch:${req.launch.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    message: limitMsg,
  });

  router.use((req, res, next) => {
    req._t0 = Date.now();
    res.set("Cache-Control", "no-store");
    res.on("finish", () => {
      const line = {
        at: "worker-broker",
        route: req.path,
        status: res.statusCode,
        ip: req.ip,
        ms: Date.now() - req._t0,
      };
      if (req.launch) Object.assign(line, { launch: req.launch.id, worker: req.launch.worker_id });
      else if (req.body && typeof req.body.launch_id === "string" && UUID_RE.test(req.body.launch_id)) line.launch = req.body.launch_id;
      if (req.body && typeof req.body.task_id === "string" && UUID_RE.test(req.body.task_id)) line.task = req.body.task_id;
      if (req._note) line.note = req._note;
      try { log(JSON.stringify(line)); } catch {}
    });
    next();
  });
  router.use(ipLimiter);
  router.use(express.json({ limit: "16kb", type: () => true }));
  router.use((req, _res, next) => {
    if (req.method !== "POST") return next(new BrokerError(405, "method_not_allowed", "POST only."));
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return next(bad("JSON object body required."));
    next();
  });

  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  // ── bootstrap ────────────────────────────────────────────────────────────
  router.post(
    "/bootstrap",
    bootstrapLimiter,
    wrap(async (req, res) => {
      const { launch_id, token } = req.body;
      if (typeof launch_id !== "string" || !UUID_RE.test(launch_id) || typeof token !== "string" || !TOKEN_RE.test(token)) {
        req._note = "bad_input";
        throw unauthorized();
      }
      const key = loadBrokerKey(env.AA_BROKER_KEY);
      const { data: launch, error } = await db.from("aa_worker_launches").select("*").eq("id", launch_id).maybeSingle();
      if (error) throw error;
      const t = now();
      const hashOk = hashEquals(sha256Hex(token), launch ? launch.bootstrap_hash : "");
      const fail = (note) => {
        req._note = note;
        return unauthorized();
      };
      if (!launch) throw fail("unknown_launch");
      if (!hashOk) throw fail("hash_mismatch");
      if (launch.bootstrap_used_at) throw fail("already_used");
      if (launch.status !== "starting") throw fail(`status_${launch.status}`);
      if (t.getTime() - Date.parse(launch.created_at) > BOOTSTRAP_WINDOW_MS) throw fail("window_passed");
      if (launch.expires_at && Date.parse(launch.expires_at) <= t.getTime()) throw fail("expired");

      // decrypt before burning the token: a broken row must not consume the one-time bootstrap
      const dbUrl = decryptDsn(launch.db_dsn_enc, launch.id, key);
      const mailUrl = decryptDsn(launch.mail_dsn_enc, launch.id, key);

      const workerToken = newToken();
      const { data: won, error: uErr } = await db
        .from("aa_worker_launches")
        .update({ bootstrap_used_at: t.toISOString(), status: "running", worker_token_hash: sha256Hex(workerToken) })
        .eq("id", launch.id)
        .eq("status", "starting")
        .is("bootstrap_used_at", null)
        .select("id, worker_id, expires_at");
      if (uErr) throw uErr;
      if (!won || !won[0]) throw fail("race_lost");
      req._note = "bootstrapped";
      res.json({ db_url: dbUrl, mail_db_url: mailUrl, worker_token: workerToken, worker_id: won[0].worker_id, expires_at: won[0].expires_at });
    }),
  );

  // ── bearer auth for everything else ──────────────────────────────────────
  async function authCheck(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(String(req.get("authorization") || ""));
    if (!m) {
      req._note = "no_bearer";
      throw unauthorized();
    }
    const hash = sha256Hex(m[1]);
    const { data: rows, error } = await db
      .from("aa_worker_launches")
      .select("id, worker_id, status, expires_at, bootstrap_used_at, worker_token_hash")
      .eq("worker_token_hash", hash)
      .limit(2);
    if (error) throw error;
    const launch = rows && rows.length === 1 ? rows[0] : null;
    if (!launch || !hashEquals(hash, launch.worker_token_hash) || !launch.bootstrap_used_at) {
      req._note = "bad_token";
      throw unauthorized();
    }
    if (!AUTH_STATUSES.includes(launch.status) || Date.parse(launch.expires_at) <= now().getTime()) {
      req._note = `launch_${launch.status}`;
      throw unauthorized();
    }
    req.launch = launch;
  }
  const authed = [
    (req, _res, next) => authCheck(req).then(() => next(), next),
    (req, res, next) => launchLimiter(req, res, next),
  ];

  /**
   * The task, only if this worker has claimed it and it is in flight.
   * claimed_by is "<worker_id>-<slot>"; we match that segment EXACTLY (a plain
   * startsWith let worker "vast-ab" read tasks claimed by "vast-abc-1").
   * opts.requireLease additionally demands a live lease (lease_until > now()):
   * used for the endpoints that release secrets/upload URLs.
   *
   * Remaining risk: the worker holds a DSN that can UPDATE aa_tasks.claimed_by /
   * lease_until, so a compromised worker could re-claim another user's task row
   * and then ask the broker for its portal secret. Mitigation would be to move
   * claim/lease writes behind a SECURITY DEFINER RPC and revoke column UPDATE.
   */
  async function claimedTask(req, opts = {}) {
    const taskId = req.body.task_id;
    if (typeof taskId !== "string" || !UUID_RE.test(taskId)) throw bad("task_id must be a uuid.");
    const { data: task, error } = await db
      .from("aa_tasks")
      .select("id, user_id, tenant_host, status, claimed_by, lease_until")
      .eq("id", taskId)
      .maybeSingle();
    if (error) throw error;
    const workerId = String(req.launch.worker_id || "");
    const claimedBy = String((task && task.claimed_by) || "");
    const exact = !!workerId && (claimedBy === workerId || (claimedBy.startsWith(`${workerId}-`) && /^\d+$/.test(claimedBy.slice(workerId.length + 1))));
    const leaseLive = !opts.requireLease || (task && task.lease_until && Date.parse(task.lease_until) > now().getTime());
    if (!task || !exact || !leaseLive || !IN_FLIGHT.includes(task.status)) {
      req._note = "not_claimed";
      throw forbidden();
    }
    return task;
  }

  const tenantOf = (task) => {
    const host = String(task.tenant_host || "").trim().toLowerCase();
    if (!host || !HOST_RE.test(host)) throw new BrokerError(409, "no_tenant", "Task has no tenant host.");
    return host;
  };

  router.post(
    "/task-assets",
    ...authed,
    wrap(async (req, res) => {
      const task = await claimedTask(req, { requireLease: true });
      const { data: prof, error } = await db.from("aa_profiles").select("resume_path").eq("user_id", task.user_id).maybeSingle();
      if (error) throw error;
      let resume = null;
      const rp = String((prof && prof.resume_path) || "");
      if (rp && rp.startsWith(`${task.user_id}/`) && !rp.includes("..")) {
        const { data: s, error: sErr } = await db.storage.from(RESUME_BUCKET).createSignedUrl(rp, RESUME_URL_TTL_S);
        if (sErr) throw sErr;
        if (s && s.signedUrl) resume = { url: s.signedUrl, filename: rp.split("/").pop() };
      }
      const proofPath = `${task.user_id}/${task.id}.jpg`;
      const { data: up, error: uErr } = await db.storage.from(PROOF_BUCKET).createSignedUploadUrl(proofPath, { upsert: true });
      if (uErr) throw uErr;
      if (!up || !up.signedUrl) throw new Error("signed upload url missing");
      res.json({ resume, proof: { path: proofPath, upload_url: up.signedUrl, token: up.token } });
    }),
  );

  router.post(
    "/portal-secret",
    ...authed,
    wrap(async (req, res) => {
      const task = await claimedTask(req, { requireLease: true });
      const host = tenantOf(task);
      const { data: acct, error } = await db
        .from("aa_portal_accounts")
        .select("login_email, secret_ciphertext")
        .eq("user_id", task.user_id)
        .eq("tenant_host", host)
        .maybeSingle();
      if (error) throw error;
      if (!acct || !acct.secret_ciphertext) return res.json({ none: true });
      const password = decryptSecret(acct.secret_ciphertext, task.user_id, host);
      await db.from("aa_portal_accounts").update({ last_used_at: now().toISOString() }).eq("user_id", task.user_id).eq("tenant_host", host);
      res.json({ login_email: acct.login_email, password });
    }),
  );

  router.post(
    "/portal-account",
    ...authed,
    wrap(async (req, res) => {
      const { login_email, password, status } = req.body;
      if (typeof login_email !== "string" || login_email.length > 254 || !EMAIL_RE.test(login_email)) throw bad("login_email is invalid.");
      if (typeof password !== "string" || !password || password.length > 512) throw bad("password is invalid.");
      if (status !== undefined && !PORTAL_STATUSES.includes(status)) throw bad(`status must be one of ${PORTAL_STATUSES.join(", ")}.`);
      const task = await claimedTask(req);
      const host = tenantOf(task);
      const row = {
        user_id: task.user_id,
        tenant_host: host,
        login_email,
        secret_ciphertext: encryptSecret(password, task.user_id, host),
        last_used_at: now().toISOString(),
      };
      if (status) row.status = status;
      const { error } = await db.from("aa_portal_accounts").upsert(row, { onConflict: "user_id,tenant_host" });
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  router.post(
    "/heartbeat",
    ...authed,
    wrap(async (req, res) => {
      const { idle, active } = req.body;
      if (typeof idle !== "boolean" || !Number.isInteger(active) || active < 0 || active > 1000) throw bad("idle (bool) and active (int) are required.");
      req._note = `idle=${idle} active=${active}`;
      res.json({ ok: true, stop: req.launch.status === "stopping" });
    }),
  );

  router.use((req, _res, next) => next(new BrokerError(404, "not_found", "Unknown endpoint.")));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof BrokerError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err && (err.type === "entity.too.large" || err.status === 413)) return res.status(413).json({ error: { code: "too_large", message: "Body too large." } });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: { code: "invalid_json", message: "Body is not valid JSON." } });
    if (err && (err.code === "broker_unconfigured" || err.code === "vault_unconfigured")) {
      req._note = err.code;
      return res.status(503).json({ error: { code: "unconfigured", message: "Broker is not configured." } });
    }
    if (err && err.code === "decrypt_failed") {
      req._note = "decrypt_failed";
      return res.status(500).json({ error: { code: "decrypt_failed", message: "Could not decrypt." } });
    }
    req._note = `internal: ${String((err && (err.code || err.name)) || "error").slice(0, 40)}`;
    console.error("[worker-broker] internal error on", req.path, (err && err.code) || "");
    res.status(500).json({ error: { code: "internal", message: "Something went wrong." } });
  });

  return router;
}
