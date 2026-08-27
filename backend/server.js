import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateTailoredResume } from "./lib/aiClient.js";
import { compileLatexToPdf } from "./lib/latexCompiler.js";
import { buildFilename } from "./lib/filename.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, "resume-source");
const SAVE_DIR = "C:\\Users\\debna\\OneDrive\\Documents\\Resume";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve the frontend as static files so you only need one server running.
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.post("/api/generate", async (req, res) => {
  const { jd, apiKey, provider } = req.body;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ error: "API key is required." });
  }
  if (!jd || !jd.trim()) {
    return res.status(400).json({ error: "Paste a job description first." });
  }

  const firstName = process.env.CANDIDATE_FIRST_NAME || "Candidate";
  const lastName = process.env.CANDIDATE_LAST_NAME || "Resume";

  try {
    // 1. Always read the CURRENT baseline .tex/.cls from disk - so every
    //    generation starts fresh from your latest saved resume, not from
    //    a previous JD-tailored version.
    const [currentTex, currentCls] = await Promise.all([
      readFile(path.join(SOURCE_DIR, "resume.tex"), "utf-8"),
      readFile(path.join(SOURCE_DIR, "resume.cls"), "utf-8"),
    ]);

    // Read optional additional context (gracefully default to empty string).
    let additionalContext = "";
    try {
      additionalContext = await readFile(path.join(SOURCE_DIR, "additional-context.txt"), "utf-8");
    } catch {
      // File doesn't exist or is unreadable — that's fine, it's optional.
    }

    // 2. Ask the selected AI provider to tailor the content + self-score the match.
    const { metrics, tex, cls } = await generateTailoredResume({
      jd,
      currentTex,
      currentCls,
      additionalContext,
      apiKey: apiKey.trim(),
      provider: provider || "anthropic",
    });

    // 3. Compile to PDF.
    const pdfBuffer = await compileLatexToPdf({ tex, cls });

    // 4. Build an ATS-friendly filename.
    const filename = buildFilename({
      firstName,
      lastName,
      company: metrics.company,
      roleTitle: metrics.roleTitle,
    });

    // 5. Save PDF to the Resume folder.
    await mkdir(SAVE_DIR, { recursive: true });
    const savePath = path.join(SAVE_DIR, filename);
    await writeFile(savePath, pdfBuffer);
    console.log(`Saved resume to: ${savePath}`);

    // Respond with the PDF as base64 plus metrics, so the frontend can
    // trigger a download AND render the scorecard from one call.
    res.json({
      filename,
      pdfBase64: pdfBuffer.toString("base64"),
      metrics,
      tex, // returned so you can eyeball/save the LaTeX source if you want
      cls,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Resume optimizer running at http://localhost:${PORT}`);
  console.log(`Reading baseline resume from: ${SOURCE_DIR}`);
});
