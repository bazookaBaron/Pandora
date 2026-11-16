// Compiles LaTeX to PDF using the public "LaTeX on HTTP" service (YtoTech).
// No local LaTeX install required - just outbound internet access.
// Source/docs: https://github.com/YtoTech/latex-on-http
//
// If you'd rather not depend on a third-party service, install `tectonic`
// (https://tectonic-typesetting.github.io/) - it's a single small binary,
// far lighter than a full TeX Live install - and swap this function to
// shell out to it instead (see comment at the bottom of this file).

const COMPILE_URL = process.env.LATEX_COMPILE_URL || "https://latex.ytotech.com/builds/sync";
const COMPILE_TIMEOUT_MS = Number(process.env.LATEX_TIMEOUT_MS) || 60_000;

// ── Sanitizer ───────────────────────────────────────────────────────────
// The .tex/.cls are LLM-generated from user-controlled input (resume + JD), so
// treat them as hostile: TeX can read/write files and (with shell-escape) run
// commands. Reject anything that touches the filesystem, changes category
// codes, builds control sequences dynamically, or loads a package that is not
// on the allowlist (derived from resume-source/resume.tex + resume.cls).
export const ALLOWED_PACKAGES = new Set([
  // resume.cls
  "geometry", "parskip", "etoolbox", "keycommand", "xstring", "hyperref",
  "helvet", "fontenc",
  // harmless extras an LLM may reasonably add
  "inputenc", "enumitem", "xcolor", "textcomp", "lmodern", "titlesec",
  "tabularx", "array", "ragged2e", "microtype",
]);
export const ALLOWED_CLASSES = new Set(["resume", "article"]);

const FORBIDDEN_CS = [
  "input", "include", "includeonly", "openin", "openout", "read", "readline",
  "write", "immediate", "closein", "closeout", "newread", "newwrite",
  "catcode", "csname", "scantokens", "endlinechar", "verbatiminput",
  "lstinputlisting", "includegraphics", "includepdf", "directlua", "luaexec",
  "pdfshellescape", "ShellEscape", "write18", "InputIfFileExists",
  "openininput", "usetikzlibrary", "href\\s*\\{\\s*file", "mathchardef",

];
const FORBIDDEN_RE = new RegExp("\\\\(?:" + FORBIDDEN_CS.join("|") + ")(?![A-Za-z])", "i");

const MAX_TEX_BYTES = 300 * 1024;

export class LatexUnsafeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "LatexUnsafeError";
    this.code = "LATEX_UNSAFE";
  }
}

/** Remove TeX comments (an unescaped % to end of line). */
function stripComments(src) {
  return src.replace(/(^|[^\\])%.*$/gm, "$1");
}

/**
 * Throws LatexUnsafeError when `src` contains a forbidden construct; returns
 * `src` unchanged otherwise.
 * @param {string} src
 * @param {string} [label]
 */
export function sanitizeLatex(src, label = "tex") {
  const s = String(src ?? "");
  if (Buffer.byteLength(s, "utf8") > MAX_TEX_BYTES) {
    throw new LatexUnsafeError(`${label}: document is too large.`);
  }
  if (s.includes("\0")) throw new LatexUnsafeError(`${label}: NUL byte.`);
  const code = stripComments(s);

  if (code.includes("^^")) {
    throw new LatexUnsafeError(`${label}: ^^ character notation is not allowed.`);
  }
  const bad = FORBIDDEN_RE.exec(code);
  if (bad) {
    throw new LatexUnsafeError(`${label}: forbidden command ${bad[0]}.`);
  }

  const pkgRe = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = pkgRe.exec(code))) {
    for (const p of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!ALLOWED_PACKAGES.has(p)) {
        throw new LatexUnsafeError(`${label}: package "${p}" is not allowed.`);
      }
    }
  }
  // A bare \usepackage with no braces would otherwise slip past the regex.
  const total = (code.match(/\\(?:usepackage|RequirePackage)(?![A-Za-z])/g) || []).length;
  const parsed = (code.match(pkgRe) || []).length;
  if (total !== parsed) throw new LatexUnsafeError(`${label}: malformed package load.`);

  const clsRe = /\\(?:documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  while ((m = clsRe.exec(code))) {
    if (!ALLOWED_CLASSES.has(m[1].trim())) {
      throw new LatexUnsafeError(`${label}: class "${m[1]}" is not allowed.`);
    }
  }
  return s;
}

export async function compileLatexToPdf({ tex, cls }) {
  sanitizeLatex(tex, "resume.tex");
  sanitizeLatex(cls, "resume.cls");

  // Escape hatch: set LATEX_COMPILER=tectonic (and have the `tectonic` binary on
  // PATH) to compile locally instead of hitting the third-party hosted service
  // (latex.ytotech.com receives the full resume text). Opt-in.
  if (process.env.LATEX_COMPILER === "tectonic") {
    return compileLatexToPdfLocal({ tex, cls });
  }

  let res;
  try {
    res = await fetch(COMPILE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        compiler: "pdflatex",
        resources: [
          { main: true, content: tex, path: "resume.tex" },
          { content: cls, path: "resume.cls" },
        ],
      }),
      signal: AbortSignal.timeout(COMPILE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      `LaTeX compile service unreachable (${COMPILE_URL}): ${e.message}. ` +
      `Set LATEX_COMPILER=tectonic to compile locally instead.`
    );
  }

  if (res.status === 201 || res.status === 200) {
    const buf = Buffer.from(await res.arrayBuffer());
    // The service can return 200 with a JSON error payload (or a truncated /
    // empty body) instead of a PDF — validate the magic bytes so a broken
    // compile surfaces here rather than as a corrupt download downstream.
    if (buf.length < 1000 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error(
        `LaTeX compile returned ${res.status} but the body was not a valid PDF ` +
        `(${buf.length} bytes, starts with ${JSON.stringify(buf.subarray(0, 60).toString("latin1"))}).`
      );
    }
    return buf;
  }

  // Compile errors come back as JSON with logs - surface them instead of
  // a generic failure so you can see exactly what broke.
  let detail;
  try {
    detail = await res.json();
  } catch {
    detail = await res.text();
  }
  // YtoTech nests the pdflatex log under `logs` / `output` — hoist it if present.
  const log = detail && typeof detail === "object"
    ? (detail.logs || detail.log || detail.output || JSON.stringify(detail))
    : String(detail);
  throw new Error(
    `LaTeX compile failed (${res.status}): ${String(log).slice(0, 4000)}`
  );
}

// ---- Local alternative using `tectonic` instead of the hosted API ----
// Only invoked when LATEX_COMPILER=tectonic. Requires the `tectonic` binary on
// PATH (a single ~20 MB download from https://tectonic-typesetting.github.io/).
export async function compileLatexToPdfLocal({ tex, cls }) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;

  sanitizeLatex(tex, "resume.tex");
  sanitizeLatex(cls, "resume.cls");

  const dir = await mkdtemp(path.join(tmpdir(), "resume-"));
  try {
    await writeFile(path.join(dir, "resume.tex"), tex);
    await writeFile(path.join(dir, "resume.cls"), cls);
    await new Promise((resolve, reject) => {
      // -Z untrusted: disables shell-escape and external file access.
      execFile("tectonic", ["-Z", "untrusted", "resume.tex"], { cwd: dir, timeout: COMPILE_TIMEOUT_MS, killSignal: "SIGKILL" }, (err, _stdout, stderr) =>
        err ? reject(new Error(`tectonic failed: ${stderr || err.message}`)) : resolve()
      );
    });
    const pdf = await readFile(path.join(dir, "resume.pdf"));
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("tectonic produced a non-PDF output.");
    }
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
