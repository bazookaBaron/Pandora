# Resume Optimizer

Paste a JD → it reads `backend/resume-source/resume.tex` + `resume.cls`,
tailors the content with Claude, compiles it to PDF, downloads it with an
ATS-friendly filename, and shows a scorecard (keyword match, ATS pass
chance, human screen chance, missing hard requirements).

## 1. Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `ANTHROPIC_API_KEY` — get one from https://console.anthropic.com
- `CANDIDATE_FIRST_NAME` / `CANDIDATE_LAST_NAME` — used in the downloaded filename
- `CLAUDE_MODEL` — defaults to `claude-sonnet-5`, override if needed

## 2. Put your real baseline resume in place

Replace the placeholder files with your actual, up-to-date resume:

- `backend/resume-source/resume.tex`
- `backend/resume-source/resume.cls`

Every generation always reads fresh from these two files — so keep them as
your single source of truth and update them whenever your real resume
changes. Generated/tailored versions are never written back here.

## 3. Run it

```bash
cd backend
npm start
```

Open **http://localhost:8787** — the backend also serves the frontend, so
that's the only URL you need.

## 4. Use it

1. Paste a job description into the textarea.
2. Click "Generate & Download Resume".
3. The PDF downloads automatically as `FirstName_LastName_Resume_Company.pdf`.
4. The scorecard shows keyword match %, ATS pass chance %, human screen
   chance %, matched/missing keywords, and any hard gaps (e.g. "JD wants
   5-7 yrs, resume shows 4+").

**These percentages are Claude's honest self-assessment, not a real ATS
simulation** — treat them as a directional gut-check, not a guarantee. No
resume tool can tell you exactly what a specific company's ATS will do.

## Notes on the moving pieces

- **PDF compilation** goes through the free hosted [LaTeX-on-HTTP](https://github.com/YtoTech/latex-on-http)
  API by default (no local LaTeX needed — just internet access). If you'd
  rather not depend on a third-party service, install
  [tectonic](https://tectonic-typesetting.github.io/) (a single small
  binary, much lighter than full TeX Live) and swap in the commented-out
  `compileLatexToPdfLocal` function in `backend/lib/latexCompiler.js`.
- **Fabrication guardrail**: the prompt explicitly tells Claude not to
  invent skills/experience/years — missing requirements show up as
  `missingRequiredKeywords` / `hardGaps` instead of being papered over.
- **File naming**: `backend/lib/filename.js` builds
  `FirstName_LastName_Resume_Company.pdf` — no spaces or special
  characters, which is the general best-practice convention for both ATS
  parsing and human recruiters skimming a downloads folder.
- Nothing here is deployed anywhere — it's a local tool. Your resume
  content and the JD only ever go to Anthropic's API (to tailor the resume)
  and to the LaTeX compile API (to render the PDF).
