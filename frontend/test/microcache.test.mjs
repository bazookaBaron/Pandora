import test from "node:test";
import assert from "node:assert/strict";
import { cached, invalidate, hasFresh } from "../lib/microCache.js";
import { emailMatchesCompany, _setDomainMap } from "../lib/companyVerify.js";
import { makeSemaphore } from "../lib/semaphore.js";

test("invalidate during an in-flight build prevents storing stale data", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const p = cached("gen:k", 60000, async () => { await gate; return "stale"; });
  invalidate("gen:");
  release();
  assert.equal(await p, "stale"); // the caller still gets its answer...
  assert.equal(hasFresh("gen:k"), false); // ...but it was not cached
});

test("LRU: a touched entry survives namespace eviction", async () => {
  for (let i = 0; i < 150; i++) await cached(`lru:${i}`, 60000, () => i);
  await cached("lru:0", 60000, () => "x"); // touch oldest
  await cached("lru:new", 60000, () => "n"); // forces one eviction
  assert.equal(hasFresh("lru:0"), true);
  assert.equal(hasFresh("lru:1"), false);
});

test("one namespace cannot evict another", async () => {
  await cached("keep:a", 60000, () => 1);
  for (let i = 0; i < 400; i++) await cached(`flood:${i}`, 60000, () => i);
  assert.equal(hasFresh("keep:a"), true);
});

test("semaphore: aborted waiter leaves the queue", async () => {
  const s = makeSemaphore(1);
  await s.acquire();
  const ac = new AbortController();
  const w = s.acquire({ signal: ac.signal });
  assert.equal(s.pending, 1);
  ac.abort();
  await assert.rejects(w);
  assert.equal(s.pending, 0);
  s.release();
  assert.equal(s.available, 1);
});

test("work-email domain matching", async () => {
  _setDomainMap({ Google: "google.com", Amazon: "amazon.com" });
  assert.equal((await emailMatchesCompany("a@google.com", "Google")).ok, true);
  assert.equal((await emailMatchesCompany("a@mail.google.com", "Google")).ok, true);
  assert.equal((await emailMatchesCompany("a@gmail.com", "Google")).ok, false);
  assert.equal((await emailMatchesCompany("a@evilgoogle.com", "Google")).ok, false);
  assert.equal((await emailMatchesCompany("a@acme.co.in", "Acme Pvt Ltd")).ok, true);
  assert.equal((await emailMatchesCompany("a@other.com", "Acme Inc")).ok, false);
  // No first-word matching: "Bank of America" must not accept @bank.com.
  assert.equal((await emailMatchesCompany("a@bank.com", "Bank of America")).ok, false);
  assert.equal((await emailMatchesCompany("a@bankofamerica.com", "Bank of America")).ok, true);
  assert.equal((await emailMatchesCompany("a@tata.com", "Tata Consultancy Services")).ok, false);
});

test("company verify secret fails closed in production", async () => {
  const { verifySecretConfigured, hashCode } = await import("../lib/companyVerify.js");
  const prev = { env: process.env.NODE_ENV, s: process.env.COMPANY_VERIFY_SECRET };
  const origErr = console.error;
  console.error = () => {};
  try {
    process.env.NODE_ENV = "production";
    delete process.env.COMPANY_VERIFY_SECRET;
    assert.equal(verifySecretConfigured(), false);
    assert.throws(() => hashCode("u", "123456"), /not configured/);
    process.env.COMPANY_VERIFY_SECRET = "x".repeat(32);
    assert.equal(verifySecretConfigured(), true);
    assert.match(hashCode("u", "123456"), /^[0-9a-f]{64}$/);
  } finally {
    console.error = origErr;
    if (prev.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.env;
    if (prev.s === undefined) delete process.env.COMPANY_VERIFY_SECRET; else process.env.COMPANY_VERIFY_SECRET = prev.s;
  }
});
