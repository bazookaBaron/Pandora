/**
 * Worker broker (routes/workerBroker.js) against an in-memory db. Run: npm run test:autoapply
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createWorkerBroker, encryptDsn, decryptDsn, sha256Hex, hashEquals, loadBrokerKey } from "../routes/workerBroker.js";
import { encryptSecret, decryptSecret } from "../lib/autoapply/vault.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const BROKER_KEY_B64 = crypto.randomBytes(32).toString("base64");
const VAULT_KEY = crypto.randomBytes(32);
const KEY = loadBrokerKey(BROKER_KEY_B64);
const U1 = "eeeeeeee-0000-4000-8000-000000000001";
const tok = () => crypto.randomBytes(32).toString("base64url");
const vault = {
  encryptSecret: (p, u, h) => encryptSecret(p, u, h, { key: VAULT_KEY }),
  decryptSecret: (b, u, h) => decryptSecret(b, u, h, { key: VAULT_KEY }),
};

let db, server, base, logs;
const env = { AA_BROKER_KEY: BROKER_KEY_B64 };

function launchRow({ status = "starting", createdAgoMs = 60_000, used = false, token = tok(), id = crypto.randomUUID() } = {}) {
  const created = new Date(Date.now() - createdAgoMs);
  return {
    token,
    row: {
      id,
      worker_id: `vast-${id.replace(/-/g, "").slice(0, 8)}`,
      bootstrap_hash: sha256Hex(token),
      bootstrap_used_at: used ? new Date().toISOString() : null,
      worker_token_hash: sha256Hex(tok()),
      db_dsn_enc: encryptDsn(`postgresql://aa_worker.ref:pw-main@pooler:5432/postgres#${id}`, id, KEY),
      mail_dsn_enc: encryptDsn(`postgresql://aa_worker.ref:pw-mail@pooler:5432/postgres#${id}`, id, KEY),
      status,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 12 * 3600_000).toISOString(),
    },
  };
}

before(async () => {
  db = createFakeDb({});
  logs = [];
  const app = express();
  app.use("/w", createWorkerBroker({ db, env, vault, log: (l) => logs.push(l), limits: { bootstrapPer10Min: 1000, ipPerMin: 10000, launchPerMin: 10000 } }));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}/w`;
});
after(() => server && server.close());

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function bootstrapped(opts = {}) {
  const { token, row } = launchRow(opts);
  db.rows("aa_worker_launches").push(row);
  const r = await post("/bootstrap", { launch_id: row.id, token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { row, wt: r.body.worker_token, auth: { authorization: `Bearer ${r.body.worker_token}` }, res: r.body };
}

test("dsn crypto: round trip, AAD bound to the launch id, v1 format", () => {
  const id = crypto.randomUUID();
  const blob = encryptDsn("postgresql://x", id, KEY);
  assert.match(blob, /^v1:/);
  assert.equal(decryptDsn(blob, id, KEY), "postgresql://x");
  assert.throws(() => decryptDsn(blob, crypto.randomUUID(), KEY), (e) => e.code === "decrypt_failed");
  assert.throws(() => decryptDsn(blob.slice(3), id, KEY), (e) => e.code === "decrypt_failed");
  assert.equal(hashEquals(sha256Hex("a"), sha256Hex("a")), true);
  assert.equal(hashEquals(sha256Hex("a"), sha256Hex("b")), false);
  assert.equal(hashEquals("zz", sha256Hex("b")), false);
});

test("bootstrap: one-time, returns DSNs + worker token, sets running and a new token hash", async () => {
  const { row, res, wt } = await bootstrapped();
  assert.equal(res.worker_id, row.worker_id);
  assert.match(res.db_url, /pw-main/);
  assert.match(res.mail_db_url, /pw-mail/);
  assert.equal(res.expires_at, row.expires_at);
  const stored = db.rows("aa_worker_launches").find((r) => r.id === row.id);
  assert.equal(stored.status, "running");
  assert.ok(stored.bootstrap_used_at);
  assert.equal(stored.worker_token_hash, sha256Hex(wt));
  // logs never carry secrets
  const all = logs.join("\n");
  assert.ok(!all.includes("pw-main") && !all.includes(wt));
});

test("bootstrap rejects: reuse, wrong token, unknown launch, too old, not starting, bad input", async () => {
  const { token, row } = launchRow();
  db.rows("aa_worker_launches").push(row);
  assert.equal((await post("/bootstrap", { launch_id: row.id, token: tok() })).status, 401, "hash mismatch");
  assert.equal((await post("/bootstrap", { launch_id: row.id, token })).status, 200);
  assert.equal((await post("/bootstrap", { launch_id: row.id, token })).status, 401, "second use");
  assert.equal((await post("/bootstrap", { launch_id: crypto.randomUUID(), token })).status, 401, "unknown");
  const old = launchRow({ createdAgoMs: 21 * 60_000 });
  db.rows("aa_worker_launches").push(old.row);
  assert.equal((await post("/bootstrap", { launch_id: old.row.id, token: old.token })).status, 401, "older than 20 min");
  const stopped = launchRow({ status: "stopped" });
  db.rows("aa_worker_launches").push(stopped.row);
  assert.equal((await post("/bootstrap", { launch_id: stopped.row.id, token: stopped.token })).status, 401, "not starting");
  assert.equal((await post("/bootstrap", { launch_id: "x", token: "y" })).status, 401);
  assert.equal((await post("/bootstrap", "not json")).status, 400);
  assert.equal((await post("/bootstrap", { launch_id: row.id, token, pad: "x".repeat(20000) })).status, 413);
});

test("bearer auth: missing / wrong token / stopped / expired launch -> 401", async () => {
  const { row, auth } = await bootstrapped();
  assert.equal((await post("/heartbeat", { idle: true, active: 0 })).status, 401);
  assert.equal((await post("/heartbeat", { idle: true, active: 0 }, { authorization: `Bearer ${tok()}` })).status, 401);
  assert.deepEqual((await post("/heartbeat", { idle: false, active: 2 }, auth)).body, { ok: true, stop: false });
  const stored = db.rows("aa_worker_launches").find((r) => r.id === row.id);
  stored.status = "stopping";
  assert.deepEqual((await post("/heartbeat", { idle: true, active: 0 }, auth)).body, { ok: true, stop: true });
  stored.status = "stopped";
  assert.equal((await post("/heartbeat", { idle: true, active: 0 }, auth)).status, 401);
  stored.status = "running";
  stored.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await post("/heartbeat", { idle: true, active: 0 }, auth)).status, 401);
});

test("task-assets: only for this worker's in-flight task; signed resume + proof upload", async () => {
  const { row, auth } = await bootstrapped();
  const t = { id: crypto.randomUUID(), user_id: U1, tenant_host: "acme.myworkdayjobs.com", status: "running", claimed_by: `${row.worker_id}-2` };
  const other = { id: crypto.randomUUID(), user_id: U1, tenant_host: "acme.myworkdayjobs.com", status: "running", claimed_by: "vast-ffffffff-1" };
  const done = { ...t, id: crypto.randomUUID(), status: "applied" };
  db.rows("aa_tasks").push(t, other, done);
  db.rows("aa_profiles").push({ user_id: U1, resume_path: `${U1}/resume.pdf` });
  const r = await post("/task-assets", { task_id: t.id }, auth);
  assert.equal(r.status, 200);
  assert.equal(r.body.resume.filename, "resume.pdf");
  assert.match(r.body.resume.url, /aa-resumes/);
  assert.equal(r.body.proof.path, `${U1}/${t.id}.jpg`);
  assert.ok(r.body.proof.upload_url && r.body.proof.token);
  const sign = db.storage.calls.find((c) => c.op === "sign" && c.bucket === "aa-resumes");
  assert.equal(sign.expiresIn, 1800);
  assert.equal((await post("/task-assets", { task_id: other.id }, auth)).status, 403);
  assert.equal((await post("/task-assets", { task_id: done.id }, auth)).status, 403);
  assert.equal((await post("/task-assets", { task_id: "nope" }, auth)).status, 400);
});

test("portal-secret / portal-account: vault round trip scoped to task user + tenant", async () => {
  const { row, auth } = await bootstrapped();
  const host = "beta.greenhouse.io";
  const t = { id: crypto.randomUUID(), user_id: U1, tenant_host: host, status: "submitting", claimed_by: `${row.worker_id}-1` };
  db.rows("aa_tasks").push(t);
  assert.deepEqual((await post("/portal-secret", { task_id: t.id }, auth)).body, { none: true });
  assert.equal((await post("/portal-account", { task_id: t.id, login_email: "bad", password: "x" }, auth)).status, 400);
  assert.equal((await post("/portal-account", { task_id: t.id, login_email: "a@b.co", password: "s3cret!", status: "weird" }, auth)).status, 400);
  assert.deepEqual((await post("/portal-account", { task_id: t.id, login_email: "a@b.co", password: "s3cret!", status: "pending_verify" }, auth)).body, { ok: true });
  const acct = db.rows("aa_portal_accounts").find((a) => a.user_id === U1 && a.tenant_host === host);
  assert.ok(acct && acct.secret_ciphertext && !acct.secret_ciphertext.includes("s3cret"));
  assert.equal(acct.status, "pending_verify");
  assert.deepEqual((await post("/portal-secret", { task_id: t.id }, auth)).body, { login_email: "a@b.co", password: "s3cret!" });
  assert.ok(!logs.join("\n").includes("s3cret"));
});

test("rate limit: bootstrap per IP", async () => {
  const app = express();
  app.use("/w", createWorkerBroker({ db: createFakeDb({}), env, vault, log: () => {}, limits: { bootstrapPer10Min: 2 } }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/w/bootstrap`;
  const hit = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch_id: crypto.randomUUID(), token: tok() }) }).then((r) => r.status);
  assert.deepEqual([await hit(), await hit(), await hit()], [401, 401, 429]);
  srv.close();
});

test("unconfigured broker key -> 503 without leaking", async () => {
  const app = express();
  const d = createFakeDb({});
  const { token, row } = launchRow();
  d.rows("aa_worker_launches").push(row);
  app.use("/w", createWorkerBroker({ db: d, env: {}, vault, log: () => {} }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/w/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch_id: row.id, token }) });
  assert.equal(res.status, 503);
  assert.equal(d.rows("aa_worker_launches")[0].bootstrap_used_at, null, "token not burned");
  srv.close();
});
