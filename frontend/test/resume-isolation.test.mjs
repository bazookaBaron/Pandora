/**
 * Safeguard test for the "wrong person's data" bug class (P0).
 *
 * It runs many résumé generations CONCURRENTLY through the real pipeline
 * functions (extractStructuredResume + generateTailoredResume) and asserts:
 *   1. each call's output contains only that call's own candidate data;
 *   2. no call's output leaks another call's candidate data;
 *   3. no call's output leaks the FORMAT skeleton's placeholder strings.
 *
 * The provider HTTP call is stubbed (deterministic, no network, no API key), so
 * this isolates exactly what a concurrency / shared-module-state bug would break:
 * per-request scoping inside lib/aiClient.js.
 *
 * Run:  node test/resume-isolation.test.mjs
 * Exit: 0 = pass, 1 = fail.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS,
  extractStructuredResume,
  generateTailoredResume,
} from "../lib/aiClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skeletonTex = await readFile(
  path.join(__dirname, "..", "resume-source", "resume.tex"),
  "utf8",
);
const skeletonCls = "CLS-PLACEHOLDER";

// ── Distinct fake candidates ───────────────────────────────────────────────
const CANDIDATES = [
  { name: "Alice Alphabravo", company: "Northgate Systems", school: "Riverside Tech" },
  { name: "Bob Charliedelta", company: "Peakwave Labs", school: "Hollow Creek University" },
  { name: "Carol Echofoxtrot", company: "Ironmarsh Digital", school: "Fenwick College" },
  { name: "Dave Golfhotel", company: "Bluerock Analytics", school: "Ashgrove Institute" },
  { name: "Erin Indiajuliet", company: "Silverpine Software", school: "Marlowe State" },
];

const rawResumeText = (c) => `${c.name}
Senior Backend Engineer | ${c.company} | 2019-2024
- Built payment reconciliation service at ${c.company} handling 2M events/day.
- Led migration of ${c.company} monolith to microservices, cutting deploy time 60%.
Education: B.S. Computer Science, ${c.school}, 2019
Skills: Go, Postgres, Kafka, Kubernetes`;

// ── Stub the provider so both stages are deterministic ─────────────────────
// Stage 1 (extract) prompt contains "STRICT JSON object"; Stage 2 (tailor)
// prompt contains "---METRICS---". We echo back data derived ONLY from the
// prompt we were handed — so any cross-call bleed must come from shared state
// in aiClient.js, not from this stub.
PROVIDERS.gemini.call = async ({ prompt }) => {
  if (prompt.includes("---METRICS---") || prompt.includes("SKELETON .tex")) {
    // Stage 2: pull the candidate name straight out of THIS prompt's JSON.
    const m = prompt.match(/"name":\s*"([^"]+)"/);
    const name = m ? m[1] : "NO_NAME_IN_PROMPT";
    return [
      "---METRICS---",
      JSON.stringify({
        company: "TargetCo",
        roleTitle: "Backend Engineer",
        keywordMatchPercent: 50,
        atsPassChancePercent: 50,
        humanScreenChancePercent: 50,
        matchedKeywords: [],
        missingRequiredKeywords: [],
        hardGaps: [],
        notes: "ok",
      }),
      "---TEX---",
      `\\documentclass{resume}\\begin{document}\\introduction[fullname={${name}}]\\end{document}`,
      "---CLS---",
      "CLS-PLACEHOLDER",
      "---END---",
    ].join("\n");
  }
  // Stage 1: build strict JSON from THIS prompt's raw résumé text block.
  const block = prompt.split("RAW RÉSUMÉ TEXT:")[1] || prompt;
  const nameLine = block.split("\n").map((s) => s.trim()).filter(Boolean)[1] || "";
  const compMatch = block.match(/\|\s*([A-Za-z0-9 ]+?)\s*\|/);
  const schoolMatch = block.match(/Education:.*?,\s*([A-Za-z ]+?),/);
  return JSON.stringify({
    name: nameLine,
    contact: { email: "", phone: "", location: "", links: [] },
    summary: "",
    skills: [{ category: "Skills", items: ["Go", "Postgres", "Kafka"] }],
    experience: [
      {
        company: (compMatch && compMatch[1].trim()) || "",
        title: "Senior Backend Engineer",
        location: "",
        start: "2019",
        end: "2024",
        bullets: ["Built payment reconciliation service.", "Led microservices migration."],
      },
    ],
    projects: [],
    education: [
      {
        school: (schoolMatch && schoolMatch[1].trim()) || "",
        degree: "B.S. Computer Science",
        start: "",
        end: "2019",
        details: "",
      },
    ],
  });
};

// ── Run all candidates concurrently through the full pipeline ──────────────
const runs = CANDIDATES.map(async (c) => {
  const structured = await extractStructuredResume({
    resumeText: rawResumeText(c),
    apiKey: "test-key",
    provider: "gemini",
  });
  const out = await generateTailoredResume({
    jd: `We need a Backend Engineer familiar with ${c.company} scale systems.`,
    structuredResume: structured,
    currentTex: skeletonTex,
    currentCls: skeletonCls,
    apiKey: "test-key",
    provider: "gemini",
  });
  return { candidate: c, structured, tex: out.tex };
});

const results = await Promise.all(runs);

// ── Assertions ────────────────────────────────────────────────────────────
const SKELETON_MARKERS = [
  "CANDIDATE FULL NAME",
  "candidate.email@example.com",
  "Company Name",
  "University Name",
  "Placeholder skill",
];
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error("  ✗ " + msg);
};

for (let i = 0; i < results.length; i++) {
  const { candidate, structured, tex } = results[i];

  if (structured.name !== candidate.name) {
    fail(`run ${i}: extracted name "${structured.name}" != "${candidate.name}"`);
  }
  if (!tex.includes(candidate.name)) {
    fail(`run ${i}: own name "${candidate.name}" missing from output .tex`);
  }
  for (let j = 0; j < CANDIDATES.length; j++) {
    if (j === i) continue;
    if (tex.includes(CANDIDATES[j].name)) {
      fail(`run ${i} (${candidate.name}) LEAKED another candidate: "${CANDIDATES[j].name}"`);
    }
    if (structured.experience[0]?.company === CANDIDATES[j].company) {
      fail(`run ${i}: extracted company bled from candidate ${j}`);
    }
  }
  for (const marker of SKELETON_MARKERS) {
    if (tex.includes(marker)) {
      fail(`run ${i}: skeleton placeholder "${marker}" leaked into output`);
    }
  }
}

if (failures) {
  console.error(`\nFAIL — ${failures} assertion(s) failed across ${results.length} concurrent runs.`);
  process.exit(1);
}
console.log(
  `PASS — ${results.length} concurrent résumé generations stayed fully isolated; ` +
    `no cross-candidate bleed, no skeleton-placeholder leak.`,
);
