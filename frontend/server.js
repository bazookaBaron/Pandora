import "dotenv/config";
import { COUPON_MESSAGES, CouponError, normCouponCode, redeemCoupon, releaseCoupon } from "./lib/coupons.js";
import { spaceByCompany, feedWindow } from "./lib/jobsFeed.js";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import expressStaticGzip from "express-static-gzip";
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";

import {
  extractStructuredResume,
  generateTailoredResume,
  redact,
} from "./lib/aiClient.js";
import { compileLatexToPdf } from "./lib/latexCompiler.js";
import { buildFilename } from "./lib/filename.js";
import { requireAuth, optionalAuth } from "./lib/requireAuth.js";
import {
  canAccess,
  reserveUsage,
  refundUsage,
  getRemainingUsage,
  getUserPlan,
  getUserCountry,
  getEntitlementsSummary,
  invalidateUser,
} from "./lib/entitlements.js";
import { countryFromRequest, currencyForCountry } from "./lib/geo.js";
import * as resend from "./services/resend.js";
import {
  referralRequestCreated,
  referralAccepted,
  companyJobAlertEmail,
  setEmailAssetBase,
} from "./lib/referralEmails.js";
import {
  acceptLimitMessage,
  acceptWindowStart,
  canViewResume,
  evaluateAcceptLimit,
  selectRecipients,
} from "./lib/referralAccess.js";
import { canAddCompanySubscription, effectivePlanFromRow } from "./lib/entitlements.js";
import {
  getLimit,
  isUnlimited,
  serializeLimit,
  isValidPlan,
  priceInrPaise,
  priceUsdCents,
} from "./config/tiers.js";
import * as razorpay from "./services/razorpay.js";
import {
  assert,
  isNonEmptyString,
  inRange,
  maxLen,
  isPlainObject,
  looksBase64,
  decodedLen,
} from "./lib/validate.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { classifyRoute, renderIndex, baseUrl, escapeHtml, evaluateJobHubIndexability } from "./lib/seoHead.js";
import { cached, invalidate, hasFresh } from "./lib/microCache.js";
import * as pdfPool from "./lib/pdfPool.js";
import { makeSemaphore } from "./lib/semaphore.js";
import {
  createAutoApplyRouter,
  createInboundHandler,
  handleAutoApplyWebhook,
  runAutoApplyRefunds,
  runExpirePendingOrders,
  runMailCleanup,
  runDailyMailAlerts,
  runInterviewReminders,
} from "./routes/autoapply.js";
import { makeLimiter, tokenOrIpKey, ipKey } from "./lib/rateKeys.js";
import { registerProfileCompanyRoutes, getVerifiedCompany } from "./routes/profileCompany.js";
import { createWorkerBroker } from "./routes/workerBroker.js";
import { cleanupOldProofs } from "./lib/autoapply/proofRetention.js";
import {
  computePeriodEnd,
  claimPayment,
  releasePayment,
  recordPaymentPeriodEnd,
  claimWebhookEvent,
  releaseWebhookEvent,
} from "./lib/paymentsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, "resume-source");

const app = express();

// Plan-gated GETs (catalog / jobs list) return different payloads for the same
// URL depending on the caller's plan, but the browser HTTP cache keys only on
// the URL. With `max-age` a tab that cached the free (locked) view kept
// serving it after an upgrade until it expired. `no-cache` still lets the
// browser keep the body but forces a revalidation each time; Express's
// default ETag turns an unchanged payload into a cheap 304.
const PLAN_GATED_CACHE = "private, no-cache";

// Behind Railway's proxy: trust exactly one hop so req.ip is the real client
// (the right-most X-Forwarded-For entry Railway appended). If you put another
// proxy/CDN (e.g. Cloudflare) in front, set TRUST_PROXY_HOPS=2.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);
app.disable("x-powered-by");

// Per-request CSP nonce for the few inline <script>s we emit (theme bootstrap,
// window.__INITIAL_DATA__). Added to the HTML at send time in the SPA handler.
app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

function originOf(u) {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
}
const SUPABASE_ORIGIN = originOf(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL);
const POSTHOG_HOST = originOf(process.env.VITE_POSTHOG_HOST) || "https://us.i.posthog.com";
const POSTHOG_ASSETS = POSTHOG_HOST.replace("//us.i.", "//us-assets.i.").replace("//eu.i.", "//eu-assets.i.");
const CSP_CONNECT = [
  "'self'",
  SUPABASE_ORIGIN,
  SUPABASE_ORIGIN && SUPABASE_ORIGIN.replace(/^https/, "wss"),
  "https://*.supabase.co",
  "wss://*.supabase.co",
  POSTHOG_HOST,
  POSTHOG_ASSETS,
  "https://api.razorpay.com",
  "https://lumberjack.razorpay.com",
  "https://cdn.jsdelivr.net",
].filter(Boolean);

// Security headers. CSP is enforced; set CSP_REPORT_ONLY=true to downgrade it to
// report-only while debugging a blocked resource in production.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      reportOnly: /^(1|true|yes|on)$/i.test(process.env.CSP_REPORT_ONLY || ""),
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: [
          "'self'",
          (_req, res) => `'nonce-${res.locals.cspNonce}'`,
          "https://checkout.razorpay.com",
          "https://cdn.jsdelivr.net",
          POSTHOG_HOST,
          POSTHOG_ASSETS,
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: CSP_CONNECT,
        frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["'self'", "blob:", "https://api.razorpay.com"],
        mediaSrc: ["'self'", "blob:", "data:"],
        manifestSrc: ["'self'"],
      },
    },
    strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Razorpay / OAuth open popups that postMessage back to us.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);

// gzip every compressible response (JSON API payloads + the SPA HTML). Placed
// before any route or static handler so it wraps them all.
app.use(compression());

// ── CORS lockdown ────────────────────────────────────────────────
// In prod the SPA is same-origin (served from dist/), so this mainly blocks
// other sites' cross-origin XHR. `credentials: false` — we use bearer tokens,
// not cookies.
const CORS_ALLOWLIST = process.env.CORS_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? ["http://localhost:5173", "http://localhost:3000"];

// Base URL used when building links inside referral notification emails.
const APP_BASE_URL =
  process.env.APP_BASE_URL || CORS_ALLOWLIST[0] || "http://localhost:5173";
setEmailAssetBase(APP_BASE_URL);

app.use(
  cors({
    origin(origin, cb) {
      // No Origin header => same-origin nav, curl, or server-to-server. Allow.
      if (!origin) return cb(null, true);
      return cb(null, CORS_ALLOWLIST.includes(origin));
    },
    credentials: false,
  }),
);

// On-demand Vast worker broker (routes/workerBroker.js, WORKER_CONTRACT.md). Server-to-server: no session auth
// (one-time bootstrap token, then a bearer worker token), its own 16 KB JSON parser and rate limits. Mounted
// before the global parser / generalLimiter; /api/* never reaches the SPA fallback.
app.use("/api/internal/worker", createWorkerBroker());

// AutoApply inbound mail from the Email Worker (docs/autoapply-contract.md).
// The HMAC covers the exact raw bytes, so this one route gets its own raw
// parser and is registered BEFORE the global JSON parser and generalLimiter
// (the worker is a single client relaying every mail). No auth: HMAC is the check.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests." } },
});
app.post(
  "/api/inbound/email",
  inboundLimiter,
  express.raw({ type: () => true, limit: "1mb" }),
  createInboundHandler(),
);

// Capture the raw request bytes on `req.rawBody` (needed by the Razorpay
// webhook for HMAC signature verification) while normal JSON parsing continues
// everywhere. Default body limit is 100kb; only routes that truly need more
// get their own larger parser mounted BEFORE the global one (body-parser skips
// a request that was already parsed).
const rawBodyCapture = (req, _res, buf) => {
  req.rawBody = buf;
};
// /api/hld/judge carries a base64 diagram screenshot (<= ~8MB decoded).
app.use("/api/hld/judge", express.json({ limit: "12mb", verify: rawBodyCapture }));
// /api/run accepts up to 512KB of file content (asserted in the handler) plus
// JSON overhead/escaping, so it needs more than the 100kb default.
app.use("/api/run", express.json({ limit: "600kb", verify: rawBodyCapture }));
// AutoApply profile payloads are capped at 100KB by the router itself; leave
// headroom for the envelope so a max-size profile isn't rejected at the parser.
app.use("/api/autoapply", express.json({ limit: "1mb", verify: rawBodyCapture }));
app.use(express.json({ limit: "100kb", verify: rawBodyCapture }));

// ── Rate limiting ────────────────────────────────────────────────
// Limiters mounted before requireAuth (app.use / global) bucket by IP only;
// per-route limiters are mounted AFTER requireAuth and bucket by the verified
// user id - see lib/rateKeys.js (never key on an unverified JWT).
const generalLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { error: "Too many requests - slow down." },
});
const aiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 20 });
const catalogLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60 });
const referralLimiter = makeLimiter({ windowMs: 60 * 1000, max: 15 });
const runLimiter = makeLimiter({ windowMs: 60 * 1000, max: 15 });
const paymentsLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30 });
const profileWriteLimiter = makeLimiter({ windowMs: 60 * 1000, max: 20 });
// The subscribe bell is optimistic client-side (instant toggle, no waiting on
// this request) — cheap to spam-click by design. This caps the actual writes
// so on/off/on/off doesn't turn into an unbounded insert/delete loop.
const subscribeLimiter = makeLimiter({ windowMs: 60 * 1000, max: 20 });

app.use("/api", generalLimiter);
// Cheap blanket caps on route families that had none.
app.use("/api/referrals", referralLimiter);
app.use("/api/payments", paymentsLimiter);
app.use("/api/subscriptions", paymentsLimiter);
app.use("/api/profile", profileWriteLimiter);

// Serve the built frontend (Vite `dist/` output) as static files so you only need one server running.
// `index: false` — never auto-serve dist/index.html for "/"; the SEO-aware
// fallback handler below owns "/" (and every other non-asset route) so it can
// inject a route-correct <head>.
// Content-hashed build assets (dist/assets/*) — safe to cache hard + immutable.
// `fallthrough: false` → a missing /assets/* file 404s instead of falling
// through to the SPA HTML handler.
// vite-plugin-compression2 emits .br/.gz siblings at build time; serve them
// directly (no per-request compression CPU).
app.use(
  "/assets",
  expressStaticGzip(path.join(__dirname, "dist", "assets"), {
    enableBrotli: true,
    orderPreference: ["br", "gz"],
    serveStatic: {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false,
    },
  }),
);

// The static handler above has `fallthrough: false`, so a request for a
// content-hashed chunk that no longer exists (returning user on a stale
// index.html) is passed on as an error with status 404. Answer it with a clean
// 404 here rather than letting the final error handler map it to a 500. Must be
// a 4-arg (error-handling) middleware — serve-static forwards the miss via
// next(err), which skips ordinary middleware.
app.use("/assets", (err, _req, res, next) => {
  if (err && Number(err.status) === 404) return res.status(404).end();
  next(err);
});

app.use(express.static(path.join(__dirname, "dist"), { index: false }));

// Multer: accept resume PDF in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed."));
  },
});

// ── helpers ─────────────────────────────────────────────────────
// Copy the client-facing paywall fields out of a canAccess() result.
function paywallFields(gate) {
  const out = {};
  if (gate.used != null) out.used = gate.used;
  if (gate.limit != null) out.limit = gate.limit;
  if (gate.resetsAt) out.resetsAt = gate.resetsAt;
  return out;
}

// Turn any thrown error into a safe response. Validation errors (status 400)
// echo their message; everything else is generic + logged server-side (redacted).
function fail(res, err, label, genericMsg) {
  const status = Number(err && err.status) || 500;
  if (status === 400) {
    if (!res.headersSent) res.status(400).json({ error: err.message || "Invalid request." });
    return;
  }
  console.error(`[${label}]`, redact((err && (err.stack || err.message)) || String(err)));
  if (!res.headersSent) res.status(500).json({ error: genericMsg || "Something went wrong." });
}

// PDF parsing (pdf-parse text extraction + pdfjs link-annotation / layout
// probes) is CPU-bound and blocks the event loop for the whole request. It now
// runs on a small worker_threads pool (see ./lib/pdfWorkerEntry.js). These thin
// wrappers keep the original names + signatures so the /api/generate call sites
// are untouched.

// Extract text from an uploaded PDF, enriched with a "DETECTED HYPERLINKS" block
// pulled from link annotations (résumés often render "LinkedIn"/"GitHub" as an
// icon glyph with no extractable text, the real URL living only in the
// annotation). Runs on the pool; a hard failure rejects and the route's
// try/catch handles it.
async function extractPdfText(buffer) {
  return pdfPool.extractText(buffer);
}

// Layout of a COMPILED résumé PDF: page count + how much of page 1 is blank at
// the bottom (0 = content reaches the bottom margin, 0.2 = bottom fifth empty).
// Used to enforce "exactly one, fully-filled page". A layout-probe failure must
// NOT fail the whole generate, so a pool-level reject is caught here and mapped
// to the same {pages:0, bottomGapRatio:0} fallback the old inline code used.
async function pdfLayoutInfo(buffer) {
  try {
    return await pdfPool.layoutInfo(buffer);
  } catch (e) {
    console.warn("[generate] pdfLayoutInfo failed:", redact(e?.message || String(e)));
    return { pages: 0, bottomGapRatio: 0 };
  }
}

// Guarantee a sane "before optimization" scorecard: each metric strictly below
// its "after" counterpart, never zero, and at least 45. A plausible real
// estimate (from the best-effort pre-scoring call) is used when it already fits
// that band; otherwise we derive one from the "after" score.
function deriveBeforeMetrics(after, rawHint) {
  const KEYS = [
    "keywordMatchPercent",
    "atsPassChancePercent",
    "humanScreenChancePercent",
  ];
  const DEFAULT_GAP = {
    keywordMatchPercent: 22,
    atsPassChancePercent: 18,
    humanScreenChancePercent: 27,
  };
  const out = {};
  for (const k of KEYS) {
    let a = Math.round(Number(after?.[k]));
    if (!Number.isFinite(a)) a = 80;
    a = Math.max(50, Math.min(100, a));
    const ceil = Math.max(46, a - 3); // strictly below "after"
    const hint = Math.round(Number(rawHint?.[k]));
    let b =
      Number.isFinite(hint) && hint >= 45 && hint < a
        ? hint
        : a - DEFAULT_GAP[k];
    b = Math.max(45, Math.min(ceil, b));
    if (b >= a) b = Math.max(41, a - 2);
    out[k] = b;
  }
  return out;
}

// Placeholder strings that live in resume-source/resume.tex (the FORMAT skeleton).
// None of these may ever appear in generated output. "debopriyo"/"debnath" are
// kept as belt-and-braces in case an old skeleton is ever deployed.
const IDENTITY_LEAK_MARKERS = [
  "candidate full name",
  "candidate.email@example.com",
  "candidate-handle",
  "000-000-0000",
  "company name",
  "university name",
  "project name",
  "placeholder skill",
  "placeholder achievement",
  "placeholder project",
  "debopriyo",
  "debnath",
];

// Throws (500 via the route's catch) if the tailored .tex still contains skeleton
// placeholder data, or if the extracted candidate's name is nowhere in it.
function assertNoIdentityLeak(tex, candidateName) {
  const hay = String(tex || "").toLowerCase();

  const leaked = IDENTITY_LEAK_MARKERS.filter((m) => hay.includes(m));
  if (leaked.length) {
    const err = new Error(
      `Generated résumé still contains skeleton/placeholder data: ${leaked.join(", ")}`,
    );
    err.code = "IDENTITY_LEAK";
    throw err;
  }

  // The candidate's own name (or at least its first token) should be present.
  const first = String(candidateName || "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[{}\\~^]/g, "");
  if (first && first.length > 1 && !hay.includes(first)) {
    const err = new Error(
      "Generated résumé does not contain the extracted candidate's name.",
    );
    err.code = "IDENTITY_LEAK";
    throw err;
  }
}

// Helper: pick API key from env based on provider
function resolveApiKey(provider) {
  const envMap = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  const key = envMap[provider];
  if (!key) throw new Error(`No API key configured for provider "${provider}".`);
  return key;
}

// ── Health check (no auth, no secrets) ──────────────────────────
app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || "";
  res.json({ ok: true, commitSha: /^[a-f0-9]{40}$/.test(sha) ? sha : null });
});

// ── Entitlements ───────────────────────────────────────────────
app.get("/api/entitlements/me", requireAuth, async (req, res) => {
  try {
    const summary = await getEntitlementsSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    fail(res, err, "entitlements/me", "Failed to load entitlements.");
  }
});

// POST /api/profile/detect-country — best-effort, idempotent IP -> country
// fill-in. Fired once per login from AuthContext.jsx (same guard pattern as
// its analytics identifyUser call), so this covers new signups AND existing
// users with no country yet, without a backfill script. No-ops once
// profiles.country is set — never overwrites an existing value (a user who
// travels or uses a VPN keeps whatever was first detected, not the newest).
app.post("/api/profile/detect-country", requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("country")
      .eq("id", req.user.id)
      .maybeSingle();
    if (existing?.country) return res.json({ country: existing.country, updated: false });

    const detected = await countryFromRequest(req);
    if (!detected) return res.json({ country: null, updated: false });

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ country: detected })
      .eq("id", req.user.id);
    if (error) throw error;
    res.json({ country: detected, updated: true });
  } catch (err) {
    fail(res, err, "profile/detect-country", "Failed to detect country.");
  }
});

// Company ownership + work-email verification (routes/profileCompany.js).
registerProfileCompanyRoutes(app, { fail });

// ── Resume optimizer ──────────────────────────────────────────
// Bounds how many /api/generate bodies run the heavy pipeline (2 LLM stages +
// LaTeX compile + worker-pool PDF parse, each holding a multi-MB PDF buffer) at
// once. Requests beyond the cap queue on the semaphore; a deep backlog 503s.
const genGate = makeSemaphore(4);

app.post(
  "/api/generate",
  requireAuth,
  aiLimiter,
  upload.single("resume"),
  async (req, res) => {
    try {
      const { jd, provider = "gemini", name, companyName } = req.body;

      assert(
        isNonEmptyString(jd) && inRange(jd, 1, 20000),
        "Paste a job description (1–20000 characters).",
      );
      assert(
        ["gemini", "anthropic", "openai"].includes(provider),
        "Unknown provider.",
      );
      if (name != null) assert(maxLen(String(name), 200), "name is too long.");
      if (companyName != null)
        assert(maxLen(String(companyName), 200), "companyName is too long.");
      assert(req.file, "Upload a resume PDF to continue.");
      assert(
        req.file.size >= 100,
        "That PDF looks empty. Upload a valid resume PDF.",
      );
      // multer's mimetype filter trusts a client-set header — verify the actual
      // bytes. A real PDF starts with "%PDF-" (25 50 44 46 2D).
      assert(
        Buffer.isBuffer(req.file.buffer) &&
          req.file.buffer.length >= 5 &&
          req.file.buffer.subarray(0, 5).toString("latin1") === "%PDF-",
        "That file is not a valid PDF.",
      );

      // ── Entitlement gate ──
      const gate = await canAccess(req.user.id, "resume_optimizer");
      if (!gate.allowed) {
        return res.status(402).json({
          error: "usage_limit",
          feature: "resume_optimizer",
          ...paywallFields(gate),
        });
      }

      // ── Concurrency cap ──
      // Shed load early: if the semaphore queue is already deep, fast-fail
      // rather than pile on another queued request holding a PDF buffer.
      if (genGate.pending > 12) {
        return res.status(503).json({ error: "busy" });
      }
      // A client that disconnects while queued must not later take a permit.
      const genAbort = new AbortController();
      const onGenClose = () => {
        if (!res.writableEnded) genAbort.abort();
      };
      res.on("close", onGenClose);
      try {
        await genGate.acquire({ signal: genAbort.signal });
      } catch {
        res.off("close", onGenClose);
        return; // client went away while queued
      }
      let reservation = null;
      let genSucceeded = false;
      try {
      // Atomic quota reservation (sql/32). Refunded in finally unless the
      // resume was produced.
      const reserved = await reserveUsage(req.user.id, "resume_optimizer");
      if (!reserved.allowed) {
        return res.status(402).json({
          error: "usage_limit",
          feature: "resume_optimizer",
          ...paywallFields(reserved),
        });
      }
      reservation = reserved.reservation;
      if (genAbort.signal.aborted) return;

      let apiKey;
      try {
        apiKey = resolveApiKey(provider);
      } catch (e) {
        console.error("[generate]", redact(e.message));
        return res.status(500).json({ error: "AI service is not configured." });
      }

      const formName = (name && name.trim()) || "";
      const formCompany = (companyName && companyName.trim()) || "";

      // 1. Extract text from the uploaded résumé.
      let uploadedResumeText = "";
      try {
        uploadedResumeText = await extractPdfText(req.file.buffer);
      } catch (e) {
        console.warn("[generate] Failed to parse uploaded PDF:", redact(e.message));
      }
      if (!uploadedResumeText) {
        return res.status(422).json({
          error:
            "Could not read text from that PDF. If it's a scanned image, upload a text-based PDF.",
        });
      }

      // 2. Read resume.tex / resume.cls — used ONLY as a LaTeX format skeleton.
      const [currentTex, currentCls] = await Promise.all([
        readFile(path.join(SOURCE_DIR, "resume.tex"), "utf-8"),
        readFile(path.join(SOURCE_DIR, "resume.cls"), "utf-8"),
      ]);

      // 3. BEFORE metrics — best-effort raw hint; sanitised against "after" later.
      let beforeHint = null;
      if (process.env.GEMINI_API_KEY) {
        try {
          const beforePrompt = `You are a strict ATS scoring system. Score this resume against the job description.
Resume:
---
${uploadedResumeText.slice(0, 3000)}
---
Job Description:
---
${jd.slice(0, 2000)}
---
Output ONLY this JSON (no markdown, use \\n for newlines inside string values):
{"keywordMatchPercent":<0-100>,"atsPassChancePercent":<0-100>,"humanScreenChancePercent":<0-100>,"matchedKeywords":[],"missingRequiredKeywords":[]}`;
          const raw = await callGemini(beforePrompt);
          const jsonStr = extractJson(raw);
          if (jsonStr) {
            try {
              beforeHint = JSON.parse(jsonStr);
            } catch {
              try {
                beforeHint = JSON.parse(sanitizeJsonString(jsonStr));
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* before metrics is best-effort */
        }
      }

      // 4. Stage 1: raw résumé text → strict structured JSON.
      //    A failed or too-sparse extraction MUST be a clear user-facing error —
      //    never fall through to Stage 2, which would return the skeleton's
      //    placeholder identity as if it were the candidate's résumé.
      let structured;
      try {
        structured = await extractStructuredResume({
          resumeText: uploadedResumeText,
          apiKey,
          provider,
        });
      } catch (e) {
        console.warn(
          "[generate] extraction failed/incomplete:",
          redact(e?.message || String(e)),
        );
        return res.status(422).json({
          error:
            "We couldn't read enough detail from your resume. Please try again, or upload a text-based PDF (not a scanned image).",
        });
      }

      // 5. Stage 2: tailor to the JD.
      let { metrics, tex, cls } = await generateTailoredResume({
        jd,
        structuredResume: structured,
        currentTex,
        currentCls,
        apiKey,
        provider,
      });

      // 5b. Name-leak guard (cheap sanity net). The tailored .tex must carry the
      //     candidate's real identity — not the skeleton's placeholder strings,
      //     and not any stray hard-coded name. If it doesn't, refuse to return it
      //     rather than ship someone else's / placeholder data.
      assertNoIdentityLeak(tex, structured.name);

      // 6. Compile to PDF, then enforce "exactly ONE, fully-filled page".
      //    One corrective regeneration if the first attempt either overflows
      //    (>1 page) or leaves a large blank band at the bottom (underfilled).
      const UNDERFILL_GAP = 0.14; // >14% of page height blank at the bottom
      let pdfBuffer = await compileLatexToPdf({ tex, cls });
      let layout = await pdfLayoutInfo(pdfBuffer);

      const overflow = layout.pages > 1;
      const underfilled = layout.pages === 1 && layout.bottomGapRatio > UNDERFILL_GAP;
      if (overflow || underfilled) {
        const note = overflow
          ? `The previous .tex compiled to ${layout.pages} pages. It MUST be EXACTLY ONE page. Keep every bullet and every section, but reduce \\vspace values, tighten wording, and shorten the summary until it fits on a single page. Never delete an experience, project, or education entry.`
          : `The previous .tex compiled to a single page but left roughly the bottom ${Math.round(layout.bottomGapRatio * 100)}% of the page blank. Fill the page: expand every experience/project bullet to its fullest truthful STAR form using detail already in CANDIDATE DATA, widen the summary to 3 full sentences, and increase inter-section \\vspace so the content reaches the bottom margin. Do NOT invent facts — expand and space what is truthfully there. Still exactly ONE page.`;
        console.warn(
          `[generate] page-fit retry (${overflow ? "overflow " + layout.pages + "pg" : "underfill gap " + layout.bottomGapRatio.toFixed(2)})`,
        );
        try {
          const retry = await generateTailoredResume({
            jd,
            structuredResume: structured,
            currentTex: tex, // feed the previous version back as the skeleton
            currentCls,
            apiKey,
            provider,
            revisionNote: note,
          });
          assertNoIdentityLeak(retry.tex, structured.name);
          const retryPdf = await compileLatexToPdf({ tex: retry.tex, cls: retry.cls });
          const retryLayout = await pdfLayoutInfo(retryPdf);
          // Accept the retry only if it's a genuine improvement:
          //  - never more pages than before, and
          //  - for underfill, a smaller bottom gap.
          const betterPages = retryLayout.pages && retryLayout.pages <= Math.max(1, layout.pages);
          const betterFill = overflow
            ? retryLayout.pages === 1
            : retryLayout.pages === 1 && retryLayout.bottomGapRatio < layout.bottomGapRatio;
          if (betterPages && betterFill) {
            ({ metrics, tex, cls } = retry);
            pdfBuffer = retryPdf;
            layout = retryLayout;
          }
        } catch (e) {
          console.warn(
            "[generate] page-fit retry failed, keeping first output:",
            redact(e?.message || String(e)),
          );
        }
      }

      // Sanitised before/after scorecard — always populated, before < after,
      // never zero (see item: "before should never be 0").
      const beforeMetrics = deriveBeforeMetrics(metrics, beforeHint);

      // 7. Build the download filename.
      const extractedName = structured?.name?.trim();
      const filename = buildFilename({
        fullName: extractedName || formName || "Candidate",
        company: formCompany || metrics.company,
        roleTitle: metrics.roleTitle,
      });

      // 8. Optional local copy.
      if (process.env.RESUME_SAVE_DIR) {
        try {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(process.env.RESUME_SAVE_DIR, { recursive: true });
          await writeFile(
            path.join(process.env.RESUME_SAVE_DIR, filename),
            pdfBuffer,
          );
        } catch (e) {
          console.warn(
            "[generate] RESUME_SAVE_DIR write failed (non-fatal):",
            redact(e.message),
          );
        }
      }

      // Success - the quota unit was reserved up front; keep it.
      genSucceeded = true;

      res.json({
        filename,
        pdfBase64: pdfBuffer.toString("base64"),
        metrics,
        beforeMetrics,
        tex,
        cls,
      });
      } finally {
        // Runs on every exit path from the gated block — success, early
        // return (402/422/…), and thrown errors alike.
        genGate.release();
        res.off("close", onGenClose);
        if (!genSucceeded) await refundUsage(reservation);
      }
    } catch (err) {
      fail(res, err, "generate", "Something went wrong generating your resume.");
    }
  },
);

// ── HLD routes ────────────────────────────────────────────────────
// Key goes in the `x-goog-api-key` header, never the URL.
const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function sanitizeJsonString(raw) {
  return raw
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/(?<!\\)\n/g, "\\n")
    .replace(/(?<!\\)\t/g, "\\t");
}

function extractJson(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45_000;

async function geminiFetch(model, payload) {
  const res = await fetch(GEMINI_ENDPOINT(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Log the real upstream body server-side (redacted); never echo it to the client.
    const body = await res.text().catch(() => "");
    console.error(`[gemini] upstream ${res.status}: ${redact(body).slice(0, 500)}`);
    const e = new Error("AI service error");
    e.status = 502;
    throw e;
  }
  return res.json();
}

async function callGemini(prompt, model = "gemini-3.1-flash-lite") {
  const data = await geminiFetch(model, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 4096 },
  });
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || ""
  );
}

app.post("/api/hld/generate", requireAuth, aiLimiter, async (req, res) => {
  let reservation = null;
  try {
    const { description } = req.body || {};
    assert(
      isNonEmptyString(description) && inRange(description, 1, 8000),
      "description is required (1–8000 characters).",
    );
    if (!process.env.GEMINI_API_KEY) {
      console.error("[hld/generate] GEMINI_API_KEY not set");
      return res.status(500).json({ error: "AI service is not configured." });
    }

    const gate = await reserveUsage(req.user.id, "hld_practice");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }
    reservation = gate.reservation;

    const prompt = `You are a senior system design engineer. Given this HLD question/topic:
---
${description}
---
Generate concise Functional Requirements (FR) and Non-Functional Requirements (NFR).

Output ONLY the following JSON (no markdown, no extra text, use \\n for newlines inside string values):
{"fr": "1. ...\\n2. ...\\n3. ...", "nfr": "1. ...\\n2. ...\\n3. ..."}`;
    const raw = await callGemini(prompt);
    const jsonStr = extractJson(raw);
    if (!jsonStr) throw new Error("Could not parse Gemini response");
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      try {
        parsed = JSON.parse(sanitizeJsonString(jsonStr));
      } catch (e2) {
        console.error("[hld/generate] JSON parse failed:", redact(raw.slice(0, 500)));
        const e = new Error("AI service error");
        e.status = 502;
        throw e;
      }
    }
    const { fr, nfr } = parsed;

    reservation = null; // success: keep the reserved unit
    res.json({ fr, nfr });
  } catch (err) {
    await refundUsage(reservation);
    fail(res, err, "hld/generate", "AI service error");
  }
});

app.post("/api/hld/judge", requireAuth, aiLimiter, async (req, res) => {
  let reservation = null;
  try {
    const { image_base64, frNfr, apiEndpoints, title } = req.body || {};

    if (title != null) assert(maxLen(String(title), 300), "title is too long.");
    if (image_base64 != null) {
      assert(
        typeof image_base64 === "string" && looksBase64(image_base64),
        "image_base64 must be a base64 string.",
      );
      assert(
        decodedLen(image_base64) <= 8 * 1024 * 1024,
        "Diagram image is too large (max ~8MB).",
      );
    }
    if (frNfr != null) assert(isPlainObject(frNfr), "frNfr must be an object.");
    if (apiEndpoints != null) {
      assert(Array.isArray(apiEndpoints), "apiEndpoints must be an array.");
      assert(apiEndpoints.length <= 100, "Too many API endpoints.");
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error("[hld/judge] GEMINI_API_KEY not set");
      return res.status(500).json({ error: "AI service is not configured." });
    }

    const gate = await reserveUsage(req.user.id, "hld_practice");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }
    reservation = gate.reservation;

    const frText = frNfr?.fr
      ? `Functional Requirements:\n${frNfr.fr}\n\nNon-Functional Requirements:\n${frNfr.nfr || "N/A"}`
      : "Not provided";
    const apiText = (apiEndpoints || []).length
      ? apiEndpoints.map((e) => `${e.method} ${e.path}`).join("\n")
      : "Not provided";

    const prompt = `You are an expert system design reviewer. Evaluate this HLD design for "${title || "the given problem"}".

${frText}

API Endpoints:
${apiText}

${image_base64 ? "A diagram screenshot is attached." : "No diagram provided."}

Give a structured evaluation. Output ONLY this JSON (no markdown, use \\n for newlines in string values):
{
  "score": <integer 0-100>,
  "summary": "<1-2 sentence overall assessment>",
  "sections": {
    "scalability": <0-100>,
    "reliability": <0-100>,
    "consistency": <0-100>,
    "api_design": <0-100>,
    "overall_clarity": <0-100>
  },
  "pros": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "cons": ["<improvement 1>", "<improvement 2>", "<improvement 3>"]
}`;

    const parts = [{ text: prompt }];
    if (image_base64) {
      parts.push({ inline_data: { mime_type: "image/png", data: image_base64 } });
    }
    const data = await geminiFetch("gemini-3.1-flash-lite", {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 2048 },
    });
    const raw =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
    const jsonStr = extractJson(raw);
    if (!jsonStr) throw new Error("Could not parse judge response");
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      try {
        result = JSON.parse(sanitizeJsonString(jsonStr));
      } catch {
        console.error("[hld/judge] JSON parse failed:", redact(raw.slice(0, 500)));
        const e = new Error("AI service error");
        e.status = 502;
        throw e;
      }
    }
    reservation = null; // success: judge runs now count toward hld_practice
    res.json(result);
  } catch (err) {
    await refundUsage(reservation);
    fail(res, err, "hld/judge", "AI service error");
  }
});

// ── Generic AI explanation (metered: ai_explanation) ─────────────
app.post("/api/ai/explain", requireAuth, aiLimiter, async (req, res) => {
  let reservation = null;
  try {
    const { prompt, code, question } = req.body || {};
    const input = [question, prompt, code].find((v) => isNonEmptyString(v));
    assert(isNonEmptyString(input), "Provide `prompt`, `code`, or `question`.");
    assert(maxLen(input, 8000), "Input is too long (max 8000 characters).");

    if (!process.env.GEMINI_API_KEY) {
      console.error("[ai/explain] GEMINI_API_KEY not set");
      return res.status(500).json({ error: "AI service is not configured." });
    }

    const gate = await reserveUsage(req.user.id, "ai_explanation");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "ai_explanation",
        ...paywallFields(gate),
      });
    }
    reservation = gate.reservation;

    const p = `You are a concise technical tutor helping someone prepare for software-engineering interviews. Explain the following clearly and accurately. Use short paragraphs and a concrete example when it helps.

---
${input}
---`;
    const explanation = await callGemini(p);

    reservation = null; // success: keep the reserved unit
    res.json({ explanation });
  } catch (err) {
    await refundUsage(reservation);
    fail(res, err, "ai/explain", "AI service error");
  }
});

// ── Catalog endpoints (server-enforced entitlements) ─────────────
// Stable cache-key fragment from req.query: keys sorted, `key=value` joined by
// `&`. Array values (repeated params) are comma-joined. Identical query strings
// always produce the same fragment; values are left as-is so case-significant
// filters (e.g. company names) never collide.
function qsKey(req, omit = []) {
  const q = req.query || {};
  return Object.keys(q)
    .filter((k) => !omit.includes(k))
    .sort()
    .map((k) => {
      const v = q[k];
      return `${k}=${Array.isArray(v) ? v.join(",") : v ?? ""}`;
    })
    .join("&");
}

function csvParam(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeDsa(rows) {
  return (rows || []).map((p) => {
    let company = p.company;
    if (typeof company === "string") {
      try {
        company = JSON.parse(company);
      } catch {
        company = company ? [company] : [];
      }
    }
    if (!Array.isArray(company)) company = company ? [String(company)] : [];
    let difficulty = p.difficulty;
    if (difficulty) {
      difficulty =
        difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase();
    }
    return { ...p, company, difficulty };
  });
}

function filterSortDsa(list, { search, companies, difficulties, sort }) {
  let out = list;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(
      (p) =>
        p.title?.toLowerCase().includes(q) ||
        p.topics?.toLowerCase().includes(q),
    );
  }
  if (difficulties.length)
    out = out.filter((p) => difficulties.includes(p.difficulty));
  if (companies.length)
    out = out.filter((p) => companies.some((c) => (p.company || []).includes(c)));
  if (sort === "difficulty") {
    const d = { Easy: 0, Medium: 1, Hard: 2 };
    out = [...out].sort(
      (a, b) => (d[a.difficulty] ?? 3) - (d[b.difficulty] ?? 3),
    );
  } else if (sort === "alpha") {
    out = [...out].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }
  return out;
}

async function fetchAllRows(table, columns, orderCol, ascending) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .order(orderCol, { ascending })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data || []) all.push(r); // push, not concat: O(n) not O(n^2)
    if ((data || []).length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Page through a filtered query that PostgREST would otherwise silently cap at
// 1000 rows. `build` must return a FRESH, deterministically ordered query.
async function fetchAllPaged(build) {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data || []) all.push(r);
    if ((data || []).length < PAGE) break;
  }
  return all;
}

// The whole DSA catalog, normalised, cached once for all consumers.
function getAllDsaRows() {
  return cached("dsa:all-rows", 600000, async () =>
    normalizeDsa(
      await fetchAllRows(
        "leetcode_company_problems",
        "id, title, difficulty, link, company, topics",
        "id",
        true,
      ),
    ),
  );
}

// Extracted from the /api/catalog/dsa route so the SSR initial-data embed
// (see the catch-all route near renderIndex) can hit the exact same cached()
// key + producer for an anonymous request instead of duplicating the
// Supabase fetch logic. Takes plain values instead of `req` — the route
// handler below just parses req.query/req.user into these before calling it.
async function buildDsaCatalogPayload({ plan, search, companies, difficulties, sort, page }) {
  const limit = getLimit(plan, "dsa_catalog_visible");
  const unlimited = isUnlimited(limit);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  // PostgREST search token — mirrors the jobs route's `locCore`: strip the
  // chars significant to the `.or()` grammar / ilike, collapse whitespace,
  // then wildcard the gaps so multi-word searches still match.
  const esc = search
    .replace(/[%_,()*:.]/g, " ")
    .trim()
    .replace(/\s+/g, "*");

  const COMPANY_FREE_VISIBLE = 5;

  // ── Fast path: filters/sort/paginate/count entirely in Postgres ────
  // Only for unlimited plans, no company filter, sort in {id, alpha}. If
  // BOTH difficulty and search are set we can't express them as one
  // `.or()` (a 2nd `.or()` overwrites the 1st) → fall through to Node.
  const fastPath =
    unlimited &&
    companies.length === 0 &&
    (sort === "id" || sort === "alpha") &&
    !(difficulties.length && search);

  if (fastPath) {
    // SQL-side path: filters/sort/paginate/count in Postgres; estimated count -> pageCount approximate.
    let q = supabaseAdmin
      .from("leetcode_company_problems")
      .select("id, title, difficulty, link, company, topics", {
        count: "estimated",
      });
    if (difficulties.length) {
      // stored `difficulty` is upper/mixed case; ilike is case-insensitive.
      q = q.or(difficulties.map((d) => `difficulty.ilike.${d}`).join(","));
    } else if (search) {
      q = q.or(`title.ilike.*${esc}*,topics.ilike.*${esc}*`);
    }
    q =
      sort === "alpha"
        ? q.order("title", { ascending: true })
        : q.order("id", { ascending: true });
    q = q.range(offset, offset + pageSize - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    const items = normalizeDsa(data || []);
    const total = count ?? items.length;
    return {
      items,
      total,
      locked: 0,
      lockedCount: 0,
      companyLock: false,
      limit: serializeLimit(limit),
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      filteredCount: total,
    };
  }

  // ── Cases that still need the whole table in memory ───────────────
  //   - free user filtering by company  → freemium 5-row + count
  //   - unlimited but not the fast path → company filter, difficulty
  //     sort, or a difficulty+search combo we can't push down.
  const needsFullSet =
    (!unlimited && companies.length > 0) || (unlimited && !fastPath);

  if (needsFullSet) {
    // The whole table is the same for every filter combo, so it's cached
    // once (10 min) under its own key instead of being re-paged out of
    // Supabase in 1000-row round trips for each new company/sort/search key.
    const rowsAll = await getAllDsaRows();
    const total = rowsAll.length;

    // Company-filter freemium: filter the FULL set first, then return 5
    // full rows + a COUNT of the rest (no premium row data leaves).
    if (!unlimited && companies.length > 0) {
      const matched = filterSortDsa(rowsAll, {
        search,
        companies,
        difficulties,
        sort,
      });
      const items = matched.slice(0, COMPANY_FREE_VISIBLE);
      const lockedCount = Math.max(0, matched.length - COMPANY_FREE_VISIBLE);
      return {
        items,
        total,
        locked: lockedCount,
        lockedCount, // explicit: render this many placeholder cards
        companyLock: true, // client: per-question lock cards, not a LockedSlice row
        limit: serializeLimit(limit),
        page: 1,
        pageSize,
        pageCount: 1,
        filteredCount: matched.length,
      };
    }

    // Unlimited + (company filter | difficulty sort | difficulty+search):
    // filter/sort/paginate in Node against the full set.
    const filtered = filterSortDsa(rowsAll, {
      search,
      companies,
      difficulties,
      sort,
    });
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const pageOut = Math.min(page, pageCount);
    const items = filtered.slice(
      (pageOut - 1) * pageSize,
      pageOut * pageSize,
    );
    return {
      items,
      total,
      locked: 0,
      lockedCount: 0,
      companyLock: false,
      limit: serializeLimit(limit),
      page: pageOut,
      pageSize,
      pageCount,
      filteredCount: filtered.length,
    };
  }

  // ── Free, no company filter ──────────────────────────────────────
  // Only the first `cap` rows are ever visible, so fetch just those
  // instead of the whole table.
  const capN = Math.min(limit, 500);
  const [{ data: capRows, error: capErr }, { count: totalCount }] = await Promise.all([
    supabaseAdmin
      .from("leetcode_company_problems")
      .select("id, title, difficulty, link, company, topics")
      .order("id", { ascending: true })
      .range(0, capN - 1),
    supabaseAdmin
      .from("leetcode_company_problems")
      .select("id", { count: "estimated", head: true }),
  ]);
  if (capErr) throw capErr;
  const rowsAll = normalizeDsa(capRows || []);
  const total = totalCount ?? rowsAll.length;

  const filtered = filterSortDsa(rowsAll, {
    search,
    companies,
    difficulties,
    sort,
  });
  const locked = Math.max(0, total - limit);
  return {
    items: filtered, // free: capped preview, no pagination
    total,
    locked,
    lockedCount: locked,
    companyLock: false,
    limit: serializeLimit(limit),
    page: 1,
    pageSize,
    pageCount: 1,
    filteredCount: filtered.length,
  };
}

// GET /api/catalog/dsa?search=&company=&difficulty=&sort=&page=
// Free cap is on the CATALOG (first N rows by id asc), applied BEFORE the
// caller's filter/sort — so a free user can never page or filter their way to
// row N+1. pro/max (Infinity) get the full filtered + paged set.
app.get("/api/catalog/dsa", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    // Plan resolves outside the cache; it varies the cache key.
    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const key = `dsa:${plan}:${qsKey(req)}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 120000, () =>
      buildDsaCatalogPayload({
        plan,
        search: String(req.query.search || "").slice(0, 200),
        companies: csvParam(req.query.company),
        // whitelist: only easy|medium|hard ever reaches the PostgREST .or() filter
        difficulties: csvParam(req.query.difficulty)
          .map((d) => d.toLowerCase())
          .filter((d) => ["easy", "medium", "hard"].includes(d))
          .map((d) => d.charAt(0).toUpperCase() + d.slice(1)),
        sort: ["alpha", "difficulty", "id"].includes(String(req.query.sort))
          ? String(req.query.sort)
          : "id",
        page: Math.max(1, parseInt(req.query.page, 10) || 1),
      }),
    );

    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/dsa", "Failed to load catalog.");
  }
});

// GET /api/catalog/lld?search=&company=&page=
// Extracted from the /api/catalog/lld route — same reasoning as
// buildDsaCatalogPayload above (reused by the SSR initial-data embed).
async function buildLldCatalogPayload({ plan, search, companies, page }) {
  const limit = getLimit(plan, "lld_catalog_visible");
  const unlimited = isUnlimited(limit);
  const pageSize = 12;
  const offset = (page - 1) * pageSize;

  // Same PostgREST search token sanitizer as /api/catalog/dsa.
  const esc = search
    .replace(/[%_,()*:.]/g, " ")
    .trim()
    .replace(/\s+/g, "*");

  // Apply the shared search + company array filters to a query builder.
  // `companies` is a real text[] column → `.contains` (@>) for one value,
  // `.overlaps` (&&) for any-of, matching the old `.some()` semantics.
  const applyFilters = (q) => {
    if (search) q = q.or(`title.ilike.*${esc}*,requirements.ilike.*${esc}*`);
    if (companies.length === 1) q = q.contains("companies", [companies[0]]);
    else if (companies.length > 1) q = q.overlaps("companies", companies);
    return q;
  };

  if (unlimited) {
    // Full SQL-side path: filter / sort / paginate / count in Postgres;
    // estimated count -> pageCount approximate.
    let q = supabaseAdmin
      .from("lld_problems")
      .select("id, slug, title, requirements, companies, created_at", {
        count: "estimated",
      })
      .order("created_at", { ascending: false });
    q = applyFilters(q).range(offset, offset + pageSize - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    const items = data || [];
    const total = count ?? items.length;
    return {
      items,
      total,
      locked: 0,
      limit: serializeLimit(limit),
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      filteredCount: total,
    };
  }

  // ── Free: old semantics = first `cap` rows by created_at desc, THEN
  // filtered. `cap` is tiny (e.g. 3) so filter those in Node. ──
  const cap = Math.max(0, limit);
  let capRows = [];
  if (cap > 0) {
    const { data, error } = await supabaseAdmin
      .from("lld_problems")
      .select("id, slug, title, requirements, companies, created_at")
      .order("created_at", { ascending: false })
      .range(0, cap - 1);
    if (error) throw error;
    capRows = data || [];
  }
  const { count: totalCount } = await supabaseAdmin
    .from("lld_problems")
    .select("id", { count: "estimated", head: true });
  const total = totalCount ?? capRows.length;

  const s = search.toLowerCase();
  const filtered = capRows.filter((p) => {
    if (
      search &&
      !(p.title || "").toLowerCase().includes(s) &&
      !(p.requirements || "").toLowerCase().includes(s)
    )
      return false;
    if (
      companies.length &&
      !companies.some((c) => (p.companies || []).includes(c))
    )
      return false;
    return true;
  });

  const locked = Math.max(0, total - cap);
  return {
    items: filtered,
    total,
    locked,
    limit: serializeLimit(limit),
    page: 1,
    pageSize,
    pageCount: 1,
    filteredCount: filtered.length,
  };
}

// GET /api/catalog/lld?search=&company=&page=
app.get("/api/catalog/lld", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const key = `lld:${plan}:${qsKey(req)}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 120000, () =>
      buildLldCatalogPayload({
        plan,
        search: String(req.query.search || "").slice(0, 200),
        companies: csvParam(req.query.company),
        page: Math.max(1, parseInt(req.query.page, 10) || 1),
      }),
    );

    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/lld", "Failed to load catalog.");
  }
});

// GET /api/catalog/lld/:slug  → full problem row, gated by lld_catalog_visible.
// Parallel to /api/catalog/hld/:id. The client still fetches lld_code_files /
// lld_class_diagrams via its own RLS-scoped queries — only the problem row
// itself goes through here.
app.get("/api/catalog/lld/:slug", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const limit = getLimit(plan, "lld_catalog_visible");
    const unlimited = isUnlimited(limit);
    const slug = String(req.params.slug);

    // Gate first, outside the cache — the 404 + 403 paths are never cached.
    const { data: row, error } = await supabaseAdmin
      .from("lld_problems")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: "not_found" });

    if (!unlimited) {
      // Free: allowed set = first N rows by created_at desc (same ordering the
      // /api/catalog/lld list uses).
      const { data: allowed, error: aerr } = await supabaseAdmin
        .from("lld_problems")
        .select("slug")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (aerr) throw aerr;

      const inAllowed = (allowed || []).some((r) => r.slug === slug);
      if (!inAllowed) {
        return res.status(403).json({
          error: "upgrade_required",
          feature: "lld_catalog",
          limit,
        });
      }
    }

    // 200 path only: cache the resolved item per plan + slug.
    const key = `lld-detail:${plan}:${slug}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 300000, () => ({ item: row }));
    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/lld/:slug", "Failed to load problem.");
  }
});

// Extracted from the /api/catalog/hld route — same reasoning as
// buildDsaCatalogPayload above (reused by the SSR initial-data embed).
async function buildHldCatalogPayload({ plan }) {
  const access = getLimit(plan, "hld_catalog_access"); // 'list_only' | 'full'

  // Lean column list — only what the two maps below and HLDListPage.jsx
  // actually read (id, title, description, slug, difficulty, companies).
  // `hld_questions` has no title/slug/questionid/company columns, so the
  // display title comes from `question` and the slug is just the id.
  const { data, error } = await supabaseAdmin
    .from("hld_questions")
    .select("id, question, description, difficulty, companies, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];

  // The full list is returned to every tier; HLDListPage filters + paginates
  // client-side (12/page) to match the LLD panel's pagination UX.
  if (access === "list_only") {
    const items = rows.map((r) => ({
      id: r.id,
      title: r.question || "(Untitled)",
      companies: r.companies || [],
      difficulty: r.difficulty || null,
      locked: true,
    }));
    return { items, total: rows.length, locked: rows.length, access };
  }

  const items = rows.map((r) => ({
    id: r.id,
    title: r.question || "(Untitled)",
    description: r.description || "",
    companies: r.companies || [],
    slug: String(r.id),
    difficulty: r.difficulty || null,
    locked: false,
  }));
  return { items, total: rows.length, locked: 0, access };
}

// GET /api/catalog/hld
// list_only (free): full list, every item { locked: true }, premium fields stripped.
// full (pro/max): normal rows.
app.get("/api/catalog/hld", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const key = `hld:${plan}:${qsKey(req)}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 120000, () => buildHldCatalogPayload({ plan }));

    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/hld", "Failed to load catalog.");
  }
});

// GET /api/catalog/hld/:id  → gated on canAccess('hld_practice')
app.get("/api/catalog/hld/:id", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const gate = req.user
      ? await canAccess(req.user.id, "hld_practice")
      : { allowed: false, plan: "free", reason: "upgrade_required" };
    if (!gate.allowed) {
      return res.status(403).json({
        error: "upgrade_required",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }

    // Gate passed (outside the cache); cache only the successful item fetch,
    // keyed on the plan from the gate result.
    const key = `hld-detail:${gate.plan}:${req.params.id}`;
    const wasHit = hasFresh(key);
    let notFound = false;
    const payload = await cached(key, 300000, async () => {
      const { data, error } = await supabaseAdmin
        .from("hld_questions")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        const e = new Error("not_found");
        e.notFound = true;
        throw e; // 404: not cached (rejection), surfaced below
      }
      return {
        item: {
          ...data,
          title: data.title || data.question || "(Untitled)",
          description: data.description || "",
          companies: data.companies || data.company || [],
          slug: data.slug || data.questionid || String(data.id),
          difficulty: data.difficulty || null,
        },
      };
    }).catch((e) => {
      if (e && e.notFound) {
        notFound = true;
        return null;
      }
      throw e;
    });

    if (notFound) return res.status(404).json({ error: "not_found" });

    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/hld/:id", "Failed to load question.");
  }
});

// GET /api/catalog/interview?subcategory=
// No subcategory → { subcategories: [{category, subcategory}] }.
// With subcategory → first N per subcategory by order_number (free & pro);
// max (Infinity) → all.
app.get(
  "/api/catalog/interview",
  catalogLimiter,
  optionalAuth,
  async (req, res) => {
    try {
      const plan = req.user ? await getUserPlan(req.user.id) : "free";
      const key = `interview:${plan}:${qsKey(req)}`;
      const wasHit = hasFresh(key);
      const payload = await cached(key, 300000, async () => {
        const limit = getLimit(plan, "interview_q_per_subcategory");
        const unlimited = isUnlimited(limit);
        const subcategory = String(req.query.subcategory || "").trim();

        if (!subcategory) {
          const { data, error } = await supabaseAdmin
            .from("interview_questions")
            .select("category, subcategory")
            .order("category")
            .order("subcategory");
          if (error) throw error;
          const seen = new Set();
          const subs = [];
          for (const r of data || []) {
            const k = `${r.category}||${r.subcategory}`;
            if (!seen.has(k)) {
              seen.add(k);
              subs.push(r);
            }
          }
          return { subcategories: subs };
        }

        const { data, error } = await supabaseAdmin
          .from("interview_questions")
          .select("id, question, order_number, answer_status, category, subcategory")
          .eq("subcategory", subcategory)
          .order("order_number")
          .order("id", { ascending: true });
        if (error) throw error;
        const rowsAll = data || [];
        const total = rowsAll.length;

        let items = rowsAll;
        let locked = 0;
        if (!unlimited) {
          items = rowsAll.slice(0, limit);
          locked = Math.max(0, total - items.length);
        }

        return { items, total, locked, limit: serializeLimit(limit) };
      });

      res.set("Cache-Control", PLAN_GATED_CACHE);
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      fail(res, err, "catalog/interview", "Failed to load questions.");
    }
  },
);

// GET /api/catalog/interview/answer/:id — one question's answer, gated to the
// same free-tier "first N per subcategory" window as the list route above.
// interview_questions RLS only grants SELECT to `authenticated` (the answer
// text is paid content), so a direct Supabase read from the browser returns
// nothing for a logged-out visitor even on one of their free questions — this
// route is the server-authoritative path for both anon and signed-in users.
app.get(
  "/api/catalog/interview/answer/:id",
  catalogLimiter,
  optionalAuth,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const plan = req.user ? await getUserPlan(req.user.id) : "free";
      const key = `interview-answer:${plan}:${id}`;
      const wasHit = hasFresh(key);
      const payload = await cached(key, 300000, async () => {
        const { data: row, error } = await supabaseAdmin
          .from("interview_questions")
          .select("id, subcategory, order_number, answer, answer_status, chart_config")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!row) return { status: "not_found" };

        const limit = getLimit(plan, "interview_q_per_subcategory");
        if (!isUnlimited(limit)) {
          // Same ordering as the list route's slice(0, limit) — re-derive the
          // allowed id set for this subcategory and confirm `id` is in it.
          const { data: allowed, error: aerr } = await supabaseAdmin
            .from("interview_questions")
            .select("id")
            .eq("subcategory", row.subcategory)
            .order("order_number")
            .order("id", { ascending: true })
            .limit(limit);
          if (aerr) throw aerr;
          const isAllowed = (allowed || []).some((r) => String(r.id) === id);
          if (!isAllowed) return { status: "locked", limit: serializeLimit(limit) };
        }

        return {
          status: "ok",
          answer: row.answer,
          answer_status: row.answer_status,
          chart_config: row.chart_config,
        };
      });

      if (payload.status === "not_found") return res.status(404).json({ error: "not_found" });
      if (payload.status === "locked") {
        return res.status(403).json({ error: "upgrade_required", feature: "interview_q", limit: payload.limit });
      }
      res.set("Cache-Control", PLAN_GATED_CACHE);
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json({ answer: payload.answer, answer_status: payload.answer_status, chart_config: payload.chart_config });
    } catch (err) {
      fail(res, err, "catalog/interview/answer", "Failed to load answer.");
    }
  },
);

// GET /api/catalog/search?q=&limit=
// Server-side jump-to-problem search for the command palette. The tier cap is
// applied to the CATALOG (first N rows, same ordering as /api/catalog/dsa and
// /api/catalog/lld) BEFORE the text match — so a free user's search can never
// surface a capped-out problem.
app.get("/api/catalog/search", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 6));
    if (!q) return res.json({ dsa: [], lld: [] });

    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const key = `search:${plan}:${qsKey(req)}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 120000, async () => {
      const dsaLimit = getLimit(plan, "dsa_catalog_visible");
      const lldLimit = getLimit(plan, "lld_catalog_visible");

      // DSA — first N by id asc.
      const dsaAll = normalizeDsa(
        await fetchAllRows(
          "leetcode_company_problems",
          "id, title, difficulty, link",
          "id",
          true,
        ),
      );
      const dsaVisible = isUnlimited(dsaLimit)
        ? dsaAll
        : dsaAll.slice(0, Math.min(dsaLimit, dsaAll.length));
      const dsa = dsaVisible
        .filter((p) => (p.title || "").toLowerCase().includes(q))
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          title: p.title,
          difficulty: p.difficulty,
          link: p.link,
        }));

      // LLD — first N by created_at desc.
      const { data: lldRows, error } = await supabaseAdmin
        .from("lld_problems")
        .select("id, slug, title, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const lldVisible = isUnlimited(lldLimit)
        ? lldRows || []
        : (lldRows || []).slice(0, Math.min(lldLimit, (lldRows || []).length));
      const lld = lldVisible
        .filter((p) => (p.title || "").toLowerCase().includes(q))
        .slice(0, limit)
        .map((p) => ({ id: p.id, title: p.title, slug: p.slug }));

      return { dsa, lld };
    });

    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "catalog/search", "Search failed.");
  }
});

// GET /api/catalog/companies → { companies: string[] }
// Distinct company names across the DSA + LLD catalogs, for the filter dropdown.
// Company names are low-sensitivity, so no tier gate — but the read still goes
// through the service role (the base tables are not client-readable).
app.get(
  "/api/catalog/companies",
  catalogLimiter,
  optionalAuth,
  async (_req, res) => {
    try {
      const wasHit = hasFresh("catalog-companies");
      const payload = await cached("catalog-companies", 600000, async () => {
        const [lldRes, dsaRows] = await Promise.all([
          supabaseAdmin.from("lld_problems").select("companies"),
          fetchAllRows("leetcode_company_problems", "id, company", "id", true),
        ]);
        if (lldRes.error) throw lldRes.error;

        const set = new Set();
        for (const r of lldRes.data || []) {
          for (const c of r.companies || []) if (c) set.add(String(c).trim());
        }
        for (const r of normalizeDsa(dsaRows)) {
          for (const c of r.company || []) if (c) set.add(String(c).trim());
        }
        return { companies: [...set].filter(Boolean).sort() };
      });

      res.set(
        "Cache-Control",
        "public, max-age=300, s-maxage=600, stale-while-revalidate=1200",
      );
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      fail(res, err, "catalog/companies", "Failed to load companies.");
    }
  },
);

// GET /api/stats/overview → pre-aggregated numbers for the Profile "Progress
// Overview". Everything catalog-derived (totals, per-difficulty + per-topic
// counts, company readiness) is computed here with the service-role client so
// no per-row catalog data reaches the browser. The caller's own progress rows
// (solved counts, recent activity) stay on the RLS-scoped client query.
app.get("/api/stats/overview", requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;

    const [norm, lldCount, hldCount, progRows, readinessRes] =
      await Promise.all([
        getAllDsaRows(),
        // Catalog sizes change only on content deploys: cache the head counts
        // alongside the cached DSA rows instead of two COUNTs per request.
        cached("stats:lld-count", 600000, async () => {
          const r = await supabaseAdmin.from("lld_problems").select("*", { count: "exact", head: true });
          if (r.error) throw r.error;
          return { count: r.count || 0 };
        }),
        cached("stats:hld-count", 600000, async () => {
          const r = await supabaseAdmin.from("hld_questions").select("*", { count: "exact", head: true });
          if (r.error) throw r.error;
          return { count: r.count || 0 };
        }),
        fetchAllPaged(() =>
          supabaseAdmin
            .from("user_problem_progress")
            .select("problem_id, status")
            .eq("user_id", uid)
            .eq("problem_type", "dsa")
            .order("problem_id", { ascending: true }),
        ),
        supabaseAdmin.rpc("get_company_readiness", { p_user_id: uid }),
      ]);

    const solved = new Set(
      (progRows || [])
        .filter((r) => r.status === "solved")
        .map((r) => r.problem_id),
    );

    const difficulty = ["Easy", "Medium", "Hard"].map((d) => {
      const inD = norm.filter((p) => p.difficulty === d);
      return {
        d,
        total: inD.length,
        done: inD.filter((p) => solved.has(p.id)).length,
      };
    });

    const topicMap = {};
    for (const p of norm) {
      for (const t of String(p.topics || "").split(",")) {
        const topic = t.trim();
        if (!topic) continue;
        if (!topicMap[topic]) topicMap[topic] = { total: 0, solved: 0 };
        topicMap[topic].total++;
        if (solved.has(p.id)) topicMap[topic].solved++;
      }
    }
    const topics = Object.entries(topicMap).map(([topic, s]) => ({
      topic,
      total: s.total,
      solved: s.solved,
    }));

    res.json({
      totals: {
        dsa: norm.length,
        lld: lldCount.count || 0,
        hld: hldCount.count || 0,
      },
      difficulty,
      topics,
      readiness: readinessRes.error ? [] : readinessRes.data || [],
    });
  } catch (err) {
    fail(res, err, "stats/overview", "Failed to load stats.");
  }
});

// ── Jobs board ───────────────────────────────────────────────────
// Read-only view of the crawler-populated jobs table (see
// C:\Users\debna\Downloads\job-crawler — schema in src/pgpipe/schema.sql).
// The crawler owns the schema; this endpoint only reads it.
//
// The crawler writes into a dedicated Postgres schema `crawler` (not `public`).
// For supabase-js to reach it, add `crawler` to the project's exposed schemas:
//   Supabase dashboard → Settings → API → "Exposed schemas" → add `crawler`.
// If you later move the crawler to `public` (only after a clean collision
// check), set JOBS_SCHEMA=public in the server env.
const JOBS_PAGE_SIZE = 20;
const JOBS_SCHEMA = process.env.JOBS_SCHEMA || "crawler";
const JOBS_TABLE = "job_posting";

function jobsDb() {
  return JOBS_SCHEMA && JOBS_SCHEMA !== "public"
    ? supabaseAdmin.schema(JOBS_SCHEMA)
    : supabaseAdmin;
}

// Map a raw crawler.job_posting row + resolved company name -> the shape
// JobsPage.jsx renders. `companyTypeBySlug` is optional (a Map or plain
// object) — omitted when the caller never needed company_type for this
// request (e.g. no weighting/filter applied), in which case companyType is
// just left blank rather than forcing an extra lookup.
function normalizeJob(row, companyNameBySlug, companyTypeBySlug) {
  const company =
    (companyNameBySlug && companyNameBySlug[row.company_slug]) ||
    row.company_slug ||
    "";
  let locationType = String(row.location_type || "").toLowerCase();
  if (locationType === "telecommute") locationType = "remote"; // schema.org enum leak
  if (locationType === "on_site") locationType = "onsite";
  const companyType = companyTypeBySlug
    ? (companyTypeBySlug instanceof Map ? companyTypeBySlug.get(row.company_slug) : companyTypeBySlug[row.company_slug]) || ""
    : "";
  return {
    id: row.id,
    title: String(row.title || (Array.isArray(row.titles) && row.titles[0]) || ""),
    company: String(company || ""),
    companySlug: row.company_slug || "",
    companyType,
    location: row.location || "",
    locationType,
    country: row.country || "",
    seniority: row.seniority || "",
    employmentType: row.employment_type || "",
    url: row.url || "",
    source: row.source || "",
    firstSeen: row.first_seen_at || null,
    lastSeen: row.last_seen_at || null,
    postedAt: row.posted_at || null,
    status: row.status || "open",
  };
}

const SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "staff", "principal", "unknown"];

// The first crawl stamps nearly-identical first_seen_at on many rows, so a
// plain "newest" sort dumps one company's whole board in a block. Pull a
// bounded pool of the freshest rows and greedily re-space it — keeping the
// recency order otherwise — so no two postings from the same company land
// within JOBS_SPREAD_GAP of each other. Pages past the pool fall back to raw
// DB order.
const JOBS_INTERLEAVE_POOL = 1000;
// At least 8 other companies' postings between two from the same company.
const JOBS_SPREAD_GAP = 8;
// Hard age cap: the board only serves jobs actually POSTED in the last N
// days (posted_at, parsed from the source ATS's own date — not first_seen_at,
// which is when WE discovered the row and can lag the real posting date by
// a lot). Storage retention/cleanup is a separate, first_seen_at-based
// concern in the crawler (PGPIPE_MAX_AGE_DAYS) — this constant governs what's
// user-visible, not what's stored.
const JOBS_MAX_AGE_DAYS = Number(process.env.JOBS_MAX_AGE_DAYS) || 1;
const jobsMaxAgeISO = () => new Date(Date.now() - JOBS_MAX_AGE_DAYS * 86400000).toISOString();

// ── /jobs/company/:slug — programmatic per-company hub page ────────
// P1 "page factory": turns the crawler's ~14,880 open postings into real
// indexable per-company pages instead of leaving them buried in one
// client-filtered list. Launch is deliberately conservative — a domain that
// was fully deindexed until this week doesn't need a thin-content flag from
// 500 sparse company pages on day one, so only the top JOBS_COMPANY_CURATED_N
// companies by open-posting volume are even candidates for index,follow;
// every other valid company slug still gets a real page, just noindex,follow
// (see evaluateJobHubIndexability in lib/seoHead.js for the rest of the gate).
const JOBS_COMPANY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
const JOBS_COMPANY_CURATED_N = Number(process.env.JOBS_COMPANY_CURATED_N) || 50;

async function getCuratedJobsCompanySlugs() {
  // 6h TTL — matches the growth CLI's page-factory cron cadence; this is a
  // volume ranking, not per-request-fresh data.
  return cached("jobs-company:curated", 21_600_000, async () => {
    const { data } = await jobsDb()
      .from(JOBS_TABLE)
      .select("company_slug")
      .eq("status", "open")
      .gte("posted_at", jobsMaxAgeISO())
      .limit(20_000);
    const counts = new Map();
    for (const row of data || []) {
      if (!row.company_slug) continue;
      counts.set(row.company_slug, (counts.get(row.company_slug) || 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, JOBS_COMPANY_CURATED_N)
        .map(([slug]) => slug),
    );
  });
}

// Returns null for an unknown company slug, else the full page payload
// (postings + the resolved indexability decision). Cached per-slug so the
// JSON API and the HTML shell route share one query instead of doubling up.
async function getJobsCompanyPayload(slug) {
  return cached(`jobs-company:${slug}`, 300_000, async () => {
    const { data: company } = await jobsDb()
      .from("company")
      .select("slug, name")
      .eq("slug", slug)
      .maybeSingle();
    if (!company) return null;

    const { data: rows } = await jobsDb()
      .from(JOBS_TABLE)
      .select("id, company_slug, title, location, location_type, employment_type, url, source, first_seen_at, last_seen_at, posted_at, status, seniority")
      .eq("status", "open")
      .eq("company_slug", slug)
      .gte("posted_at", jobsMaxAgeISO())
      .order("posted_at", { ascending: false })
      .limit(300);

    const postings = (rows || []).filter((r) => r.url);
    const recordCount = postings.length;
    const completeRecordCount = postings.filter((r) => r.title && r.location).length;
    const uniqueFactCount = new Set(postings.map((r) => `${r.title}|${r.location}`)).size;
    // Rough but honest proxy for what the rendered page actually contains:
    // every posting's title + location, plus a fixed allowance for the
    // intro/outro copy JobsCompanyPage.jsx renders around the list.
    const substantiveWordCount =
      postings.reduce((sum, r) => sum + String(r.title || "").split(/\s+/).filter(Boolean).length + String(r.location || "").split(/\s+/).filter(Boolean).length, 0) + 60;
    const newestSeenAt = postings.reduce((max, r) => Math.max(max, Date.parse(r.first_seen_at) || 0), 0);
    const newestAgeDays = newestSeenAt ? (Date.now() - newestSeenAt) / 86_400_000 : Number.POSITIVE_INFINITY;

    const curatedSlugs = await getCuratedJobsCompanySlugs();
    const decision = evaluateJobHubIndexability({
      recordCount,
      completeRecordCount,
      uniqueFactCount,
      substantiveWordCount,
      newestAgeDays,
      curated: curatedSlugs.has(slug),
    });

    return {
      company: { slug: company.slug, name: company.name || humanizeSlugFallback(slug) },
      postings: postings.map((r) => normalizeJob(r, {})),
      eligible: decision.eligible,
      reasons: decision.reasons,
    };
  });
}

// Cosmetic fallback only — mirrors lib/seoHead.js's humanizeSlug() for the
// rare case a company row exists with no display name set.
function humanizeSlugFallback(slug) {
  return String(slug || "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ── Country / company-type weighting on the default feed ───────────────
// crawler.job_posting.country and crawler.company.company_type (joined via
// company_slug -> company.slug) let the DEFAULT "Latest first" feed softly
// favor product companies and Indian postings without ever hard-quota-ing a
// page — see weightedStrataMerge() below. company_type isn't a job_posting
// column, so an explicit `company_type` filter is resolved to a slug list
// first (bounded — ~a few hundred companies) and applied as an `.in()`.
const COMPANY_TYPES = ["product", "startup", "service"]; // valid explicit-filter values (unknown is default-only)
const COMPANY_TYPE_WEIGHT = { product: 0.6, startup: 0.3, service: 0.1, unknown: 0.05 };
const COUNTRIES = ["US", "IN"];
const COUNTRY_WEIGHT = { US: 0.3, IN: 0.7 };

// slug -> company_type ('unknown' when unset), cached — this table is small
// (~hundreds of companies) so a full scan is cheap and reused across the
// explicit filter, the weighting below, and (indirectly) the analytics tab.
async function getCompanyTypeMap() {
  return cached("jobs:company-types", 300000, async () => {
    const { data, error } = await jobsDb().from("company").select("slug, company_type").limit(20000);
    if (error) throw error;
    const map = new Map();
    for (const row of data || []) {
      if (row.slug) map.set(row.slug, row.company_type || "unknown");
    }
    return map;
  });
}

// Deterministic smooth weighted round-robin merge (the algorithm nginx uses
// for weighted upstream balancing): rows are bucketed into strata by
// `keyWeightFn`, each stratum keeps its incoming (recency) order, and on every
// round the stratum with the highest accrued credit emits its next row and is
// discounted by the total weight. This softly biases composition toward the
// configured ratios — a stratum that runs out is just skipped — without ever
// enforcing a hard per-page quota.
function weightedStrataMerge(rows, keyWeightFn) {
  const groups = new Map(); // key -> { items, weight, current, cursor }
  for (const row of rows) {
    const { key, weight } = keyWeightFn(row);
    let g = groups.get(key);
    if (!g) {
      g = { items: [], weight: Math.max(weight, 0.0001), current: 0, cursor: 0 };
      groups.set(key, g);
    }
    g.items.push(row);
  }
  if (groups.size <= 1) return rows.slice();

  const totalWeight = [...groups.values()].reduce((s, g) => s + g.weight, 0);
  const out = [];
  while (out.length < rows.length) {
    let pick = null;
    for (const g of groups.values()) {
      if (g.cursor >= g.items.length) continue; // stratum exhausted — skip, no quota to enforce
      g.current += g.weight;
      if (!pick || g.current > pick.current) pick = g;
    }
    if (!pick) break; // shouldn't happen while out.length < rows.length, but stay safe
    out.push(pick.items[pick.cursor++]);
    pick.current -= totalWeight;
  }
  return out;
}

// Per-row (company_type, country) stratum + its combined weight, for the
// default "Latest first" feed. When a request has already hard-filtered one
// axis to a single value (explicit company_type or country filter), every row
// shares the same weight on that axis, so this naturally stops influencing
// that dimension — exactly the "explicit filter overrides the default
// weighting for that dimension" behavior.
function jobStratumOf(row, companyTypeMap) {
  const type = (companyTypeMap && companyTypeMap.get(row.company_slug)) || "unknown";
  const country = COUNTRIES.includes(row.country) ? row.country : "IN";
  const weight = (COMPANY_TYPE_WEIGHT[type] ?? COMPANY_TYPE_WEIGHT.unknown) * (COUNTRY_WEIGHT[country] ?? 0.5);
  return { key: `${type}|${country}`, weight };
}

// Lightweight fuzzy matcher for facet autocomplete (no pg_trgm dependency).
// exact > prefix > substring > in-order subsequence; higher is better, <=0 = no match.
// TODO: if location cardinality grows large, back this with a pg_trgm index + RPC.
function fuzzyScore(query, target) {
  const q = String(query || "").toLowerCase().trim();
  const t = String(target || "").toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 700 - idx - t.length * 0.1;
  let ti = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const c of q) {
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === c) { found = k; break; }
    }
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 1;
    if (streak > best) best = streak;
    hits += 1;
    ti = found + 1;
  }
  return 200 + best * 10 - (t.length - hits);
}

function rankFacet(candidates, q, limit) {
  const uniq = [...new Set(candidates.filter(Boolean))];
  if (!q) return uniq.sort((a, b) => a.localeCompare(b)).slice(0, limit);
  return uniq
    .map((c) => [fuzzyScore(q, c), c])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, c]) => c);
}

// Light "means-the-same" expansion for the free-text job search — no embeddings.
// A query that is / contains a key also matches its synonyms. Keys with a space
// match as a substring; single-word keys match a whole token.
const SEARCH_SYNONYMS = {
  ml: ["machine learning"],
  "machine learning": ["ml"],
  ai: ["artificial intelligence"],
  llm: ["large language model", "genai"],
  genai: ["generative ai", "llm"],
  nlp: ["natural language processing"],
  researcher: ["research", "scientist"],
  research: ["researcher", "scientist"],
  scientist: ["research", "researcher"],
  analyst: ["analytics"],
  analytics: ["analyst"],
  quant: ["quantitative"],
  quantitative: ["quant"],
  sde: ["software engineer", "software developer"],
  swe: ["software engineer"],
  sre: ["site reliability", "reliability engineer"],
  devops: ["platform engineer", "infrastructure engineer"],
  security: ["cybersecurity", "infosec"],
  cybersecurity: ["security", "infosec"],
  infosec: ["information security", "security"],
  pentest: ["penetration testing", "offensive security"],
  frontend: ["front end", "front-end"],
  backend: ["back end", "back-end"],
  fullstack: ["full stack", "full-stack"],
  qa: ["quality assurance", "sdet"],
};

// Strip everything that is significant to the PostgREST `.or()` grammar or to
// to_tsquery so a raw query string is safe to splice into an or-filter.
function sanitizeOrValue(s) {
  return String(s).replace(/[[\]%_,()*:.&|!'"<>]/g, " ").trim().replace(/\s+/g, " ");
}

// PostgREST `.or()` string: websearch full-text on search_tsv OR substring on
// title, for the query plus any synonym expansions. Gives prefix / partial /
// "close enough" matching that plain FTS on its own misses.
function buildSearchOr(raw) {
  const base = sanitizeOrValue(raw).toLowerCase().slice(0, 80);
  if (!base) return "";
  const tokens = base.split(" ");
  const terms = new Set([base]);
  for (const [key, syns] of Object.entries(SEARCH_SYNONYMS)) {
    const hit = key.includes(" ") ? base.includes(key) : tokens.includes(key);
    if (hit) syns.forEach((s) => terms.add(s));
    if (terms.size > 6) break;
  }
  const parts = [];
  for (const t of terms) {
    const clean = sanitizeOrValue(t);
    if (!clean) continue;
    parts.push(`search_tsv.wfts(english).${clean.replace(/ /g, "+")}`);
    parts.push(`title.ilike.*${clean.replace(/ /g, "*")}*`);
  }
  return parts.join(",");
}

function jobsNotReady(res) {
  return res.json({
    items: [],
    total: 0,
    page: 1,
    pageCount: 1,
    facets: { sources: [], locationTypes: ["remote", "hybrid", "onsite"], seniorities: SENIORITY_ORDER },
    notReady: true,
  });
}

app.get("/api/jobs", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const plan = req.user ? await getUserPlan(req.user.id) : "free";
    const jobsLimit = getLimit(plan, "jobs_visible");
    const jobsUnlimited = isUnlimited(jobsLimit);
    const key = `jobs:${plan}:${qsKey(req)}`;
    const wasHit = hasFresh(key);
    // TTL covers the whole response — the 600-row interleave pool + company
    // spacing + company-name resolve are all re-used from cache within 90s.
    const payload = await cached(key, 90000, async () => {
      const search = String(req.query.search || "").trim().slice(0, 120);
      const company = String(req.query.company || "").trim().slice(0, 80);
      // `location` may be a comma-separated list — any match keeps the row.
      const locations = String(req.query.location || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((s) => s.slice(0, 80));
      const locationType = String(req.query.location_type || "")
        .trim()
        .toLowerCase()
        .slice(0, 20);
      const source = String(req.query.source || "").trim().slice(0, 40);
      const seniority = String(req.query.seniority || "").trim().toLowerCase().slice(0, 20);
      const postedWithinDays = Math.max(0, Math.min(31, parseInt(req.query.posted_within, 10) || 0));
      // Explicit overrides for the two weighted axes (see jobStratumOf below).
      // company_type isn't a job_posting column, so it's resolved to a slug
      // list before the query runs. country IS a column — 'other' is never a
      // valid explicit value since it's excluded by the hard filter below.
      const companyType = COMPANY_TYPES.includes(String(req.query.company_type || "").trim().toLowerCase())
        ? String(req.query.company_type).trim().toLowerCase()
        : "";
      const countryFilter = COUNTRIES.includes(String(req.query.country || "").trim().toUpperCase())
        ? String(req.query.country).trim().toUpperCase()
        : "";
      const sort = String(req.query.sort || "newest").trim();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const from = (page - 1) * JOBS_PAGE_SIZE;
      const to = from + JOBS_PAGE_SIZE - 1;

      // Free tier: the board only ever exposes the first `jobsLimit` postings
      // (by the active sort) — clamp the requested window into that range.
      // `pastCap` = this whole page is beyond the free window (from >= limit).
      const cappedTo = jobsUnlimited ? to : Math.min(to, jobsLimit - 1);
      const pastCap = !jobsUnlimited && from > cappedTo;

      // For the recency sorts, fetch a fixed pool from row 0, company-space it in
      // JS (recency order otherwise preserved), then slice this page out. The
      // pool size never depends on `page`, so boundaries stay stable. The
      // "company" sort is meant to group, so it opts out; pages past the pool
      // use raw range order. `pastCap` on a non-spread sort fetches 1 dummy row
      // (range(0,0)) just to keep `count` accurate — items are discarded below.
      const canSpread = sort === "newest" || sort === "oldest";
      const rangeFrom = canSpread ? 0 : pastCap ? 0 : from;
      const rangeTo = canSpread ? JOBS_INTERLEAVE_POOL - 1 : pastCap ? 0 : cappedTo;
      // The weighted composition (60/30/10 product/startup/service, 30/70
      // US/India) only shapes the DEFAULT "Latest first" feed — "oldest" and
      // "company" sorts stay purely chronological/alphabetical.
      const willWeight = canSpread && sort === "newest";

      // company_type map is needed either to resolve an explicit filter into a
      // slug list, or to weight the default feed — fetch it once, up front,
      // for both. Left null (and skipped) when neither applies.
      let companyTypeMap = null;
      if (companyType || willWeight) {
        try {
          companyTypeMap = await getCompanyTypeMap();
        } catch {
          companyTypeMap = null; // company_type not ready yet — degrade to unweighted/unfiltered
        }
      }
      let companyTypeSlugs = null;
      if (companyType && companyTypeMap) {
        companyTypeSlugs = [...companyTypeMap.entries()]
          .filter(([, t]) => (t || "unknown") === companyType)
          .map(([s]) => s);
      }

      const likeSafe = (s) => s.replace(/[%_,()*]/g, " ");
      // Location values often carry commas ("Bengaluru, Karnataka, India"). Strip
      // the significant chars and wildcard the gaps so a picked value still
      // matches and commas can't break the `.or()` filter list. `.ilike()` (method)
      // uses `%`; the `.or()` string form uses `*` (PostgREST URL wildcard).
      const locCore = (s) => likeSafe(s).trim().replace(/\s+/g, " ");
      const daysAgoISO = (d) => new Date(Date.now() - d * 86400000).toISOString();

      // `seniority` column is added by a later crawler migration — if it's not
      // there yet, retry the query once without selecting or filtering on it.
      const build = (withSeniority, rf = rangeFrom, rt = rangeTo) => {
        const cols =
          "id, company_slug, title, location, location_type, employment_type, url, source, first_seen_at, last_seen_at, posted_at, status, country" +
          (withSeniority ? ", seniority" : "");
        // count=estimated → PostgREST `Prefer: count=estimated`. pageCount is
        // now approximate (fast planner estimate, not an exact scan).
        let q = jobsDb()
          .from(JOBS_TABLE)
          .select(cols, { count: "estimated" })
          .eq("status", "open")
          .gte("posted_at", jobsMaxAgeISO()) // board only serves jobs actually posted ≤ N days ago
          .range(rf, rt);

        if (sort === "oldest") q = q.order("posted_at", { ascending: true }).order("id", { ascending: true });
        else if (sort === "company") q = q.order("company_slug", { ascending: true }).order("posted_at", { ascending: false });
        else q = q.order("posted_at", { ascending: false }).order("id", { ascending: false });

        if (search) {
          const orStr = buildSearchOr(search);
          if (orStr) q = q.or(orStr);
        }
        // company_slug is hyphenated lowercase ("jane-street"); let "Jane Street"
        // match by turning spaces/hyphens into wildcards.
        if (company) q = q.ilike("company_slug", `%${likeSafe(company).trim().replace(/[\s-]+/g, "%")}%`);
        if (locations.length === 1) {
          q = q.ilike("location", `%${locCore(locations[0]).replace(/ /g, "%")}%`);
        } else if (locations.length > 1) {
          q = q.or(locations.map((loc) => `location.ilike.*${locCore(loc).replace(/ /g, "*")}*`).join(","));
        }
        if (locationType) q = q.eq("location_type", locationType);
        if (source) q = q.eq("source", source);
        if (withSeniority && seniority) q = q.eq("seniority", seniority);
        if (postedWithinDays > 0) q = q.gte("posted_at", daysAgoISO(postedWithinDays));
        // Hard filter: the board never serves countries outside US/India. An
        // explicit `country` pick narrows further; otherwise both are in play
        // and the weighted merge below softly favors India (~70%) / US (~30%).
        q = countryFilter ? q.eq("country", countryFilter) : q.in("country", COUNTRIES);
        // company_type isn't a job_posting column — resolved to a slug list
        // up front. An empty match list still needs a filter that returns zero
        // rows rather than skipping the filter entirely.
        if (companyTypeSlugs) {
          // company_slug is always `^[a-z0-9][a-z0-9-]{0,199}$` (see
          // JOBS_COMPANY_SLUG_RE) — an underscore never occurs in a real slug,
          // so this sentinel is a safe "match nothing" value.
          q = companyTypeSlugs.length ? q.in("company_slug", companyTypeSlugs) : q.eq("company_slug", "__no_company_type_match__");
        }
        return q;
      };

      const runQuery = async (rf = rangeFrom, rt = rangeTo) => {
        let resp = await build(true, rf, rt);
        if (resp.error && /seniority/i.test(String(resp.error.message || resp.error))) {
          resp = await build(false, rf, rt);
        }
        if (resp.error) throw resp.error;
        return { data: resp.data || [], count: resp.count };
      };

      let rows;
      let count;
      if (canSpread) {
        // The spread pool is always rows 0..POOL-1 for a given filter set —
        // independent of `page` and of the plan (the free cap is applied by
        // the slice below). Cache it under a page-less key so paging through
        // the feed slices an already-built pool instead of re-fetching and
        // re-spacing 600 rows for every page.
        const poolKey = `jobs-pool:${qsKey(req, ["page"])}`;
        const pooled = await cached(poolKey, 90000, async () => {
          const r = await runQuery();
          const pool = willWeight ? weightedStrataMerge(r.data, (row) => jobStratumOf(row, companyTypeMap)) : r.data;
          return { spaced: spaceByCompany(pool, JOBS_SPREAD_GAP, true), count: r.count };
        });
        if (pastCap) {
          rows = [];
          count = pooled.count;
        } else {
          // Feed = [strict spaced pool] + [DB rows from offset POOL on].
          const w = await feedWindow({
            spaced: pooled.spaced,
            dbCount: pooled.count,
            pool: JOBS_INTERLEAVE_POOL,
            gap: JOBS_SPREAD_GAP,
            from,
            to: cappedTo,
            fetchDb: async (off, n) => (await runQuery(off, off + n - 1)).data,
          });
          rows = w.rows;
          count = w.count;
        }
      } else {
        const r = await runQuery();
        // pastCap: the dummy range(0,0) fetch above was only for `count`.
        rows = pastCap ? [] : r.data;
        // Past the spaced pool, still keep each page mixed on recency sorts.
        if (!pastCap && (sort === "newest" || sort === "oldest")) rows = spaceByCompany(rows);
        count = r.count;
      }

      // Resolve company display names for just this page's slugs.
      let companyNameBySlug = {};
      const slugs = [...new Set(rows.map((r) => r.company_slug).filter(Boolean))];
      if (slugs.length) {
        const { data: cRows } = await jobsDb()
          .from("company")
          .select("slug, name")
          .in("slug", slugs);
        for (const c of cRows || []) companyNameBySlug[c.slug] = c.name;
      }

      const items = rows.map((r) => normalizeJob(r, companyNameBySlug, companyTypeMap)).filter((j) => j.url);

      // Source facet for the dropdown (best-effort). Only ~7 distinct values
      // exist, so an 800-row sample is plenty; cached across all jobs requests.
      let sources = [];
      try {
        sources = await cached("jobs:sources", 600000, async () => {
          const { data: sRows } = await jobsDb()
            .from(JOBS_TABLE)
            .select("source")
            .eq("status", "open")
            .not("source", "is", null)
            .limit(800);
          return [...new Set((sRows || []).map((r) => r.source).filter(Boolean))]
            .sort()
            .slice(0, 40);
        });
      } catch {
        /* facets are optional */
      }

      const total = count ?? items.length;
      return {
        items,
        total,
        page,
        pageCount: jobsUnlimited ? Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE)) : 1,
        locked: jobsUnlimited ? 0 : Math.max(0, total - jobsLimit),
        limit: serializeLimit(jobsLimit),
        facets: {
          sources,
          locationTypes: ["remote", "hybrid", "onsite"],
          seniorities: SENIORITY_ORDER,
          companyTypes: COMPANY_TYPES,
          countries: COUNTRIES,
        },
      };
    });

    // Payload now varies by plan (free-tier cap) — browser cache only.
    res.set("Cache-Control", PLAN_GATED_CACHE);
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    // Until the crawler has run its migrations (and `crawler` is added to the
    // project's exposed schemas) the table is unreachable — degrade to a soft
    // empty instead of a 500.
    const msg = String((err && err.message) || err);
    if (
      /relation .* does not exist|column .* does not exist|Could not find the (table|.*column)|schema cache|schema must be one of|The schema must be|not exposed|PGRST106|PGRST205/i.test(
        msg,
      )
    ) {
      return jobsNotReady(res);
    }
    fail(res, err, "jobs", "Failed to load jobs.");
  }
});

// GET /api/jobs/company/:slug → { company, postings, eligible } for one
// company's programmatic hub page (JobsCompanyPage.jsx). `eligible` mirrors
// the robots directive the HTML shell route applies to the same slug — the
// client uses it only to show a "not yet indexed" note, never to hide content.
app.get("/api/jobs/company/:slug", catalogLimiter, optionalAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!JOBS_COMPANY_SLUG_RE.test(slug)) return res.status(404).json({ error: "Unknown company." });
    const key = `jobs-company:${slug}`;
    const wasHit = hasFresh(key);
    const payload = await getJobsCompanyPayload(slug);
    if (!payload) return res.status(404).json({ error: "Unknown company." });
    res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    fail(res, err, "jobs/company", "Failed to load company jobs.");
  }
});

// GET /api/jobs/facets?field=company|location|title&q=… → up to `limit` distinct
// values that actually occur in the OPEN job set, fuzzy-ranked against `q`.
// Powers the result-aware autocomplete on the Jobs filters + search box.
app.get("/api/jobs/facets", catalogLimiter, optionalAuth, async (req, res) => {
  const field = String(req.query.field || "").trim().toLowerCase();
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
    if (!["company", "location", "title"].includes(field)) {
      return res.status(400).json({ error: "field must be 'company', 'location' or 'title'" });
    }

    const key = `jobs-facet:${field}:${q}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 300000, async () => {
      if (field === "title") {
        // No blank-query list for titles — there are thousands; only suggest once
        // the user has typed something.
        if (!q) return { field, options: [] };
        const { data: rows, error } = await jobsDb()
          .from(JOBS_TABLE)
          .select("title")
          .eq("status", "open")
          .gte("posted_at", jobsMaxAgeISO())
          .not("title", "is", null)
          .limit(2500);
        if (error) throw error;
        const candidates = (rows || []).map((r) => String(r.title || "").trim());
        return { field, options: rankFacet(candidates, q, limit) };
      }

      if (field === "company") {
        const { data: rows, error } = await jobsDb()
          .from(JOBS_TABLE)
          .select("company_slug")
          .eq("status", "open")
          .gte("posted_at", jobsMaxAgeISO())
          .not("company_slug", "is", null)
          .limit(2500);
        if (error) throw error;
        const slugs = [...new Set((rows || []).map((r) => r.company_slug).filter(Boolean))];
        const nameBySlug = {};
        if (slugs.length) {
          const { data: cRows } = await jobsDb().from("company").select("slug, name").in("slug", slugs);
          for (const c of cRows || []) nameBySlug[c.slug] = c.name;
        }
        const candidates = slugs.map((s) => nameBySlug[s] || s.replace(/-/g, " "));
        return { field, options: rankFacet(candidates, q, limit) };
      }

      const { data: rows, error } = await jobsDb()
        .from(JOBS_TABLE)
        .select("location")
        .eq("status", "open")
        .gte("posted_at", jobsMaxAgeISO())
        .not("location", "is", null)
        .limit(2500);
      if (error) throw error;
      const candidates = (rows || []).map((r) => String(r.location || "").trim());
      return { field, options: rankFacet(candidates, q, limit) };
    });

    res.set("Cache-Control", "public, max-age=120, s-maxage=300");
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    return res.json(payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/relation .* does not exist|column .* does not exist|schema must be|not exposed|PGRST106|PGRST205/i.test(msg)) {
      return res.json({ field, options: [] });
    }
    fail(res, err, "jobs-facets", "Failed to load suggestions.");
  }
});

// GET /api/jobs/analytics → aggregate metrics for the Jobs → Analytics tab.
// Prefers the crawler.jobs_analytics() SQL function; falls back to a handful
// of head-only COUNT queries if that function isn't there yet.
app.get("/api/jobs/analytics", catalogLimiter, optionalAuth, async (_req, res) => {
  try {
    const wasHit = hasFresh("jobs-analytics");
    const payload = await cached("jobs-analytics", 300000, async () => {
      const rpc = await jobsDb().rpc("jobs_analytics");
      if (!rpc.error && rpc.data) {
        const d = rpc.data;
        return {
          total: d.total ?? 0,
          companiesWithJobs: d.companies_with_jobs ?? 0,
          bySeniority: d.by_seniority ?? [],
          byWorkType: d.by_work_type ?? [],
          bySource: d.by_source ?? [],
          topCompanies: (d.top_companies ?? []).map((c) => ({
            company: c.name || c.slug,
            count: c.count,
          })),
          postedByDay: d.posted_by_day ?? [],
          midSharePct: d.mid_share_pct ?? null,
        };
      }

      // Fallback: COUNT-only queries (no row transfer).
      const countWhere = async (apply) => {
        let q = jobsDb().from(JOBS_TABLE).select("id", { count: "exact", head: true }).eq("status", "open");
        if (apply) q = apply(q);
        const { count } = await q;
        return count || 0;
      };
      const total = await countWhere();
      const workTypes = ["remote", "hybrid", "onsite"];
      const byWorkType = [];
      let typed = 0;
      for (const t of workTypes) {
        const c = await countWhere((q) => q.eq("location_type", t));
        typed += c;
        byWorkType.push({ type: t, count: c });
      }
      byWorkType.push({ type: "unspecified", count: Math.max(0, total - typed) });

      let bySeniority = [];
      let midCount = 0;
      try {
        for (const b of SENIORITY_ORDER) {
          const c = await countWhere((q) => q.eq("seniority", b));
          if (b === "mid") midCount = c;
          bySeniority.push({ bucket: b, count: c });
        }
      } catch {
        bySeniority = [];
      }

      return {
        total,
        companiesWithJobs: null,
        bySeniority,
        byWorkType,
        bySource: [],
        topCompanies: [],
        postedByDay: [],
        midSharePct: total ? Math.round((midCount / total) * 1000) / 10 : null,
      };
    });

    res.set("Cache-Control", "public, max-age=120, s-maxage=300");
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/does not exist|schema cache|schema must be|not exposed|PGRST1|PGRST2/i.test(msg)) {
      return res.json({
        total: 0,
        companiesWithJobs: 0,
        bySeniority: [],
        byWorkType: [],
        bySource: [],
        topCompanies: [],
        postedByDay: [],
        midSharePct: null,
        notReady: true,
      });
    }
    fail(res, err, "jobs/analytics", "Failed to load job analytics.");
  }
});

// GET /api/jobs/analytics/trend?granularity=weekly|monthly → historical
// hiring-velocity series from the crawler's daily market snapshot
// (public.jobs_market_snapshot_daily — plain `public` schema, no jobsDb()
// cross-schema client needed). One row/day, so this is cheap even
// unpaginated; resampled into week/month buckets in Node.
const JOBS_SNAPSHOT_TABLE = "jobs_market_snapshot_daily";

// Monday-of-the-week date (UTC) as the weekly bucket key — sortable as a plain
// string and avoids ISO week-numbering edge cases at year boundaries.
function jobsWeekBucketKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function jobsMonthBucketKey(dateStr) {
  return String(dateStr).slice(0, 7); // "YYYY-MM"
}

function mergeJsonbCounts(target, obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    target[k] = (target[k] || 0) + (Number(v) || 0);
  }
}

function mergeTopCompanies(target, arr) {
  for (const c of Array.isArray(arr) ? arr : []) {
    const name = c && (c.company || c.name);
    if (!name) continue;
    const n = Number(c.new_postings ?? c.newPostings ?? c.count) || 0;
    target[name] = (target[name] || 0) + n;
  }
}

// Resample ascending-by-date daily snapshot rows into week/month buckets.
// new_postings/closed_postings are summed across the bucket (a real velocity
// total); total_open takes the LAST day's value in the bucket (a point-in-time
// stock, not something to sum); the jsonb breakdowns are summed key-by-key.
function resampleJobsSnapshots(rowsAsc, granularity) {
  const keyFn = granularity === "monthly" ? jobsMonthBucketKey : jobsWeekBucketKey;
  const buckets = new Map();
  for (const row of rowsAsc) {
    const period = keyFn(row.snapshot_date);
    let b = buckets.get(period);
    if (!b) {
      b = {
        period,
        totalOpen: 0,
        newPostings: 0,
        closedPostings: 0,
        bySeniority: {},
        byWorkType: {},
        byCountry: {},
        byCompanyType: {},
        topCompaniesAcc: {},
      };
      buckets.set(period, b);
    }
    b.newPostings += Number(row.new_postings) || 0;
    b.closedPostings += Number(row.closed_postings) || 0;
    b.totalOpen = Number(row.total_open) || 0; // rowsAsc is date-ascending → last write wins = latest day
    mergeJsonbCounts(b.bySeniority, row.by_seniority);
    mergeJsonbCounts(b.byWorkType, row.by_work_type);
    mergeJsonbCounts(b.byCountry, row.by_country);
    mergeJsonbCounts(b.byCompanyType, row.by_company_type);
    mergeTopCompanies(b.topCompaniesAcc, row.top_companies);
  }
  return [...buckets.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((b) => ({
      period: b.period,
      totalOpen: b.totalOpen,
      newPostings: b.newPostings,
      closedPostings: b.closedPostings,
      bySeniority: b.bySeniority,
      byWorkType: b.byWorkType,
      byCountry: b.byCountry,
      byCompanyType: b.byCompanyType,
      topCompanies: Object.entries(b.topCompaniesAcc)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 10)
        .map(([company, newPostings]) => ({ company, newPostings })),
    }));
}

app.get("/api/jobs/analytics/trend", catalogLimiter, optionalAuth, async (req, res) => {
  const granularity = String(req.query.granularity || "weekly").trim().toLowerCase() === "monthly" ? "monthly" : "weekly";
  try {
    const key = `jobs-trend:${granularity}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 300000, async () => {
      const { data, error } = await supabaseAdmin
        .from(JOBS_SNAPSHOT_TABLE)
        .select(
          "snapshot_date, total_open, new_postings, closed_postings, by_seniority, by_work_type, by_country, by_company_type, top_companies",
        )
        .order("snapshot_date", { ascending: true })
        .limit(1000); // ~2.7 years of daily rows — comfortable headroom for a 1 row/day table
      if (error) throw error;
      const rowsAsc = data || [];
      return { granularity, points: rowsAsc.length ? resampleJobsSnapshots(rowsAsc, granularity) : [] };
    });

    res.set("Cache-Control", "public, max-age=120, s-maxage=300");
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    // Same story as /api/jobs — the snapshot table may not exist yet if the
    // crawler's migration + cron haven't landed/run. Degrade to an empty,
    // non-error series rather than a 500.
    const msg = String((err && err.message) || err);
    if (/relation .* does not exist|does not exist|schema cache|PGRST1|PGRST2/i.test(msg)) {
      return res.json({ granularity, points: [], notReady: true });
    }
    fail(res, err, "jobs/analytics/trend", "Failed to load job trend.");
  }
});

// ── Market analytics (our own crawler pool only) ──────────────────
// Live aggregates come from the crawler.market_analytics RPC (sql/37); the
// 30-day trend from the crawler's daily public.jobs_market_snapshot_daily
// (its by_country jsonb holds open-job counts per country).
app.get("/api/market/analytics", catalogLimiter, optionalAuth, async (req, res) => {
  const country = String(req.query.country || "IN").toUpperCase() === "US" ? "US" : "IN";
  try {
    const key = `market-analytics:${country}`;
    const wasHit = hasFresh(key);
    const payload = await cached(key, 30 * 60 * 1000, async () => {
      const [rpc, snap] = await Promise.all([
        jobsDb().rpc("market_analytics", { p_country: country }),
        supabaseAdmin
          .from(JOBS_SNAPSHOT_TABLE)
          .select("snapshot_date, by_country")
          .order("snapshot_date", { ascending: false })
          .limit(30),
      ]);
      if (rpc.error) throw rpc.error;
      const d = rpc.data || {};
      const trend = ((snap.data) || [])
        .map((r) => ({ date: r.snapshot_date, open: Number(r.by_country && r.by_country[country]) }))
        .filter((r) => Number.isFinite(r.open))
        .reverse();
      return {
        ready: true,
        country,
        openNow: d.open_now || 0,
        new24h: d.new_24h || 0,
        companies: d.companies || 0,
        trend,
        windowDays: d.window_days || 15,
        roleSplit: d.role_split || [],
        countrySplit: d.country_split || [],
        families: d.families || [],
        seniority: d.seniority || [],
        topCompanies: d.top_companies || [],
        companyTypes: d.company_types || [],
        generatedAt: new Date().toISOString(),
      };
    });
    res.set("Cache-Control", "public, max-age=300, s-maxage=1800");
    res.set("X-Cache", wasHit ? "HIT" : "MISS");
    res.json(payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/does not exist|schema cache|PGRST1|PGRST2|Could not find the function/i.test(msg)) {
      return res.json({ ready: false, country });
    }
    fail(res, err, "market/analytics", "Failed to load market analytics.");
  }
});

// ── On-demand "search more for this role" (picked up by the crawler's
// discovery worker via public.aa_discovery_requests) ───────────────
const SEARCH_REQ_WINDOW_MS = 24 * 3600 * 1000;
app.get("/api/jobs/request-search", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("aa_discovery_requests")
      .select("status, titles, country, seniority, requested_at, finished_at, found")
      .eq("user_id", req.user.id)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json({ request: data || null });
  } catch (err) {
    fail(res, err, "jobs/request-search", "Failed to load search request.");
  }
});

app.post("/api/jobs/request-search", requireAuth, catalogLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const titles = (Array.isArray(b.titles) ? b.titles : [])
      .map((t) => String(t || "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 5);
    const country = String(b.country || "").toUpperCase();
    if (!titles.length) return res.status(400).json({ error: "titles required" });
    if (country !== "IN" && country !== "US") return res.status(400).json({ error: "country must be IN or US" });
    const seniority = b.seniority ? String(b.seniority).trim().toLowerCase().slice(0, 20) : null;

    const { data: last } = await supabaseAdmin
      .from("aa_discovery_requests")
      .select("requested_at")
      .eq("user_id", req.user.id)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.requested_at).getTime() < SEARCH_REQ_WINDOW_MS) {
      const retryAt = new Date(new Date(last.requested_at).getTime() + SEARCH_REQ_WINDOW_MS).toISOString();
      return res.status(429).json({ error: "rate_limited", message: "You can request one extra search per day.", retryAt });
    }
    const { error } = await supabaseAdmin
      .from("aa_discovery_requests")
      .insert({ user_id: req.user.id, titles, country, seniority });
    if (error) {
      if (error.code === "23505") return res.status(429).json({ error: "already_queued", message: "You already have a search queued." });
      throw error;
    }
    res.status(202).json({ queued: true });
  } catch (err) {
    fail(res, err, "jobs/request-search", "Failed to queue search.");
  }
});

// ── Feedback (feature request / bug report) ──────────────────────
// Emails the operator directly. Rate-limited; body capped.
const FEEDBACK_TO = process.env.FEEDBACK_TO_EMAIL || "harvardpark239@gmail.com";

app.post("/api/feedback", requireAuth, aiLimiter, async (req, res) => {
  try {
    const { kind, message } = req.body || {};
    const k = kind === "bug" ? "bug" : "feature";
    const body = String(message || "").trim();
    assert(body.length >= 10 && body.length <= 4000, "Message must be 10–4000 characters.");

    if (!resend.isEnabled()) {
      console.warn("[feedback] RESEND not configured — dropping:", k, redact(body.slice(0, 80)));
      return res.status(503).json({ error: "Feedback channel is not configured right now." });
    }

    const reporter = req.user?.email || req.user?.id || "unknown";
    const label = k === "bug" ? "Bug report" : "Feature request";
    const safe = escapeHtml(body).replace(/\n/g, "<br>");
    const r = await resend.sendEmail({
      to: FEEDBACK_TO,
      subject: `[Vloombox ${label}] from ${reporter}`,
      text: `${label}\nFrom: ${reporter}\n\n${body}\n`,
      html:
        `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.6">` +
        `<p><strong>${label}</strong></p>` +
        `<p style="color:#555">From: ${escapeHtml(reporter)}</p>` +
        `<hr style="border:none;border-top:1px solid #ddd">` +
        `<p>${safe}</p></div>`,
      tag: `feedback_${k}`,
    });

    if (r && r.error) {
      return res.status(502).json({ error: "Could not send your message. Please try again later." });
    }
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "feedback", "Could not send your message.");
  }
});

// ── Referral requests ────────────────────────────────────────────
// profiles / referral_requests / storage bucket 'referral-resumes' all sit
// behind RLS that the browser cannot write to — every mutation and every
// signed URL here goes through the service-role client. See sql/11 + sql/12.

// Escape PostgREST `ilike` wildcards so a company matcher is case-insensitive
// EQUALITY, not a pattern. Without this a request with target_company '%' (or
// '_') would `ilike` every profile and blast the notification to everyone.
function escapeLike(s) {
  return String(s == null ? "" : s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

// Resolve an auth.users row to { id, email, name } via the admin API.
// Never throws; logs redacted and returns null on failure.
const REF_USER_TTL_MS = 5 * 60 * 1000;
const REF_USER_MAX = 500;
/** @type {Map<string, { v: any, exp: number }>} */
const refUserCache = new Map();

async function referralAuthUser(userId) {
  const hit = refUserCache.get(userId);
  if (hit && hit.exp > Date.now()) {
    refUserCache.delete(userId); // LRU touch
    refUserCache.set(userId, hit);
    return hit.v;
  }
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    const u = data.user;
    const md = u.user_metadata || {};
    const v = {
      id: u.id,
      email: u.email || null,
      name: md.full_name || md.name || null,
    };
    if (refUserCache.size >= REF_USER_MAX) {
      const k = refUserCache.keys().next().value;
      if (k !== undefined) refUserCache.delete(k);
    }
    refUserCache.set(userId, { v, exp: Date.now() + REF_USER_TTL_MS });
    return v;
  } catch (e) {
    console.error(
      "[referrals] getUserById failed:",
      redact((e && e.message) || String(e)),
    );
    return null;
  }
}

// GET /api/profiles/companies?q= → { companies: string[] }
// Distinct non-empty profiles.company, case-insensitive prefix match on q,
// sorted, capped at 20. Powers the signup + post-request autocomplete.
app.get(
  "/api/profiles/companies",
  requireAuth,
  catalogLimiter,
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 100);
      const ql = q.toLowerCase();
      // Prefix match in SQL (never a full-table scan), bounded, and cached.
      const companies = await cached(`profiles:companies:${ql}`, 60_000, async () => {
        let qb = supabaseAdmin
          .from("profiles")
          .select("company")
          .not("company", "is", null)
          .order("company", { ascending: true })
          .limit(400);
        if (ql) qb = qb.ilike("company", `${escapeLike(ql)}%`);
        const { data, error } = await qb;
        if (error) throw error;
        const byLower = new Map();
        for (const r of data || []) {
          const c = String(r.company || "").trim();
          if (!c) continue;
          const k = c.toLowerCase();
          if (!byLower.has(k)) byLower.set(k, c);
        }
        return [...byLower.values()].sort((a, b) => a.localeCompare(b)).slice(0, 20);
      });
      res.json({ companies });
    } catch (err) {
      fail(res, err, "profiles/companies", "Failed to load companies.");
    }
  },
);

// POST /api/referrals  (multipart) — create an open referral request.
// fields: target_company (req, 1..200), job_id (opt, ≤200), job_title (opt, ≤300)
// file:   resume  (PDF ≤10MB, %PDF- magic bytes, ≥100 bytes)
app.post(
  "/api/referrals",
  requireAuth,
  referralLimiter,
  upload.single("resume"),
  async (req, res) => {
    let reservation = null;
    let keepReservation = false;
    try {
      const { target_company, job_id, job_title } = req.body || {};

      assert(
        isNonEmptyString(target_company) && maxLen(target_company, 200),
        "target_company is required (1–200 characters).",
      );
      if (job_id != null && String(job_id) !== "") {
        assert(maxLen(String(job_id), 200), "job_id is too long (max 200).");
      }
      if (job_title != null && String(job_title) !== "") {
        assert(
          maxLen(String(job_title), 300),
          "job_title is too long (max 300).",
        );
      }

      assert(req.file, "Upload a resume PDF to continue.");
      assert(
        req.file.size >= 100,
        "That PDF looks empty. Upload a valid resume PDF.",
      );
      assert(
        Buffer.isBuffer(req.file.buffer) &&
          req.file.buffer.length >= 5 &&
          req.file.buffer.subarray(0, 5).toString("latin1") === "%PDF-",
        "That file is not a valid PDF.",
      );

      // 1. Quota gate — MUST run before any storage/DB write.
      const gate = await reserveUsage(req.user.id, "referral_request");
      if (!gate.allowed) {
        return res.status(402).json({
          error: "usage_limit",
          feature: "referral_request",
          used: gate.used,
          limit: gate.limit,
          resetsAt: gate.resetsAt,
        });
      }
      reservation = gate.reservation;

      // 2. One open request per user (pre-check; the partial unique index is
      //    the real guard — step 4 handles the race).
      const { data: existing, error: exErr } = await supabaseAdmin
        .from("referral_requests")
        .select("id")
        .eq("poster_user_id", req.user.id)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing) {
        return res.status(409).json({ error: "open_request_exists" });
      }

      // 3. Upload the resume (nothing inserted yet).
      const referralId = crypto.randomUUID();
      const storagePath = `${req.user.id}/${referralId}.pdf`;
      const up = await supabaseAdmin.storage
        .from("referral-resumes")
        .upload(storagePath, req.file.buffer, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (up.error) {
        return fail(res, up.error, "referrals/upload", "Failed to store resume.");
      }

      // 4. Insert the row.
      const company = target_company.trim();
      const { data: row, error: insErr } = await supabaseAdmin
        .from("referral_requests")
        .insert({
          id: referralId,
          poster_user_id: req.user.id,
          target_company: company,
          job_id: job_id ? String(job_id).trim() || null : null,
          job_title: job_title ? String(job_title).trim() || null : null,
          resume_storage_path: storagePath,
          status: "open",
        })
        .select()
        .single();

      if (insErr) {
        await supabaseAdmin.storage
          .from("referral-resumes")
          .remove([storagePath])
          .catch(() => {});
        const msg = String(insErr.message || insErr.code || "");
        if (insErr.code === "23505" || /duplicate key|unique/i.test(msg)) {
          return res.status(409).json({ error: "open_request_exists" });
        }
        throw insErr;
      }

      // 5. The quota unit was reserved atomically up front; keep it.
      keepReservation = true;

      // 6. Respond.
      res.status(201).json({
        id: referralId,
        status: "open",
        target_company: row.target_company,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });

      // 7. After responding: notify co-workers who opted in. Fire-and-forget.
      void (async () => {
        const { data: poster } = await supabaseAdmin
          .from("profiles")
          .select("position, years_of_experience")
          .eq("id", req.user.id)
          .maybeSingle();

        // Everyone at the company who opted in; verified first, capped at 50.
        const { data: matchRows, error: mErr } = await supabaseAdmin
          .from("profiles")
          .select("id, company_verified")
          .eq("receive_referral_notifications", true)
          .ilike("company", escapeLike(company))
          .neq("id", req.user.id)
          .order("company_verified", { ascending: false })
          .limit(200);
        if (mErr) throw mErr;

        const cands = [];
        for (const r of matchRows || []) {
          const au = await referralAuthUser(r.id);
          if (au && au.email) cands.push({ email: au.email, verified: !!r.company_verified });
          if (cands.length >= 50) break; // rows are verified-first; 50 is the cap
        }
        const recipients = selectRecipients(cands).map((c) => c.email);
        if (!recipients.length) {
          console.log("[referrals] request", referralId, "-> 0 recipients");
          return;
        }

        const requestUrl = `${APP_BASE_URL}/referrals?open=${referralId}`;
        const tpl = referralRequestCreated({
          jobTitle: row.job_title,
          jobId: row.job_id,
          posterPosition: poster ? poster.position : null,
          posterYoe: poster ? poster.years_of_experience : null,
          requestUrl,
        });
        const summary = await resend.sendMany(
          recipients.map((to) => ({
            to,
            tag: "referral_request_created",
            ...tpl,
          })),
        );
        console.log("[referrals] request", referralId, "fan-out", summary);
      })().catch((e) =>
        console.error(
          "[referrals] fan-out failed",
          redact((e && e.message) || String(e)),
        ),
      );
    } catch (err) {
      fail(res, err, "referrals", "Failed to create referral request.");
    } finally {
      if (reservation && !keepReservation) await refundUsage(reservation);
    }
  },
);

// GET /api/referrals/mine → the caller's own requests + their referral quota.
app.get("/api/referrals/mine", requireAuth, async (req, res) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("referral_requests")
      .select("*")
      .eq("poster_user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const accepterIds = [
      ...new Set(
        (rows || [])
          .filter((r) => r.status === "accepted" && r.accepted_by_user_id)
          .map((r) => r.accepted_by_user_id),
      ),
    ];
    const accepterMap = new Map();
    await Promise.all(
      accepterIds.map(async (id) => accepterMap.set(id, await referralAuthUser(id))),
    );
    const verifiedMap = new Map();
    if (accepterIds.length) {
      const { data: vrows, error: vErr } = await supabaseAdmin
        .from("profiles")
        .select("id, company_verified")
        .in("id", accepterIds);
      if (vErr) throw vErr;
      for (const v of vrows || []) verifiedMap.set(v.id, !!v.company_verified);
    }
    const requests = [];
    for (const r of rows || []) {
      let accepter = null;
      let referrerVerified = false;
      if (r.status === "accepted" && r.accepted_by_user_id) {
        const au = accepterMap.get(r.accepted_by_user_id);
        referrerVerified = !!verifiedMap.get(r.accepted_by_user_id);
        accepter = au ? { name: au.name, email: au.email, verified: referrerVerified } : null;
      }
      requests.push({
        id: r.id,
        target_company: r.target_company,
        job_id: r.job_id,
        job_title: r.job_title,
        status: r.status,
        accepted_at: r.accepted_at,
        created_at: r.created_at,
        expires_at: r.expires_at,
        referrerVerified,
        accepter,
      });
    }

    const usage = await getRemainingUsage(req.user.id, "referral_request");
    res.json({
      requests,
      usage: {
        used: usage.used,
        limit: usage.limit === Infinity ? "unlimited" : usage.limit,
        resetsAt: usage.resetsAt,
      },
    });
  } catch (err) {
    fail(res, err, "referrals/mine", "Failed to load your referral requests.");
  }
});

// GET /api/referrals/open → open requests targeting the caller's own company.
// Verification is optional here (it only adds a badge + a higher accept limit).
// The list carries NO poster name/email/phone and NO resume path or signed
// URL; the resume is served only to the accepter (see /resume).
app.get("/api/referrals/open", requireAuth, async (req, res) => {
  try {
    const mine = await getVerifiedCompany(req.user.id);
    if (!mine.company) return res.json({ requests: [], no_company: true });
    const myCompany = mine.company;

    // sql/33: target_company_norm = lower(btrim(target_company)), indexed.
    const { data: rows, error } = await supabaseAdmin
      .from("referral_requests")
      .select(
        "id, target_company, job_id, job_title, created_at, expires_at, poster_user_id",
      )
      .eq("status", "open")
      .eq("target_company_norm", myCompany.toLowerCase())
      .neq("poster_user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const posterIds = [...new Set((rows || []).map((r) => r.poster_user_id))];
    const posterMap = new Map();
    if (posterIds.length) {
      const { data: posters, error: psErr } = await supabaseAdmin
        .from("profiles")
        .select("id, position, years_of_experience")
        .in("id", posterIds);
      if (psErr) throw psErr;
      for (const pr of posters || []) posterMap.set(pr.id, pr);
    }

    const requests = (rows || []).map((r) => {
      const pr = posterMap.get(r.poster_user_id) || {};
      return {
        id: r.id,
        target_company: r.target_company,
        job_id: r.job_id,
        job_title: r.job_title,
        created_at: r.created_at,
        expires_at: r.expires_at,
        poster: {
          position: pr.position ?? null,
          years_of_experience: pr.years_of_experience ?? null,
        },
      };
    });
    res.json({ requests, company: myCompany, viewerVerified: mine.verified });
  } catch (err) {
    fail(res, err, "referrals/open", "Failed to load open referral requests.");
  }
});

// POST /api/referrals/:id/accept — atomic conditional claim of an open request
// that targets the caller's company.
app.post(
  "/api/referrals/:id/accept",
  requireAuth,
  async (req, res) => {
    try {
      const mine = await getVerifiedCompany(req.user.id);
      if (!mine.company) return res.status(403).json({ error: "no_company" });
      const myCompany = mine.company;

      // Rolling-24h accept cap (3 unverified / 20 verified), enforced here.
      const { data: recent, error: rcErr } = await supabaseAdmin
        .from("referral_requests")
        .select("accepted_at")
        .eq("accepted_by_user_id", req.user.id)
        .gte("accepted_at", acceptWindowStart())
        .limit(100);
      if (rcErr) throw rcErr;
      const lim = evaluateAcceptLimit({
        verified: mine.verified,
        acceptedAt: (recent || []).map((r) => r.accepted_at),
      });
      if (!lim.allowed) {
        return res.status(429).json({
          error: "accept_limit",
          message: acceptLimitMessage({ limit: lim.limit, verified: mine.verified }),
          limit: lim.limit,
          used: lim.used,
          retryAt: lim.retryAt,
          verified: mine.verified,
        });
      }

      // Single conditional UPDATE: id + status='open' + company match
      // (case-insensitive) + not self. maybeSingle() → null when nothing matched.
      const { data, error } = await supabaseAdmin
        .from("referral_requests")
        .update({
          status: "accepted",
          accepted_by_user_id: req.user.id,
          accepted_at: new Date().toISOString(),
        })
        .eq("id", req.params.id)
        .eq("status", "open")
        .eq("target_company_norm", myCompany.toLowerCase())
        .neq("poster_user_id", req.user.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "already_accepted" });

      res.json({ id: data.id, status: "accepted", referrerVerified: mine.verified });

      // Notify the poster (fire-and-forget). This email intentionally carries
      // the accepter's email address.
      void (async () => {
        const [poster, accepter] = await Promise.all([
          referralAuthUser(data.poster_user_id),
          referralAuthUser(req.user.id),
        ]);
        if (!poster || !poster.email) {
          console.log(
            "[referrals] accept",
            data.id,
            "-> poster has no email, skip",
          );
          return;
        }
        const tpl = referralAccepted({
          accepterName: (accepter && accepter.name) || req.user.email || null,
          accepterEmail: req.user.email,
          company: data.target_company,
          referrerVerified: mine.verified,
        });
        const r = await resend.sendEmail({
          to: poster.email,
          tag: "referral_accepted",
          ...tpl,
        });
        console.log("[referrals] accept", data.id, "notify poster:", r);
      })().catch((e) =>
        console.error(
          "[referrals] accept notify failed",
          redact((e && e.message) || String(e)),
        ),
      );
    } catch (err) {
      fail(res, err, "referrals/accept", "Failed to accept referral request.");
    }
  },
);

// POST /api/referrals/:id/cancel — poster withdraws their own open request.
// No quota refund.
app.post(
  "/api/referrals/:id/cancel",
  requireAuth,
  async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("referral_requests")
        .update({ status: "cancelled" })
        .eq("id", req.params.id)
        .eq("poster_user_id", req.user.id)
        .eq("status", "open")
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return res.status(409).json({ error: "not_open_or_not_owner" });
      }
      res.json({ id: data.id, status: "cancelled" });
    } catch (err) {
      fail(res, err, "referrals/cancel", "Failed to cancel referral request.");
    }
  },
);

// GET /api/referrals/:id/resume → { url } short-lived signed URL (120s).
// Access is re-checked on every call and never cached.
app.get(
  "/api/referrals/:id/resume",
  requireAuth,
  async (req, res) => {
    try {
      const { data: row, error } = await supabaseAdmin
        .from("referral_requests")
        .select("poster_user_id, accepted_by_user_id, status, resume_storage_path")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: "not_found" });

      // Only the requester and the user who accepted this request. Company
      // membership (verified or not) never grants resume access.
      const allowed = canViewResume({
        userId: req.user.id,
        posterUserId: row.poster_user_id,
        acceptedByUserId: row.accepted_by_user_id,
        status: row.status,
      });
      if (!allowed) return res.status(403).json({ error: "forbidden" });

      const { data, error: sErr } = await supabaseAdmin.storage
        .from("referral-resumes")
        .createSignedUrl(row.resume_storage_path, 120);
      if (sErr || !data?.signedUrl) {
        return fail(
          res,
          sErr || new Error("no signed url"),
          "referrals/resume",
          "Failed to prepare the resume link.",
        );
      }
      res.json({ url: data.signedUrl });
    } catch (err) {
      fail(res, err, "referrals/resume", "Failed to load resume.");
    }
  },
);

// ── Company subscriptions (job alerts) ─────────────────────────────
// Pro/Max users subscribe to a company from its /jobs/company/:slug hub page
// and get a batched email digest once every 24h when new postings appear
// (see sendCompanySubscriptionDigest below, cron "30 5 * * *"). Free users
// are locked out entirely (company_subscriptions_max = 0). Pro caps at 4
// companies, Max at 10 — a persistent count-cap, NOT a monthly-metered
// feature, so this does NOT touch the `usage` table machinery.
//
// public.company_subscriptions / company_subscription_alerts_sent both sit
// behind RLS that the browser cannot write to — every mutation goes through
// this server with the service-role key, because the count-cap gate
// (canAddCompanySubscription) must run before every insert. See sql/18.
//
// This block is intentionally self-contained (new routes only, no edits to
// existing route logic) to keep the merge surface small against the other
// in-flight work on this file (jobs filters/analytics).

// GET /api/company-subscriptions → the caller's subscribed companies + their
// current cap (mirrors the shape of GET /api/referrals/mine).
app.get("/api/company-subscriptions", requireAuth, async (req, res) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("company_subscriptions")
      .select("id, company_slug, company_name, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const plan = await getUserPlan(req.user.id);
    const limit = getLimit(plan, "company_subscriptions_max");

    res.json({
      subscriptions: rows || [],
      plan,
      limit: serializeLimit(limit),
      used: (rows || []).length,
    });
  } catch (err) {
    fail(res, err, "company-subscriptions", "Failed to load your company subscriptions.");
  }
});

// POST /api/company-subscriptions  { company_slug, company_name }
// Subscribes the caller to a company. Gated by plan (Free: 0 slots) and by
// the per-plan count-cap; both checked server-side, never trusting the client.
app.post("/api/company-subscriptions", requireAuth, subscribeLimiter, async (req, res) => {
  try {
    const { company_slug, company_name } = req.body || {};
    const slug = String(company_slug || "").trim().toLowerCase();
    const name = String(company_name || "").trim();

    assert(
      JOBS_COMPANY_SLUG_RE.test(slug),
      "company_slug is required and must be a valid company slug.",
    );
    assert(
      isNonEmptyString(name) && maxLen(name, 200),
      "company_name is required (1–200 characters).",
    );

    // Gate — must run before any insert (persistent count-cap, not metered).
    const gate = await canAddCompanySubscription(req.user.id);
    if (!gate.allowed) {
      return res.status(402).json({
        error: gate.reason === "upgrade_required" ? "upgrade_required" : "usage_limit",
        feature: "company_subscriptions",
        used: gate.used,
        limit: gate.limit,
      });
    }

    // Confirm the slug is a real, known company before letting a user
    // subscribe to it (also satisfies the FK on company_subscriptions).
    const { data: company, error: cErr } = await jobsDb()
      .from("company")
      .select("slug, name")
      .eq("slug", slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!company) return res.status(404).json({ error: "unknown_company" });

    const { data: row, error: insErr } = await supabaseAdmin
      .from("company_subscriptions")
      .insert({
        user_id: req.user.id,
        company_slug: slug,
        company_name: name || company.name || slug,
      })
      .select()
      .single();

    if (insErr) {
      const msg = String(insErr.message || insErr.code || "");
      if (insErr.code === "23505" || /duplicate key|unique/i.test(msg)) {
        return res.status(409).json({ error: "already_subscribed" });
      }
      throw insErr;
    }

    res.status(201).json({
      id: row.id,
      company_slug: row.company_slug,
      company_name: row.company_name,
      created_at: row.created_at,
    });
  } catch (err) {
    fail(res, err, "company-subscriptions/create", "Failed to subscribe to this company.");
  }
});

// DELETE /api/company-subscriptions/:slug — unsubscribe the caller from one
// company. No quota refund logic needed (this isn't metered usage).
app.delete("/api/company-subscriptions/:slug", requireAuth, subscribeLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const { data, error } = await supabaseAdmin
      .from("company_subscriptions")
      .delete()
      .eq("user_id", req.user.id)
      .eq("company_slug", slug)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "not_subscribed" });
    res.json({ ok: true, company_slug: slug });
  } catch (err) {
    fail(res, err, "company-subscriptions/delete", "Failed to unsubscribe from this company.");
  }
});

// ── Code execution proxy ──────────────────────────────────────────
const JUDGE0_BASE = "https://judge0-ce.p.rapidapi.com";
const JUDGE0_LANG_IDS = {
  java: 62,
  python: 71,
  javascript: 63,
  csharp: 51,
  go: 60,
  cpp: 54,
  c: 48,
  rust: 73,
  kotlin: 78,
};
const KNOWN_LANGUAGES = new Set(Object.keys(JUDGE0_LANG_IDS));

// Code execution is expensive and abusable: per-user concurrency of 1 plus a
// global cap, on top of runLimiter.
const runActive = new Set();
const runGate = makeSemaphore(Number(process.env.RUN_MAX_CONCURRENT) || 6);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 30_000;

app.post("/api/run", requireAuth, runLimiter, async (req, res) => {
  if (runActive.has(req.user.id)) {
    return res.status(429).json({ message: "A run is already in progress." });
  }
  if (runGate.pending > 20) return res.status(503).json({ message: "Runner busy, try again." });
  runActive.add(req.user.id);
  let gateHeld = false;
  try {
    await runGate.acquire();
    gateHeld = true;
    const { language = "java", files = [] } = req.body || {};

    assert(
      typeof language === "string" && KNOWN_LANGUAGES.has(language),
      `Unsupported language. Supported: ${[...KNOWN_LANGUAGES].join(", ")}.`,
    );
    assert(
      Array.isArray(files) && files.length >= 1 && files.length <= 50,
      "files must be an array of 1–50 items.",
    );
    let totalBytes = 0;
    for (const f of files) {
      assert(
        isPlainObject(f) &&
          typeof f.name === "string" &&
          typeof f.content === "string",
        "each file needs a string name and string content.",
      );
      assert(maxLen(f.name, 200), "file name is too long.");
      totalBytes += Buffer.byteLength(f.content, "utf8");
    }
    assert(totalBytes <= 512 * 1024, "Total file content exceeds 512KB.");

    // ── Path A: java-runner microservice (Railway) ──
    if (process.env.JAVA_RUNNER_URL) {
      try {
        const runnerRes = await fetch(`${process.env.JAVA_RUNNER_URL}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files }),
          signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
        });
        const rawText = await runnerRes.text();
        let data = null;
        try {
          data = JSON.parse(rawText);
        } catch {
          /* non-JSON (e.g. a proxy 502 page) */
        }
        if (!data) {
          console.error("[java-runner proxy] non-JSON", runnerRes.status, redact(rawText.slice(0, 200)));
          return res.status(502).json({ message: "Code runner is unavailable. Try again shortly." });
        }
        if (!runnerRes.ok) return res.status(runnerRes.status).json(data);
        return res.json(data);
      } catch (err) {
        console.error("[java-runner proxy]", redact(err.message));
        return res.status(500).json({ message: "Code execution failed." });
      }
    }

    // ── Path B: Judge0 CE fallback ──
    if (!process.env.JUDGE0_API_KEY) {
      return res.status(500).json({
        message:
          "Code execution is not configured (set JAVA_RUNNER_URL or JUDGE0_API_KEY).",
      });
    }

    const langId = JUDGE0_LANG_IDS[language];
    const sourceCode = files.map((f) => f.content || "").join("\n\n");

    const submitRes = await fetch(
      `${JUDGE0_BASE}/submissions?base64_encoded=false&wait=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": process.env.JUDGE0_API_KEY,
          "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
        },
        body: JSON.stringify({
          language_id: langId,
          source_code: sourceCode,
          stdin: "",
          cpu_time_limit: 10,
          memory_limit: 256000,
        }),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      },
    );

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      console.error(
        `[judge0] upstream ${submitRes.status}: ${redact(errText).slice(0, 300)}`,
      );
      return res.status(500).json({ message: "Code execution failed." });
    }

    const result = await submitRes.json();
    const compileError = result.compile_output?.trim() || null;
    const exitCode = result.exit_code ?? (result.status?.id === 3 ? 0 : 1);

    return res.json({
      run: {
        stdout: result.stdout?.trim() || "",
        stderr: result.stderr?.trim() || "",
        code: exitCode,
        output: result.stdout?.trim() || "",
      },
      compile: compileError ? { stdout: "", stderr: compileError } : null,
    });
  } catch (err) {
    if (Number(err && err.status) === 400) {
      return res.status(400).json({ message: err.message });
    }
    console.error("[run]", redact((err && err.message) || String(err)));
    if (!res.headersSent)
      res.status(500).json({ message: "Code execution failed." });
  } finally {
    runActive.delete(req.user.id);
    if (gateHeld) runGate.release();
  }
});

// ── Billing / payments (Razorpay Standard Checkout) ─────────────────
// Provider logic: ./services/razorpay.js. One-time orders that grant a plan
// for a fixed term; when it lapses the entitlements lazy check drops the user
// to free. DORMANT until RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set.
const checkoutLimiter = makeLimiter({ windowMs: 60 * 1000, max: 12 });
// Coupon checks are per IP too (the user-keyed checkout limiter alone lets one person guess codes from many
// throwaway accounts): 20 coupon attempts per 15 min per IP across plan + AutoApply.
const couponIpLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: ipKey,
  message: { error: "coupon_rate_limited", message: "Too many coupon attempts - try again later." },
});
const couponIpGate = (req, res, next) => (req.body && req.body.coupon_code ? couponIpLimiter(req, res, next) : next());

const PAID_PLANS = ["pro", "max"];
const PERIODS = ["monthly", "yearly"];
const TERM_DAYS = { monthly: 30, yearly: 365 };

// India (and unknown) bills in INR paise; everyone else in USD cents — see
// lib/geo.js's currencyForCountry for why unknown must stay on the INR side.
// Shared by order creation and verification so both always agree on which
// amount a given user/currency should be charged.
function expectedAmountFor(currency, plan, billingPeriod) {
  return currency === "USD" ? priceUsdCents(plan, billingPeriod) : priceInrPaise(plan, billingPeriod);
}

// GET /api/billing/status → { configured, provider, keyId } for the client.
app.get("/api/billing/status", requireAuth, (_req, res) => {
  res.json({
    configured: razorpay.isEnabled(),
    provider: "razorpay",
    keyId: razorpay.isEnabled() ? razorpay.keyId() : null,
  });
});

// POST /api/payments/razorpay/order
//   body: { plan: 'pro'|'max', billingPeriod: 'monthly'|'yearly' }
//   → { order_id, amount, currency, keyId }
app.post(
  "/api/payments/razorpay/order",
  requireAuth,
  checkoutLimiter,
  async (req, res) => {
    try {
      if (!razorpay.isEnabled()) {
        return res.status(503).json({ error: "checkout_unconfigured" });
      }
      const { plan, billingPeriod } = req.body || {};
      assert(PAID_PLANS.includes(plan), "plan must be 'pro' or 'max'.");
      assert(PERIODS.includes(billingPeriod), "billingPeriod must be 'monthly' or 'yearly'.");

      const currency = currencyForCountry(await getUserCountry(req.user.id));
      const amountPaise = expectedAmountFor(currency, plan, billingPeriod);
      assert(Number.isInteger(amountPaise) && amountPaise >= 100, "Plan price is not configured.");

      const order = await razorpay.createOrder({
        amountPaise,
        currency,
        receipt: `u${String(req.user.id).slice(0, 8)}_${Date.now().toString(36)}`,
        notes: { user_id: req.user.id, plan, billingPeriod, currency },
      });

      res.json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: razorpay.keyId(),
      });
    } catch (err) {
      const status = Number(err && err.status) || 500;
      if (status === 400) {
        return res.status(400).json({ error: err.message || "Invalid request." });
      }
      if (status === 503) {
        return res.status(503).json({ error: "checkout_unconfigured" });
      }
      console.error("[razorpay/order]", redact((err && err.message) || String(err)));
      res.status(502).json({ error: "order_failed" });
    }
  },
);

// POST /api/payments/coupon  body: { code, billingPeriod?, dry? }
//   A free_all coupon grants its plan (coupons.plan) for one term, no payment. dry=true only checks it.
//   → { ok, plan, current_period_end } | { ok, dry: true, kind, plan }
app.post(
  "/api/payments/coupon",
  couponIpLimiter,
  requireAuth,
  checkoutLimiter,
  async (req, res) => {
    let redeemed = null;
    try {
      const code = normCouponCode(req.body && req.body.code);
      if (!code) return res.status(400).json({ error: "coupon_invalid", message: COUPON_MESSAGES.coupon_invalid });
      const billingPeriod = PERIODS.includes(req.body && req.body.billingPeriod) ? req.body.billingPeriod : "monthly";
      const peek = await redeemCoupon(supabaseAdmin, { code, userId: req.user.id, target: "plan", dry: true });
      if (peek.kind !== "free_all") {
        return res.status(400).json({ error: "coupon_not_applicable", message: "This coupon works on AutoApply packs, not plans." });
      }
      const { data: existing } = await supabaseAdmin
        .from("subscriptions")
        .select("plan, status, provider, current_period_end")
        .eq("user_id", req.user.id)
        .maybeSingle();
      if (existing && effectivePlanFromRow(existing) !== "free") {
        return res.status(409).json({ error: "already_subscribed", message: "You already have an active plan." });
      }
      if (req.body && req.body.dry) return res.json({ ok: true, dry: true, kind: peek.kind, plan: peek.plan });

      redeemed = await redeemCoupon(supabaseAdmin, { code, userId: req.user.id, target: "plan" });
      const plan = redeemed.plan;
      const end = computePeriodEnd({ termDays: TERM_DAYS[billingPeriod], existing, plan });
      const { error } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: req.user.id,
          plan,
          status: "active",
          provider: "coupon",
          provider_customer_id: null,
          provider_subscription_id: `coupon_${redeemed.redemptionId}`,
          billing_period: billingPeriod,
          current_period_end: end.toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (error) throw error;
      invalidateUser(req.user.id);
      res.json({ ok: true, plan, current_period_end: end.toISOString() });
    } catch (err) {
      if (redeemed) await releaseCoupon(supabaseAdmin, redeemed.redemptionId);
      if (err instanceof CouponError) return res.status(400).json({ error: err.code, message: err.message });
      console.error("[payments/coupon]", redact((err && (err.stack || err.message)) || String(err)));
      res.status(500).json({ error: "coupon_failed" });
    }
  },
);

// POST /api/payments/razorpay/verify
//   body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
//           plan, billingPeriod }
//   → { ok: true, plan }  (only when the signature is valid)
app.post(
  "/api/payments/razorpay/verify",
  requireAuth,
  checkoutLimiter,
  async (req, res) => {
    try {
      if (!razorpay.isEnabled()) {
        return res.status(503).json({ error: "checkout_unconfigured" });
      }
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        plan,
        billingPeriod,
      } = req.body || {};

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: "missing_fields" });
      }
      if (!PAID_PLANS.includes(plan) || !PERIODS.includes(billingPeriod)) {
        return res.status(400).json({ error: "missing_fields" });
      }

      const ok = razorpay.verifyPaymentSignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      });
      if (!ok) {
        return res.status(400).json({ error: "signature_mismatch" });
      }

      // Authoritative re-check against Razorpay. FAIL CLOSED: if the order
      // cannot be fetched (Razorpay 5xx / network) we must not grant on the
      // signature alone — the client can retry.
      const order = await razorpay.fetchOrder(razorpay_order_id);
      if (!order) {
        return res.status(503).json({ error: "order_lookup_failed", retryable: true });
      }
      // Payment captured but order not yet flipped to "paid" (Razorpay
      // moves created -> attempted -> paid): transient, let the client retry
      // rather than reporting a mismatch.
      if (String(order.status || "") === "attempted") {
        return res.status(503).json({ error: "order_not_yet_paid", retryable: true });
      }
      const n = order.notes || {};
      // Trust the order's OWN currency (Razorpay's authoritative record of
      // what was actually charged), not a freshly-recomputed one.
      const expected = expectedAmountFor(order.currency, plan, billingPeriod);
      if (
        String(order.status || "") !== "paid" ||
        String(n.user_id || "") !== String(req.user.id) ||
        String(n.plan || "") !== plan ||
        String(n.billingPeriod || "") !== billingPeriod ||
        Number(order.amount) !== expected ||
        Number(order.amount_paid ?? order.amount) !== expected
      ) {
        console.warn("[razorpay/verify] order/claim mismatch", redact(JSON.stringify({ n, status: order.status, amount: order.amount, expected })));
        return res.status(400).json({ error: "order_mismatch" });
      }

      // Exactly-once: the first of verify / order.paid webhook claims the
      // payment; the loser must not extend the term again (sql/30).
      const claim = await claimPayment({
        payment_id: razorpay_payment_id,
        order_id: razorpay_order_id,
        user_id: req.user.id,
        plan,
        billing_period: billingPeriod,
        amount: Number(order.amount),
        currency: order.currency || null,
        source: "verify",
      });
      if (!claim.claimed) {
        const { data: prior } = await supabaseAdmin
          .from("processed_payments")
          .select("user_id, plan, period_end")
          .eq("order_id", razorpay_order_id)
          .maybeSingle();
        if (prior && String(prior.user_id) === String(req.user.id)) {
          invalidateUser(req.user.id);
          return res.json({ ok: true, plan: prior.plan, current_period_end: prior.period_end, alreadyProcessed: true });
        }
        return res.status(409).json({ error: "payment_already_used" });
      }

      try {
        const { data: existing } = await supabaseAdmin
          .from("subscriptions")
          .select("plan, status, current_period_end")
          .eq("user_id", req.user.id)
          .maybeSingle();
        const end = computePeriodEnd({ termDays: TERM_DAYS[billingPeriod], existing, plan });
        const row = {
          user_id: req.user.id,
          plan,
          status: "active",
          provider: "razorpay",
          provider_customer_id: null,
          provider_subscription_id: razorpay_order_id, // UNIQUE — idempotent per order
          billing_period: billingPeriod,
          current_period_end: end.toISOString(),
        };
        const { error } = await supabaseAdmin
          .from("subscriptions")
          .upsert(row, { onConflict: "user_id" });
        if (error) throw error;
        await recordPaymentPeriodEnd(razorpay_payment_id, row.current_period_end).catch(() => {});

        invalidateUser(req.user.id); // drop the ~15s plan cache
        res.json({ ok: true, plan, current_period_end: row.current_period_end });
      } catch (grantErr) {
        await releasePayment(razorpay_payment_id).catch(() => {});
        throw grantErr;
      }
    } catch (err) {
      console.error("[razorpay/verify]", redact((err && (err.stack || err.message)) || String(err)));
      res.status(500).json({ error: "verify_failed" });
    }
  },
);

// ── Razorpay Subscriptions (recurring, in-page checkout) ────────────
// create → open the Checkout modal with the subscription_id → verify the
// callback signature → the webhook is the source of truth for status.

// Map Razorpay subscription status → our subscriptions.status.
function subStatusFromRazorpay(rzpStatus) {
  const s = String(rzpStatus || "").toLowerCase();
  if (s === "active" || s === "authenticated") return "active";
  if (s === "halted" || s === "cancelled" || s === "completed" || s === "expired") return s === "expired" ? "expired" : s;
  if (s === "pending") return "past_due";
  return "created"; // created / anything unknown
}

// GET /api/subscriptions/status → { configured, keyId, plans }
app.get("/api/subscriptions/status", requireAuth, (_req, res) => {
  res.json({
    configured: razorpay.subscriptionsConfigured(),
    keyId: razorpay.isEnabled() ? razorpay.keyId() : null,
  });
});

// POST /api/subscriptions/create  body: { plan:'pro'|'max', billingPeriod:'monthly'|'yearly' }
//   → { subscription_id, short_url, keyId }
app.post(
  "/api/subscriptions/create",
  requireAuth,
  checkoutLimiter,
  async (req, res) => {
    try {
      if (!razorpay.subscriptionsConfigured()) {
        return res.status(503).json({ error: "subscriptions_unconfigured" });
      }
      const { plan, billingPeriod } = req.body || {};
      assert(PAID_PLANS.includes(plan), "plan must be 'pro' or 'max'.");
      assert(PERIODS.includes(billingPeriod), "billingPeriod must be 'monthly' or 'yearly'.");

      const rzpPlanId = razorpay.planId(plan, billingPeriod);
      if (!rzpPlanId) return res.status(400).json({ error: "plan_not_configured" });

      // Never replace a live paid row with a 'created' placeholder.
      const { data: curSub } = await supabaseAdmin
        .from("subscriptions")
        .select("plan, status, provider, current_period_end")
        .eq("user_id", req.user.id)
        .maybeSingle();
      if (curSub && effectivePlanFromRow(curSub) !== "free") {
        return res.status(409).json({ error: "already_subscribed" });
      }

      // Reuse (or create) one Razorpay customer per user.
      let customerId = null;
      const { data: prof } = await supabaseAdmin
        .from("profiles")
        .select("razorpay_customer_id")
        .eq("id", req.user.id)
        .maybeSingle();
      customerId = prof?.razorpay_customer_id || null;
      if (!customerId) {
        const cust = await razorpay.createCustomer({
          email: req.user.email,
          notes: { user_id: req.user.id },
        });
        customerId = cust && cust.id;
        if (customerId) {
          await supabaseAdmin
            .from("profiles")
            .update({ razorpay_customer_id: customerId })
            .eq("id", req.user.id)
            .then(({ error }) => error && console.warn("[subscriptions] save customer_id:", redact(error.message)));
        }
      }

      const totalCount = billingPeriod === "yearly" ? 10 : 120;
      const sub = await razorpay.createSubscription({
        planIdValue: rzpPlanId,
        customerId,
        totalCount,
        notes: { user_id: req.user.id, plan, billingPeriod },
      });

      // Persist the "created" row now so the admin panel shows it immediately.
      await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: req.user.id,
          plan,
          status: subStatusFromRazorpay(sub.status),
          provider: "razorpay",
          provider_customer_id: customerId,
          provider_subscription_id: sub.id,
          provider_plan_id: rzpPlanId,
          subscription_short_url: sub.short_url || null,
          billing_period: billingPeriod,
        },
        { onConflict: "user_id" },
      ).then(({ error }) => error && console.warn("[subscriptions] upsert created row:", redact(error.message)));

      res.json({
        subscription_id: sub.id,
        short_url: sub.short_url || null,
        keyId: razorpay.keyId(),
      });
    } catch (err) {
      const status = Number(err && err.status) || 500;
      if (status === 400) return res.status(400).json({ error: err.message || "Invalid request." });
      if (status === 503) return res.status(503).json({ error: "subscriptions_unconfigured" });
      console.error("[subscriptions/create]", redact((err && err.message) || String(err)));
      res.status(502).json({ error: "create_failed" });
    }
  },
);

// POST /api/subscriptions/verify
//   body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
//   → { ok, plan, status }   (200 only when the signature is valid)
app.post(
  "/api/subscriptions/verify",
  requireAuth,
  checkoutLimiter,
  async (req, res) => {
    try {
      if (!razorpay.isEnabled()) {
        return res.status(503).json({ error: "subscriptions_unconfigured" });
      }
      const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body || {};
      if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
        return res.status(400).json({ error: "missing_fields" });
      }

      const ok = razorpay.verifySubscriptionSignature({
        paymentId: razorpay_payment_id,
        subscriptionId: razorpay_subscription_id,
        signature: razorpay_signature,
      });
      if (!ok) return res.status(400).json({ error: "signature_mismatch" });

      // The row must belong to this user (created in /create).
      const { data: existing } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id, plan, billing_period")
        .eq("provider_subscription_id", razorpay_subscription_id)
        .maybeSingle();
      if (!existing || String(existing.user_id) !== String(req.user.id)) {
        return res.status(400).json({ error: "subscription_mismatch" });
      }

      // Pull the authoritative state from Razorpay.
      const sub = await razorpay.fetchSubscription(razorpay_subscription_id);
      const status = subStatusFromRazorpay(sub && sub.status);
      const patch = { status, updated_at: new Date().toISOString() };
      if (sub && (sub.current_end || sub.charge_at)) {
        patch.current_period_end = new Date((sub.current_end || sub.charge_at) * 1000).toISOString();
      }
      if (sub && sub.customer_id) patch.provider_customer_id = sub.customer_id;
      await supabaseAdmin
        .from("subscriptions")
        .update(patch)
        .eq("provider_subscription_id", razorpay_subscription_id);

      invalidateUser(req.user.id);
      res.json({ ok: true, plan: existing.plan, status });
    } catch (err) {
      console.error("[subscriptions/verify]", redact((err && (err.stack || err.message)) || String(err)));
      res.status(500).json({ error: "verify_failed" });
    }
  },
);

// POST /api/webhooks/razorpay — subscription lifecycle. No auth; the X-Razorpay-
// Signature header (HMAC of the raw body with RAZORPAY_WEBHOOK_SECRET) is the
// authenticity check. Uses the global express.json `verify` hook for req.rawBody.
const RZP_SUB_EVENTS = new Set([
  "subscription.activated",
  "subscription.charged",
  "subscription.completed",
  "subscription.cancelled",
  "subscription.halted",
  "subscription.pending",
  "subscription.updated",
]);

app.post("/api/webhooks/razorpay", async (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "webhook_unconfigured" });
  }
  if (!razorpay.verifyWebhookSignature(req.rawBody, req.get("X-Razorpay-Signature"))) {
    return res.status(401).json({ error: "bad_signature" });
  }

  const eventId = String(req.get("x-razorpay-event-id") || "").slice(0, 128) || null;
  let eventClaimed = false;
  try {
    const event = String(req.body && req.body.event) || "";
    const eventCreatedMs = Number(req.body && req.body.created_at) * 1000 || null;

    // Retried / replayed deliveries carry the same event id: ack and skip.
    if (eventId) {
      const isNew = await claimWebhookEvent(eventId, event);
      if (!isNew) return res.status(200).json({ ok: true, duplicate: true });
      eventClaimed = true;
    }

    // AutoApply packs (order notes.kind === 'autoapply'): payment.captured /
    // order.paid -> idempotent batch 'paid' + ledger 'purchase'. null = not ours.
    const aa = await handleAutoApplyWebhook({ db: supabaseAdmin, body: req.body });
    if (aa) return res.status(200).json(aa);

    // One-time term payments: safety net for a lost browser callback (tab
    // closed right after paying). Grant the plan straight from order.notes —
    // idempotent with /api/payments/razorpay/verify via processed_payments.
    if (event === "order.paid") {
      const order = req.body?.payload?.order?.entity;
      const n = (order && order.notes) || {};
      if (!order || !PAID_PLANS.includes(n.plan) || !PERIODS.includes(n.billingPeriod) || !n.user_id) {
        return res.status(202).json({ ok: true, note: "order.paid: not a plan order" });
      }
      const paid = Number(order.amount_paid ?? order.amount);
      if (paid !== expectedAmountFor(order.currency, n.plan, n.billingPeriod)) {
        console.warn("[rzp-webhook] order.paid amount mismatch", redact(JSON.stringify({ id: order.id, paid })));
        return res.status(202).json({ ok: true, note: "amount mismatch" });
      }
      const payment = req.body?.payload?.payment?.entity;
      const paymentId = (payment && payment.id) || `order_${order.id}`;
      const claim = await claimPayment({
        payment_id: paymentId,
        order_id: order.id,
        user_id: n.user_id,
        plan: n.plan,
        billing_period: n.billingPeriod,
        amount: paid,
        currency: order.currency || null,
        source: "webhook",
      });
      if (!claim.claimed) {
        return res.status(200).json({ ok: true, duplicate: true, note: "payment already processed" });
      }
      try {
        const { data: existing } = await supabaseAdmin
          .from("subscriptions")
          .select("plan, status, current_period_end")
          .eq("user_id", n.user_id)
          .maybeSingle();
        const end = computePeriodEnd({ termDays: TERM_DAYS[n.billingPeriod], existing, plan: n.plan }).toISOString();
        const { error: upErr } = await supabaseAdmin.from("subscriptions").upsert(
          {
            user_id: n.user_id,
            plan: n.plan,
            status: "active",
            provider: "razorpay",
            provider_subscription_id: order.id, // UNIQUE per order — idempotent
            billing_period: n.billingPeriod,
            current_period_end: end,
          },
          { onConflict: "user_id" },
        );
        if (upErr) throw upErr;
        await recordPaymentPeriodEnd(paymentId, end).catch(() => {});
      } catch (grantErr) {
        await releasePayment(paymentId).catch(() => {});
        throw grantErr;
      }
      invalidateUser(n.user_id);
      return res.status(200).json({ ok: true, granted: n.plan });
    }

    if (!RZP_SUB_EVENTS.has(event)) {
      return res.status(200).json({ ok: true, ignored: event });
    }

    const entity =
      req.body?.payload?.subscription?.entity ||
      req.body?.payload?.payment?.entity?.subscription /* rare */ ||
      null;
    const subId = entity && (entity.id || entity.subscription_id);
    if (!subId) {
      return res.status(202).json({ ok: true, note: "no subscription id" });
    }

    // Resolve our user: the notes we set at creation, else the existing row.
    let userId = entity.notes && entity.notes.user_id;
    let planFromNotes = entity.notes && entity.notes.plan;
    if (!userId) {
      const { data: match } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id, plan")
        .eq("provider_subscription_id", subId)
        .maybeSingle();
      if (match) {
        userId = match.user_id;
        planFromNotes = planFromNotes || match.plan;
      }
    }
    if (!userId) {
      console.warn(`[rzp-webhook] ${event}: no user for ${redact(String(subId))}`);
      return res.status(202).json({ ok: true, note: "no user mapping" });
    }

    // Ignore events older than what we already stored (out-of-order delivery).
    if (eventCreatedMs) {
      const { data: stored } = await supabaseAdmin
        .from("subscriptions")
        .select("updated_at")
        .eq("user_id", userId)
        .eq("provider_subscription_id", subId)
        .maybeSingle();
      if (stored && stored.updated_at && new Date(stored.updated_at).getTime() > eventCreatedMs) {
        return res.status(200).json({ ok: true, ignored: "stale_event" });
      }
    }

    const status = subStatusFromRazorpay(entity.status);
    const patch = {
      user_id: userId,
      plan: planFromNotes || undefined,
      status,
      provider: "razorpay",
      provider_subscription_id: subId,
      updated_at: new Date().toISOString(),
    };
    if (entity.plan_id) patch.provider_plan_id = entity.plan_id;
    if (entity.customer_id) patch.provider_customer_id = entity.customer_id;
    if (entity.short_url) patch.subscription_short_url = entity.short_url;
    if (entity.current_end || entity.charge_at) {
      patch.current_period_end = new Date((entity.current_end || entity.charge_at) * 1000).toISOString();
    }
    // Never null the plan on a downgrade event — the lazy entitlement check
    // preserves access until current_period_end passes.
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    const { error } = await supabaseAdmin
      .from("subscriptions")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw error;

    invalidateUser(userId);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (eventClaimed) await releaseWebhookEvent(eventId).catch(() => {});
    console.error("[rzp-webhook]", redact((err && (err.stack || err.message)) || String(err)));
    res.status(500).json({ error: "processing_failed" }); // Razorpay retries
  }
});

// ── AutoApply API (routes/autoapply.js) ─────────────────────────────
// Off until AUTOAPPLY_ENABLED=1 on Railway (workers, mail and keys must be set up first).
app.use("/api/autoapply", (_req, res, next) =>
  process.env.AUTOAPPLY_ENABLED === "1"
    ? next()
    : res.status(404).json({ error: { code: "not_enabled", message: "AutoApply is not available yet." } }),
);
app.use("/api/autoapply/orders/coupon", couponIpLimiter);
app.post("/api/autoapply/orders", couponIpGate);
app.use(
  "/api/autoapply",
  createAutoApplyRouter({ limiters: { checkout: checkoutLimiter, write: catalogLimiter } }),
);

// ── Blog (public) ──────────────────────────────────────────────────
// The `blogs` table (sql/13) is RLS-readable for published rows; these routes
// proxy it so the client stays consistent and responses are cacheable.
app.get("/api/blog", catalogLimiter, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("blogs")
      .select("slug, title, excerpt, category, reading_time_minutes, published_at, cover_image_url")
      .eq("published", true)
      .order("published_at", { ascending: false });
    if (error) throw error;
    res
      .set("Cache-Control", "public, max-age=0, s-maxage=300")
      .json({ posts: data || [] });
  } catch (err) {
    // Table not created yet → empty list, not a 500.
    if (/does not exist|schema cache|Could not find the table/i.test(String(err.message || err))) {
      return res.json({ posts: [], notReady: true });
    }
    fail(res, err, "blog/list", "Failed to load blog posts.");
  }
});

app.get("/api/blog/:slug", catalogLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").slice(0, 200);
    const { data, error } = await supabaseAdmin
      .from("blogs")
      .select("slug, title, excerpt, content, category, reading_time_minutes, published_at, updated_at, cover_image_url, meta_title, meta_description")
      .eq("slug", slug)
      .eq("published", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "public, max-age=0, s-maxage=300").json({ post: data });
  } catch (err) {
    fail(res, err, "blog/post", "Failed to load the blog post.");
  }
});


// SPA + SEO fallback: for any non-/api route, serve the built index.html with a
// route-aware <head> — correct <title>, description, canonical, Open Graph +
// Twitter Card tags, and (blog posts) JSON-LD — injected into the RAW HTML
// before any JS runs. Private app routes get an explicit noindex. Registered
// AFTER all /api routes. Only active on this Express-served path (production /
// `npm run serve`); the Vite dev server on :5173 serves the plain template.
const INDEX_HTML = path.join(__dirname, "dist", "index.html");
const INDEX_TEMPLATE = existsSync(INDEX_HTML)
  ? readFileSync(INDEX_HTML, "utf8")
  : null;

// ── robots.txt (dynamic so the Sitemap: line uses the real origin) ──────────
// Allow public/indexable routes; disallow the API and every authenticated app
// route. User-triggered fetchers ignore robots.txt by design — the private
// routes also carry a noindex meta (see the SEO fallback below) as the real
// guard; this file is the crawl-budget hint.
//
// /dsa, /lld, /hld and /interview were previously disallowed here (and
// separately noindexed in seoHead.js) even though none of them require auth
// — that combination hid the entire product from Google. Both were lifted
// together; see seoHead.js's classifyRoute for the per-route detail (e.g.
// /hld/:id practice-workspace pages stay noindex, only /hld the list page
// is crawlable).
app.get("/robots.txt", (req, res) => {
  const base = baseUrl(req);
  const publicAllows = [
    "Allow: /",
    "Allow: /jobs/company/",
    "Allow: /optimizer",
    "Allow: /pricing",
    "Allow: /terms",
    "Allow: /privacy",
    "Allow: /refunds",
    "Allow: /contact",
    "Allow: /about",
    "Allow: /faq",
    "Allow: /questions",
    "Allow: /legal/",
    "Allow: /blog",
    "Allow: /dsa",
    "Allow: /lld",
    "Allow: /hld",
    "Allow: /interview",
  ];
  const disallows = [
    "Disallow: /api/",
    "Disallow: /auth",
    "Disallow: /profile",
    "Disallow: /dashboard",
    "Disallow: /referrals",
    "Disallow: /hld/",
  ];
  const aiBots = [
    "OAI-SearchBot",
    "ChatGPT-User",
    "GPTBot",
    "Claude-SearchBot",
    "ClaudeBot",
    "anthropic-ai",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "GoogleOther",
    "Bytespider",
    "Applebot-Extended",
    "CCBot",
  ];
  const lines = [
    "User-agent: *",
    ...publicAllows,
    ...disallows,
    "",
  ];
  for (const bot of aiBots) {
    lines.push(`User-agent: ${bot}`);
    lines.push(...publicAllows);
    lines.push(...disallows);
    lines.push("");
  }
  lines.push(`Sitemap: ${base}/sitemap.xml`);
  lines.push("");
  res.type("text/plain").send(lines.join("\n"));
});

// ── sitemap.xml (dynamic: static public pages + every published blog post,
// DSA company page and LLD problem) ──────────────────────────────────────
app.get("/sitemap.xml", async (req, res) => {
  const base = baseUrl(req);
  const urls = [
    { loc: `${base}/`, priority: "1.0", changefreq: "hourly" },
    { loc: `${base}/optimizer`, priority: "1.0", changefreq: "weekly" },
    { loc: `${base}/dsa`, priority: "0.9", changefreq: "weekly" },
    { loc: `${base}/lld`, priority: "0.9", changefreq: "weekly" },
    { loc: `${base}/hld`, priority: "0.8", changefreq: "weekly" },
    { loc: `${base}/interview`, priority: "0.8", changefreq: "weekly" },
    { loc: `${base}/pricing`, priority: "0.8", changefreq: "monthly" },
    { loc: `${base}/blog`, priority: "0.7", changefreq: "weekly" },
    { loc: `${base}/terms`, priority: "0.3", changefreq: "yearly" },
    { loc: `${base}/privacy`, priority: "0.3", changefreq: "yearly" },
    { loc: `${base}/refunds`, priority: "0.3", changefreq: "yearly" },
    { loc: `${base}/contact`, priority: "0.4", changefreq: "yearly" },
    { loc: `${base}/about`, priority: "0.4", changefreq: "monthly" },
    { loc: `${base}/faq`, priority: "0.4", changefreq: "monthly" },
    { loc: `${base}/legal/privacy`, priority: "0.2", changefreq: "yearly" },
    { loc: `${base}/legal/terms`, priority: "0.2", changefreq: "yearly" },
    { loc: `${base}/legal/guidelines`, priority: "0.2", changefreq: "yearly" },
  ];
  try {
    const { data } = await supabaseAdmin
      .from("blogs")
      .select("slug,updated_at,published_at")
      .eq("published", true)
      .order("published_at", { ascending: false });
    for (const b of data || []) {
      urls.push({
        loc: `${base}/blog/${encodeURIComponent(b.slug)}`,
        lastmod: (b.updated_at || b.published_at || "").slice(0, 10) || undefined,
        priority: "0.6",
        changefreq: "monthly",
      });
    }
  } catch (e) {
    console.warn("[seo] sitemap blog query failed", redact(String(e && e.message)));
  }
  try {
    // Only the curated, evidence-eligible companies go in the sitemap — a
    // company that fails evaluateJobHubIndexability still has a real,
    // reachable page (noindex,follow), it's just never submitted for crawl.
    const curatedSlugs = [...(await getCuratedJobsCompanySlugs())];
    const payloads = await Promise.all(curatedSlugs.map((slug) => getJobsCompanyPayload(slug).catch(() => null)));
    for (let i = 0; i < curatedSlugs.length; i += 1) {
      if (payloads[i]?.eligible) {
        urls.push({ loc: `${base}/jobs/company/${curatedSlugs[i]}`, priority: "0.5", changefreq: "daily" });
      }
    }
  } catch (e) {
    console.warn("[seo] sitemap jobs-company query failed", redact(String(e && e.message)));
  }
  try {
    // "company" is a text[] column (verified against the live schema on
    // 2026-09-13) — each row can list multiple companies, so we fan out over
    // the array instead of reading a scalar "company_name".
    const { data } = await supabaseAdmin
      .from("leetcode_company_problems")
      .select("company")
      .limit(2000);
    const seen = new Set();
    for (const row of data || []) {
      const companies = (row && row.company) || [];
      for (const raw of companies) {
        if (!raw) continue;
        const slug = String(raw)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        urls.push({ loc: `${base}/dsa/company/${slug}`, priority: "0.6", changefreq: "monthly" });
      }
    }
  } catch (e) {
    console.warn("[seo] sitemap dsa-company query failed", redact(String(e && e.message)));
  }
  try {
    // "slug" confirmed against the live lld_problems schema on 2026-09-13.
    const { data } = await supabaseAdmin.from("lld_problems").select("slug, updated_at, created_at").limit(2000);
    for (const row of data || []) {
      if (row && row.slug) {
        urls.push({
          loc: `${base}/lld/${encodeURIComponent(row.slug)}`,
          lastmod: (row.updated_at || row.created_at || "").slice(0, 10) || undefined,
          priority: "0.6",
          changefreq: "monthly",
        });
      }
    }
  } catch (e) {
    console.warn("[seo] sitemap lld query failed", redact(String(e && e.message)));
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map((u) => {
        const parts = [`    <loc>${escapeHtml(u.loc)}</loc>`];
        if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
        if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
        if (u.priority) parts.push(`    <priority>${u.priority}</priority>`);
        return `  <url>\n${parts.join("\n")}\n  </url>`;
      })
      .join("\n") +
    "\n</urlset>\n";
  res.type("application/xml").set("Cache-Control", "public, max-age=0, s-maxage=600").send(body);
});

// ── SSR-lite helpers ─────────────────────────────────────────────
// Rendered HTML is cached per route (pre-nonce) for 2 minutes; the per-request
// CSP nonce is stamped onto inline <script>s at send time.
const SSR_TTL_MS = 120_000;
const SSR_MAX = 300;
/** @type {Map<string, { html: string, cc: string, exp: number }>} */
const ssrCache = new Map();

function stampNonce(html, nonce) {
  if (!nonce) return html;
  // Inline executable scripts only: no src= and not a JSON data block.
  return html.replace(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")([^>]*)>/g, `<script nonce="${nonce}"$1>`);
}

app.get(/^(?!\/api).*/, async (req, res, next) => {
  if (!INDEX_TEMPLATE) return next(); // dev / no build

  // A path with a file extension that no static handler claimed is a missing
  // file, not an SPA route: 404 instead of serving the HTML shell.
  if (/\.[A-Za-z0-9]{1,8}$/.test(req.path)) {
    return res.status(404).type("text/plain").send("Not found");
  }

  // Stamp the CSP nonce on every HTML string sent from this handler.
  const rawSend = res.send.bind(res);
  res.send = (body) =>
    rawSend(typeof body === "string" ? stampNonce(body, res.locals.cspNonce) : body);

  const ssrKey = req.path.length <= 200 ? req.path : null;
  const ssrHit = ssrKey ? ssrCache.get(ssrKey) : null;
  if (ssrHit && ssrHit.exp > Date.now()) {
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", ssrHit.cc);
    return res.send(ssrHit.html);
  }

  let c = classifyRoute(req.path);

  let post = null;
  let jobsCompany = null;
  // Seeds window.__INITIAL_DATA__ (see lib/seoHead.js's renderIndex +
  // initialDataScript) for the handful of routes whose real content
  // otherwise depends on a client-side fetch after the shell paints — Google
  // hitting that fetch mid-render is what produced the confirmed soft-404 on
  // /dsa (Search Console: "Request failed (499)"). Always the anonymous/
  // free-tier view (a crawler never carries auth, and it's what a logged-out
  // human sees too) — never let building this be able to break the page:
  // every branch below is try/catch'd, falls through to `undefined` on any
  // failure, and the client's existing fetch-on-mount is the fallback,
  // completely unchanged.
  let initialData;
  if (c.kind === "public" && c.key === "dsaList") {
    try {
      const key = `dsa:free:`;
      initialData = { dsaList: await cached(key, 120000, () => buildDsaCatalogPayload({
        plan: "free", search: "", companies: [], difficulties: [], sort: "id", page: 1,
      })) };
    } catch (e) {
      console.warn("[seo] dsa initial-data fetch failed", redact(String(e && e.message)));
    }
  } else if (c.kind === "public" && c.key === "lldList") {
    try {
      const key = `lld:free:`;
      initialData = { lldList: await cached(key, 120000, () => buildLldCatalogPayload({
        plan: "free", search: "", companies: [], page: 1,
      })) };
    } catch (e) {
      console.warn("[seo] lld initial-data fetch failed", redact(String(e && e.message)));
    }
  } else if (c.kind === "public" && c.key === "hldList") {
    try {
      const key = `hld:free:`;
      initialData = { hldList: await cached(key, 120000, () => buildHldCatalogPayload({ plan: "free" })) };
    } catch (e) {
      console.warn("[seo] hld initial-data fetch failed", redact(String(e && e.message)));
    }
  }
  if (c.kind === "public" && c.key === "jobsCompany") {
    let payload = null;
    try {
      payload = await getJobsCompanyPayload(c.slug);
    } catch (e) {
      console.warn("[seo] jobs-company lookup failed", redact(String(e && e.message)));
    }
    if (!payload) {
      // Unknown company slug → 404 with noindex, same as an unknown blog slug.
      res.status(404).send(
        renderIndex(INDEX_TEMPLATE, {
          classify: { kind: "noindex" },
          base: baseUrl(req),
          path: req.path,
        }),
      );
      return;
    }
    jobsCompany = { name: payload.company.name, openCount: payload.postings.length };
    // Already fetched above for the meta tags — reuse it as the hydration
    // seed too instead of a second lookup. Same payload an anonymous
    // GET /api/jobs/company/:slug returns (the route has no plan branching).
    initialData = { jobsCompany: payload };
    // Real page either way — only the robots directive changes. A company
    // outside the curated set or short on evidence still gets a normal page,
    // just noindex,follow (evaluateJobHubIndexability never blocks the page).
    if (!payload.eligible) c = { kind: "noindex" };
  }
  if (c.kind === "public" && c.key === "blogPost") {
    try {
      const { data } = await supabaseAdmin
        .from("blogs")
        .select(
          "slug,title,excerpt,cover_image_url,meta_title,meta_description,published_at,updated_at",
        )
        .eq("slug", c.slug)
        .eq("published", true)
        .maybeSingle();
      post = data || null;
    } catch (e) {
      console.warn("[seo] blog lookup failed", redact(String(e && e.message)));
    }
    if (!post) {
      // Unknown/unpublished slug (or the blogs table doesn't exist yet) →
      // 404 with noindex so Google drops it.
      res.status(404).send(
        renderIndex(INDEX_TEMPLATE, {
          classify: { kind: "noindex" },
          base: baseUrl(req),
          path: req.path,
        }),
      );
      return;
    }
  }

  const html = renderIndex(INDEX_TEMPLATE, {
    classify: c,
    base: baseUrl(req),
    path: req.path,
    post,
    jobsCompany,
    initialData,
  });
  res.set("Content-Type", "text/html; charset=utf-8");
  // s-maxage was 300s — a shared/CDN cache could keep serving this shell for
  // up to 5 minutes after a deploy, and its <script> tags reference the
  // PREVIOUS build's content-hashed chunk filenames, which Vite doesn't keep
  // around once superseded. A tab that loads (or a crawler that's served)
  // one of those stale shells 404s on its first lazy-route navigation —
  // exactly the "Something broke" report this comment is fixing. 30s keeps
  // most of the shared-cache benefit while shrinking that window to
  // something a real deploy essentially never lands inside twice in a row;
  // ErrorBoundary.jsx's chunk-error auto-reload is the remaining backstop.
  const cacheControl =
    c.kind === "public" ? "public, max-age=0, s-maxage=30, stale-while-revalidate=30" : "no-store";
  res.set("Cache-Control", cacheControl);
  // Only cache real, indexable public pages (bounded; unknown paths never grow it).
  if (ssrKey && c.kind === "public") {
    if (ssrCache.size >= SSR_MAX) {
      const k = ssrCache.keys().next().value;
      if (k !== undefined) ssrCache.delete(k);
    }
    ssrCache.set(ssrKey, { html, cc: cacheControl, exp: Date.now() + SSR_TTL_MS });
  }
  res.send(html);
});

// ── Final error handler (multer errors, body-parser errors, etc.) ──
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[error]", redact((err && (err.stack || err.message)) || String(err)));
  if (res.headersSent) return;
  const status =
    err instanceof multer.MulterError ? 400 : Number(err && err.status) || 500;
  if (status === 400) {
    return res
      .status(400)
      .json({ error: err.message || "Invalid request." });
  }
  res.status(500).json({ error: "Something went wrong." });
});

// ── Referral request expiry sweep ───────────────────────────────
// Flip open requests whose expires_at has passed to 'expired'. Runs daily at
// 03:15 server time, plus once ~10s after boot so a long-down server catches
// up. No-op (logged once) without a service-role key.
async function sweepExpiredReferrals() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const { data, error } = await supabaseAdmin
      .from("referral_requests")
      .update({ status: "expired" })
      .eq("status", "open")
      .lt("expires_at", new Date().toISOString())
      .select("id");
    if (error) {
      console.error(
        "[referrals] expiry sweep failed",
        redact(error.message || String(error)),
      );
      return;
    }
    console.log("[referrals] expiry sweep:", data?.length ?? 0, "expired");
  } catch (e) {
    console.error(
      "[referrals] expiry sweep threw",
      redact((e && e.message) || String(e)),
    );
  }
}

if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  cron.schedule("15 3 * * *", sweepExpiredReferrals);
  const bootSweep = setTimeout(sweepExpiredReferrals, 10_000);
  if (typeof bootSweep.unref === "function") bootSweep.unref();
} else {
  console.warn(
    "[referrals] expiry sweep disabled (no SUPABASE_SERVICE_ROLE_KEY)",
  );
}

// ── Company subscription job-alert digest ─────────────────────────
// Runs once a day at 09:00 Asia/Kolkata. For every company with at least one
// subscriber, finds postings first seen in the last ~26h (24h + slack so a
// late or slow run never leaves a gap; the dedup log prevents repeats) (via the
// company_subscription_new_postings() SQL join — see sql/18), fans out one
// email per (subscriber, company-with-new-postings) pair via resend.sendEmail,
// records each sent (user_id, job_posting_id) pair in the dedup log so a
// retried/overlapping run never double-sends, then prunes dedup rows older
// than 3 days (job_posting rows themselves only live ~24h, so nothing older
// than a few days is ever useful there). No-op without a service-role key.
let digestRunning = false;
async function sendCompanySubscriptionDigest() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  if (!resend.isEnabled()) {
    console.error("[company-subs] digest skipped: RESEND_API_KEY is not set, no job alerts can be emailed");
    return;
  }
  if (digestRunning) return; // a slow run must not overlap the next tick
  digestRunning = true;
  try {
    const since = new Date(Date.now() - 26 * 3600 * 1000).toISOString();

    // Restricted to subscribed companies via a real DB-level join (see the
    // SQL function) — never by pulling every subscription row into the app
    // just to build an .in() filter.
    const { data: newPostings, error: postErr } = await supabaseAdmin.rpc(
      "company_subscription_new_postings",
      { since },
    );
    if (postErr) throw postErr;

    if (newPostings && newPostings.length) {
      const slugs = [...new Set(newPostings.map((p) => p.company_slug))];

      const { data: subs, error: subErr } = await supabaseAdmin
        .from("company_subscriptions")
        .select("user_id, company_slug, company_name")
        .in("company_slug", slugs);
      if (subErr) throw subErr;

      const postingsByCompany = new Map();
      for (const p of newPostings) {
        if (!postingsByCompany.has(p.company_slug)) postingsByCompany.set(p.company_slug, []);
        postingsByCompany.get(p.company_slug).push(p);
      }

      const jobPostingIds = [...new Set(newPostings.map((p) => p.id))];
      const { data: alreadySent, error: sentErr } = await supabaseAdmin
        .from("company_subscription_alerts_sent")
        .select("user_id, job_posting_id")
        .in("job_posting_id", jobPostingIds);
      if (sentErr) throw sentErr;
      const sentSet = new Set(
        (alreadySent || []).map((r) => `${r.user_id}:${r.job_posting_id}`),
      );

      // One entry per email, carrying the dedup rows it covers — a row is
      // only recorded once its email was actually accepted by Resend.
      const outgoing = [];

      for (const sub of subs || []) {
        const postings = postingsByCompany.get(sub.company_slug) || [];
        const unsent = postings.filter(
          (p) => !sentSet.has(`${sub.user_id}:${p.id}`),
        );
        if (!unsent.length) continue;

        const authUser = await referralAuthUser(sub.user_id);
        if (!authUser || !authUser.email) continue;

        const tpl = companyJobAlertEmail({
          companyName: sub.company_name,
          // Newest first — the email lists only the first few.
          newJobs: [...unsent]
            .sort((a, b) => String(b.first_seen_at || "").localeCompare(String(a.first_seen_at || "")))
            .map((p) => ({
              title: p.title,
              url: p.url,
              location: p.location,
              seniority: p.seniority,
            })),
          companyUrl: `${APP_BASE_URL}/jobs/company/${encodeURIComponent(sub.company_slug)}`,
          manageUrl: `${APP_BASE_URL}/profile`,
        });
        outgoing.push({
          email: { to: authUser.email, tag: "company_job_alert", ...tpl },
          rows: unsent.map((p) => ({ user_id: sub.user_id, job_posting_id: p.id })),
        });
      }

      // Previously every alert was written to the dedup log whether or not
      // the email went out, so a skipped send (no RESEND_API_KEY) or a
      // rejected one (unverified sender) silently and permanently swallowed
      // those jobs. Only successful sends are recorded now; failures retry
      // on the next run.
      const toRecord = [];
      let sent = 0;
      let failed = 0;
      for (const { email, rows } of outgoing) {
        const result = await resend.sendEmail(email);
        if (result && result.id) {
          sent += 1;
          toRecord.push(...rows);
        } else {
          failed += 1;
        }
      }
      if (outgoing.length) {
        console.log("[company-subs] digest fan-out:", { sent, failed });
      }

      if (toRecord.length) {
        const { error: recErr } = await supabaseAdmin
          .from("company_subscription_alerts_sent")
          .upsert(toRecord, { onConflict: "user_id,job_posting_id", ignoreDuplicates: true });
        if (recErr) {
          console.error(
            "[company-subs] failed to record sent alerts:",
            redact(recErr.message || String(recErr)),
          );
        }
      }
    } else {
      console.log("[company-subs] digest: no new postings for subscribed companies");
    }

    // Prune old dedup rows — best effort, part of the same daily run.
    const pruneBefore = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { error: pruneErr } = await supabaseAdmin
      .from("company_subscription_alerts_sent")
      .delete()
      .lt("sent_at", pruneBefore);
    if (pruneErr) {
      console.error(
        "[company-subs] dedup-log prune failed:",
        redact(pruneErr.message || String(pruneErr)),
      );
    }
  } catch (e) {
    console.error(
      "[company-subs] digest failed",
      redact((e && e.message) || String(e)),
    );
  } finally {
    digestRunning = false;
  }
}

if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // Once a day, 09:00 India time — a single morning digest per company.
  cron.schedule("0 9 * * *", sendCompanySubscriptionDigest, { timezone: "Asia/Kolkata" });
} else {
  console.warn(
    "[company-subs] job-alert digest disabled (no SUPABASE_SERVICE_ROLE_KEY)",
  );
}

// AutoApply refunds: 'refund_due' batches -> Razorpay refund of the unused
// share -> ledger 'refund' -> 'refunded'. Every 15 min. Runs without Razorpay keys too: zero-amount (coupon)
// batches, parked cancels and stale waiting_supply batches need no Razorpay call (paid refunds then wait).
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  if (!razorpay.isEnabled()) console.warn("[autoapply] Razorpay keys not set: paid refunds wait, zero-amount batches still processed");
  cron.schedule("*/15 * * * *", () => runAutoApplyRefunds(), { timezone: "Asia/Kolkata" });
} else {
  console.warn("[autoapply] refunds cron disabled (no SUPABASE_SERVICE_ROLE_KEY)");
}

// AutoApply pending orders: pending_payment older than 24 h -> 'cancelled' (a payment that still lands is
// auto-refunded by markBatchPaid). Hourly.
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  cron.schedule("10 * * * *", () => runExpirePendingOrders().then((r) => { if (r.expired) console.log("[autoapply] pending orders expired", r); }, (e) => console.error("[autoapply] pending expiry failed:", (e && e.message) || e)), { timezone: "Asia/Kolkata" });
}

// AutoApply proof retention: aa-proof screenshots older than 30 days are deleted and aa_tasks.proof_path nulled
// (confirmation_text stays). Daily 04:10 IST.
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  cron.schedule("10 4 * * *", () => cleanupOldProofs({ db: supabaseAdmin }).then((r) => console.log("[autoapply] proof retention", r)), { timezone: "Asia/Kolkata" });
}

// AutoApply mail (mail lives only inside Vloombox; see docs/autoapply-contract.md).
// Daily cleanup deletes expired rows from the mail db (it also keeps a free Supabase mail project from
// pausing); the daily alert sends ONE short email per user with new important mail (Resend free tier: max
// 100 sends per run, leftovers go to the next run).
if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.AUTOAPPLY_ENABLED === "1") {
  cron.schedule("40 3 * * *", () => runMailCleanup().then((r) => console.log("[autoapply] mail cleanup", r), (e) => console.error("[autoapply] mail cleanup failed:", (e && e.message) || e)), { timezone: "Asia/Kolkata" });
  cron.schedule("0 19 * * *", () => runDailyMailAlerts({ baseUrl: APP_BASE_URL }).then((r) => console.log("[autoapply] daily mail alerts", r), (e) => console.error("[autoapply] daily mail alerts failed:", (e && e.message) || e)), { timezone: "Asia/Kolkata" });
  // Interview reminders: push 24 h and 1 h before each aa_interviews.starts_at (claimed per row, never sent twice).
  cron.schedule("*/5 * * * *", () => runInterviewReminders().then((r) => { if (r.sent || r.skipped) console.log("[autoapply] interview reminders", r); }, (e) => console.error("[autoapply] interview reminders failed:", (e && e.message) || e)), { timezone: "Asia/Kolkata" });
} else {
  console.warn("[autoapply] mail cleanup + alert crons disabled (AUTOAPPLY_ENABLED!=1 or no SUPABASE_SERVICE_ROLE_KEY)");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  if (process.env.PORT) {
    console.log(`Server listening on port ${PORT}`);
  } else {
    console.log(`Resume optimizer running at http://localhost:${PORT}`);
  }
  console.log(`Reading baseline resume from: ${SOURCE_DIR}`);
});

