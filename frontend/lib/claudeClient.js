const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/**
 * Builds the instruction prompt for Claude. Keeps the same "no fabrication,
 * 1-page, keep .cls unchanged unless spacing is broken" rules you were
 * already using manually, plus asks for a structured metrics block so the
 * UI can show real numbers instead of guessing client-side.
 */
function buildPrompt({ jd, currentTex, currentCls, firstName, lastName, additionalContext }) {
  return `You are an expert ATS resume optimizer and LaTeX resume engineer.

I will give you my current .tex resume content, my .cls (styling/macro) file, and a job description (JD).

TASK
- Rewrite ONLY the content in my .tex file to target this specific JD: keywords, required skills, terminology, and responsibilities.
- Use exact JD terminology where it truthfully matches my experience.
- NEVER fabricate experience, skills, technologies, metrics, years of experience, or achievements. If a JD requirement is not in my background, leave it out rather than implying I have it.
- Keep all LaTeX commands/macros compatible with the .cls file provided (do not invent new macros).
- Keep it strictly 1 page at the class's current font size/margins. Only touch the .cls file if the content cannot fit without a spacing/margin adjustment - if you do, return the full modified .cls too; otherwise return the .cls unchanged.
- Do not change my name, contact info, education, or dates.
- Professional, dense, ATS-friendly. No graphics, no tables beyond what's already in the template.

Then, honestly self-assess the match. Do not inflate the scores - they should reflect a realistic, skeptical read, the same way a careful recruiter or ATS would score it. Explicitly call out any hard/required JD qualifications (years of experience, named technologies, certifications) that are missing from my background.

CURRENT .tex:
---
${currentTex}
---

CURRENT .cls:
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

OUTPUT FORMAT (follow exactly, no other text before/after):

---METRICS---
{
  "company": "<company name extracted from JD, PascalCase or CamelCase, no spaces, for use in a filename>",
  "roleTitle": "<job title from JD>",
  "keywordMatchPercent": <integer 0-100>,
  "atsPassChancePercent": <integer 0-100>,
  "humanScreenChancePercent": <integer 0-100>,
  "matchedKeywords": ["<keyword>", "..."],
  "missingRequiredKeywords": ["<keyword>", "..."],
  "hardGaps": ["<short description of any hard requirement not met, e.g. 'JD requires 5-7 yrs, resume shows 4+'>"],
  "notes": "<1-2 sentence honest summary of the fit>"
}
---TEX---
<complete updated .tex file content, nothing else>
---CLS---
<complete .cls file content - unchanged unless you had to adjust spacing, in which case return the full modified version>
---END---`;
}

/**
 * Calls the Anthropic Messages API and parses out the three sections.
 */
export async function generateTailoredResume({ jd, currentTex, currentCls, firstName, lastName, additionalContext, apiKey: providedKey }) {
  const apiKey = providedKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("No API key provided. Enter your Anthropic API key in the UI or set ANTHROPIC_API_KEY in .env.");
  }

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";
  const prompt = buildPrompt({ jd, currentTex, currentCls, firstName, lastName, additionalContext });

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");

  return parseModelOutput(text);
}

function parseModelOutput(text) {
  const metricsMatch = text.match(/---METRICS---([\s\S]*?)---TEX---/);
  const texMatch = text.match(/---TEX---([\s\S]*?)---CLS---/);
  const clsMatch = text.match(/---CLS---([\s\S]*?)---END---/);

  if (!metricsMatch || !texMatch || !clsMatch) {
    throw new Error(
      "Could not parse Claude's response into METRICS/TEX/CLS sections. Raw response:\n" + text.slice(0, 2000)
    );
  }

  let metrics;
  try {
    metrics = JSON.parse(metricsMatch[1].trim());
  } catch (e) {
    throw new Error("Metrics block was not valid JSON: " + metricsMatch[1].slice(0, 500));
  }

  const tex = texMatch[1].trim();
  const cls = clsMatch[1].trim();

  return { metrics, tex, cls };
}
