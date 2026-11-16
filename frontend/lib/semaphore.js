// Tiny async counting semaphore. `acquire()` resolves immediately while permits
// are available, otherwise queues FIFO until a `release()` frees one. `pending`
// is the number of waiters currently queued (not counting in-flight holders).
//
// `acquire({ signal })` rejects (and leaves the queue) if the signal aborts
// while waiting, so a client that disconnected never ends up holding a permit.
export function makeSemaphore(max) {
  let available = Math.max(1, max | 0);
  /** @type {{ resolve: () => void }[]} */
  const waiters = [];

  return {
    acquire(opts) {
      const signal = opts && opts.signal;
      if (signal && signal.aborted) {
        return Promise.reject(abortError());
      }
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve: null };
        const onAbort = () => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(abortError());
        };
        entry.resolve = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve();
        };
        waiters.push(entry);
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next.resolve();
      else available++;
    },
    get pending() {
      return waiters.length;
    },
    get available() {
      return available;
    },
  };
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  e.code = "ABORTED";
  return e;
}
