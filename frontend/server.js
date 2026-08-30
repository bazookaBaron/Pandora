import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import * as lemonSqueezy from "./services/lemonSqueezy.js";
import { getLimit, isUnlimited, serializeLimit } from "./config/tiers.js";
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
app.use(express.static(path.join(__dirname, "dist")));

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

// Helper: extract plain text from an uploaded PDF buffer.
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text?.trim() || "";
  } finally {
    await parser.destroy().catch(() => {});
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

      // 3. BEFORE metrics — best-effort.
      let beforeMetrics = null;
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
              beforeMetrics = JSON.parse(jsonStr);
            } catch {
              try {
                beforeMetrics = JSON.parse(sanitizeJsonString(jsonStr));
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
      const structured = await extractStructuredResume({
        resumeText: uploadedResumeText,
        apiKey,
        provider,
      });

      // 5. Stage 2: tailor to the JD.
      const { metrics, tex, cls } = await generateTailoredResume({
        jd,
        structuredResume: structured,
        currentTex,
        currentCls,
        apiKey,
        provider,
      });

      // 6. Compile to PDF.
      const pdfBuffer = await compileLatexToPdf({ tex, cls });

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

// ── Billing / checkout (Lemon Squeezy) ───────────────────────────
// All provider-specific logic lives in ./services/lemonSqueezy.js. These routes
// are dormant until every LEMONSQUEEZY_* env var is set (see .env), at which
// point `lemonSqueezy.isEnabled()` flips true.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
});

// GET /api/billing/status → { configured } so PricingPage can pick the button state.
app.get("/api/billing/status", requireAuth, (_req, res) => {
  res.json({ configured: lemonSqueezy.isEnabled() });
});

// POST /api/checkout  body: { plan: 'pro'|'max', billingPeriod: 'monthly'|'yearly' }
//   → { url }  hosted Lemon Squeezy checkout URL
app.post("/api/checkout", checkoutLimiter, requireAuth, async (req, res) => {
  try {
    const { plan, billingPeriod } = req.body || {};
    assert(plan === "pro" || plan === "max", "plan must be 'pro' or 'max'.");
    assert(
      billingPeriod === "monthly" || billingPeriod === "yearly",
      "billingPeriod must be 'monthly' or 'yearly'.",
    );

    const origin =
      req.headers.origin && CORS_ALLOWLIST.includes(req.headers.origin)
        ? req.headers.origin
        : CORS_ALLOWLIST[0] || "http://localhost:5173";
    const redirectUrl = `${origin}/pricing?checkout=success`;

    const url = await lemonSqueezy.createCheckout({
      userId: req.user.id,
      email: req.user.email,
      plan,
      billingPeriod,
      redirectUrl,
    });
    res.json({ url });
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status === 503) {
      return res.status(503).json({ error: "checkout_unconfigured" });
    }
    if (status === 400) {
      return res.status(400).json({ error: err.message || "Invalid request." });
    }
    console.error("[checkout]", redact((err && err.message) || String(err)));
    res.status(502).json({ error: "checkout_failed" });
  }
});

// POST /api/webhooks/lemonsqueezy — subscription lifecycle from Lemon Squeezy.
// No auth: authenticity is the HMAC signature. Uses the global express.json +
// its `verify` hook for req.rawBody — do NOT mount express.raw here (it would
// double-read the stream). Registered before the SPA fallback.
app.post("/api/webhooks/lemonsqueezy", async (req, res) => {
  if (!lemonSqueezy.isEnabled()) {
    return res.status(503).json({ error: "webhook_unconfigured" });
  }
  if (
    !lemonSqueezy.verifyWebhookSignature(req.rawBody, req.get("X-Signature"))
  ) {
    return res.status(401).json({ error: "bad_signature" });
  }

  try {
    const norm = lemonSqueezy.mapWebhook(req.body || {});

    if (!lemonSqueezy.HANDLED_EVENTS.has(norm.event)) {
      // Ack so LS stops retrying an event we don't act on.
      return res.status(200).json({ ok: true, ignored: norm.event });
    }

    // Resolve the user: prefer the custom user_id echoed from checkout; else
    // match the LS customer id against an existing subscriptions row.
    let userId = norm.userId;
    if (!userId && norm.providerCustomerId) {
      const { data: match } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id")
        .eq("provider_customer_id", norm.providerCustomerId)
        .maybeSingle();
      if (match && match.user_id) userId = match.user_id;
    }
    if (!userId) {
      console.warn(
        `[ls-webhook] ${norm.event}: no user mapping for sub ${redact(
          String(norm.providerSubscriptionId),
        )} — acking without a write`,
      );
      return res.status(202).json({ ok: true, note: "no user mapping" });
    }

    const status = lemonSqueezy.statusForEvent(
      norm.event,
      norm.lsStatus,
      norm.currentPeriodEnd,
    );

    if (lemonSqueezy.isUpsertEvent(norm.event)) {
      // Full row. UNIQUE(user_id) → LS retries land on the same row → the
      // upsert is naturally idempotent.
      const row = {
        user_id: userId,
        plan: norm.planFromVariant,
        status,
        provider: "lemonsqueezy",
        provider_customer_id: norm.providerCustomerId,
        provider_subscription_id: norm.providerSubscriptionId,
        billing_period: norm.billingPeriod,
        current_period_end: norm.currentPeriodEnd,
      };
      const { error } = await supabaseAdmin
        .from("subscriptions")
        .upsert(row, { onConflict: "user_id" });
      if (error) throw error;
    } else {
      // cancelled | expired | payment_failed — KEEP the existing plan so the
      // entitlements lazy check-on-access preserves access until the period
      // ends. Targeted update; never nulls plan.
      const patch = { status };
      if (norm.currentPeriodEnd) patch.current_period_end = norm.currentPeriodEnd;
      const { error } = await supabaseAdmin
        .from("subscriptions")
        .update(patch)
        .eq("user_id", userId);
      if (error) throw error;
    }

    invalidateUser(userId); // drop the ~15s plan cache so the change is seen now
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(
      "[ls-webhook] processing failed:",
      redact((err && (err.stack || err.message)) || String(err)),
    );
    // 500 → LS retries with backoff.
    res.status(500).json({ error: "processing_failed" });
  }
});

// SPA fallback: serve the built index.html for any non-/api route so client-side
// routing works on hard refresh. Registered AFTER all /api routes.
const INDEX_HTML = path.join(__dirname, "dist", "index.html");
app.get(/^(?!\/api).*/, (_req, res, next) => {
  if (!existsSync(INDEX_HTML)) return next();
  res.sendFile(INDEX_HTML);
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
