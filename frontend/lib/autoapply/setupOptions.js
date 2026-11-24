/**
 * AutoApply setup form: the question schema, the dropdown option lists and the validation rules.
 * Pure (no Node or browser APIs): the API (lib/autoapply/questions.js, routes/autoapply.js) and the Setup page
 * (src/pages/autoapply/SetupPage.jsx) import the same file, so the client and the server check answers identically.
 *
 * Question shape:
 *   { key, label, group, type: 'select'|'multiselect'|'yesno'|'number'|'date'|'text', options?: [{value,label}],
 *     required, gate?, help?, default?, min?, max?, maxItems?, pattern?, patternMsg?, requiredIf? }
 *   gate: true  -> also checked by the profile gate (profileGate.js, mirrors cloud_hunter/saas/profile_gate.py).
 *                  The gate set is unchanged; `required` alone only means "the setup form needs it".
 *   requiredIf  -> { key, equals }: required only while another answer has that value.
 * Keys are the ones cloud_hunter/saas/worker/profile_build.py reads (fields.* -> answers.json fields,
 * facts.* -> rules / salary / ai_facts). Values stay in the shapes it parses: numbers as plain numbers (days,
 * years, LPA), yes/no as 'yes'/'no', dates as YYYY-MM-DD, country codes comma separated.
 */
import { ROLE_SUGGESTIONS } from "../../src/lib/roleSuggestions.js";

const o = (value, label = value) => ({ value: String(value), label });
const opts = (list) => list.map((x) => (Array.isArray(x) ? o(x[0], x[1]) : o(x)));

// ── option lists ──────────────────────────────────────────────────────────
export const YES_NO = opts([["yes", "Yes"], ["no", "No"]]);

export const INDIAN_CITIES = [
  "Bengaluru", "Hyderabad", "Pune", "Chennai", "Mumbai", "Navi Mumbai", "Thane", "Delhi", "New Delhi", "Gurugram",
  "Noida", "Greater Noida", "Faridabad", "Ghaziabad", "Kolkata", "Ahmedabad", "Gandhinagar", "Vadodara", "Surat",
  "Jaipur", "Chandigarh", "Mohali", "Indore", "Bhopal", "Nagpur", "Nashik", "Lucknow", "Kanpur", "Coimbatore",
  "Kochi", "Thiruvananthapuram", "Mysuru", "Mangaluru", "Visakhapatnam", "Vijayawada", "Bhubaneswar", "Patna",
  "Ranchi", "Guwahati", "Dehradun", "Goa", "Madurai", "Tiruchirappalli", "Raipur", "Ludhiana", "Amritsar",
  "Jammu", "Srinagar", "Varanasi", "Agra", "Hubballi", "Belagavi", "Puducherry", "Siliguri", "Jodhpur", "Udaipur",
];
// "Pan India" (shown as Anywhere in India) is in the matcher's ANYWHERE set (cloud_hunter/saas/matching.py).
export const ANYWHERE_IN_INDIA = "Pan India";
export const LOCATION_OPTIONS = [
  o(ANYWHERE_IN_INDIA, "Anywhere in India"),
  o("Remote", "Remote"),
  ...["Bengaluru", "Hyderabad", "Pune", "Chennai", "Mumbai", "Delhi", "Gurugram", "Noida", "Kolkata", "Ahmedabad",
    "Jaipur", "Chandigarh", "Kochi", "Coimbatore", "Indore", "Thiruvananthapuram", "Bhubaneswar", "Nagpur",
    "Lucknow", "Visakhapatnam", "Vadodara", "Mysuru", "Mangaluru", "Goa"].map((c) => o(c)),
];
export const MAX_LOCATIONS = 10;
export const MAX_TITLES = 5;
export const TITLE_OPTIONS = ROLE_SUGGESTIONS.map((t) => o(t));

export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];
export const COUNTRIES = ["India", "United States", "United Kingdom", "Canada", "Australia", "Singapore",
  "United Arab Emirates", "Germany", "Netherlands", "Ireland", "Other"];
export const WORK_AUTH = opts([["IN", "India"], ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"],
  ["AU", "Australia"], ["SG", "Singapore"], ["AE", "UAE"], ["DE", "Germany"], ["NL", "Netherlands"], ["IE", "Ireland"]]);
export const VISA_STATUS = opts([["citizen", "Citizen / no visa needed"], ["permanent_resident", "Permanent resident / green card"],
  ["work_visa", "Work visa (H-1B, L-1, Skilled worker…)"], ["student_visa", "Student visa / OPT"],
  ["dependent_visa", "Dependent visa"], ["none", "No visa for other countries"]]);
export const NATIONALITIES = opts([["indian", "Indian"], ["american", "American"], ["british", "British"],
  ["canadian", "Canadian"], ["australian", "Australian"], ["nepali", "Nepali"], ["bangladeshi", "Bangladeshi"],
  ["sri_lankan", "Sri Lankan"], ["other", "Other"]]);

export const DEGREES = ["B.Tech / B.E.", "B.Sc", "BCA", "B.Com", "BBA / BBM", "BA", "B.Arch", "B.Des", "B.Pharm",
  "MBBS", "LLB", "M.Tech / M.E.", "M.Sc", "MCA", "MBA / PGDM", "M.Com", "MA", "M.Des", "M.Pharm", "LLM", "CA",
  "CS", "CMA", "PhD", "Diploma", "12th / Higher Secondary", "Other"];
export const BRANCHES = ["Computer Science", "Information Technology", "Electronics and Communication",
  "Electrical", "Electrical and Electronics", "Mechanical", "Civil", "Chemical", "Instrumentation",
  "Biotechnology", "Aerospace", "Data Science / AI", "Mathematics", "Statistics", "Physics", "Chemistry",
  "Commerce", "Economics", "Finance", "Marketing", "Human Resources", "Operations", "Business Administration",
  "Design", "Law", "Pharmacy", "Medicine", "Arts / Humanities", "Other"];
export const HIGHEST_DEGREE = opts([["high_school", "High school (12th)"], ["diploma", "Diploma"],
  ["bachelor", "Bachelor's"], ["master", "Master's"], ["phd", "PhD"], ["other", "Other"]]);

export const LANGUAGES = ["English", "Hindi", "Bengali", "Tamil", "Telugu", "Kannada", "Malayalam", "Marathi",
  "Gujarati", "Punjabi", "Odia", "Urdu", "Assamese", "Konkani", "French", "German", "Spanish", "Japanese",
  "Mandarin", "Arabic"];

const years = (n) => (n === 0 ? "Fresher (0)" : n === 1 ? "1 year" : n >= 30 ? "30+ years" : `${n} years`);
export const EXPERIENCE_YEARS = Array.from({ length: 31 }, (_, n) => o(n, years(n)));
export const NOTICE_DAYS = opts([["0", "Immediate joiner (0 days)"], ["15", "15 days or less"], ["30", "30 days (1 month)"],
  ["45", "45 days"], ["60", "60 days (2 months)"], ["90", "90 days (3 months)"], ["120", "More than 90 days"]]);
export const START_DAYS = opts([["0", "Immediately"], ["7", "Within 1 week"], ["15", "Within 15 days"], ["30", "Within 1 month"],
  ["45", "Within 45 days"], ["60", "Within 2 months"], ["90", "Within 3 months"]]);
const LPA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 60, 70, 80, 100, 125, 150];
export const CURRENT_CTC = [o(0, "Fresher / no current salary"), ...LPA.map((n) => o(n, `₹${n} LPA`))];
export const EXPECTED_CTC = [o(0, "Open to discussion / as per norms"), ...LPA.map((n) => o(n, `₹${n} LPA`))];
export const HOW_HEARD = opts(["LinkedIn", "Company website", "Job board", "Employee referral", "Social media", "Other"]);
export const GENDERS = opts([["male", "Male"], ["female", "Female"], ["non_binary", "Non-binary"], ["decline", "Prefer not to say"]]);
export const ETHNICITIES = opts([["asian", "Asian"], ["south_asian", "South Asian"], ["white", "White"],
  ["black", "Black or African"], ["hispanic", "Hispanic or Latino"], ["middle_eastern", "Middle Eastern"],
  ["mixed", "Two or more"], ["other", "Other"], ["decline", "Prefer not to say"]]);
export const DISABILITY = opts([["no", "No"], ["yes", "Yes"], ["decline", "Prefer not to say"]]);
export const VETERAN = opts([["no", "No, not a veteran"], ["yes", "Yes"], ["decline", "Prefer not to say"]]);

export const MIN_SCORE_LEVELS = [
  { value: 0, label: "Broad (more jobs)", help: "Every job that matches your titles and locations." },
  { value: 20, label: "Balanced", help: "Skips jobs whose description barely mentions your skills. Recommended." },
  { value: 30, label: "Strict", help: "Only jobs that clearly ask for your skills. Fewer applications." },
];
export const MIN_SCORE_DEFAULT = 20;
/** Saved prefs may hold an old slider value (0–100): show the nearest level (the matcher caps at 30 anyway). */
export const scoreLevel = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return MIN_SCORE_DEFAULT;
  return n >= 30 ? 30 : n >= 10 ? 20 : 0;
};

const thisYear = () => new Date().getFullYear();
export const GRAD_YEARS = () => Array.from({ length: 50 }, (_, i) => o(thisYear() + 4 - i));

// ── text patterns ─────────────────────────────────────────────────────────
const NAME_RE = "^[\\p{L}][\\p{L} .'\\-]*$";
export const PHONE_RE = /^\+91 [6-9]\d{4} \d{5}$/;
const LINKEDIN_RE = "^https://([a-z]{2,3}\\.)?linkedin\\.com/in/[A-Za-z0-9\\-_%]{2,100}/?$";
const URL_RE = "^https://[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(/[^\\s<>\"']*)?$";

// ── the questions ─────────────────────────────────────────────────────────
const q = (key, label, group, extra = {}) => ({ key, label, group, type: "text", required: true, ...extra });
const sel = (key, label, group, options, extra = {}) => q(key, label, group, { type: "select", options, ...extra });
const yn = (key, label, group, extra = {}) => q(key, label, group, { type: "yesno", options: YES_NO, ...extra });

const G_ID = "About you", G_CONTACT = "Contact and address", G_WORK = "Work and pay", G_EDU = "Education",
  G_AUTH = "Work authorisation", G_FORM = "Common form questions", G_EEO = "Diversity (you may decline)";

export const QUESTIONS = [
  q("fields.first_name", "Legal first name", G_ID, { gate: true, min: 1, max: 50, pattern: NAME_RE, patternMsg: "Letters, spaces, . ' - only." }),
  q("fields.last_name", "Legal last name", G_ID, { gate: true, min: 1, max: 50, pattern: NAME_RE, patternMsg: "Letters, spaces, . ' - only." }),
  q("fields.preferred_name", "Preferred name", G_ID, { min: 1, max: 40, pattern: NAME_RE, patternMsg: "Letters, spaces, . ' - only.", help: "What recruiters should call you." }),
  q("facts.date_of_birth", "Date of birth", G_ID, { type: "date", widget: "dmy", minAge: 16, maxAge: 80 }),
  sel("facts.gender", "Gender", G_ID, GENDERS, { default: "decline" }),
  sel("facts.nationality", "Nationality", G_ID, NATIONALITIES, { default: "indian" }),
  q("facts.languages", "Languages you speak", G_ID, { type: "multiselect", options: opts(LANGUAGES), maxItems: 6, default: "English" }),

  q("fields.phone", "Mobile number", G_CONTACT, { gate: true, help: "Indian mobile, +91 then 10 digits.", placeholder: "+91 98765 43210" }),
  q("fields.address_line1", "Address line", G_CONTACT, { min: 5, max: 150, help: "House / street / area." }),
  sel("fields.city", "Current city", G_CONTACT, [...INDIAN_CITIES.map((c) => o(c)), o("Other")], { gate: true }),
  sel("fields.state", "State / UT", G_CONTACT, [...INDIAN_STATES.map((c) => o(c)), o("Outside India")]),
  q("fields.postal_code", "PIN code", G_CONTACT, { pattern: "^[1-9][0-9]{5}$", patternMsg: "6-digit PIN code.", inputMode: "numeric", max: 6 }),
  sel("fields.country", "Country", G_CONTACT, COUNTRIES.map((c) => o(c)), { gate: true, default: "India" }),
  q("fields.linkedin", "LinkedIn profile URL", G_CONTACT, { max: 200, pattern: LINKEDIN_RE, patternMsg: "Use https://www.linkedin.com/in/your-name", placeholder: "https://www.linkedin.com/in/your-name" }),
  q("fields.github", "GitHub or portfolio URL", G_CONTACT, { max: 200, pattern: URL_RE, patternMsg: "A full https:// link.", placeholder: "https://github.com/you" }),
  q("fields.website", "Other website (optional)", G_CONTACT, { required: false, max: 200, pattern: URL_RE, patternMsg: "A full https:// link." }),

  sel("facts.total_experience_years", "Total experience", G_WORK, EXPERIENCE_YEARS, { gate: true }),
  sel("facts.relevant_experience_years", "Relevant experience for the roles you want", G_WORK, EXPERIENCE_YEARS),
  yn("facts.currently_employed", "Currently employed?", G_WORK, { gate: true }),
  q("fields.current_company", "Current (or last) employer", G_WORK, { min: 2, max: 80, requiredIf: { key: "facts.currently_employed", equals: "yes" } }),
  q("fields.current_title", "Current (or last) job title", G_WORK, { min: 2, max: 80, suggest: "titles", requiredIf: { key: "facts.currently_employed", equals: "yes" } }),
  sel("facts.notice_period_days", "Notice period", G_WORK, NOTICE_DAYS, { gate: true }),
  sel("facts.earliest_start_days", "Earliest start after an offer", G_WORK, START_DAYS),
  sel("facts.current_ctc_lpa", "Current CTC (per year)", G_WORK, CURRENT_CTC),
  sel("facts.expected_ctc_lpa", "Expected CTC (per year)", G_WORK, EXPECTED_CTC),
  yn("facts.willing_to_relocate", "Willing to relocate?", G_WORK, { gate: true, default: "yes" }),
  yn("facts.willing_wfo", "Willing to work from the office?", G_WORK, { default: "yes" }),
  yn("facts.willing_shifts", "Willing to work in shifts?", G_WORK, { default: "no" }),

  sel("facts.highest_degree", "Highest education level", G_EDU, HIGHEST_DEGREE),
  sel("fields.degree", "Degree", G_EDU, DEGREES.map((d) => o(d))),
  sel("facts.education_branch", "Branch / specialisation", G_EDU, BRANCHES.map((d) => o(d))),
  q("fields.school", "College / university", G_EDU, { min: 2, max: 120 }),
  q("facts.graduation_year", "Graduation year", G_EDU, { type: "select", options: "GRAD_YEARS" }),

  q("facts.work_authorized_in", "Countries you can work in without a new visa", G_AUTH, { type: "multiselect", options: WORK_AUTH, maxItems: 10, joiner: ",", gate: true, default: "IN" }),
  sel("facts.visa_status", "Visa status for other countries", G_AUTH, VISA_STATUS, { default: "none" }),
  yn("facts.needs_sponsorship", "Do you need visa sponsorship?", G_AUTH, { gate: true, default: "no" }),

  sel("facts.how_did_you_hear", "How did you hear about the job? (default answer)", G_FORM, HOW_HEARD, { default: "LinkedIn" }),
  yn("facts.previously_worked_here", "Previously worked for the company? (default answer)", G_FORM, { default: "no", help: "We answer No unless the company is in your work history." }),
  yn("facts.has_referral", "Were you referred by an employee? (default answer)", G_FORM, { default: "no" }),
  yn("facts.background_check", "Do you consent to a background check?", G_FORM, { default: "yes" }),
  yn("facts.non_compete", "Are you bound by a non-compete agreement?", G_FORM, { default: "no" }),

  sel("facts.disability", "Disability", G_EEO, DISABILITY, { default: "decline" }),
  sel("facts.veteran", "Veteran status", G_EEO, VETERAN, { default: "decline" }),
  sel("facts.ethnicity", "Ethnicity", G_EEO, ETHNICITIES, { default: "decline" }),
];
export const GROUPS = [G_ID, G_CONTACT, G_WORK, G_EDU, G_AUTH, G_FORM, G_EEO];

/** options can be a lazy list name (graduation years depend on today's date). */
export const optionsOf = (question) => (question.options === "GRAD_YEARS" ? GRAD_YEARS() : question.options || []);
export const SCHEMA_BY_KEY = new Map(QUESTIONS.map((x) => [x.key, x]));

// ── validation (shared by client and server) ──────────────────────────────
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ANGLE_RE = /[<>]/;
export const MAX_FREE_LEN = 2000;

/** Strip invisible / control characters, collapse spaces. */
export function cleanText(v) {
  return String(v ?? "").normalize("NFC").replace(CONTROL_RE, "").replace(/[ \t]+/g, " ").trim();
}

/** Indian mobile -> '+91 98765 43210', or null. Accepts +91 / 91 / 0 prefixes, spaces, dashes, brackets. */
export function normalisePhone(v) {
  let d = String(v ?? "").replace(/[\s\-().]/g, "");
  if (d.startsWith("+91")) d = d.slice(3);
  else if (/^91\d{10}$/.test(d)) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}

function matchOption(options, raw) {
  const v = String(raw).trim().toLowerCase();
  return options.find((op) => op.value.toLowerCase() === v || op.label.toLowerCase() === v) || null;
}

function ageOn(iso, today) {
  const [y, m, d] = iso.split("-").map(Number);
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age;
}

/**
 * Check one answer against its schema question. Returns { ok: true, value } with the canonical stored string
 * ('' = empty) or { ok: false, message }. Emptiness is not an error here; see missingRequired.
 */
export function checkAnswer(question, raw, { today = new Date() } = {}) {
  const qq = question;
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (Array.isArray(raw)) raw = raw.join(qq.joiner || ", ");
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return { ok: false, message: "Must be text or a number." };
  const v = cleanText(raw);
  if (!v) return { ok: true, value: "" };
  if (v.length > MAX_FREE_LEN) return { ok: false, message: "Too long." };
  const options = optionsOf(qq);
  switch (qq.type) {
    case "select":
    case "yesno": {
      const hit = matchOption(options, v);
      return hit ? { ok: true, value: hit.value } : { ok: false, message: "Choose one of the options." };
    }
    case "multiselect": {
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const p of parts) {
        const hit = matchOption(options, p);
        if (!hit) return { ok: false, message: `"${p.slice(0, 40)}" is not one of the options.` };
        if (!out.includes(hit.value)) out.push(hit.value);
      }
      if (qq.maxItems && out.length > qq.maxItems) return { ok: false, message: `Pick at most ${qq.maxItems}.` };
      return { ok: true, value: out.join(qq.joiner || ", ") };
    }
    case "number": {
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) return { ok: false, message: "Must be a non-negative number." };
      return { ok: true, value: String(n) };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, message: "Pick the day, month and year." };
      const [y, m, d] = v.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false, message: "That date does not exist." };
      if (qq.minAge != null || qq.maxAge != null) {
        const age = ageOn(v, today);
        if (qq.minAge != null && age < qq.minAge) return { ok: false, message: `You must be at least ${qq.minAge}.` };
        if (qq.maxAge != null && age > qq.maxAge) return { ok: false, message: "Check the year." };
      }
      return { ok: true, value: v };
    }
    default: {
      if (qq.key === "fields.phone") {
        const p = normalisePhone(v);
        return p ? { ok: true, value: p } : { ok: false, message: "Enter an Indian mobile number: +91 and 10 digits starting 6–9." };
      }
      if (ANGLE_RE.test(v)) return { ok: false, message: "Remove < and > characters." };
      if (qq.min && v.length < qq.min) return { ok: false, message: `At least ${qq.min} characters.` };
      if (qq.max && v.length > qq.max) return { ok: false, message: `At most ${qq.max} characters.` };
      if (qq.pattern && !new RegExp(qq.pattern, "u").test(v)) return { ok: false, message: qq.patternMsg || "Invalid format." };
      return { ok: true, value: v };
    }
  }
}

/** Is this question required given the other answers? */
export function isRequired(question, answers = {}) {
  if (question.requiredIf) {
    return String(answers[question.requiredIf.key] ?? "").toLowerCase() === String(question.requiredIf.equals).toLowerCase();
  }
  return !!question.required;
}

/** Validate a whole setup form -> { values: {key: canonical}, errors: {key: message} }. */
export function validateSetupAnswers(answers = {}, { today } = {}) {
  const values = {};
  const errors = {};
  for (const question of QUESTIONS) {
    const r = checkAnswer(question, answers[question.key], { today });
    if (!r.ok) { errors[question.key] = r.message; continue; }
    if (r.value) values[question.key] = r.value;
  }
  for (const question of QUESTIONS) {
    if (!errors[question.key] && !values[question.key] && isRequired(question, values)) errors[question.key] = "Required.";
  }
  return { values, errors };
}

// ── preferences ───────────────────────────────────────────────────────────
/** prefs -> { prefs, errors }. Titles 1..5 from the curated list, locations 1..10 from LOCATION_OPTIONS,
 *  min_score one of the three levels. Canonical casing is restored. */
export function validatePrefsInput(prefs = {}) {
  const errors = {};
  const out = { ...prefs };
  const pick = (field, list, max, label) => {
    const raw = prefs[field];
    if (raw === undefined) { errors[field] = `Choose at least one ${label}.`; return; }
    if (!Array.isArray(raw)) { errors[field] = `Must be a list of ${label}s.`; return; }
    const vals = [];
    for (const item of raw) {
      if (typeof item !== "string") { errors[field] = `Must be a list of ${label}s.`; return; }
      const hit = matchOption(list, cleanText(item));
      if (!hit) { errors[field] = `"${cleanText(item).slice(0, 40)}" is not in the ${label} list.`; return; }
      if (!vals.includes(hit.value)) vals.push(hit.value);
    }
    if (!vals.length) errors[field] = `Choose at least one ${label}.`;
    else if (vals.length > max) errors[field] = `Choose at most ${max} ${label}s.`;
    out[field] = vals;
  };
  pick("titles", TITLE_OPTIONS, MAX_TITLES, "job title");
  pick("locations", LOCATION_OPTIONS, MAX_LOCATIONS, "location");
  if (out.min_score === undefined) out.min_score = MIN_SCORE_DEFAULT;
  else if (!MIN_SCORE_LEVELS.some((l) => l.value === Number(out.min_score))) errors.min_score = "Choose Broad, Balanced or Strict.";
  else out.min_score = Number(out.min_score);
  return { prefs: out, errors };
}

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

// ── parsed resume (aa_profiles.profile) ────────────────────────────────────
/** Light checks on the reviewed resume draft. The worker fills "past experience" (title / company) and "skills"
 *  from it, so every experience entry needs both, and the client also requires at least one skill (`strict`). */
export function validateProfileDraft(p = {}, { strict = false } = {}) {
  const errors = {};
  const str = (v) => (v === null || v === undefined ? "" : typeof v === "string" || typeof v === "number" ? String(v) : null);
  for (const [k, v] of Object.entries(p)) {
    if (k === "skills" || k === "experience" || k === "education" || k === "languages") continue;
    const t = str(v);
    if (t !== null && t.length > 4000) errors[k] = "Too long.";
  }
  if (p.skills !== undefined) {
    const list = Array.isArray(p.skills) ? p.skills : null;
    if (!list) errors.skills = "Skills must be a list.";
    else if (list.length > 80) errors.skills = "At most 80 skills.";
    else if (list.some((x) => { const t = typeof x === "string" ? x : x && typeof x === "object" ? str(x.name) : null; return t === null || cleanText(t).length > 60; })) errors.skills = "Each skill is a short name (60 characters max).";
  }
  if (strict && !(Array.isArray(p.skills) && p.skills.some((x) => cleanText(typeof x === "string" ? x : x && x.name).length > 0))) errors.skills = "Add at least one skill.";
  if (p.experience !== undefined) {
    if (!Array.isArray(p.experience) || p.experience.length > 30) errors.experience = "Experience must be a list (30 entries max).";
    else {
      p.experience.forEach((e, i) => {
        if (!e || typeof e !== "object") { errors[`experience.${i}`] = "Invalid entry."; return; }
        for (const f of ["title", "company"]) {
          const t = cleanText(str(e[f]) ?? "");
          if (!t) errors[`experience.${i}.${f}`] = `Add the ${f === "title" ? "job title" : "company"}.`;
          else if (t.length > 120) errors[`experience.${i}.${f}`] = "At most 120 characters.";
        }
      });
    }
  }
  if (p.education !== undefined && (!Array.isArray(p.education) || p.education.length > 10)) errors.education = "Education must be a list (10 entries max).";
  return errors;
}
