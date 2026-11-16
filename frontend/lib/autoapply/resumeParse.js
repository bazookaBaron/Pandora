/**
 * Resume -> profile draft. Free by default: text extraction with pdf-parse
 * (PDF) or jszip (DOCX), then a rule-based extractor. An LLM pass is optional
 * (AA_RESUME_AI=gemini|openai|anthropic plus that provider's API key) and only
 * fills gaps the rules left; any AI failure falls back to the rule draft.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?\d{1,3}[\s-]?)?(\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4,5}/;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;|)]*)?)/gi;

const SECTION_RE = {
  skills: /^(technical\s+)?skills(\s*&\s*\w+)?|^core competencies|^technologies|^tech stack/i,
  experience: /^(work\s+|professional\s+)?experience|^employment( history)?|^work history/i,
  education: /^education|^academic/i,
  projects: /^projects?/i,
  summary: /^(professional\s+)?summary|^profile|^objective|^about( me)?/i,
  other: /^(certifications?|achievements?|awards?|publications?|languages?|interests|hobbies|activities|positions of responsibility|extra-?curricular)/i,
};

const DEGREE_RE = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|bachelor[^,\n]*|m\.?\s?tech|m\.?\s?sc|m\.?\s?s\b|master[^,\n]*|mba|ph\.?\s?d|bca|mca|diploma)/i;

export async function extractText(buffer, ext) {
  if (ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: Buffer.from(buffer) });
    try {
      const r = await parser.getText();
      return (r && r.text) || "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (ext === "docx") {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file("word/document.xml");
    if (!f) return "";
    const xml = await f.async("string");
    return xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
  return "";
}

function splitSections(lines) {
  const out = { header: [], skills: [], experience: [], education: [], projects: [], summary: [], other: [] };
  let cur = "header";
  for (const line of lines) {
    const t = line.replace(/[:\s]+$/, "").trim();
    const isHeading = t.length > 0 && t.length <= 40 && !/[.@]/.test(t) && !/:\s*\S/.test(line);
    let hit = null;
    if (isHeading) for (const [k, re] of Object.entries(SECTION_RE)) if (re.test(t)) { hit = k; break; }
    if (hit) { cur = hit; continue; }
    out[cur].push(line);
  }
  return out;
}

function guessName(headerLines) {
  for (const raw of headerLines.slice(0, 6)) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (!l || EMAIL_RE.test(l) || /\d{4}/.test(l) || /https?:|www\.|linkedin|github/i.test(l)) continue;
    const words = l.split(" ");
    if (words.length >= 1 && words.length <= 4 && words.every((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w))) {
      return words.map((w) => (w === w.toUpperCase() && w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
    }
  }
  return "";
}

function experienceYears(text) {
  const m = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:\w+\s+){0,3}experience/i.exec(text);
  if (m) return Number(m[1]);
  // fall back to the span of years in the experience section
  return null;
}

function yearsFromRanges(lines, now = new Date()) {
  const yr = now.getUTCFullYear();
  let min = Infinity;
  let max = -Infinity;
  const re = /\b((?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:19|20)\d{2}|present|current|now|till date)/gi;
  for (const l of lines) {
    let m;
    while ((m = re.exec(l))) {
      const a = Number(m[1]);
      const b = /^\d/.test(m[2]) ? Number(m[2]) : yr;
      if (a <= b) { min = Math.min(min, a); max = Math.max(max, b); }
    }
  }
  return Number.isFinite(min) ? Math.max(0, max - min) : null;
}

export function draftFromText(text, now = new Date()) {
  const clean = String(text || "").replace(/\r/g, "").replace(/ /g, " ");
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  const sec = splitSections(lines);
  const all = lines.join("\n");

  const name = guessName(sec.header.length ? sec.header : lines);
  const [first_name = "", ...rest] = name.split(" ");
  const email = (EMAIL_RE.exec(all) || [""])[0];
  const headerBlob = sec.header.join(" ");
  const phoneM = PHONE_RE.exec(headerBlob.replace(EMAIL_RE, " ")) || PHONE_RE.exec(all.replace(EMAIL_RE, " "));
  const phone = phoneM && phoneM[0].replace(/\D/g, "").length >= 10 ? phoneM[0].trim() : "";

  const urls = (all.match(URL_RE) || []).filter((u) => !EMAIL_RE.test(u) && /[a-z]/i.test(u));
  const norm = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/[).,;]+$/, "");
  const linkedin = urls.find((u) => /linkedin\.com\//i.test(u));
  const github = urls.find((u) => /github\.com\//i.test(u));
  const website = urls.find((u) => /^(https?:\/\/|www\.)/i.test(u) && !/linkedin\.com|github\.com/i.test(u));

  const skills = [
    ...new Set(
      sec.skills
        .map((l) => l.replace(/^[^:]{1,30}:/, ""))
        .join(", ")
        .split(/[,|•·;\n\t]+/)
        .map((s) => s.replace(/^[-–*\s]+/, "").trim())
        .filter((s) => s.length > 1 && s.length <= 40),
    ),
  ].slice(0, 60);

  const education = sec.education.filter((l) => DEGREE_RE.test(l) || /university|college|institute|school/i.test(l)).slice(0, 6);
  const degreeM = DEGREE_RE.exec(sec.education.join("\n"));
  const school = sec.education.find((l) => /university|college|institute|iit|nit|school/i.test(l)) || "";
  const gradYears = (sec.education.join(" ").match(/\b(19|20)\d{2}\b/g) || []).map(Number);

  const expLines = sec.experience.slice(0, 80);
  const years = experienceYears(all) ?? yearsFromRanges(expLines, now);
  const firstRole = expLines.find((l) => l.length <= 120 && !/^[-•*]/.test(l)) || "";
  const roleParts = firstRole.split(/\s+(?:at|@|\||–|—|-|,)\s+/);

  const location = (sec.header.find((l) => /,\s*[A-Za-z]+/.test(l) && !EMAIL_RE.test(l) && !/https?:|linkedin|github/i.test(l) && l.length < 60) || "").trim();

  const profile = {
    name,
    first_name,
    last_name: rest.join(" "),
    email,
    phone,
    location,
    linkedin: linkedin ? norm(linkedin) : "",
    github: github ? norm(github) : "",
    website: website ? norm(website) : "",
    summary: sec.summary.join(" ").slice(0, 1200),
    skills,
    experience: expLines.slice(0, 40),
    education,
    total_experience_years: years,
    current_title: roleParts.length > 1 ? roleParts[0].trim().slice(0, 80) : "",
    current_company: roleParts.length > 1 ? roleParts[1].trim().slice(0, 80) : "",
    source: "rules",
  };

  const suggested = {
    "fields.first_name": profile.first_name,
    "fields.last_name": profile.last_name,
    "fields.phone": profile.phone,
    "fields.linkedin": profile.linkedin,
    "fields.github": profile.github,
    "fields.website": profile.website,
    "fields.current_company": profile.current_company,
    "fields.current_title": profile.current_title,
    "fields.school": school.slice(0, 120),
    "fields.degree": degreeM ? degreeM[0].trim() : "",
    "facts.total_experience_years": years == null ? "" : String(years),
    "facts.graduation_year": gradYears.length ? String(Math.max(...gradYears.filter((y) => y <= now.getUTCFullYear() + 5))) : "",
  };
  profile.suggested_answers = Object.fromEntries(Object.entries(suggested).filter(([, v]) => v !== "" && v != null && v !== "-Infinity"));
  return profile;
}

const AI_KEYS = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/** Optional AI enrichment. Returns the draft unchanged unless configured. */
export async function maybeEnrichWithAi(draft, text) {
  const provider = String(process.env.AA_RESUME_AI || "").trim().toLowerCase();
  const apiKey = provider && process.env[AI_KEYS[provider]];
  if (!apiKey) return draft;
  try {
    const { extractStructuredResume } = await import("../aiClient.js");
    const s = await extractStructuredResume({ resumeText: text, apiKey, provider });
    const out = { ...draft, source: "rules+ai" };
    if (!out.name && s.name) out.name = s.name;
    if (!out.email && s.contact?.email) out.email = s.contact.email;
    if (!out.phone && s.contact?.phone) out.phone = s.contact.phone;
    if (!out.location && s.contact?.location) out.location = s.contact.location;
    if (!out.skills.length && s.skills.length) out.skills = s.skills.flat().map(String).slice(0, 60);
    if (Array.isArray(s.experience) && s.experience.length) out.experience = s.experience;
    if (Array.isArray(s.education) && s.education.length) out.education = s.education;
    return out;
  } catch (e) {
    console.warn("[autoapply/resume] AI enrichment skipped:", (e && e.message) || String(e));
    return draft;
  }
}
