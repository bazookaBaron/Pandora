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
        // URL is built dynamically with model name
        // defaultModel: "gemini-3.6-flash",
        defaultModel: "gemini-3.5-flash",
        call: callGemini,
    },
};

// ── Shared prompt builder ─────────────────────────────────────────
function buildPrompt({ jd, currentTex, currentCls, additionalContext }) {
    return `You are an elite ATS resume optimizer, professional resume writer, and LaTeX engineer. Your goal is to produce the HIGHEST-SCORING resume possible for this JD while staying 100% truthful.

═══════════════════════════════════════════════════════════
SECTION A — LATEX STRUCTURAL RULES (violating ANY = failure)
═══════════════════════════════════════════════════════════
1. The .cls uses a CUSTOM layout (a3paper, 12 in tall, 21 pt font). NEVER change document class options, paper size, font, or margins in the .cls.
2. Return the .cls file COMPLETELY UNCHANGED — byte-for-byte identical.
3. The .tex uses CUSTOM MACROS: \\introduction, \\summary, \\skillItem, \\experienceItem, \\projectItem, \\educationItem, and environments: skillsSection, experienceSection, educationSection. Use these EXACT macros with EXACT parameter names. Do NOT substitute \\section, \\subsection, tabular, or any standard LaTeX.
4. Preserve EXACT section order: Introduction → Summary → Skills → Experience → Projects → Education.
5. Keep ALL \\vspace, \\itemsep, \\hspace, \\hfill spacing commands exactly as in the original .tex.
6. Keep \\begin{itemize}/\\end{itemize} blocks with their \\itemsep -6pt {} spacing.
7. Do NOT remove or shorten project descriptions. Keep every keyHighlight and every bullet. REWORD to target the JD — never delete.
8. Experience section: keep at least the same number of bullets. Rewrite content to align with JD — never drop bullets.
9. NEVER change: name, contact info, education, dates, company names, project names, durations.
10. ONLY modify TEXT CONTENT inside: \\summary{…}, \\skillItem skills={…}, \\item bullets, \\projectItem keyHighlight={…}.

═══════════════════════════════════════════════════════════
SECTION B — ATS & RECRUITER OPTIMIZATION STRATEGY
═══════════════════════════════════════════════════════════
Apply ALL of the following to maximize ATS score and recruiter impact:

SUMMARY (\\summary{…}):
• Open with the exact target role title from the JD.
• Mention years of experience, 2-3 top technical skills from the JD, and a quantified achievement.
• Keep it to 2-3 impactful sentences.

SKILLS (\\skillItem):
• Mirror the JD's technology names EXACTLY (e.g. if JD says "React.js" don't write "React"; if JD says "AWS Lambda" don't write just "Lambda").
• Reorder skills within each category so the most JD-relevant ones appear first.
• Add JD-required skills ONLY if they truthfully match my experience or are listed in the additional context.

EXPERIENCE BULLETS (\\item):
• Use strong action verbs: Architected, Engineered, Designed, Optimized, Led, Implemented, Built, Delivered, Scaled.
• Follow the STAR format: Situation context → Action taken → Result/Impact with a metric where possible.
• Front-load each bullet with JD keywords in the first 8-10 words (ATS often weighs the start of bullets more).
• Quantify impact wherever truthful (%, $, users, latency reduction, uptime improvement, etc.).
• Naturally embed JD keywords and phrases — aim for high keyword density without keyword-stuffing.

PROJECTS:
• Reword keyHighlight and bullets to emphasize JD-relevant technologies, patterns, and outcomes.
• Keep the same depth and detail as the original — do NOT shorten.

KEYWORD STRATEGY:
• Extract the top 15-20 hard skills and technologies from the JD.
• Ensure each one that truthfully matches my experience appears at least once in the resume (ideally in both Skills AND a bullet).
• Use the EXACT terminology from the JD (e.g., "microservices architecture" not just "microservices").

WHAT TO NEVER DO:
• NEVER fabricate experience, skills, technologies, metrics, years, or achievements.
• NEVER add skills or technologies I have not used — if a JD requirement doesn't match my background, leave it out.
• NEVER inflate or exaggerate impact numbers.

PAGE FIT:
• The resume must compile to exactly 1 page with the given .cls.
• Fill the page — dense, professional content. No large empty spaces.
• If tight, adjust \\vspace values in .tex only (NOT .cls).

═══════════════════════════════════════════════════════════
SECTION C — SELF-ASSESSMENT
═══════════════════════════════════════════════════════════
After rewriting, score the resume HONESTLY as a skeptical recruiter/ATS:
• Do not inflate scores.
• Call out every hard/required JD qualification that is missing.
• If a required technology or year-of-experience threshold isn't met, flag it.

═══════════════════════════════════════════════════════════
INPUTS
═══════════════════════════════════════════════════════════

CURRENT .tex:
---
${currentTex}
---

CURRENT .cls (DO NOT MODIFY — return byte-for-byte identical):
---
${currentCls}
---

ADDITIONAL EXPERIENCE NOT YET IN MY RESUME (incorporate only what's genuinely relevant to this JD; never fabricate beyond what's listed here):
---
${additionalContext || "None provided."}
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
<complete updated .tex — same structure, same macros, optimized content>
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

function parseModelOutput(text) {
    const metricsMatch = text.match(/---METRICS---\s*([\s\S]*?)\s*---TEX---/);
    const texMatch = text.match(/---TEX---\s*([\s\S]*?)\s*---CLS---/);
    const clsMatch = text.match(/---CLS---\s*([\s\S]*?)\s*---END---/);

    if (!metricsMatch || !texMatch || !clsMatch) {
        throw new Error(
            "Could not parse model response into METRICS/TEX/CLS sections. Raw response:\n" +
            text.slice(0, 2000)
        );
    }

    let metrics;
    try {
        metrics = JSON.parse(metricsMatch[1].trim());
    } catch {
        throw new Error(
            "Metrics block was not valid JSON: " + metricsMatch[1].slice(0, 500)
        );
    }

    return { metrics, tex: texMatch[1].trim(), cls: clsMatch[1].trim() };
}

// ── Public entry point ────────────────────────────────────────────

export async function generateTailoredResume({
    jd,
    currentTex,
    currentCls,
    additionalContext,
    apiKey,
    provider: providerKey = "anthropic",
}) {
    const provider = PROVIDERS[providerKey];
    if (!provider) {
        throw new Error(
            `Unknown provider "${providerKey}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
        );
    }

    if (!apiKey) {
        throw new Error(
            `No API key provided for ${provider.name}. Enter it in the UI.`
        );
    }

    const model = provider.defaultModel;
    const prompt = buildPrompt({ jd, currentTex, currentCls, additionalContext });
    const rawText = await provider.call({ apiKey, model, prompt });

    return parseModelOutput(rawText);
}

export { PROVIDERS };
