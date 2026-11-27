/**
 * Tiny in-memory stand-in for the supabase-js service-role client, covering
 * only the query-builder surface the AutoApply code uses. Never networked.
 */
import crypto from "node:crypto";

const UNIQUE = {
  aa_profiles: [["user_id"], ["apply_alias"]],
  aa_answers: [["user_id", "question_key"]],
  aa_batches: [["id"], ["razorpay_order_id"], ["razorpay_payment_id"]],
  aa_credit_ledger: [["id"], { cols: ["batch_id"], where: (r) => r.reason === "purchase" }, { cols: ["task_id"], where: (r) => r.reason === "capture" }],
  aa_tasks: [["id"]],
  aa_mail_events: [["id"], ["dedupe_key"]],
  aa_health: [["component"]],
  aa_interviews: [["id"], ["mail_event_id"]],
  aa_push_subscriptions: [["id"], ["endpoint"]],
  aa_needs_you: [["id"]],
  aa_portal_accounts: [["user_id", "tenant_host"]],
  aa_worker_launches: [["id"], ["worker_id"]],
  processed_payments: [["payment_id"], ["order_id"]],
};

const DEFAULTS = {
  aa_profiles: () => ({ profile: {}, prefs: {}, email_mode: "inbox", review_before_apply: true, onboarding_done: false, apply_alias: null, contact_email: null, consent_at: null, resume_path: null }),
  aa_batches: () => ({ id: crypto.randomUUID(), status: "pending_payment", credits_used: 0, currency: "INR", purchased_at: null, razorpay_order_id: null, razorpay_payment_id: null, review_until: null }),
  aa_tasks: () => ({ id: crypto.randomUUID(), status: "shortlisted", attempt: 0, score: 0 }),
  aa_needs_you: () => ({ id: crypto.randomUUID(), resolved_at: null, resolution: null, payload: {} }),
  aa_answers: () => ({ source: "user" }),
};

let seq = 1;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function createFakeDb(seed = {}) {
  const tables = {};
  const rpcCalls = [];
  const storage = [];
  const t = (name) => (tables[name] ||= []);

  function violates(table, row, ignore) {
    for (const u of UNIQUE[table] || []) {
      const cols = Array.isArray(u) ? u : u.cols;
      const where = Array.isArray(u) ? null : u.where;
      if (where && !where(row)) continue;
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = t(table).find((r) => r !== ignore && (!where || where(r)) && cols.every((c) => r[c] === row[c]));
      if (clash) return { code: "23505", message: `duplicate key value violates unique constraint (${cols.join(",")})` };
    }
    return null;
  }

  function withDefaults(table, row) {
    const base = DEFAULTS[table] ? DEFAULTS[table]() : {};
    const r = { ...base, ...clone(row) };
    if (!("id" in r) && ["aa_credit_ledger", "aa_mail_events", "aa_push_subscriptions", "aa_interviews"].includes(table)) r.id = seq++;
    const nowIso = new Date().toISOString();
    r.created_at ??= nowIso;
    r.updated_at ??= nowIso;
    if (table === "aa_mail_events") r.received_at ??= nowIso;
    return r;
  }

  function builder(table) {
    const filters = [];
    let op = "select";
    let payload = null;
    let opts = {};
    let wantRows = false;
    let countMode = null;
    let head = false;
    let orderBy = null;
    let lim = null;
    let off = 0;
    const orders = [];
    let single = null;
    let cols = null;

    const match = (r) => filters.every((f) => f(r));
    const b = {
      select(c, o = {}) {
        if (c && c !== "*") cols = String(c).split(",").map((x) => x.trim()).filter(Boolean);
        if (op === "select") {
          countMode = o.count || null;
          head = !!o.head;
        } else wantRows = true;
        return b;
      },
      insert(rows) { op = "insert"; payload = rows; return b; },
      update(patch) { op = "update"; payload = patch; return b; },
      upsert(rows, o = {}) { op = "upsert"; payload = rows; opts = o; return b; },
      delete() { op = "delete"; return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      or(expr) {
        const conds = String(expr).split(",").map((part) => {
          const [c, op, ...rest] = part.split(".");
          const v = rest.join(".");
          if (op === "ilike") {
            const re = new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m).replace(/%/g, ".*") + "$", "i");
            return (r) => re.test(String(r[c] ?? ""));
          }
          if (op === "eq") return (r) => String(r[c]) === v;
          throw new Error("fake or(): unsupported " + part);
        });
        filters.push((r) => conds.some((fn) => fn(r)));
        return b;
      },
      ilike(c, pat) {
        const re = new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m).replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
        filters.push((r) => re.test(String(r[c] ?? "")));
        return b;
      },
      not(c, o, v) {
        if (o === "is" && v === null) filters.push((r) => r[c] !== null && r[c] !== undefined);
        else if (o === "eq") filters.push((r) => r[c] !== v);
        else throw new Error("fake not(): unsupported " + o);
        return b;
      },
      neq(c, v) { filters.push((r) => r[c] !== v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b; },
      gte(c, v) { filters.push((r) => r[c] != null && r[c] >= v); return b; },
      gt(c, v) { filters.push((r) => r[c] != null && r[c] > v); return b; },
      lte(c, v) { filters.push((r) => r[c] != null && r[c] <= v); return b; },
      lt(c, v) { filters.push((r) => r[c] != null && r[c] < v); return b; },
      order(c, o = {}) { orderBy = { c, asc: o.ascending !== false }; orders.push(orderBy); return b; },
      limit(n) { lim = n; return b; },
      range(from, to) { off = from; lim = to - from + 1; return b; },
      maybeSingle() { single = "maybe"; return b; },
      single() { single = "one"; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };

    function finish(rows) {
      let out = rows.map((r) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k]])) : r)).map(clone);
      if (single) {
        if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        if (!out.length) return single === "one" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
        return { data: out[0], error: null };
      }
      return { data: out, error: null };
    }

    function run() {
      const rows = t(table);
      if (op === "select") {
        let out = rows.filter(match);
        if (orders.length) out = [...out].sort((a, z) => { for (const o of orders) { const d = (a[o.c] > z[o.c] ? 1 : a[o.c] < z[o.c] ? -1 : 0) * (o.asc ? 1 : -1); if (d) return d; } return 0; });
        if (lim != null) out = out.slice(off, off + lim);
        if (countMode) return { data: head ? null : finish(out).data, count: out.length, error: null };
        return finish(out);
      }
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const made = [];
        for (const raw of list) {
          const r = withDefaults(table, raw);
          const v = violates(table, r);
          if (v) return { data: null, error: v };
          rows.push(r);
          made.push(r);
        }
        return wantRows || single ? finish(made) : { data: null, error: null };
      }
      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) {
          const next = { ...r, ...clone(payload), updated_at: new Date().toISOString() };
          const v = violates(table, next, r);
          if (v) return { data: null, error: v };
          Object.assign(r, next);
        }
        return wantRows || single ? finish(hit) : { data: null, error: null };
      }
      if (op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const keys = String(opts.onConflict || "id").split(",").map((s) => s.trim());
        const made = [];
        for (const raw of list) {
          const existing = rows.find((r) => keys.every((k) => r[k] === raw[k]));
          if (existing && opts.ignoreDuplicates) continue; // ON CONFLICT DO NOTHING: no row returned
          if (existing) {
            const next = { ...existing, ...clone(raw) };
            const v = violates(table, next, existing);
            if (v) return { data: null, error: v };
            Object.assign(existing, next);
            made.push(existing);
          } else {
            const r = withDefaults(table, raw);
            const v = violates(table, r);
            if (v) return { data: null, error: v };
            rows.push(r);
            made.push(r);
          }
        }
        return wantRows || single ? finish(made) : { data: null, error: null };
      }
      if (op === "delete") {
        const keep = rows.filter((r) => !match(r));
        const n = rows.length - keep.length;
        tables[table] = keep;
        return { data: null, error: null, count: n };
      }
      return { data: null, error: { message: "unsupported" } };
    }
    return b;
  }

  for (const [k, v] of Object.entries(seed)) for (const r of v) t(k).push(withDefaults(k, r));

  return {
    tables,
    rpcCalls,
    from: builder,
    rows: (name) => t(name),
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
    storage: {
      calls: storage,
      from(bucket) {
        return {
          async upload(p, buf, o) { storage.push({ op: "upload", bucket, path: p, size: buf.length, o }); return { data: { path: p }, error: null }; },
          async remove(paths) { storage.push({ op: "remove", bucket, paths }); return { data: [], error: null }; },
          async createSignedUploadUrl(p, o) {
            storage.push({ op: "sign_upload", bucket, path: p, o });
            return { data: { signedUrl: `https://storage.test/upload/${bucket}/${p}?token=up`, token: "up", path: p }, error: null };
          },
          async createSignedUrl(p, expiresIn) {
            storage.push({ op: "sign", bucket, path: p, expiresIn });
            return { data: { signedUrl: `https://storage.test/${bucket}/${p}?token=signed&expires=${expiresIn}` }, error: null };
          },
        };
      },
    },
  };
}
