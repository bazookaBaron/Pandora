import test from "node:test";
import assert from "node:assert/strict";
import { spaceByCompany, feedWindow } from "../lib/jobsFeed.js";

const GAP = 8, POOL = 60;
// deterministic DB: 300 rows, 12 companies; pool region bunched in blocks of 5 (first crawl), later rows in pairs
const DB = Array.from({ length: 300 }, (_, i) => ({ id: i, company_slug: "c" + (i < POOL ? Math.floor(i / 5) % 12 : Math.floor(i / 2) % 12) }));
const spaced = spaceByCompany(DB.slice(0, POOL), GAP, true);
const fetchDb = async (off, n) => DB.slice(off, off + n);
const win = (from, to, dbCount = DB.length) => feedWindow({ spaced, dbCount, pool: POOL, gap: GAP, from, to, fetchDb });

function violations(rows) {
  let v = 0;
  rows.forEach((r, i) => { for (let k = Math.max(0, i - GAP); k < i; k++) if (rows[k].company_slug === r.company_slug) v++; });
  return v;
}

test("strict pool may drop rows; count = spaced + db beyond pool", async () => {
  const { count } = await win(0, 9);
  assert.equal(count, spaced.length + (DB.length - POOL));
});

test("no empty middle pages; windows are full until count", async () => {
  const { count } = await win(0, 0);
  for (let p = 0; p * 10 < count; p++) {
    const { rows } = await win(p * 10, p * 10 + 9);
    assert.equal(rows.length, Math.min(10, count - p * 10), "page " + p);
  }
});

test("gap respected inside pool, across pool boundary and across later pages", async () => {
  const all = [];
  for (let p = 0; p < 20; p++) all.push(...(await win(p * 10, p * 10 + 9)).rows);
  assert.equal(violations(all.slice(0, spaced.length)), 0);
  // boundary: last gap of pool + first rows of DB region
  const boundary = all.slice(spaced.length - GAP, spaced.length + 10);
  assert.equal(violations(boundary), 0);
});

test("window straddling pool boundary joins spaced and DB rows", async () => {
  const L = spaced.length;
  const { rows } = await win(L - 3, L + 4);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.slice(0, 3), spaced.slice(L - 3));
  assert.equal(violations(rows), 0);
});

test("dbCount <= pool: count is spaced length only", async () => {
  const r = await feedWindow({ spaced, dbCount: POOL, pool: POOL, gap: GAP, from: 0, to: 9, fetchDb });
  assert.equal(r.count, spaced.length);
});

test("pagination is stable: overlapping windows return identical rows", async () => {
  const a = (await win(70, 109)).rows.map((r) => r.id);
  const b = (await win(80, 99)).rows.map((r) => r.id);
  assert.deepEqual(a.slice(10, 30), b);
});
