// worker_threads entry for CPU-bound PDF parsing.
//
// Runs the pdf-parse text extraction + pdfjs link-annotation / layout probes
// off the main event loop. Messages in: { id, op, buffer } where `op` is
// "extractText" | "layoutInfo" and `buffer` is an ArrayBuffer (transferred).
// Messages out: { id, ok: true, result } or { id, ok: false, error }.
import { parentPort } from "node:worker_threads";
import { PDFParse } from "pdf-parse";

// ── pdfjs-dist (legacy build) ────────────────────────────────────
// Verbatim from server.js: lazy-import the legacy ESM build via createRequire +
// pathToFileURL, and point GlobalWorkerOptions.workerSrc at the sibling worker.
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
// empty placeholder hrefs like a bare "https://".
function isUsefulProfileUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(s)) return false;
  if (/^https?:\/\/wa\.me\//i.test(s)) return false;
  return true;
}

// Extract text from an uploaded PDF, enriched with a "DETECTED HYPERLINKS" block
// pulled from link annotations. Mirrors server.js extractPdfText exactly.
async function extractText(arrayBuffer) {
  let text = "";
  const parser = new PDFParse({ data: Buffer.from(arrayBuffer) });
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
      data: new Uint8Array(arrayBuffer),
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
    console.warn("[pdfworker] pdfjs link extraction failed:", e?.message || String(e));
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

// Layout of a COMPILED résumé PDF: page count + bottom blank-band ratio.
// Mirrors server.js pdfLayoutInfo, including the {pages:0,bottomGapRatio:0}
// fallback on any error (the layout probe must never fail generate).
async function layoutInfo(arrayBuffer) {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
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
      const bottomGapRatio = Math.max(0, Math.min(1, minY / vp.height));
      return { pages, bottomGapRatio };
    } finally {
      await doc.destroy().catch(() => {});
    }
  } catch (e) {
    console.warn("[pdfworker] layoutInfo failed:", e?.message || String(e));
    return { pages: 0, bottomGapRatio: 0 };
  }
}

if (!parentPort) {
  throw new Error("pdfWorkerEntry.js must be run as a worker_threads worker");
}

parentPort.on("message", async (msg) => {
  const { id, op, buffer } = msg || {};
  try {
    let result;
    if (op === "extractText") {
      result = await extractText(buffer);
    } else if (op === "layoutInfo") {
      // layoutInfo swallows its own errors and returns the fallback shape.
      result = await layoutInfo(buffer);
    } else {
      throw new Error(`unknown op: ${String(op)}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
