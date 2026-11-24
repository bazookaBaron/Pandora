/**
 * Needs-you, consolidated (owner): items accumulate silently while a batch works; once the batch's other work
 * is done (or it is blocked only on needs-you) the user gets ONE page with ONE form holding everything that was
 * missing across all the forms we could not submit.
 *
 *   readyItems({db, userId, now})       open items whose batch is ready (+ the still-accumulating count)
 *   buildForm(items, tasks, answers)    pure: -> { fields, sites, unconfirmed, profile }
 *   parseSubmission(form, body)         pure: validates a POST body against the form the server rebuilt
 *   applySubmission({db, userId, ...})  saves answers (aa_answers), resolves items, re-queues their tasks
 *   notifyReadyNeedsYou({db, send})     cron: at most ONE push per batch, when it becomes ready
 *
 * aa_batches.needs_you_notified_at = when the batch's needs-you first surfaced (the push, or the user opening
 * the page first). From then on its items show at once and no further push is sent.
 *
 * Field ids are aa_answers keys (standard `fields.*` / `facts.*` or learned `q.<16 hex>`), so the semantics
 * match PUT /answers. Questions are deduped by normalised label; date-of-birth parts ('Date of Birth - Day',
 * '... Month', '... Year') collapse into the one facts.date_of_birth field and every original question key also
 * gets its derived answer (the worker looks answers up by the item's payload.question_key).
 */
import { publicQuestions, LEARNED_KEY_RE, learnedKey, normaliseLabel, validateAnswer, isValidKey } from "./questions.js";
import { confirmSubmitted, isVerifyItem, notSubmitted } from "./verify.js";

const DAY_MS = 86400000;
// standard questions with their option lists expanded ({value, label}), from the shared setup schema
let STD = null;
const stdQuestion = (key) => {
  if (!STD) STD = new Map(publicQuestions().map((q) => [q.key, q]));
  return STD.get(key) || null;
};
/** An item this old is shown even while its batch still works (the scheduler expires items after 7 days). */
export const READY_AFTER_MS = 3 * DAY_MS;
const ACTIVE_TASK = ["shortlisted", "queued", "claimed", "running", "waiting_code", "submitting"];
const WORKING_BATCH = ["paid", "shortlisting", "review", "running"];
export const TEXT_MAX = 500;
export const TEXTAREA_MAX = 2000;
const MAX_FIELDS = 200;
const MAX_ITEMS = 500;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DOB_RE = /\b(date of birth|birth date|birthdate|dob|d o b|birthday)\b/;
const YES_NO_Q_RE = /^(are|do|did|have|has|will|would|can|could|is|were)\b/;
const LONG_RE = /\b(describe|explain|why|tell us|cover letter|summary|elaborate)\b/;
const SIMPLE_ALIASES = [
  [/^(first|given) name$/, "fields.first_name"],
  [/^(last|family) name$|^surname$/, "fields.last_name"],
  [/^(phone|mobile|phone number|mobile number|contact number|mobile phone)$/, "fields.phone"],
  [/^linkedin( profile)?( url| link)?$/, "fields.linkedin"],
  [/^github( profile)?( url| link)?$/, "fields.github"],
  [/^(website|portfolio|personal website|portfolio url|website url)$/, "fields.website"],
  [/^(current )?city$/, "fields.city"],
  [/^(postal code|pin code|pincode|zip|zip code|postcode)$/, "fields.postal_code"],
];

const optValue = (o) => (o && typeof o === "object" ? String(o.value ?? o.label ?? "") : String(o ?? ""));
const optLabel = (o) => (o && typeof o === "object" ? String(o.label ?? o.value ?? "") : String(o ?? ""));
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function dobPart(norm) {
  if (!DOB_RE.test(norm)) return null;
  if (/\b(day|dd|date of month)\s*$/.test(norm) || /\bday\b/.test(norm)) return "day";
  if (/\b(month|mm)\b/.test(norm)) return "month";
  if (/\b(year|yyyy|yy)\b/.test(norm)) return "year";
  return "full";
}

/** The canonical field a question label belongs to: { key, part } (part only for date-of-birth pieces). */
export function canonicalFor(label, options = []) {
  const norm = normaliseLabel(label);
  const part = dobPart(norm);
  if (part) return { key: "facts.date_of_birth", part };
  if (!options || !options.length) {
    for (const [re, key] of SIMPLE_ALIASES) if (re.test(norm)) return { key, part: null };
  }
  return { key: learnedKey(label), part: null };
}

/** The key the worker reads this item's answer from. */
export function itemKey(payload) {
  const p = payload || {};
  const k = typeof p.question_key === "string" && LEARNED_KEY_RE.test(p.question_key) ? p.question_key : null;
  return k || learnedKey(p.question || p.label || "");
}

const isYesNoSet = (opts) => opts.length > 0 && opts.every((o) => ["yes", "no"].includes(normaliseLabel(optValue(o))));

function controlFor(key, label, options) {
  const std = stdQuestion(key);
  if (std) {
    const options = Array.isArray(std.options) ? std.options.map((o) => ({ value: optValue(o), label: optLabel(o) })) : [];
    if (std.type === "select" && isYesNoSet(options)) return { type: "yesno", options };
    return { type: ["select", "multiselect", "yesno", "number", "date", "text"].includes(std.type) ? std.type : "text", options };
  }
  const norm = normaliseLabel(label);
  if (options.length) return { type: isYesNoSet(options) ? "yesno" : "select", options: options.map((o) => ({ value: optValue(o), label: optLabel(o) })) };
  if (YES_NO_Q_RE.test(norm)) return { type: "yesno", options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }] };
  if (/\bdate\b/.test(norm)) return { type: "date", options: [] };
  if (String(label).length > 90 || LONG_RE.test(norm)) return { type: "textarea", options: [] };
  return { type: "text", options: [] };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const siteLabel = (task, payload) => clip((task && task.ats) || hostOf((payload && payload.apply_url) || (task && task.apply_url)) || "this site", 80);
const siteId = (kind, site) => `${kind}:${String(site).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").slice(0, 80)}`;
const VERIFY_EMAIL_RE = /verif|confirm.*e-?mail|activat|e-?mail.*(code|link)/i;

/**
 * Pure. items: open aa_needs_you rows (ready ones); tasks: Map id -> {company, title, apply_url, ats, status};
 * answers: {key: value}. -> { fields, sites, unconfirmed, profile }
 */
export function buildForm(items, tasks = new Map(), answers = {}) {
  const fields = new Map();
  const sites = new Map();
  const unconfirmed = [];
  let profile = null;
  for (const it of items) {
    const p = it.payload || {};
    const task = (it.task_id && tasks.get(it.task_id)) || null;
    if (it.kind === "profile") {
      profile = profile || { item_id: it.id, batch_id: it.batch_id || p.batch_id || null, missing: Array.isArray(p.missing) ? p.missing : [] };
      continue;
    }
    if (isVerifyItem(it)) {
      unconfirmed.push({ item_id: it.id, company: (task && task.company) || null, title: (task && task.title) || null, apply_url: p.apply_url || (task && task.apply_url) || null, created_at: it.created_at });
      continue;
    }
    if (it.kind === "question") {
      const label = clip(p.question || p.label, 300);
      if (!label) continue;
      const opts = Array.isArray(p.options) ? p.options.filter((o) => optValue(o)).slice(0, 100) : [];
      const { key, part } = canonicalFor(label, opts);
      let f = fields.get(key);
      if (!f) {
        if (fields.size >= MAX_FIELDS) continue;
        const std = stdQuestion(key);
        const ctl = controlFor(key, label, part ? [] : opts);
        f = {
          id: key,
          key,
          label: std ? std.label.replace(/\s*\(optional\)$/i, "") : label,
          type: ctl.type,
          options: ctl.options,
          help: (std && std.help) || null,
          value: answers[key] ?? null,
          suggestion: p.suggestion ?? null,
          max_length: ctl.type === "textarea" ? TEXTAREA_MAX : TEXT_MAX,
          companies: [],
          sources: [],
          item_ids: [],
        };
        fields.set(key, f);
      } else if (!stdQuestion(key) && !part && f.type !== "text" && f.type !== "textarea") {
        // same question with more choices elsewhere: union of the options
        for (const o of opts) if (!f.options.some((x) => normaliseLabel(x.value) === normaliseLabel(optValue(o)))) f.options.push({ value: optValue(o), label: optLabel(o) });
      }
      f.item_ids.push(it.id);
      f.sources.push({ item_id: it.id, task_id: it.task_id || null, key: itemKey(p), part, options: opts.map(optValue) });
      const company = task && task.company;
      if (company && !f.companies.includes(company) && f.companies.length < 10) f.companies.push(company);
      if (f.suggestion == null && p.suggestion != null) f.suggestion = p.suggestion;
      continue;
    }
    // captcha / sso / account / other: one block per site
    const isAccount = it.kind === "account";
    const site = siteLabel(task, p);
    const verifyEmail = isAccount && VERIFY_EMAIL_RE.test(String(p.note || ""));
    const kind = isAccount ? (verifyEmail ? "verify_email" : "account") : "manual";
    const id = siteId(kind, site);
    let s = sites.get(id);
    if (!s) {
      s = {
        id,
        site,
        kind,
        title: kind === "verify_email" ? `Verify your account email on ${site}` : kind === "account" ? `Sign in to your account on ${site}` : `Apply yourself on ${site}`,
        note: clip(p.note, 300) || null,
        jobs: [],
      };
      sites.set(id, s);
    }
    s.jobs.push({ item_id: it.id, task_id: it.task_id || null, item_kind: it.kind, company: (task && task.company) || null, title: (task && task.title) || null, apply_url: p.apply_url || (task && task.apply_url) || null });
  }
  return { fields: [...fields.values()], sites: [...sites.values()], unconfirmed, profile };
}

/** Public shape (strips server-side bookkeeping). */
export function publicForm(form) {
  return {
    fields: form.fields.map(({ sources, item_ids, ...f }) => ({ ...f, count: item_ids.length })),
    sites: form.sites.map((s) => ({ ...s, jobs: s.jobs.map(({ task_id, ...j }) => j) })),
    unconfirmed: form.unconfirmed,
    profile: form.profile,
  };
}

function matchOption(value, options) {
  const want = normaliseLabel(value);
  if (!options.length) return value;
  const hit = options.find((o) => normaliseLabel(o) === want);
  return hit === undefined ? null : hit;
}

/** Value for one original question from the canonical answer (date-of-birth parts, option spelling). */
export function derivedAnswer(value, source) {
  const opts = source.options || [];
  if (source.part && source.part !== "full") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!m) return null;
    const [y, mo, d] = [m[1], Number(m[2]), Number(m[3])];
    if (source.part === "year") return opts.length ? matchOption(y, opts) : y;
    if (source.part === "day") {
      if (!opts.length) return String(d).padStart(2, "0");
      return opts.find((o) => Number(o) === d) ?? null;
    }
    const name = MONTHS[mo - 1];
    if (!opts.length) return String(mo).padStart(2, "0");
    return opts.find((o) => Number(o) === mo) ?? opts.find((o) => { const n = normaliseLabel(o); return n === name || n === name.slice(0, 3); }) ?? null;
  }
  if (!opts.length) return String(value);
  return matchOption(value, opts);
}

const bad = (message) => Object.assign(new Error(message), { status: 400, code: "invalid_input" });

/**
 * Pure. body: { answers: {fieldId: value}, sites: {siteId: 'done'}, manual: {itemId: 'applied'|'skip'},
 * unconfirmed: {itemId: 'yes'|'no'} }. Throws {status 400} on anything unknown / invalid / too long.
 * -> { answers: [{key, value}], derived: [{key, value}], answeredFields: Set, sites: [site], manual: [{item, how}],
 *      unconfirmed: [{item_id, yes}] }
 */
export function parseSubmission(form, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) throw bad("Send { answers, sites, manual, unconfirmed }.");
  const obj = (v, name) => {
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) throw bad(`${name} must be an object.`);
    if (Object.keys(v).length > MAX_ITEMS) throw bad(`Too many entries in ${name}.`);
    return v;
  };
  const answersIn = obj(b.answers, "answers");
  const sitesIn = obj(b.sites, "sites");
  const manualIn = obj(b.manual, "manual");
  const unconfIn = obj(b.unconfirmed, "unconfirmed");
  const byField = new Map(form.fields.map((f) => [f.id, f]));
  const answers = [];
  const derived = [];
  const answeredFields = new Set();
  for (const [id, raw] of Object.entries(answersIn)) {
    const f = byField.get(id);
    if (!f) throw bad(`Unknown field: ${clip(id, 60)}`);
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue; // left blank
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw bad(`${f.label}: answer must be text.`);
    const str = String(raw).trim();
    if (str.length > f.max_length) throw bad(`${f.label}: at most ${f.max_length} characters.`);
    if (!isValidKey(f.key)) throw bad(`Unknown field: ${clip(id, 60)}`);
    const v = validateAnswer(f.key, str);
    if (!v.ok) throw bad(v.message.replace(f.key, f.label));
    let value = v.value;
    if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad(`${f.label}: pick a date.`);
    if ((f.type === "select" || f.type === "yesno") && f.options.length && !stdQuestion(f.key)) {
      // learned question with choices: the answer must be one of the site's own options (stored in its spelling)
      const hit = f.options.find((o) => normaliseLabel(o.value) === normaliseLabel(value));
      if (!hit) throw bad(`${f.label}: choose one of the options.`);
      value = hit.value;
    }
    answers.push({ key: f.key, value });
    answeredFields.add(f.id);
    for (const s of f.sources) {
      if (s.key === f.key) continue;
      const d = derivedAnswer(value, s);
      if (d !== null && d !== undefined && String(d).length <= TEXTAREA_MAX) derived.push({ key: s.key, value: String(d) });
    }
  }
  const siteById = new Map(form.sites.map((s) => [s.id, s]));
  const sites = [];
  for (const [id, v] of Object.entries(sitesIn)) {
    const s = siteById.get(id);
    if (!s || s.kind === "manual") throw bad(`Unknown site block: ${clip(id, 60)}`);
    if (v === false || v === null || v === "") continue;
    if (v !== true && v !== "done") throw bad("sites values must be 'done'.");
    sites.push(s);
  }
  const manualItems = new Map(form.sites.filter((s) => s.kind === "manual").flatMap((s) => s.jobs.map((j) => [j.item_id, j])));
  const manual = [];
  for (const [id, v] of Object.entries(manualIn)) {
    const j = manualItems.get(id);
    if (!j) throw bad(`Unknown job: ${clip(id, 60)}`);
    if (v === null || v === "" || v === false) continue;
    if (!["applied", "skip"].includes(v)) throw bad("manual values must be 'applied' or 'skip'.");
    manual.push({ job: j, how: v });
  }
  const unconfIds = new Set(form.unconfirmed.map((u) => u.item_id));
  const unconfirmed = [];
  for (const [id, v] of Object.entries(unconfIn)) {
    if (!unconfIds.has(id)) throw bad(`Unknown application: ${clip(id, 60)}`);
    if (v === null || v === "") continue;
    if (!["yes", "no"].includes(v)) throw bad("unconfirmed values must be 'yes' or 'no'.");
    unconfirmed.push({ item_id: id, yes: v === "yes" });
  }
  return { answers, derived, answeredFields, sites, manual, unconfirmed };
}

async function countActive(db, batchId) {
  const { count, error } = await db.from("aa_tasks").select("id", { count: "exact", head: true }).eq("batch_id", batchId).in("status", ACTIVE_TASK);
  if (error) throw error;
  return count || 0;
}

/** Is this batch done with its other work (or blocked only on needs-you)? */
export async function batchReady(db, batch) {
  if (!batch) return true;
  if (!WORKING_BATCH.includes(batch.status)) return true;
  return (await countActive(db, batch.id)) === 0;
}

/**
 * Open items of a user, split into ready ones (shown) and the number still accumulating.
 * -> { items, tasks: Map, accumulating }
 */
export async function readyItems({ db, userId, now = new Date(), all = false, markSurfaced = true }) {
  const { data: items, error } = await db
    .from("aa_needs_you")
    .select("id, kind, payload, task_id, batch_id, created_at")
    .eq("user_id", userId)
    .is("resolved_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_ITEMS);
  if (error) throw error;
  const list = items || [];
  const ids = [...new Set(list.map((i) => i.task_id).filter(Boolean))];
  const tasks = new Map();
  if (ids.length) {
    const r = await db.from("aa_tasks").select("id, batch_id, company, title, apply_url, ats, status").in("id", ids);
    if (r.error) throw r.error;
    for (const t of r.data || []) tasks.set(t.id, t);
  }
  const batchOf = (i) => i.batch_id || (i.task_id && tasks.get(i.task_id) && tasks.get(i.task_id).batch_id) || (i.payload && i.payload.batch_id) || null;
  const batchIds = [...new Set(list.map(batchOf).filter(Boolean))];
  const ready = new Map();
  if (!all && batchIds.length) {
    const { data: batches, error: bErr } = await db.from("aa_batches").select("id, status, needs_you_notified_at").in("id", batchIds);
    if (bErr) throw bErr;
    const byId = new Map((batches || []).map((b) => [b.id, b]));
    // once a batch's needs-you surfaced (pushed, or shown here), it stays shown: re-queued retries make the
    // batch busy again, and the rest of the form must not disappear meanwhile
    const surface = [];
    for (const id of batchIds) {
      const b = byId.get(id);
      if (b && b.needs_you_notified_at) ready.set(id, true);
      else {
        const r = await batchReady(db, b);
        ready.set(id, r);
        if (r && b) surface.push(id);
      }
    }
    if (markSurfaced && surface.length) {
      const { error: sErr } = await db.from("aa_batches").update({ needs_you_notified_at: now.toISOString() }).in("id", surface).is("needs_you_notified_at", null);
      if (sErr) throw sErr;
    }
  }
  const old = now.getTime() - READY_AFTER_MS;
  const shown = [];
  let accumulating = 0;
  for (const i of list) {
    const b = batchOf(i);
    const isReady = all || i.kind === "profile" || !b || ready.get(b) !== false || Date.parse(i.created_at) <= old;
    if (isReady) shown.push({ ...i, batch_id: b });
    else accumulating++;
  }
  return { items: shown, tasks, accumulating };
}

async function resolveItems(db, userId, ids, resolution, now) {
  if (!ids.length) return 0;
  const { data, error } = await db
    .from("aa_needs_you")
    .update({ resolved_at: now.toISOString(), resolution })
    .eq("user_id", userId)
    .in("id", ids)
    .is("resolved_at", null)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

async function requeueTasks(db, userId, taskIds, now) {
  if (!taskIds.length) return 0;
  const { data, error } = await db
    .from("aa_tasks")
    .update({ status: "queued", not_before: now.toISOString(), reason_code: null, reason_detail: null })
    .eq("user_id", userId)
    .in("id", taskIds)
    .eq("status", "needs_you")
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

/**
 * Save a parsed submission. Order: answers first (idempotent upserts), then task moves, then the items'
 * resolved flags last, so a failure midway leaves the items open and the same request can be retried.
 * A task is re-queued only when ALL of its open question items are answered (answers in aa_answers after this
 * save, under the item's own key or its canonical field).
 */
export async function applySubmission({ db, userId, form, parsed, items, now = new Date() }) {
  const at = now.toISOString();
  const rows = new Map();
  for (const a of [...parsed.derived, ...parsed.answers]) rows.set(a.key, { user_id: userId, question_key: a.key, answer: a.value, source: "user", updated_at: at });
  if (rows.size) {
    const { error } = await db.from("aa_answers").upsert([...rows.values()], { onConflict: "user_id,question_key" });
    if (error) throw error;
  }
  const { data: saved, error: sErr } = await db.from("aa_answers").select("question_key").eq("user_id", userId);
  if (sErr) throw sErr;
  const have = new Set((saved || []).map((r) => r.question_key));

  const out = { answers_saved: rows.size, requeued: 0, resolved: 0, confirmed: 0, not_submitted: 0, applied_by_user: 0, skipped: 0 };

  // questions: per task, every open question item must be answered
  const fieldOfItem = new Map();
  for (const f of form.fields) for (const s of f.sources) fieldOfItem.set(s.item_id, { f, s });
  const qByTask = new Map();
  for (const it of items) {
    if (it.kind !== "question" || !it.task_id || !fieldOfItem.has(it.id)) continue;
    if (!qByTask.has(it.task_id)) qByTask.set(it.task_id, []);
    qByTask.get(it.task_id).push(it.id);
  }
  const answeredItems = [];
  const readyTasks = [];
  for (const [taskId, ids] of qByTask) {
    const ok = ids.every((id) => {
      const { f, s } = fieldOfItem.get(id);
      return have.has(s.key) || have.has(f.key);
    });
    if (ok) {
      readyTasks.push(taskId);
      answeredItems.push(...ids);
    }
  }
  out.requeued += await requeueTasks(db, userId, readyTasks, now);

  // account / verify-email sites marked done: retry their applications
  const siteItems = parsed.sites.flatMap((s) => s.jobs);
  out.requeued += await requeueTasks(db, userId, siteItems.map((j) => j.task_id).filter(Boolean), now);

  // manual sites: 'applied' = the user applied themselves (no credit), 'skip' = leave this job
  const manualByHow = { applied: [], skip: [] };
  for (const m of parsed.manual) manualByHow[m.how].push(m.job);
  for (const how of ["applied", "skip"]) {
    const ids = manualByHow[how].map((j) => j.task_id).filter(Boolean);
    if (!ids.length) continue;
    const { data, error } = await db
      .from("aa_tasks")
      .update({ status: "skipped", reason_code: how === "applied" ? "done_by_user" : "dismissed" })
      .eq("user_id", userId)
      .in("id", ids)
      .eq("status", "needs_you")
      .select("id");
    if (error) throw error;
    out[how === "applied" ? "applied_by_user" : "skipped"] += (data || []).length;
  }

  // "did it go through?": yes -> applied (one credit), no -> retried while credits are left
  const itemById = new Map(items.map((i) => [i.id, i]));
  const unconfDone = [];
  for (const u of parsed.unconfirmed) {
    const it = itemById.get(u.item_id);
    if (!it || !it.task_id) continue;
    if (u.yes) {
      const r = await confirmSubmitted({ db, taskId: it.task_id, userId, now });
      if (!r.ok && r.error !== "invalid_state") continue;
      out.confirmed++;
    } else {
      const r = await notSubmitted({ db, taskId: it.task_id, userId, now });
      if (!r.ok) continue;
      out.not_submitted++;
    }
    unconfDone.push(u);
  }

  out.resolved += await resolveItems(db, userId, answeredItems, "answered", now);
  out.resolved += await resolveItems(db, userId, siteItems.map((j) => j.item_id), "done_by_user", now);
  out.resolved += await resolveItems(db, userId, manualByHow.applied.map((j) => j.item_id), "done_by_user", now);
  out.resolved += await resolveItems(db, userId, manualByHow.skip.map((j) => j.item_id), "dismissed", now);
  out.resolved += await resolveItems(db, userId, unconfDone.filter((u) => u.yes).map((u) => u.item_id), "done_by_user", now);
  out.resolved += await resolveItems(db, userId, unconfDone.filter((u) => !u.yes).map((u) => u.item_id), "dismissed", now);
  return out;
}

export function readyPushPayload(n) {
  return {
    title: "A few details needed",
    body: `${n} application${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a few details from you. It is one short form.`,
    url: "/autoapply/needs-you",
    tag: "aa-needs-you",
  };
}

/**
 * Cron: for each batch with open (non-profile) needs-you items that just became ready and was never notified,
 * claim aa_batches.needs_you_notified_at (conditional update, multi-replica safe) and send ONE push.
 */
export async function notifyReadyNeedsYou({ db, send, now = new Date(), limit = 1000 }) {
  const { data: items, error } = await db
    .from("aa_needs_you")
    .select("id, user_id, kind, task_id, batch_id, created_at")
    .is("resolved_at", null)
    .neq("kind", "profile")
    .limit(limit);
  if (error) throw error;
  const list = items || [];
  const missingBatch = [...new Set(list.filter((i) => !i.batch_id && i.task_id).map((i) => i.task_id))];
  const taskBatch = new Map();
  if (missingBatch.length) {
    const { data: ts, error: tErr } = await db.from("aa_tasks").select("id, batch_id").in("id", missingBatch);
    if (tErr) throw tErr;
    for (const t of ts || []) taskBatch.set(t.id, t.batch_id);
  }
  const byBatch = new Map();
  for (const i of list) {
    const b = i.batch_id || taskBatch.get(i.task_id);
    if (!b) continue;
    if (!byBatch.has(b)) byBatch.set(b, { user_id: i.user_id, n: 0, oldest: i.created_at });
    const g = byBatch.get(b);
    g.n++;
    if (i.created_at < g.oldest) g.oldest = i.created_at;
  }
  if (!byBatch.size) return { checked: 0, sent: 0 };
  const { data: batches, error: bErr } = await db.from("aa_batches").select("id, status, needs_you_notified_at").in("id", [...byBatch.keys()]);
  if (bErr) throw bErr;
  let sent = 0;
  for (const b of batches || []) {
    if (b.needs_you_notified_at) continue;
    const g = byBatch.get(b.id);
    const ready = (await batchReady(db, b)) || Date.parse(g.oldest) <= now.getTime() - READY_AFTER_MS;
    if (!ready) continue;
    const { data: won, error: uErr } = await db
      .from("aa_batches")
      .update({ needs_you_notified_at: now.toISOString() })
      .eq("id", b.id)
      .is("needs_you_notified_at", null)
      .select("id");
    if (uErr) throw uErr;
    if (!won || !won[0]) continue;
    const { data: prof } = await db.from("aa_profiles").select("alert_prefs").eq("user_id", g.user_id).maybeSingle();
    const prefs = prof && prof.alert_prefs && typeof prof.alert_prefs === "object" ? prof.alert_prefs : {};
    await send({ db, userId: g.user_id, payload: readyPushPayload(g.n), prefs: { push: prefs.push !== false } });
    sent++;
  }
  return { checked: byBatch.size, sent };
}

/** Batch states after which nothing is applied any more. */
export const FINAL_BATCH = ["completed", "expired", "cancelled", "refunded"];

/**
 * Cron hygiene: once a batch is final, its open needs-you items (every kind except 'profile' and the
 * "did it go through?" verify items, which still decide a credit) -> resolution 'expired', and their needs_you
 * tasks -> 'skipped' (reason needs_you_expired). Items are matched by batch_id, or through their task's batch
 * when batch_id is NULL (the worker inserts rows without it).
 */
export async function expireFinalBatchNeedsYou({ db, now = new Date(), limit = 2000 }) {
  const { data: items, error } = await db
    .from("aa_needs_you")
    .select("id, user_id, kind, payload, task_id, batch_id")
    .is("resolved_at", null)
    .neq("kind", "profile")
    .limit(limit);
  if (error) throw error;
  const list = (items || []).filter((i) => !isVerifyItem(i));
  if (!list.length) return { items: 0, tasks: 0 };
  const taskIds = [...new Set(list.map((i) => i.task_id).filter(Boolean))];
  const taskById = new Map();
  for (let k = 0; k < taskIds.length; k += 200) {
    const { data: ts, error: tErr } = await db.from("aa_tasks").select("id, user_id, batch_id, status, reason_code").in("id", taskIds.slice(k, k + 200));
    if (tErr) throw tErr;
    for (const t of ts || []) taskById.set(t.id, t);
  }
  const batchOf = (i) => {
    if (i.batch_id) return i.batch_id;
    const t = i.task_id && taskById.get(i.task_id);
    return t && t.user_id === i.user_id ? t.batch_id : null; // same user only
  };
  const batchIds = [...new Set(list.map(batchOf).filter(Boolean))];
  if (!batchIds.length) return { items: 0, tasks: 0 };
  const { data: batches, error: bErr } = await db.from("aa_batches").select("id, status").in("id", batchIds).in("status", FINAL_BATCH);
  if (bErr) throw bErr;
  const final = new Set((batches || []).map((b) => b.id));
  const hit = list.filter((i) => final.has(batchOf(i)));
  if (!hit.length) return { items: 0, tasks: 0 };
  const tIds = [...new Set(hit.map((i) => i.task_id).filter(Boolean))].filter((id) => {
    const t = taskById.get(id);
    return t && t.status === "needs_you" && t.reason_code !== "verify_submission";
  });
  let tasks = 0;
  if (tIds.length) {
    const { data: up, error: uErr } = await db
      .from("aa_tasks")
      .update({ status: "skipped", reason_code: "needs_you_expired" })
      .in("id", tIds)
      .eq("status", "needs_you")
      .select("id");
    if (uErr) throw uErr;
    tasks = (up || []).length;
  }
  const { data: res, error: rErr } = await db
    .from("aa_needs_you")
    .update({ resolved_at: now.toISOString(), resolution: "expired" })
    .in("id", hit.map((i) => i.id))
    .is("resolved_at", null)
    .select("id");
  if (rErr) throw rErr;
  return { items: (res || []).length, tasks };
}
