/**
 * Daily job-market snapshot from Adzuna's free API (Jobs -> Analytics tab).
 * Runs ONLY from the daily cron / admin trigger, never from a user request.
 *
 * Call budget per country (results_per_page=1, we read `count`):
 *   total 1 + new-7d 1 + roles 20 + experience 4 + work-mode 2 + cities 6 + contract 1 = 35
 *   x 2 countries (IN, US) = 70 calls/day, spaced >= 3 s (~3.7 min), 429 -> backoff retries
 *   (retries are failure-only and capped by maxCallsPerCountry).
 * Optional extras (extras=true): new-1d + full_time = +2 per country.
 */
export const MARKET_CONFIG = {
  countries: { IN: "in", US: "us" },
  spacingMs: 3100,
  maxCallsPerCountry: 40, // hard stop incl. retries
  backoffMs: [5000, 15000, 45000],
  roles: {
    software_engineering: ["software engineer", "software developer", "backend developer", "full stack", "frontend developer"],
    data_science_ml: { and: ["machine", "learning"] }, // both words required; bare "ml"/"ai" are too broad
    data_analyst: ["data analyst", "analytics", "bi developer", "business intelligence"],
    devops_cloud: ["devops", "cloud engineer", "sre", "site reliability", "platform engineer"],
    qa_testing: ["qa engineer", "test engineer", "sdet", "quality assurance", "automation tester"],
    cyber_security: ["security engineer", "cyber security", "information security", "soc analyst"],
    product_management: ["product manager", "product owner", "product management"],
    project_program_management: ["project manager", "program manager", "scrum master", "delivery manager"],
    business_analyst: ["business analyst", "functional analyst", "systems analyst"],
    sap_erp: { and: ["erp"], or: ["sap", "oracle", "netsuite", "dynamics", "workday"] }, // ERP postings naming a vendor
    ui_ux_design: ["ux designer", "ui designer", "product designer", "ui/ux", "graphic designer"],
    marketing: ["marketing", "seo", "digital marketing", "brand manager", "growth marketing"],
    sales_bd: { and: ["sales"], or: ["executive", "representative", "manager", "associate", "engineer"] }, // "sales" alone matches everything
    finance_accounting: ["accountant", "finance", "accounting", "financial analyst", "auditor"],
    hr_recruiting: ["recruiter", "talent acquisition", "human resources", "hr manager", "hr business partner"],
    operations_supply_chain: ["operations manager", "supply chain", "logistics", "procurement", "operations analyst"],
    customer_success_support: ["customer success", "customer support", "customer service", "support engineer"],
    consulting: ["consultant", "consulting", "advisory"],
    legal_compliance: ["legal", "compliance", "paralegal", "counsel", "risk analyst"],
    content_communications: ["content writer", "copywriter", "communications", "technical writer", "editor"],
  },
  experience: {
    entry: ["intern", "junior", "graduate", "fresher", "trainee", "associate"],
    mid: ["mid", "intermediate", "ii"],
    senior: ["senior", "sr", "lead"],
    leadership: ["manager", "head", "director", "principal"],
  },
  cities: {
    IN: { Bengaluru: "Bengaluru", Hyderabad: "Hyderabad", Pune: "Pune", Mumbai: "Mumbai", "Delhi NCR": "Gurugram", Chennai: "Chennai" },
    US: { "New York": "New York", "SF Bay Area": "San Francisco", Seattle: "Seattle", Austin: "Austin", Boston: "Boston", Chicago: "Chicago" },
  },
};

const BASE = "https://api.adzuna.com/v1/api/jobs";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** IST calendar date (YYYY-MM-DD) for a Date. */
export function istDate(d = new Date()) {
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

/** Rate-limited, retrying Adzuna client. search() -> {count, mean} or null on persistent failure. */
export function makeAdzunaClient({ appId, appKey, fetchImpl = globalThis.fetch, sleep = defaultSleep, config = MARKET_CONFIG, maxCalls = config.maxCallsPerCountry }) {
  const state = { calls: 0, lastAt: 0 };
  async function search(cc, params) {
    const qs = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: "1", "content-type": "application/json" });
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    const url = `${BASE}/${cc}/search/1?${qs}`;
    for (let attempt = 0; attempt <= config.backoffMs.length; attempt++) {
      if (state.calls >= maxCalls) return null;
      const wait = state.lastAt ? config.spacingMs - (Date.now() - state.lastAt) : 0;
      if (wait > 0) await sleep(wait);
      state.calls++;
      state.lastAt = Date.now();
      let res;
      try { res = await fetchImpl(url); } catch { res = null; }
      if (res && res.ok) {
        const j = await res.json();
        const count = Number(j && j.count);
        if (!Number.isFinite(count)) return null;
        const mean = Number(j.mean);
        return { count, mean: Number.isFinite(mean) && mean > 0 ? Math.round(mean) : null };
      }
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (retryable && attempt < config.backoffMs.length) { await sleep(config.backoffMs[attempt]); continue; }
      return null;
    }
    return null;
  }
  return { search, get calls() { return state.calls; } };
}

/**
 * Build one country's snapshot. Throws if the headline total can't be fetched
 * (nothing useful to store); individual failed sub-queries become null.
 */
export async function buildSnapshot(country, { appId, appKey, fetchImpl, sleep, config = MARKET_CONFIG, extras = false, now = new Date() } = {}) {
  const cc = config.countries[country];
  if (!cc) throw new Error(`unknown country ${country}`);
  const api = makeAdzunaClient({ appId, appKey, fetchImpl, sleep, config });
  const c = async (p) => { const r = await api.search(cc, p); return r ? r.count : null; };
  // Family keywords: an array -> what_or (any word); an object -> {and, or, phrase}
  // mapped to Adzuna's what_and / what_or / what_phrase. Still ONE call per family.
  const orOf = (kw) => {
    if (Array.isArray(kw)) return { what_or: kw.join(" ") };
    const p = {};
    if (kw.and) p.what_and = kw.and.join(" ");
    if (kw.or) p.what_or = kw.or.join(" ");
    if (kw.phrase) p.what_phrase = kw.phrase;
    return p;
  };

  const totalRes = await api.search(cc, {});
  if (!totalRes) throw new Error(`adzuna total failed for ${country}`);
  const data = {
    total: totalRes.count,
    mean_salary: totalRes.mean,
    new_7d: await c({ max_days_old: 7 }),
    roles: {}, experience: {}, work_mode: {}, cities: {},
    contract: await c({ contract: 1 }),
  };
  if (extras) {
    data.new_1d = await c({ max_days_old: 1 });
    data.full_time = await c({ full_time: 1 });
  }
  for (const [k, kw] of Object.entries(config.roles)) data.roles[k] = await c(orOf(kw));
  for (const [k, kw] of Object.entries(config.experience)) data.experience[k] = await c(orOf(kw));
  data.work_mode.remote = await c({ what: "remote" });
  data.work_mode.hybrid = await c({ what: "hybrid" });
  for (const [label, where] of Object.entries(config.cities[country])) data.cities[label] = await c({ where });
  data.generated_at = now.toISOString();
  data.api_calls = api.calls;
  return data;
}

/**
 * Daily runner with an in-DB guard. The (country, taken_on) row is inserted as
 * a {pending:true} claim first, so concurrent instances / restarts skip it. A
 * claim older than 1 h is treated as crashed and retaken. No-ops without keys.
 */
const FAILED_RETRY_MS = 6 * 3600000;
export async function runMarketSnapshots({ supabase, env = process.env, fetchImpl, sleep, now = new Date(), log = console, extras = false, force = false } = {}) {
  const appId = env.ADZUNA_APP_ID, appKey = env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return { skipped: "no_adzuna_keys" };
  const day = istDate(now);
  const out = {};
  for (const country of Object.keys(MARKET_CONFIG.countries)) {
    try {
      const { data: ex } = await supabase.from("market_snapshots").select("id,data,created_at").eq("country", country).eq("taken_on", day).maybeSingle();
      if (ex) {
        const age = Date.now() - new Date(ex.created_at).getTime();
        // A failed-day marker blocks retries for FAILED_RETRY_MS (deploy catch-ups
        // must not hammer a failing Adzuna); `force` (admin) bypasses it.
        if (ex.data && ex.data.failed && !force) {
          const at = Date.parse(ex.data.at || "") || new Date(ex.created_at).getTime();
          if (Date.now() - at < FAILED_RETRY_MS) { out[country] = "failed_recently"; continue; }
        }
        const stale = ex.data && ((ex.data.pending && age > 3600000) || ex.data.failed);
        if (!stale) { out[country] = "exists"; continue; }
        await supabase.from("market_snapshots").delete().eq("id", ex.id);
      }
      const claim = await supabase.from("market_snapshots").insert({ country, taken_on: day, data: { pending: true } });
      if (claim.error) { out[country] = "claimed_elsewhere"; continue; }
      try {
        const data = await buildSnapshot(country, { appId, appKey, fetchImpl, sleep, extras, now });
        const up = await supabase.from("market_snapshots").update({ data }).eq("country", country).eq("taken_on", day);
        if (up.error) throw up.error;
        out[country] = `ok:${data.api_calls}`;
      } catch (e) {
        // Keep the claim row as a failure marker (readers ignore it) instead of deleting it.
        await supabase.from("market_snapshots").update({ data: { failed: true, at: new Date().toISOString() } }).eq("country", country).eq("taken_on", day);
        throw e;
      }
    } catch (e) {
      out[country] = "error";
      log.error("[market] snapshot failed", country, (e && e.message) || e);
    }
  }
  return out;
}

/** Latest finished snapshot + up to 30 days of totals for a country. */
export async function loadMarketAnalytics(supabase, country) {
  const { data, error } = await supabase.from("market_snapshots").select("taken_on,data")
    .eq("country", country).order("taken_on", { ascending: false }).limit(40);
  if (error) {
    if (/does not exist|schema cache|PGRST/i.test(String(error.message || error))) return { ready: false, country };
    throw error;
  }
  const rows = (data || []).filter((r) => r.data && !r.data.pending && !r.data.failed && Number.isFinite(r.data.total));
  if (!rows.length) return { ready: false, country };
  const trend = rows.slice(0, 30).reverse().map((r) => ({ date: r.taken_on, total: r.data.total, new_7d: r.data.new_7d ?? null }));
  return { ready: true, country, date: rows[0].taken_on, snapshot: rows[0].data, trend };
}
