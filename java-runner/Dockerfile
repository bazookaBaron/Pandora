FROM eclipse-temurin:21-jdk-alpine

ENV NODE_ENV=production

# Node.js runs the Express wrapper; busybox `sh` provides ulimit for child processes.
RUN apk add --no-cache nodejs npm \
    && addgroup -S -g 10001 runner \
    && adduser -S -u 10001 -G runner -h /app -s /sbin/nologin runner

WORKDIR /app

COPY --chown=runner:runner package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R runner:runner /app

COPY --chown=runner:runner server.js lib.js ./

# Per-request work dirs live under /tmp (mkdtemp) and are removed in a finally block.
# The app tree is owned by `runner` but nothing in it needs to be writable at runtime.
USER runner

EXPOSE 3001

CMD ["node", "server.js"]
