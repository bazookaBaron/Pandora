// Compiles LaTeX to PDF using the public "LaTeX on HTTP" service (YtoTech).
// No local LaTeX install required - just outbound internet access.
// Source/docs: https://github.com/YtoTech/latex-on-http
//
// If you'd rather not depend on a third-party service, install `tectonic`
// (https://tectonic-typesetting.github.io/) - it's a single small binary,
// far lighter than a full TeX Live install - and swap this function to
// shell out to it instead (see comment at the bottom of this file).

const COMPILE_URL = "https://latex.ytotech.com/builds/sync";

export async function compileLatexToPdf({ tex, cls }) {
  // Escape hatch: set LATEX_COMPILER=tectonic (and have the `tectonic` binary on
  // PATH) to compile locally instead of hitting the hosted service. Left opt-in
  // so no local install is required by default.
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

  const dir = await mkdtemp(path.join(tmpdir(), "resume-"));
  try {
    await writeFile(path.join(dir, "resume.tex"), tex);
    await writeFile(path.join(dir, "resume.cls"), cls);
    await new Promise((resolve, reject) => {
      execFile("tectonic", ["resume.tex"], { cwd: dir }, (err, _stdout, stderr) =>
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
