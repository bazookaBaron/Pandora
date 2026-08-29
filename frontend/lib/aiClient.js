/**
 * Multi-provider AI client — supports Anthropic, OpenAI, and Google Gemini.
 * Each provider uses its best code-efficient model by default.
 */

// ── Provider configs ──────────────────────────────────────────────
const PROVIDERS = {
    anthropic: {
        name: "Anthropic",
        url: "https://api.anthropic.com/v1/messages",
        defaultModel: "claude-sonnet-4-20250514",
        call: callAnthropic,
    },
    openai: {
        name: "OpenAI",
        url: "https://api.openai.com/v1/chat/completions",
        defaultModel: "gpt-4o-mini",
        call: callOpenAI,
    },
    gemini: {
        name: "Google Gemini",
        defaultModel: "gemini-3.1-flash-lite",
        call: callGemini,
    },
};

// ── LaTeX escaping (server-side fallback) ─────────────────────────
// The candidate's real text (names, companies, bullets) can contain characters
// that are special in LaTeX. The model is instructed to escape them inside macro
// arguments; this is a defensive fallback for any value we interpolate ourselves.
export function escapeLatexText(value) {
    if (value == null) return "";
    return String(value)
        .replace(/\\/g, "\\textbackslash{}")
        .replace(/([&%$#_{}])/g, "\\$1")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/\^/g, "\\textasciicircum{}");
}

// ── Stage 1 prompt: raw résumé text → strict structured JSON ──────
function buildExtractPrompt({ resumeText }) {
    return `You are a precise résumé parser. Convert the RAW RÉSUMÉ TEXT below into a single STRICT JSON object.

OUTPUT: exactly one JSON object, no markdown fences, no commentary before or after. Use this EXACT shape and key order:
{
  "name": "",
  "contact": { "email": "", "phone": "", "location": "", "links": [] },
  "summary": "",
  "skills": [ { "category": "", "items": [] } ],
  "experience": [ { "company": "", "title": "", "location": "", "start": "", "end": "", "bullets": [] } ],
  "projects": [ { "name": "", "stack": "", "bullets": [] } ],
  "education": [ { "school": "", "degree": "", "start": "", "end": "", "details": "" } ]
}

RULES:
- Extract ONLY what is present in the text. Do NOT invent, infer, or add anything.
- Leave unknown fields as an empty string "" or an empty array []. Never use null.
- Preserve every bullet VERBATIM. You may lightly fix obvious OCR artifacts (missing spaces between words, broken hyphenation, stray line breaks) but never reword, summarize, merge, or drop a bullet.
- "links": array of URLs / profile handles (LinkedIn, GitHub, portfolio, etc.) exactly as written in the text. If a link's real URL isn't in the text (only anchor text like "LinkedIn" or "GitHub"), leave it as an empty string — do not reconstruct, guess, or complete it. Never fabricate a URL, slug, email, or phone number.
- "skills": keep the résumé's own categories and their items. If skills are listed ungrouped, use a single entry with category "Skills".
- One "experience" entry per role. If the same company lists multiple titles/date ranges, emit one entry per title.
- Dates ("start"/"end"/"graduation"): copy the text as written (e.g. "Aug 2024", "2022", "Present", "Current").
- "education.details": grade / GPA / honors / concentration text if present, else "".

RAW RÉSUMÉ TEXT:
---
${resumeText}
---

Output the JSON object now:`;
}

// ── Stage 2 prompt: structured résumé + JD → tailored .tex ────────
function buildTailorPrompt({ structuredResume, jd, currentTex, currentCls }) {
    const structuredJson =
        typeof structuredResume === "string"
            ? structuredResume
            : JSON.stringify(structuredResume, null, 2);

    return `You are an elite ATS résumé optimizer, professional résumé writer, and LaTeX engineer. Produce the HIGHEST-SCORING one-page résumé possible for this JD while staying 100% truthful to the CANDIDATE DATA.

═══════════════════════════════════════════════════════════
SECTION 0 — WHAT EACH INPUT IS (read carefully)
═══════════════════════════════════════════════════════════
• CANDIDATE DATA (JSON) is the SINGLE SOURCE OF TRUTH for this résumé. Every identity value — name, email, phone, location, links, company names, job titles, employment dates, project names, schools, degrees, graduation dates, grades — MUST come from this JSON and nothing else.
• The SKELETON .tex is the repo owner's résumé. It is ONLY a LaTeX FORMATTING TEMPLATE. Every literal value in it (the name "Debopriyo Debnath", "JP Morgan Chase", "IIT Patna", project names, dates, bullet text, etc.) is NOT the candidate's — you MUST replace every one of them with the candidate's real values from CANDIDATE DATA. If a piece of skeleton content has no counterpart in CANDIDATE DATA, delete that piece rather than keep the owner's data.
• The .cls is layout only. Return it byte-for-byte identical.
• NEVER invent, guess, autocomplete, or "repair" any URL, profile slug, or handle (LinkedIn, GitHub, portfolio, website, email, phone) — use ONLY the exact strings present in CANDIDATE DATA. If CANDIDATE DATA has an empty or missing value for one, emit its macro with an empty argument (e.g. linkedin={} / github={}); never substitute a plausible-looking fabrication such as a guessed linkedin.com/in/<name> slug.

═══════════════════════════════════════════════════════════
SECTION A — LATEX STRUCTURAL RULES (violating ANY = failure)
═══════════════════════════════════════════════════════════
1. Keep the CUSTOM MACROS and environments exactly: \\introduction[...], \\summary{...}, skillsSection + \\skillItem[...], experienceSection + \\experienceItem[...], \\projectItem[...], educationSection + \\educationItem[...]. Use these EXACT macros with these EXACT key names. Never substitute \\section, \\subsection, raw tabular, etc.
2. Keep the section ORDER: Introduction → Summary → Skills → Experience → Projects → Education. Omit Projects only if CANDIDATE DATA has no projects.
3. Keep ALL spacing commands (\\vspace, \\itemsep, \\hspace, \\hfill, \\par) as in the skeleton. Keep each \\begin{itemize} with its \\itemsep -6pt {}.
4. \\introduction keys: fullname, email, phone, linkedin, github. Map contact.links → linkedin / github by matching the URL text; strip a leading "https://" or "http://". If the candidate has no github/linkedin, pass that key empty ({}).
5. One \\experienceItem per company block. If CANDIDATE DATA has multiple roles at one company, list them as multiple rows inside roles={ \\textbf{Title} & START--END \\\\ ... }. Follow each \\experienceItem with a \\begin{itemize} ... \\end{itemize} of that role's bullets.
6. Emit one \\projectItem (+ itemize if there are bullets) per entry in projects[]. title = project name, keyHighlight = a one-line description, bullets = projects[].bullets.
7. Emit one \\educationItem per entry in education[]. university = school, program = degree, graduation = end (or start--end), grade = details.
8. Return the .cls UNCHANGED — byte-for-byte identical to the input.

═══════════════════════════════════════════════════════════
SECTION B — LATEX SAFETY
═══════════════════════════════════════════════════════════
The candidate's real text can contain LaTeX-special characters: % & # _ $ { } ~ ^ \\. Inside every macro argument you MUST escape them: \\% \\& \\# \\_ \\$ \\{ \\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}. Leave URLs usable inside \\href-style macros. Never emit a raw unescaped & or % from candidate text.

═══════════════════════════════════════════════════════════
SECTION C — ATS & RECRUITER OPTIMIZATION (truthful tailoring only)
═══════════════════════════════════════════════════════════
SUMMARY: open with the exact target role title from the JD; state the candidate's real years of experience and 2-3 of THEIR skills that the JD wants; 2-3 tight sentences; no invented metrics.
SKILLS: keep only skills the candidate actually lists. Reorder them (and the categories) so the most JD-relevant appear first. Mirror the JD's exact terminology when the candidate has the equivalent skill (JD "React.js" + candidate "React" → write "React.js"). Do NOT add a skill the candidate never listed.
EXPERIENCE BULLETS: rewrite each of the candidate's real bullets in STAR form (Situation → Action → Result), front-loading JD keywords in the first 8-10 words, strong verbs (Architected, Engineered, Designed, Optimized, Led, Built, Delivered, Scaled). Keep every bullet — reword, never drop. Quantify ONLY with numbers already present in CANDIDATE DATA; never invent or inflate a metric.
PROJECTS: reword keyHighlight and bullets toward JD-relevant tech and outcomes, same depth, no fabrication.
KEYWORD STRATEGY: pull the top 15-20 hard skills/technologies from the JD; for each one the candidate TRULY has, make sure it appears (ideally in Skills and a bullet) using the JD's exact wording.
NEVER: fabricate or exaggerate experience, skills, tools, metrics, years, titles, dates, or employers. If the JD needs something the candidate lacks, it goes ONLY into missingRequiredKeywords / hardGaps — never into the résumé body.

PAGE FIT: must compile to exactly 1 page with the given .cls. Fill the page — dense, professional, no large gaps. If tight, adjust \\vspace values in the .tex only (never the .cls).

═══════════════════════════════════════════════════════════
SECTION D — SELF-ASSESSMENT (honest, skeptical recruiter voice)
═══════════════════════════════════════════════════════════
Score conservatively. List every hard/required JD qualification the candidate does not clearly meet (missing tech, insufficient years, domain mismatch).

═══════════════════════════════════════════════════════════
INPUTS
═══════════════════════════════════════════════════════════

CANDIDATE DATA (JSON — single source of truth):
---
${structuredJson}
---

SKELETON .tex (FORMAT ONLY — replace ALL of its literal content with the candidate's):
---
${currentTex}
---

.cls (DO NOT MODIFY — return byte-for-byte identical):
---
${currentCls}
---

JOB DESCRIPTION:
---
${jd}
---

═══════════════════════════════════════════════════════════
OUTPUT FORMAT (follow exactly, no other text before/after)
═══════════════════════════════════════════════════════════

---METRICS---
{
  "company": "<company name from JD, PascalCase, no spaces, filename-safe>",
  "roleTitle": "<exact job title from JD>",
  "keywordMatchPercent": <integer 0-100>,
  "atsPassChancePercent": <integer 0-100>,
  "humanScreenChancePercent": <integer 0-100>,
  "matchedKeywords": ["<keyword>", "..."],
  "missingRequiredKeywords": ["<keyword>", "..."],
  "hardGaps": ["<description of unmet hard requirement>"],
  "notes": "<1-2 sentence honest summary of fit>"
}
---TEX---
<complete tailored .tex — skeleton's structure/macros/spacing, but the CANDIDATE'S real identity and content throughout>
---CLS---
<.cls returned UNCHANGED, byte-for-byte identical>
---END---`;
}

// ── Provider-specific callers ─────────────────────────────────────

async function callAnthropic({ apiKey, model, prompt }) {
    const res = await fetch(PROVIDERS.anthropic.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model,
            max_tokens: 16384,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return (data.content || [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
}

async function callOpenAI({ apiKey, model, prompt }) {
    const res = await fetch(PROVIDERS.openai.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            max_tokens: 16384,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
}

async function callGemini({ apiKey, model, prompt }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 16384 },
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return (
        data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || ""
    );
}

// ── Output parser (shared across all providers) ───────────────────

// Drop trailing commas before a closing } or ] (common in LLM JSON).
function stripTrailingCommas(raw) {
    return raw.replace(/,(\s*[}\]])/g, "$1");
}

// Aggressive: escape literal control chars that appear inside string values.
// Safe only for compact JSON (newlines outside strings would be mangled), so
// this is tried last.
function escapeControlChars(raw) {
    return raw
        .replace(/\r\n/g, "\\n")
        .replace(/\r/g, "\\n")
        .replace(/(?<!\\)\n/g, "\\n")
        .replace(/(?<!\\)\t/g, "\\t");
}

// Pull the outermost {...} object out of a noisy string.
function extractJsonObject(raw) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return raw.slice(start, end + 1);
}

// Try increasingly lenient repairs until one parses to an object.
function parseLenientJson(raw) {
    const base = extractJsonObject(raw) || raw;
    const candidates = [
        base,
        stripTrailingCommas(base),
        stripTrailingCommas(escapeControlChars(base)),
    ];
    for (const c of candidates) {
        try {
            const v = JSON.parse(c);
            if (v && typeof v === "object") return v;
        } catch { /* next */ }
    }
    return null;
}

// Strip a ```lang ... ``` fence wrapping a single block (if present).
function stripCodeFence(s) {
    const t = s.trim();
    const m = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : t;
}

// Locate a delimiter like `---TEX---` tolerantly: 2+ dashes, optional spaces,
// case-insensitive, and accepting a few common aliases per section.
function findDelimiter(text, names) {
    const alt = names.join("|");
    const re = new RegExp(`-{2,}\\s*(?:${alt})\\s*-{2,}`, "i");
    const m = text.match(re);
    return m ? { index: m.index, length: m[0].length } : null;
}

function sliceBetween(text, startNames, endNames) {
    const a = findDelimiter(text, startNames);
    if (!a) return null;
    const rest = text.slice(a.index + a.length);
    const b = findDelimiter(rest, endNames);
    return (b ? rest.slice(0, b.index) : rest).trim();
}

function parseModelOutput(text) {
    const cleaned = String(text || "").replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

    const metricsRaw = sliceBetween(cleaned, ["METRICS", "METRIC", "SCORE"], ["TEX", "LATEX", "RESUME_TEX"]);
    const texRaw = sliceBetween(cleaned, ["TEX", "LATEX", "RESUME_TEX"], ["CLS", "CLASS", "RESUME_CLS"]);
    const clsRaw = sliceBetween(cleaned, ["CLS", "CLASS", "RESUME_CLS"], ["END", "DONE", "FIN"]);

    const missing = [];
    if (metricsRaw == null) missing.push("METRICS");
    if (texRaw == null) missing.push("TEX");
    if (clsRaw == null) missing.push("CLS");
    if (missing.length) {
        throw new Error(
            `Model response was missing the ${missing.join(", ")} block${missing.length > 1 ? "s" : ""}. ` +
            `Expected ---METRICS--- / ---TEX--- / ---CLS--- / ---END--- delimiters. Raw response:\n` +
            cleaned.slice(0, 2000)
        );
    }

    const metricsJson = stripCodeFence(metricsRaw);
    const metrics = parseLenientJson(metricsJson);
    if (!metrics) {
        throw new Error("METRICS block was not valid JSON. Raw block:\n" + metricsJson.slice(0, 500));
    }

    return { metrics, tex: stripCodeFence(texRaw), cls: stripCodeFence(clsRaw) };
}

function resolveProvider(providerKey, apiKey) {
    const provider = PROVIDERS[providerKey];
    if (!provider) {
        throw new Error(
            `Unknown provider "${providerKey}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
        );
    }
    if (!apiKey) {
        throw new Error(`No API key provided for ${provider.name}.`);
    }
    return provider;
}

// ── Public entry point — Stage 1: extract a structured résumé ─────
// Converts the raw text of an uploaded résumé into the strict JSON shape that
// `generateTailoredResume` treats as the single source of truth.
export async function extractStructuredResume({
    resumeText,
    apiKey,
    provider: providerKey = "gemini",
}) {
    if (!resumeText || !resumeText.trim()) {
        throw new Error("extractStructuredResume: resumeText is empty.");
    }

    const provider = resolveProvider(providerKey, apiKey);
    const model = provider.defaultModel;
    const prompt = buildExtractPrompt({ resumeText });
    const rawText = await provider.call({ apiKey, model, prompt });

    if (process.env.DEBUG_AI_RAW) {
        console.error(`\n===== RAW ${provider.name} EXTRACT (len ${rawText.length}) =====\n${rawText}\n===== END RAW =====\n`);
    }

    const structured = parseLenientJson(rawText);
    if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
        throw new Error(
            "Could not extract a structured résumé from the uploaded PDF text. Raw model response:\n" +
            String(rawText).slice(0, 1000)
        );
    }

    // Normalise the shape so downstream code can rely on it.
    return {
        name: typeof structured.name === "string" ? structured.name : "",
        contact: {
            email: structured.contact?.email || "",
            phone: structured.contact?.phone || "",
            location: structured.contact?.location || "",
            links: Array.isArray(structured.contact?.links) ? structured.contact.links : [],
        },
        summary: structured.summary || "",
        skills: Array.isArray(structured.skills) ? structured.skills : [],
        experience: Array.isArray(structured.experience) ? structured.experience : [],
        projects: Array.isArray(structured.projects) ? structured.projects : [],
        education: Array.isArray(structured.education) ? structured.education : [],
    };
}

// ── Public entry point — Stage 2: tailor the résumé to a JD ──────
// `structuredResume` (from extractStructuredResume) is the source of truth for
// identity; `currentTex`/`currentCls` are used purely as a LaTeX format skeleton.
export async function generateTailoredResume({
    jd,
    structuredResume,
    currentTex,
    currentCls,
    apiKey,
    provider: providerKey = "gemini",
}) {
    if (!structuredResume || typeof structuredResume !== "object") {
        throw new Error("generateTailoredResume: structuredResume object is required.");
    }

    const provider = resolveProvider(providerKey, apiKey);
    const model = provider.defaultModel;
    const prompt = buildTailorPrompt({ structuredResume, jd, currentTex, currentCls });
    const rawText = await provider.call({ apiKey, model, prompt });

    if (process.env.DEBUG_AI_RAW) {
        console.error(`\n===== RAW ${provider.name} OUTPUT (len ${rawText.length}) =====\n${rawText}\n===== END RAW =====\n`);
    }

    return parseModelOutput(rawText);
}

export { PROVIDERS };
