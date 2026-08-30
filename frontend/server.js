import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import cron from "node-cron";

import {
  extractStructuredResume,
  generateTailoredResume,
  redact,
} from "./lib/aiClient.js";
import { compileLatexToPdf } from "./lib/latexCompiler.js";
import { buildFilename } from "./lib/filename.js";
import { requireAuth } from "./lib/requireAuth.js";
import {
  canAccess,
  incrementUsage,
  getRemainingUsage,
  getUserPlan,
  getEntitlementsSummary,
  invalidateUser,
} from "./lib/entitlements.js";
import * as resend from "./services/resend.js";
import {
  referralRequestCreated,
  referralAccepted,
} from "./lib/referralEmails.js";
import {
  getLimit,
  isUnlimited,
  serializeLimit,
  isValidPlan,
  priceInrPaise,
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
import { classifyRoute, renderIndex, baseUrl, escapeHtml } from "./lib/seoHead.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, "resume-source");

const app = express();

// Behind Railway's proxy: trust the first hop so express-rate-limit sees the
// real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

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

// Capture the raw request bytes on `req.rawBody` (needed by the Lemon Squeezy
// webhook for HMAC signature verification) while normal JSON parsing continues
// everywhere. Single body parser — do NOT add a second one.
app.use(
  express.json({
    limit: "12mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// ── Rate limiting ────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
});
const catalogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
});

app.use("/api", generalLimiter);

// Serve the built frontend (Vite `dist/` output) as static files so you only need one server running.
// `index: false` — never auto-serve dist/index.html for "/"; the SEO-aware
// fallback handler below owns "/" (and every other non-asset route) so it can
// inject a route-correct <head>.
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

// pdfjs-dist (legacy build) — used for link-annotation extraction and page-fill
// measurement. pdf-parse@2.4.5's own hyperlink/info APIs throw
// "Cannot transfer object of unsupported type" in Node, so we go direct.
let _pdfjs;
async function loadPdfjs() {
  if (!_pdfjs) {
    const { pathToFileURL } = await import("node:url");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    _pdfjs = await import(
      pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href
    );
    _pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  return _pdfjs;
}

// Real http(s) profile URLs only — drop mailto:, tel:, wa.me phone links, and
// empty placeholder hrefs like a bare "https://" (common in résumé templates
// where the LinkedIn/GitHub icon was never given a real address).
function isUsefulProfileUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(s)) return false;
  if (/^https?:\/\/wa\.me\//i.test(s)) return false;
  return true;
}

// Extract text from an uploaded PDF, enriched with hyperlink targets. Résumés
// render "LinkedIn"/"GitHub" as anchor text (often an icon glyph that yields NO
// extractable text at all) while the real URL lives only in the link
// annotation. We append an explicit "DETECTED HYPERLINKS" block so the extractor
// can resolve bare anchors — but only for links that actually carry a URL.
async function extractPdfText(buffer) {
  let text = "";
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    text = r?.text?.trim() || "";
  } finally {
    await parser.destroy().catch(() => {});
  }

  const urls = [];
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const annots = await page.getAnnotations();
        for (const a of annots) {
          if (a.subtype !== "Link") continue;
          const u = String(a.url || a.unsafeUrl || "").trim().replace(/[).,;]+$/, "");
          if (isUsefulProfileUrl(u)) urls.push(u);
        }
      }
    } finally {
      await doc.destroy().catch(() => {});
    }
  } catch (e) {
    console.warn("[generate] pdfjs link extraction failed:", redact(e?.message || String(e)));
  }

  const unique = [...new Set(urls)];
  if (unique.length) {
    text +=
      `\n\nDETECTED HYPERLINKS (exact URLs pulled from the PDF's link annotations — ` +
      `use these to fill contact.links / linkedin / github when the visible text only shows anchor words like "LinkedIn"/"GitHub"):\n` +
      unique.join("\n");
  }
  return text;
}

// Layout of a COMPILED résumé PDF: page count + how much of page 1 is blank at
// the bottom (0 = content reaches the bottom margin, 0.2 = bottom fifth empty).
// Used to enforce "exactly one, fully-filled page".
async function pdfLayoutInfo(buffer) {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
    try {
      const pages = doc.numPages;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let minY = vp.height;
      for (const it of tc.items) {
        const y = it.transform && it.transform[5];
        if (typeof y === "number" && y < minY) minY = y;
      }
      // minY = distance of lowest text from the page bottom (PDF origin = bottom-left).
      const bottomGapRatio = Math.max(0, Math.min(1, minY / vp.height));
      return { pages, bottomGapRatio };
    } finally {
      await doc.destroy().catch(() => {});
    }
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
  res.json({ ok: true });
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

// ── Resume optimizer ──────────────────────────────────────────
app.post(
  "/api/generate",
  aiLimiter,
  requireAuth,
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

      // Success — meter the use, then respond. A metering failure must not
      // deny the user the PDF they already generated.
      try {
        await incrementUsage(req.user.id, "resume_optimizer");
      } catch (e) {
        console.error(
          "[generate] incrementUsage failed:",
          redact(e?.message || String(e)),
        );
      }

      res.json({
        filename,
        pdfBase64: pdfBuffer.toString("base64"),
        metrics,
        beforeMetrics,
        tex,
        cls,
      });
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

async function geminiFetch(model, payload) {
  const res = await fetch(GEMINI_ENDPOINT(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
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

app.post("/api/hld/generate", aiLimiter, requireAuth, async (req, res) => {
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

    const gate = await canAccess(req.user.id, "hld_practice");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }

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

    try {
      await incrementUsage(req.user.id, "hld_practice");
    } catch (e) {
      console.error(
        "[hld/generate] incrementUsage failed:",
        redact(e?.message || String(e)),
      );
    }

    res.json({ fr, nfr });
  } catch (err) {
    fail(res, err, "hld/generate", "AI service error");
  }
});

app.post("/api/hld/judge", aiLimiter, requireAuth, async (req, res) => {
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

    const gate = await canAccess(req.user.id, "hld_practice");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }

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
    res.json(result);
  } catch (err) {
    fail(res, err, "hld/judge", "AI service error");
  }
});

// ── Generic AI explanation (metered: ai_explanation) ─────────────
app.post("/api/ai/explain", aiLimiter, requireAuth, async (req, res) => {
  try {
    const { prompt, code, question } = req.body || {};
    const input = [question, prompt, code].find((v) => isNonEmptyString(v));
    assert(isNonEmptyString(input), "Provide `prompt`, `code`, or `question`.");
    assert(maxLen(input, 8000), "Input is too long (max 8000 characters).");

    if (!process.env.GEMINI_API_KEY) {
      console.error("[ai/explain] GEMINI_API_KEY not set");
      return res.status(500).json({ error: "AI service is not configured." });
    }

    const gate = await canAccess(req.user.id, "ai_explanation");
    if (!gate.allowed) {
      return res.status(402).json({
        error: "usage_limit",
        feature: "ai_explanation",
        ...paywallFields(gate),
      });
    }

    const p = `You are a concise technical tutor helping someone prepare for software-engineering interviews. Explain the following clearly and accurately. Use short paragraphs and a concrete example when it helps.

---
${input}
---`;
    const explanation = await callGemini(p);

    try {
      await incrementUsage(req.user.id, "ai_explanation");
    } catch (e) {
      console.error(
        "[ai/explain] incrementUsage failed:",
        redact(e?.message || String(e)),
      );
    }

    res.json({ explanation });
  } catch (err) {
    fail(res, err, "ai/explain", "AI service error");
  }
});

// ── Catalog endpoints (server-enforced entitlements) ─────────────
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
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .order(orderCol, { ascending })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if ((data || []).length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// GET /api/catalog/dsa?search=&company=&difficulty=&sort=&page=
// Free cap is on the CATALOG (first N rows by id asc), applied BEFORE the
// caller's filter/sort — so a free user can never page or filter their way to
// row N+1. pro/max (Infinity) get the full filtered + paged set.
app.get("/api/catalog/dsa", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const plan = await getUserPlan(req.user.id);
    const limit = getLimit(plan, "dsa_catalog_visible");
    const unlimited = isUnlimited(limit);

    const search = String(req.query.search || "").slice(0, 200);
    const companies = csvParam(req.query.company);
    const difficulties = csvParam(req.query.difficulty);
    const sort = ["alpha", "difficulty", "id"].includes(String(req.query.sort))
      ? String(req.query.sort)
      : "id";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 50;

    const rowsAll = normalizeDsa(
      await fetchAllRows(
        "leetcode_company_problems",
        "id, title, difficulty, link, company, topics",
        "id",
        true,
      ),
    );
    const total = rowsAll.length;

    let base = rowsAll;
    let locked = 0;
    if (!unlimited) {
      const cap = Math.min(limit, total);
      base = rowsAll.slice(0, cap);
      locked = Math.max(0, total - cap);
    }

    const filtered = filterSortDsa(base, {
      search,
      companies,
      difficulties,
      sort,
    });

    let items;
    let pageOut = 1;
    let pageCount = 1;
    if (unlimited) {
      pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      pageOut = Math.min(page, pageCount);
      items = filtered.slice((pageOut - 1) * pageSize, pageOut * pageSize);
    } else {
      items = filtered; // free: capped preview, no pagination
    }

    res.json({
      items,
      total,
      locked,
      limit: serializeLimit(limit),
      page: pageOut,
      pageSize,
      pageCount,
      filteredCount: filtered.length,
    });
  } catch (err) {
    fail(res, err, "catalog/dsa", "Failed to load catalog.");
  }
});

// GET /api/catalog/lld?search=&company=&page=
app.get("/api/catalog/lld", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const plan = await getUserPlan(req.user.id);
    const limit = getLimit(plan, "lld_catalog_visible");
    const unlimited = isUnlimited(limit);

    const search = String(req.query.search || "").slice(0, 200);
    const companies = csvParam(req.query.company);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 12;

    const { data, error } = await supabaseAdmin
      .from("lld_problems")
      .select("id, slug, title, requirements, companies, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rowsAll = data || [];
    const total = rowsAll.length;

    let base = rowsAll;
    let locked = 0;
    if (!unlimited) {
      const cap = Math.min(limit, total);
      base = rowsAll.slice(0, cap);
      locked = Math.max(0, total - cap);
    }

    const s = search.toLowerCase();
    let filtered = base.filter((p) => {
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

    let items;
    let pageOut = 1;
    let pageCount = 1;
    if (unlimited) {
      pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      pageOut = Math.min(page, pageCount);
      items = filtered.slice((pageOut - 1) * pageSize, pageOut * pageSize);
    } else {
      items = filtered;
    }

    res.json({
      items,
      total,
      locked,
      limit: serializeLimit(limit),
      page: pageOut,
      pageSize,
      pageCount,
      filteredCount: filtered.length,
    });
  } catch (err) {
    fail(res, err, "catalog/lld", "Failed to load catalog.");
  }
});

// GET /api/catalog/lld/:slug  → full problem row, gated by lld_catalog_visible.
// Parallel to /api/catalog/hld/:id. The client still fetches lld_code_files /
// lld_class_diagrams via its own RLS-scoped queries — only the problem row
// itself goes through here.
app.get("/api/catalog/lld/:slug", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const plan = await getUserPlan(req.user.id);
    const limit = getLimit(plan, "lld_catalog_visible");
    const unlimited = isUnlimited(limit);
    const slug = String(req.params.slug);

    const { data: row, error } = await supabaseAdmin
      .from("lld_problems")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: "not_found" });

    if (unlimited) return res.json({ item: row });

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
    res.json({ item: row });
  } catch (err) {
    fail(res, err, "catalog/lld/:slug", "Failed to load problem.");
  }
});

// GET /api/catalog/hld
// list_only (free): full list, every item { locked: true }, premium fields stripped.
// full (pro/max): normal rows.
app.get("/api/catalog/hld", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const plan = await getUserPlan(req.user.id);
    const access = getLimit(plan, "hld_catalog_access"); // 'list_only' | 'full'

    const { data, error } = await supabaseAdmin
      .from("hld_questions")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data || [];

    if (access === "list_only") {
      const items = rows.map((r) => ({
        id: r.id,
        title: r.title || r.question || "(Untitled)",
        companies: r.companies || r.company || [],
        difficulty: r.difficulty || null,
        locked: true,
      }));
      return res.json({
        items,
        total: rows.length,
        locked: rows.length,
        access,
      });
    }

    const items = rows.map((r) => ({
      ...r,
      title: r.title || r.question || "(Untitled)",
      description: r.description || "",
      companies: r.companies || r.company || [],
      slug: r.slug || r.questionid || String(r.id),
      difficulty: r.difficulty || null,
      locked: false,
    }));
    res.json({ items, total: rows.length, locked: 0, access });
  } catch (err) {
    fail(res, err, "catalog/hld", "Failed to load catalog.");
  }
});

// GET /api/catalog/hld/:id  → gated on canAccess('hld_practice')
app.get("/api/catalog/hld/:id", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const gate = await canAccess(req.user.id, "hld_practice");
    if (!gate.allowed) {
      return res.status(403).json({
        error: "upgrade_required",
        feature: "hld_practice",
        ...paywallFields(gate),
      });
    }

    const { data, error } = await supabaseAdmin
      .from("hld_questions")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "not_found" });

    res.json({
      item: {
        ...data,
        title: data.title || data.question || "(Untitled)",
        description: data.description || "",
        companies: data.companies || data.company || [],
        slug: data.slug || data.questionid || String(data.id),
        difficulty: data.difficulty || null,
      },
    });
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
  requireAuth,
  async (req, res) => {
    try {
      const plan = await getUserPlan(req.user.id);
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
        return res.json({ subcategories: subs });
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

      res.json({ items, total, locked, limit: serializeLimit(limit) });
    } catch (err) {
      fail(res, err, "catalog/interview", "Failed to load questions.");
    }
  },
);

// GET /api/catalog/search?q=&limit=
// Server-side jump-to-problem search for the command palette. The tier cap is
// applied to the CATALOG (first N rows, same ordering as /api/catalog/dsa and
// /api/catalog/lld) BEFORE the text match — so a free user's search can never
// surface a capped-out problem.
app.get("/api/catalog/search", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 6));
    if (!q) return res.json({ dsa: [], lld: [] });

    const plan = await getUserPlan(req.user.id);
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

    res.json({ dsa, lld });
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
  requireAuth,
  async (_req, res) => {
    try {
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
      res.json({ companies: [...set].filter(Boolean).sort() });
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

    const [dsaRows, lldCount, hldCount, progRes, readinessRes] =
      await Promise.all([
        fetchAllRows(
          "leetcode_company_problems",
          "id, difficulty, topics",
          "id",
          true,
        ),
        supabaseAdmin
          .from("lld_problems")
          .select("*", { count: "exact", head: true }),
        supabaseAdmin
          .from("hld_questions")
          .select("*", { count: "exact", head: true }),
        supabaseAdmin
          .from("user_problem_progress")
          .select("problem_id, status")
          .eq("user_id", uid)
          .eq("problem_type", "dsa"),
        supabaseAdmin.rpc("get_company_readiness", { p_user_id: uid }),
      ]);

    const norm = normalizeDsa(dsaRows);
    const solved = new Set(
      (progRes.data || [])
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
// JobsPage.jsx renders.
function normalizeJob(row, companyNameBySlug) {
  const company =
    (companyNameBySlug && companyNameBySlug[row.company_slug]) ||
    row.company_slug ||
    "";
  let locationType = String(row.location_type || "").toLowerCase();
  if (locationType === "telecommute") locationType = "remote"; // schema.org enum leak
  if (locationType === "on_site") locationType = "onsite";
  return {
    id: row.id,
    title: String(row.title || (Array.isArray(row.titles) && row.titles[0]) || ""),
    company: String(company || ""),
    location: row.location || "",
    locationType,
    seniority: row.seniority || "",
    employmentType: row.employment_type || "",
    url: row.url || "",
    source: row.source || "",
    firstSeen: row.first_seen_at || null,
    lastSeen: row.last_seen_at || null,
    status: row.status || "open",
  };
}

const SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "staff", "principal", "unknown"];

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

app.get("/api/jobs", catalogLimiter, requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 120);
    const company = String(req.query.company || "").trim().slice(0, 80);
    const location = String(req.query.location || "").trim().slice(0, 80);
    const locationType = String(req.query.location_type || "")
      .trim()
      .toLowerCase()
      .slice(0, 20);
    const source = String(req.query.source || "").trim().slice(0, 40);
    const seniority = String(req.query.seniority || "").trim().toLowerCase().slice(0, 20);
    const postedWithin = String(req.query.posted_within || "").trim(); // '1' | '3' | '5' | 'older'
    const sort = String(req.query.sort || "newest").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const from = (page - 1) * JOBS_PAGE_SIZE;
    const to = from + JOBS_PAGE_SIZE - 1;

    const likeSafe = (s) => s.replace(/[%_,()]/g, " ");
    const daysAgoISO = (d) => new Date(Date.now() - d * 86400000).toISOString();

    // `seniority` column is added by a later crawler migration — if it's not
    // there yet, retry the query once without selecting or filtering on it.
    const build = (withSeniority) => {
      const cols =
        "id, company_slug, title, location, location_type, employment_type, url, source, first_seen_at, last_seen_at, status" +
        (withSeniority ? ", seniority" : "");
      let q = jobsDb()
        .from(JOBS_TABLE)
        .select(cols, { count: "exact" })
        .eq("status", "open")
        .range(from, to);

      if (sort === "oldest") q = q.order("first_seen_at", { ascending: true }).order("id", { ascending: true });
      else if (sort === "company") q = q.order("company_slug", { ascending: true }).order("first_seen_at", { ascending: false });
      else q = q.order("first_seen_at", { ascending: false }).order("id", { ascending: false });

      if (search) q = q.textSearch("search_tsv", search, { type: "websearch", config: "english" });
      // company_slug is hyphenated lowercase ("jane-street"); let "Jane Street"
      // match by turning spaces/hyphens into wildcards.
      if (company) q = q.ilike("company_slug", `%${likeSafe(company).trim().replace(/[\s-]+/g, "%")}%`);
      if (location) q = q.ilike("location", `%${likeSafe(location)}%`);
      if (locationType) q = q.eq("location_type", locationType);
      if (source) q = q.eq("source", source);
      if (withSeniority && seniority) q = q.eq("seniority", seniority);
      if (postedWithin === "older") q = q.lt("first_seen_at", daysAgoISO(5));
      else if (["1", "3", "5"].includes(postedWithin)) q = q.gte("first_seen_at", daysAgoISO(Number(postedWithin)));
      return q;
    };

    let resp = await build(true);
    if (resp.error && /seniority/i.test(String(resp.error.message || resp.error))) {
      resp = await build(false);
    }
    const { data, error, count } = resp;
    if (error) throw error;

    const rows = data || [];

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

    const items = rows.map((r) => normalizeJob(r, companyNameBySlug)).filter((j) => j.url);

    // Source facet for the dropdown (best-effort).
    let sources = [];
    try {
      const { data: sRows } = await jobsDb()
        .from(JOBS_TABLE)
        .select("source")
        .eq("status", "open")
        .not("source", "is", null)
        .limit(3000);
      sources = [...new Set((sRows || []).map((r) => r.source).filter(Boolean))]
        .sort()
        .slice(0, 40);
    } catch {
      /* facets are optional */
    }

    res.json({
      items,
      total: count ?? items.length,
      page,
      pageCount: Math.max(1, Math.ceil((count ?? items.length) / JOBS_PAGE_SIZE)),
      facets: {
        sources,
        locationTypes: ["remote", "hybrid", "onsite"],
        seniorities: SENIORITY_ORDER,
      },
    });
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

// GET /api/jobs/analytics → aggregate metrics for the Jobs → Analytics tab.
// Prefers the crawler.jobs_analytics() SQL function; falls back to a handful
// of head-only COUNT queries if that function isn't there yet.
app.get("/api/jobs/analytics", catalogLimiter, requireAuth, async (_req, res) => {
  try {
    const rpc = await jobsDb().rpc("jobs_analytics");
    if (!rpc.error && rpc.data) {
      const d = rpc.data;
      return res.json({
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
      });
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

    res.json({
      total,
      companiesWithJobs: null,
      bySeniority,
      byWorkType,
      bySource: [],
      topCompanies: [],
      postedByDay: [],
      midSharePct: total ? Math.round((midCount / total) * 1000) / 10 : null,
    });
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

// ── Feedback (feature request / bug report) ──────────────────────
// Emails the operator directly. Rate-limited; body capped.
const FEEDBACK_TO = process.env.FEEDBACK_TO_EMAIL || "harvardpark239@gmail.com";

app.post("/api/feedback", aiLimiter, requireAuth, async (req, res) => {
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
async function referralAuthUser(userId) {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    const u = data.user;
    const md = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || null,
      name: md.full_name || md.name || null,
    };
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
  catalogLimiter,
  requireAuth,
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 100);
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("company")
        .not("company", "is", null);
      if (error) throw error;

      const ql = q.toLowerCase();
      const byLower = new Map();
      for (const r of data || []) {
        const c = String(r.company || "").trim();
        if (!c) continue;
        if (ql && !c.toLowerCase().startsWith(ql)) continue;
        const k = c.toLowerCase();
        if (!byLower.has(k)) byLower.set(k, c);
      }
      const companies = [...byLower.values()]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 20);
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
  upload.single("resume"),
  async (req, res) => {
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
      const gate = await canAccess(req.user.id, "referral_request");
      if (!gate.allowed) {
        return res.status(402).json({
          error: "usage_limit",
          feature: "referral_request",
          used: gate.used,
          limit: gate.limit,
          resetsAt: gate.resetsAt,
        });
      }

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

      // 5. Meter the use — never blocks the response.
      await incrementUsage(req.user.id, "referral_request").catch((e) =>
        console.error(
          "[referrals] incrementUsage failed",
          redact((e && e.message) || String(e)),
        ),
      );

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

        const { data: matchRows, error: mErr } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("receive_referral_notifications", true)
          .ilike("company", escapeLike(company))
          .neq("id", req.user.id);
        if (mErr) throw mErr;

        const recipients = [];
        for (const r of matchRows || []) {
          const au = await referralAuthUser(r.id);
          if (au && au.email) recipients.push(au.email);
        }
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

    const requests = [];
    for (const r of rows || []) {
      let accepter = null;
      if (r.status === "accepted" && r.accepted_by_user_id) {
        const au = await referralAuthUser(r.accepted_by_user_id);
        accepter = au ? { name: au.name, email: au.email } : null;
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
// No poster name/email, no resume path.
app.get("/api/referrals/open", requireAuth, async (req, res) => {
  try {
    const { data: prof, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("company")
      .eq("id", req.user.id)
      .maybeSingle();
    if (pErr) throw pErr;

    const myCompany = String(prof?.company || "").trim();
    if (!myCompany) return res.json({ requests: [], no_company: true });

    const { data: rows, error } = await supabaseAdmin
      .from("referral_requests")
      .select(
        "id, target_company, job_id, job_title, created_at, expires_at, poster_user_id",
      )
      .eq("status", "open")
      .ilike("target_company", escapeLike(myCompany))
      .neq("poster_user_id", req.user.id)
      .order("created_at", { ascending: false });
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
    res.json({ requests });
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
      const { data: prof, error: pErr } = await supabaseAdmin
        .from("profiles")
        .select("company")
        .eq("id", req.user.id)
        .maybeSingle();
      if (pErr) throw pErr;

      const myCompany = String(prof?.company || "").trim();
      if (!myCompany) return res.status(403).json({ error: "no_company" });

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
        .ilike("target_company", escapeLike(myCompany))
        .neq("poster_user_id", req.user.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "already_accepted" });

      res.json({ id: data.id, status: "accepted" });

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
        .select("poster_user_id, target_company, status, resume_storage_path")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: "not_found" });

      let allowed = row.poster_user_id === req.user.id;
      if (!allowed && ["open", "accepted"].includes(row.status)) {
        const { data: prof, error: pErr } = await supabaseAdmin
          .from("profiles")
          .select("company")
          .eq("id", req.user.id)
          .maybeSingle();
        if (pErr) throw pErr;
        const mine = String(prof?.company || "").trim().toLowerCase();
        allowed =
          !!mine &&
          mine === String(row.target_company || "").trim().toLowerCase();
      }
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

app.post("/api/run", requireAuth, async (req, res) => {
  try {
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
        });
        const data = await runnerRes.json();
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
  }
});

// ── Billing / payments (Razorpay Standard Checkout) ─────────────────
// Provider logic: ./services/razorpay.js. One-time orders that grant a plan
// for a fixed term; when it lapses the entitlements lazy check drops the user
// to free. DORMANT until RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
});

const PAID_PLANS = ["pro", "max"];
const PERIODS = ["monthly", "yearly"];
const TERM_DAYS = { monthly: 30, yearly: 365 };

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
  checkoutLimiter,
  requireAuth,
  async (req, res) => {
    try {
      if (!razorpay.isEnabled()) {
        return res.status(503).json({ error: "checkout_unconfigured" });
      }
      const { plan, billingPeriod } = req.body || {};
      assert(PAID_PLANS.includes(plan), "plan must be 'pro' or 'max'.");
      assert(PERIODS.includes(billingPeriod), "billingPeriod must be 'monthly' or 'yearly'.");

      const amountPaise = priceInrPaise(plan, billingPeriod);
      assert(Number.isInteger(amountPaise) && amountPaise >= 100, "Plan price is not configured.");

      const order = await razorpay.createOrder({
        amountPaise,
        currency: "INR",
        receipt: `u${String(req.user.id).slice(0, 8)}_${Date.now().toString(36)}`,
        notes: { user_id: req.user.id, plan, billingPeriod },
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

// POST /api/payments/razorpay/verify
//   body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
//           plan, billingPeriod }
//   → { ok: true, plan }  (only when the signature is valid)
app.post(
  "/api/payments/razorpay/verify",
  checkoutLimiter,
  requireAuth,
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

      // Defence-in-depth: pull the order back and confirm it is the one this
      // user created for this plan/amount (guards against a tampered body).
      const order = await razorpay.fetchOrder(razorpay_order_id);
      if (order) {
        const n = order.notes || {};
        const expected = priceInrPaise(plan, billingPeriod);
        if (
          String(n.user_id || "") !== String(req.user.id) ||
          String(n.plan || "") !== plan ||
          String(n.billingPeriod || "") !== billingPeriod ||
          Number(order.amount) !== expected
        ) {
          console.warn("[razorpay/verify] order/claim mismatch", redact(JSON.stringify({ n, amount: order.amount, expected })));
          return res.status(400).json({ error: "order_mismatch" });
        }
      }

      const now = new Date();
      const end = new Date(now.getTime() + TERM_DAYS[billingPeriod] * 86400000);
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

      invalidateUser(req.user.id); // drop the ~15s plan cache

      res.json({ ok: true, plan, current_period_end: row.current_period_end });
    } catch (err) {
      console.error("[razorpay/verify]", redact((err && (err.stack || err.message)) || String(err)));
      res.status(500).json({ error: "verify_failed" });
    }
  },
);


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
app.get("/robots.txt", (req, res) => {
  const base = baseUrl(req);
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /$",
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
      "Disallow: /api/",
      "Disallow: /auth",
      "Disallow: /profile",
      "Disallow: /dashboard",
      "Disallow: /dsa",
      "Disallow: /lld",
      "Disallow: /hld",
      "Disallow: /interview",
      "Disallow: /referrals",
      "",
      `Sitemap: ${base}/sitemap.xml`,
      "",
    ].join("\n"),
  );
});

// ── sitemap.xml (dynamic: static public pages + every published blog post) ──
app.get("/sitemap.xml", async (req, res) => {
  const base = baseUrl(req);
  const urls = [
    { loc: `${base}/`, priority: "1.0", changefreq: "weekly" },
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

app.get(/^(?!\/api).*/, async (req, res, next) => {
  if (!INDEX_TEMPLATE) return next(); // dev / no build

  const c = classifyRoute(req.path);

  let post = null;
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
  });
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set(
    "Cache-Control",
    c.kind === "public" ? "public, max-age=0, s-maxage=300" : "no-store",
  );
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  if (process.env.PORT) {
    console.log(`Server listening on port ${PORT}`);
  } else {
    console.log(`Resume optimizer running at http://localhost:${PORT}`);
  }
  console.log(`Reading baseline resume from: ${SOURCE_DIR}`);
});
