// Tiny async counting semaphore. `acquire()` resolves immediately while permits
// are available, otherwise queues FIFO until a `release()` frees one. `pending`
// is the number of waiters currently queued (not counting in-flight holders).
export function makeSemaphore(max) {
  let available = Math.max(1, max | 0);
  /** @type {(() => void)[]} */
  const waiters = [];

  return {
    acquire() {
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
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
