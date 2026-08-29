import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";

import { extractStructuredResume, generateTailoredResume } from "./lib/aiClient.js";
import { compileLatexToPdf } from "./lib/latexCompiler.js";
import { buildFilename } from "./lib/filename.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, "resume-source");

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

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

// Helper: extract plain text from an uploaded PDF buffer.
// pdf-parse v2 exposes a `PDFParse` class (the v1 default-callable export is gone),
// so the previous `pdfParse(buffer)` call always threw and was silently swallowed —
// meaning the uploaded resume was never actually read.
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
  if (!key) throw new Error(`No API key found in .env for provider "${provider}". Set ${provider.toUpperCase()}_API_KEY.`);
  return key;
}

app.post("/api/generate", upload.single("resume"), async (req, res) => {
  const { jd, provider = "gemini", name, companyName } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "Upload a resume PDF to continue." });
  }
  if (!jd || !jd.trim()) {
    return res.status(400).json({ error: "Paste a job description first." });
  }

  let apiKey;
  try {
    apiKey = resolveApiKey(provider);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Optional user-supplied overrides. The uploaded résumé is the source of truth;
  // these are only fallbacks for the download filename.
  const formName = (name && name.trim()) || "";
  const formCompany = (companyName && companyName.trim()) || "";

  try {
    // 1. Extract text from the uploaded résumé. This — not resume.tex — is the
    //    résumé we tailor. No silent fallback to the repo owner's baseline.
    let uploadedResumeText = "";
    try {
      uploadedResumeText = await extractPdfText(req.file.buffer);
    } catch (e) {
      console.warn("[generate] Failed to parse uploaded PDF:", e.message);
    }
    if (!uploadedResumeText) {
      return res.status(422).json({
        error: "Could not read text from that PDF. If it's a scanned image, upload a text-based PDF.",
      });
    }

    // 2. Read resume.tex / resume.cls — used ONLY as a LaTeX format skeleton.
    const [currentTex, currentCls] = await Promise.all([
      readFile(path.join(SOURCE_DIR, "resume.tex"), "utf-8"),
      readFile(path.join(SOURCE_DIR, "resume.cls"), "utf-8"),
    ]);

    // 3. Compute BEFORE metrics from the raw uploaded résumé (vs JD) — best-effort.
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
          try { beforeMetrics = JSON.parse(jsonStr); }
          catch { try { beforeMetrics = JSON.parse(sanitizeJsonString(jsonStr)); } catch { /* ignore */ } }
        }
      } catch { /* before metrics is best-effort */ }
    }

    // 4. Stage 1: raw résumé text → strict structured JSON (identity source of truth).
    const structured = await extractStructuredResume({
      resumeText: uploadedResumeText,
      apiKey,
      provider,
    });

    // 5. Stage 2: tailor the structured résumé to the JD, reusing resume.tex/.cls
    //    purely as the LaTeX format skeleton.
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

    // 7. Build the download filename from the EXTRACTED name first, then the
    //    form-supplied name, then a generic default.
    const extractedName = structured?.name?.trim();
    const filename = buildFilename({
      fullName: extractedName || formName || "Candidate",
      company: formCompany || metrics.company,
      roleTitle: metrics.roleTitle,
    });

    // 8. Return-only: the client downloads from pdfBase64. Nothing is written to
    //    disk by default. Opt in to a local copy with RESUME_SAVE_DIR.
    if (process.env.RESUME_SAVE_DIR) {
      try {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(process.env.RESUME_SAVE_DIR, { recursive: true });
        await writeFile(path.join(process.env.RESUME_SAVE_DIR, filename), pdfBuffer);
        console.log(`Saved resume to: ${path.join(process.env.RESUME_SAVE_DIR, filename)}`);
      } catch (e) {
        console.warn("[generate] RESUME_SAVE_DIR write failed (non-fatal):", e.message);
      }
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
    console.error(err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});


// ── HLD routes ────────────────────────────────────────────────────
const GEMINI_API_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

/**
 * Sanitize a raw JSON string returned by an LLM: escape any literal control
 * characters (newline, tab, carriage return, etc.) that appear INSIDE a JSON
 * string value. These break JSON.parse even though they're valid in prose.
 */
function sanitizeJsonString(raw) {
  // Replace literal control characters inside string values.
  // Strategy: replace \r, \n, \t only when they are not already preceded by a backslash.
  return raw
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/(?<!\\)\n/g, '\\n')
    .replace(/(?<!\\)\t/g, '\\t');
}

/**
 * Extract the best JSON object from a raw LLM response string.
 * Uses lastIndexOf('}') so we grab the outermost complete object even if
 * there are nested braces inside string values.
 */
function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}


async function callGemini(prompt, model = "gemini-3.1-flash-lite") {
  const res = await fetch(GEMINI_API_URL(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4096 } }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
}

app.post("/api/hld/generate", async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: "description required" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });
  try {
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
      // Second attempt: sanitize control characters inside string values
      try {
        parsed = JSON.parse(sanitizeJsonString(jsonStr));
      } catch (e2) {
        console.error('[HLD generate] JSON parse failed. Raw:', raw.slice(0, 500));
        throw new Error("Gemini response JSON was malformed: " + e2.message);
      }
    }
    const { fr, nfr } = parsed;
    res.json({ fr, nfr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/api/hld/judge", async (req, res) => {
  const { image_base64, frNfr, apiEndpoints, title } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });
  try {
    const frText = frNfr?.fr ? `Functional Requirements:\n${frNfr.fr}\n\nNon-Functional Requirements:\n${frNfr.nfr || "N/A"}` : "Not provided";
    const apiText = (apiEndpoints || []).length ? apiEndpoints.map((e) => `${e.method} ${e.path}`).join("\n") : "Not provided";

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

    let contents;
    if (image_base64) {
      contents = [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: image_base64 } }] }];
    } else {
      contents = [{ parts: [{ text: prompt }] }];
    }

    const geminiRes = await fetch(GEMINI_API_URL("gemini-3.1-flash-lite"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2048 } }),
    });
    if (!geminiRes.ok) throw new Error(`Gemini error ${geminiRes.status}: ${await geminiRes.text()}`);
    const data = await geminiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
    const jsonStr = extractJson(raw);
    if (!jsonStr) throw new Error("Could not parse judge response");
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      try {
        result = JSON.parse(sanitizeJsonString(jsonStr));
      } catch (e2) {
        console.error('[HLD judge] JSON parse failed. Raw:', raw.slice(0, 500));
        throw new Error("Judge response JSON was malformed: " + e2.message);
      }
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// ── Code execution proxy ──────────────────────────────────────────
// Priority: JAVA_RUNNER_URL (Railway-hosted java-runner microservice) → Judge0 CE fallback.
//
// Fix 2: Set JAVA_RUNNER_URL=https://<your-service>.railway.app in backend/.env to use
// the purpose-built java-runner container (zero per-request cost, no third-party policy risk).
// If JAVA_RUNNER_URL is not set, falls back to Judge0 CE via RapidAPI (requires JUDGE0_API_KEY).

const JUDGE0_BASE = "https://judge0-ce.p.rapidapi.com";
const JUDGE0_LANG_IDS = {
  java: 62, python: 71, javascript: 63, csharp: 51,
  go: 60, cpp: 54, c: 48, rust: 73, kotlin: 78,
};

app.post("/api/run", async (req, res) => {
  const { language = "java", files = [] } = req.body;

  // ── Path A: java-runner microservice (Railway) ───────────────────
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
      console.error("[java-runner proxy]", err);
      return res.status(500).json({ message: err.message });
    }
  }

  // ── Path B: Judge0 CE fallback ───────────────────────────────────
  if (!process.env.JUDGE0_API_KEY) {
    return res.status(500).json({
      message: "Set JAVA_RUNNER_URL (Railway java-runner) or JUDGE0_API_KEY in backend/.env to enable code execution."
    });
  }

  const langId = JUDGE0_LANG_IDS[language];
  if (!langId) {
    return res.status(400).json({ message: `Unsupported language: ${language}. Supported: ${Object.keys(JUDGE0_LANG_IDS).join(", ")}` });
  }

  const sourceCode = files.map(f => f.content || "").join("\n\n");

  try {
    const submitRes = await fetch(`${JUDGE0_BASE}/submissions?base64_encoded=false&wait=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RapidAPI-Key": process.env.JUDGE0_API_KEY,
        "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
      },
      body: JSON.stringify({ language_id: langId, source_code: sourceCode, stdin: "", cpu_time_limit: 10, memory_limit: 256000 }),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return res.status(500).json({ message: `Judge0 error (${submitRes.status}): ${errText}` });
    }

    const result = await submitRes.json();
    const compileError = result.compile_output?.trim() || null;
    const exitCode = result.exit_code ?? (result.status?.id === 3 ? 0 : 1);

    return res.json({
      run: { stdout: result.stdout?.trim() || "", stderr: result.stderr?.trim() || "", code: exitCode, output: result.stdout?.trim() || "" },
      compile: compileError ? { stdout: "", stderr: compileError } : null,
    });
  } catch (err) {
    console.error('[Judge0]', err);
    res.status(500).json({ message: err.message });
  }
});


// SPA fallback: serve the built index.html for any non-/api route so client-side
// routing works on hard refresh. No-ops cleanly when dist/index.html doesn't
// exist yet (during dev the client is served by vite, not this server).
const INDEX_HTML = path.join(__dirname, "dist", "index.html");
app.get(/^(?!\/api).*/, (_req, res, next) => {
  if (!existsSync(INDEX_HTML)) return next();
  res.sendFile(INDEX_HTML);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Resume optimizer running at http://localhost:${PORT}`);
  console.log(`Reading baseline resume from: ${SOURCE_DIR}`);
});
