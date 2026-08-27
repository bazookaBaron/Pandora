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
  const res = await fetch(COMPILE_URL, {
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

  if (res.status === 201 || res.status === 200) {
    const buf = Buffer.from(await res.arrayBuffer());
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
  throw new Error(
    `LaTeX compile failed (${res.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`
  );
}

/* ---- Local alternative using tectonic instead of the hosted API ----
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function compileLatexToPdfLocal({ tex, cls }) {
  const dir = await mkdtemp(path.join(tmpdir(), "resume-"));
  await writeFile(path.join(dir, "resume.tex"), tex);
  await writeFile(path.join(dir, "resume.cls"), cls);
  await new Promise((resolve, reject) => {
    execFile("tectonic", ["resume.tex"], { cwd: dir }, (err) => (err ? reject(err) : resolve()));
  });
  const pdf = await readFile(path.join(dir, "resume.pdf"));
  await rm(dir, { recursive: true, force: true });
  return pdf;
}
--------------------------------------------------------------------- */
