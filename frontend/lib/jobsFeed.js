// Jobs-feed company spacing + pagination. The feed is
// [strictly spaced pool] followed by [DB rows from offset POOL onward, spaced
// per page]. Pure/injectable so it can be unit-tested without a database.

// strict: stop once only colliding rows remain (they are left out of the
// spaced pool rather than bunched at its end; still reachable by filter).
export function spaceByCompany(rows, gap = 8, strict = false, seed = []) {
  const out = [];
  const recent = seed.slice(-gap); // company_slug of the last `gap` picks
  const deferred = []; // rows skipped because their company was too recent
  let idx = 0;
  while (out.length < rows.length) {
    let pick = null;
    for (let k = 0; k < deferred.length; k++) {
      if (!recent.includes(deferred[k].company_slug || "")) {
        pick = deferred.splice(k, 1)[0];
        break;
      }
    }
    while (pick === null && idx < rows.length) {
      const cand = rows[idx++];
      if (!recent.includes(cand.company_slug || "")) pick = cand;
      else deferred.push(cand);
    }
    if (pick === null && strict) break;
    if (pick === null) {
      // Everything left collides (fewer than gap+1 companies remain): take the
      // deferred row whose company was placed longest ago, so the tail stays
      // as spread out as the remaining mix allows.
      let best = 0;
      let bestAge = -1;
      for (let k = 0; k < deferred.length; k++) {
        const age = recent.lastIndexOf(deferred[k].company_slug || "");
        const a = age === -1 ? Infinity : recent.length - age;
        if (a > bestAge) { bestAge = a; best = k; }
      }
      pick = deferred.length ? deferred.splice(best, 1)[0] : rows[idx++];
    }
    out.push(pick);
    recent.push(pick.company_slug || "");
    if (recent.length > gap) recent.shift();
  }
  return out;
}


// fetchDb(offset, limit) -> rows (DB order, from the raw ordered query).
// Returns { rows, count } for the inclusive feed window [from, to].
// Past the pool the DB region is spaced in fixed chunks aligned to `pool`, so a
// row's position never depends on which page asked for it (stable pagination);
// each chunk is seeded with the `gap` raw rows preceding it (or the pool tail
// for the first chunk) so chunk boundaries respect the gap too.
export async function feedWindow({ spaced, dbCount, pool, gap, from, to, fetchDb, chunk = 100 }) {
  const L = spaced.length;
  const count = L + Math.max(0, (dbCount || 0) - pool);
  const out = [];
  if (from < L) out.push(...spaced.slice(from, Math.min(to, L - 1) + 1));
  if (to >= L) {
    const start = Math.max(from, L);
    const dbFrom = start - L; // offset within DB region
    const dbTo = to - L;
    for (let c = Math.floor(dbFrom / chunk) * chunk; c <= dbTo; c += chunk) {
      const lead = c > 0 ? Math.min(gap, c) : 0;
      const raw = (await fetchDb(pool + c - lead, chunk + lead)) || [];
      const seed = lead
        ? raw.slice(0, lead).map((r) => r.company_slug || "")
        : spaced.slice(-gap).map((r) => r.company_slug || "");
      const page = spaceByCompany(raw.slice(lead), gap, false, seed);
      const lo = Math.max(dbFrom, c) - c;
      const hi = Math.min(dbTo, c + chunk - 1) - c;
      out.push(...page.slice(lo, hi + 1));
      if (raw.length - lead < chunk) break; // DB exhausted
    }
  }
  return { rows: out, count };
}
