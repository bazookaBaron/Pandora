import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeLatex, LatexUnsafeError } from "../lib/latexCompiler.js";

test("the shipped resume.tex and resume.cls pass the sanitizer", () => {
  sanitizeLatex(readFileSync(new URL("../resume-source/resume.tex", import.meta.url), "utf8"), "tex");
  sanitizeLatex(readFileSync(new URL("../resume-source/resume.cls", import.meta.url), "utf8"), "cls");
});

const bad = [
  ["\\input{/etc/passwd}", "input"],
  ["\\include{x}", "include"],
  ["\\openin5=/etc/passwd", "openin"],
  ["\\openout5=x", "openout"],
  ["\\immediate\\write18{id}", "write18"],
  ["\\immediate\\write16{x}", "write"],
  ["\\catcode`\\@=11", "catcode"],
  ["\\csname in\\endcsname", "csname"],
  ["\\usepackage{shellesc}", "package"],
  ["\\usepackage[a]{geometry,minted}", "package list"],
  ["\\usepackage", "bare usepackage"],
  ["^^5cinput", "caret notation"],
  ["\\documentclass{exam}", "class"],
  ["\\makeatletter\\@input{/etc/passwd}", "@input"],
  ["\\@@input /etc/passwd ", "@@input"],
  ["\\@iinput{x}", "@iinput"],
  ["\\begin{filecontents}{x.tex}\\end{filecontents}", "filecontents env"],
  ["\\begin { filecontents* } {x}", "filecontents* env"],
  ["\\openin3=/etc/passwd \\read3 to\\x", "openin/read"],
  ["\\read16 to \\x", "read terminal"],
  ["\\immediate\\write 18{id}", "write 18 with space"],
  ["\\write18{id}", "bare write18"],
  ["\\IfFileExists{/etc/passwd}{a}{b}", "IfFileExists"],
  ["\\pdffiledump length 100{/etc/passwd}", "pdffiledump"],
  ["\\pdf@shellescape", "pdf@shellescape"],
];
for (const [src, name] of bad) {
  test(`rejects ${name}`, () => {
    assert.throws(() => sanitizeLatex(src), LatexUnsafeError);
  });
}

test("allows allowlisted packages, comments mentioning forbidden words, and escaped percent", () => {
  sanitizeLatex("\\usepackage[margin=1in]{geometry}\n\\usepackage{hyperref,xcolor}\n% \\input{x}\n100\\% done \\textbf{ok}");
});
test("a comment line does not hide a real command on the next line", () => {
  assert.throws(() => sanitizeLatex("% harmless\n\\input{x}"), LatexUnsafeError);
});
test("rejects oversized documents", () => {
  assert.throws(() => sanitizeLatex("a".repeat(400 * 1024)), LatexUnsafeError);
});
