/**
 * Proof retention: application screenshots in the private 'aa-proof' bucket are kept 30 days. Daily cron:
 * tasks whose proof is older than that (by submitted_at, else updated_at) get the object deleted and
 * aa_tasks.proof_path nulled. confirmation_text (the portal's "thanks for applying" text) is kept.
 * Never throws; storage failures leave proof_path in place so the next run retries.
 */
export const PROOF_BUCKET = "aa-proof";
export const PROOF_RETENTION_DAYS = 30;
const DAY_MS = 86400000;
const CHUNK = 100;

export async function cleanupOldProofs({ db, now = new Date(), maxRows = 2000 }) {
  const cutoff = new Date(now.getTime() - PROOF_RETENTION_DAYS * DAY_MS).toISOString();
  let removed = 0;
  let failed = 0;
  try {
    const seen = new Set();
    for (const col of ["submitted_at", "updated_at"]) {
      while (removed + failed < maxRows) {
        let q = db.from("aa_tasks").select("id, proof_path, submitted_at").not("proof_path", "is", null).lt(col, cutoff);
        if (col === "updated_at") q = q.is("submitted_at", null);
        const { data: rows, error } = await q.limit(CHUNK);
        if (error) throw error;
        const batch = (rows || []).filter((r) => !seen.has(r.id));
        if (!batch.length) break;
        batch.forEach((r) => seen.add(r.id));
        const paths = batch.map((r) => String(r.proof_path)).filter((p) => p && !p.includes(".."));
        const { error: sErr } = paths.length ? await db.storage.from(PROOF_BUCKET).remove(paths) : { error: null };
        if (sErr) {
          console.warn("[autoapply/proof-retention] remove failed:", sErr.message || sErr);
          failed += batch.length;
          break;
        }
        const { error: uErr } = await db.from("aa_tasks").update({ proof_path: null }).in("id", batch.map((r) => r.id));
        if (uErr) throw uErr;
        removed += batch.length;
      }
    }
    return { removed, failed };
  } catch (e) {
    console.error("[autoapply/proof-retention]", (e && e.message) || String(e));
    return { removed, failed, error: true };
  }
}
