// Minimal worker_threads pool for CPU-bound PDF parsing.
//
// pdf-parse / pdfjs page walking is synchronous CPU work that blocks the event
// loop for the whole request. This pool moves it onto a small set of persistent
// workers (see ./pdfWorkerEntry.js) with a FIFO queue, per-task transfer of the
// PDF bytes (zero-copy), a per-task timeout, and crash recovery.
import os from "node:os";
import { Worker } from "node:worker_threads";

const POOL_SIZE = Math.max(1, Math.min(3, (os.cpus().length || 2) - 1));
const TASK_TIMEOUT_MS = 60_000;

const WORKER_URL = new URL("./pdfWorkerEntry.js", import.meta.url);

let _nextId = 1;

/** @type {Set<WorkerRec>} */
const workers = new Set();
/** @type {WorkerRec[]} */
const free = [];
/** @type {Task[]} */
const queue = [];

/**
 * @typedef {{ worker: import('node:worker_threads').Worker, current: Task | null }} WorkerRec
 * @typedef {{ id: number, op: string, ab: ArrayBuffer, resolve: Function, reject: Function, timer: NodeJS.Timeout | null }} Task
 */

function spawnWorker() {
  const worker = new Worker(WORKER_URL);
  /** @type {WorkerRec} */
  const rec = { worker, current: null };

  worker.on("message", (msg) => {
    const task = rec.current;
    if (!task || !msg || msg.id !== task.id) return;
    finishTask(rec, task);
    if (msg.ok) task.resolve(msg.result);
    else task.reject(new Error(msg.error || "pdf worker task failed"));
    pump();
  });

  const onGone = (why) => {
    if (!workers.has(rec)) return; // already cleaned up
    workers.delete(rec);
    const idx = free.indexOf(rec);
    if (idx !== -1) free.splice(idx, 1);
    const task = rec.current;
    if (task) {
      if (task.timer) clearTimeout(task.timer);
      rec.current = null;
      task.reject(new Error(`pdf worker ${why} before task ${task.op} completed`));
    }
    // A replacement is spawned lazily by pump() on the next task.
    pump();
  };

  worker.on("error", (err) => onGone(`errored (${err?.message || err})`));
  worker.on("exit", (code) => {
    if (code !== 0 || rec.current) onGone(`exited (code ${code})`);
    else workers.delete(rec);
  });

  workers.add(rec);
  free.push(rec);
  return rec;
}

function ensureWorkers() {
  while (workers.size < POOL_SIZE) spawnWorker();
}

function finishTask(rec, task) {
  if (task.timer) clearTimeout(task.timer);
  task.timer = null;
  rec.current = null;
  if (!free.includes(rec)) free.push(rec);
}

function assignTask(rec, task) {
  rec.current = task;
  const i = free.indexOf(rec);
  if (i !== -1) free.splice(i, 1);

  task.timer = setTimeout(() => {
    if (rec.current !== task) return;
    rec.current = null;
    workers.delete(rec);
    const fi = free.indexOf(rec);
    if (fi !== -1) free.splice(fi, 1);
    rec.worker.terminate().catch(() => {}); // recycle the wedged worker
    task.reject(new Error(`pdf worker task ${task.op} timed out after ${TASK_TIMEOUT_MS}ms`));
    pump();
  }, TASK_TIMEOUT_MS);
  task.timer.unref?.();

  try {
    rec.worker.postMessage({ id: task.id, op: task.op, buffer: task.ab }, [task.ab]);
  } catch (e) {
    if (task.timer) clearTimeout(task.timer);
    rec.current = null;
    workers.delete(rec);
    rec.worker.terminate().catch(() => {});
    task.reject(e instanceof Error ? e : new Error(String(e)));
    pump();
  }
}

function pump() {
  if (!queue.length) return;
  ensureWorkers();
  while (queue.length && free.length) {
    const rec = free[0];
    const task = queue.shift();
    assignTask(rec, task);
  }
}

/**
 * Run one PDF op on the pool.
 * @param {string} op  "extractText" | "layoutInfo"
 * @param {Buffer} buffer  Node Buffer of the PDF bytes
 * @returns {Promise<any>}
 */
function run(op, buffer) {
  return new Promise((resolve, reject) => {
    // Copy out an exact ArrayBuffer view so we can transfer it (zero-copy) and
    // never hand the worker a slab shared with unrelated Buffers.
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    /** @type {Task} */
    const task = { id: _nextId++, op, ab, resolve, reject, timer: null };
    queue.push(task);
    pump();
  });
}

export function extractText(buffer) {
  return run("extractText", buffer);
}

export function layoutInfo(buffer) {
  return run("layoutInfo", buffer);
}

/** Terminate every worker. Not wired into the server; handy for tests. */
export async function shutdown() {
  const recs = [...workers];
  workers.clear();
  free.length = 0;
  await Promise.all(recs.map((r) => r.worker.terminate().catch(() => {})));
}
