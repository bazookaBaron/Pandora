FROM eclipse-temurin:21-jdk-alpine

ENV NODE_ENV=production

# Node.js runs the Express wrapper; busybox `sh` provides ulimit for child processes.
RUN apk add --no-cache nodejs npm \
    && addgroup -S -g 10001 runner \
    && adduser -S -u 10001 -G runner -h /app -s /sbin/nologin runner

# Sandbox users for untrusted code: uids 10100..10103 (one per concurrent run slot,
# see RUNNER_SANDBOX_UID_BASE / MAX_CONCURRENT_RUNS; keep <= 4 slots or add more here).
# They have no home, no shell and no write access to /app.
RUN for i in 0 1 2 3; do \
      addgroup -S -g $((10100+i)) sbx$i && \
      adduser -S -D -H -u $((10100+i)) -G sbx$i -h /nonexistent -s /sbin/nologin sbx$i; \
    done

WORKDIR /app

# App tree is owned by root and read-only for everyone else (uid runner and sandbox users).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R root:root /app && chmod -R go-w /app

COPY server.js lib.js ./
RUN chmod -R go-w /app

# The server starts as root ONLY so it can spawn compile/run children with
# uid/gid = a sandbox user (child_process uid/gid needs CAP_SETUID). Server code
# never executes user code in-process. If the platform forces a non-root user,
# unset RUNNER_SANDBOX_UID_BASE and the runner falls back to the same-uid mode.
ENV RUNNER_SANDBOX_UID_BASE=10100 \
    MAX_CONCURRENT_RUNS=2

EXPOSE 3001

CMD ["node", "server.js"]
