# java-runner

Small HTTP service that compiles and runs **untrusted** Java submitted by users (LLD practice).

```
POST /run   header: X-Runner-Secret: <RUNNER_SHARED_SECRET>
            body:   { "files": [{ "name": "Main.java", "content": "..." }], "stdin": "optional" }
            200:    { "compile": { stdout, stderr, code }, "run": { stdout, stderr, code } }
            401 bad/missing secret | 400 invalid request | 413 body > 300kb | 429 busy | 500 generic
GET  /health   no auth, returns { ok: true }
```

## What is enforced

| Control | Detail |
|---|---|
| Auth | `X-Runner-Secret` compared in constant time with `RUNNER_SHARED_SECRET`. Server refuses to start when `NODE_ENV=production` and the secret is unset; with no secret `/run` rejects everything. |
| Input | File names must match `^[A-Za-z_][A-Za-z0-9_]{0,63}\.java$` (so never an option or path), max 20 files, 200KB total source, 300kb body, 16KB stdin, no duplicates, resolved path verified inside the work dir. User strings are never passed as javac/java options. |
| Process | Runs as non-root `runner` (uid 10001). Per-request work dir from `mkdtemp` under `/tmp`, mode 0700, removed in `finally`. Child env is scrubbed (no `RUNNER_SHARED_SECRET`). |
| Resources | `java -Xmx256m -Xss8m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:ActiveProcessorCount=1`, `javac -J-Xmx256m`. Compile timeout 15s, run timeout 10s. Children are `detached` and the whole **process group** is SIGKILLed on timeout or output overflow. stdout and stderr capped at 64KB each (truncated, then killed). |
| ulimit | On POSIX, each child is exec'd through `sh -c 'ulimit -u N -v KB -f 10240 -t S; exec ...'` (best-effort; a failing ulimit does not abort the run). `-u` defaults to 128 (not 64) because it counts threads of the whole UID, including node and concurrent runs; tune with `ULIMIT_NPROC`, `ULIMIT_VMEM_KB`. |
| Concurrency | `MAX_CONCURRENT_RUNS` (default 2) simultaneous runs, `MAX_QUEUE` (default 4) waiting; beyond that `429` with `Retry-After`. |
| Errors | Clients only ever get generic messages; details are logged server-side. |

## What is NOT isolated (be honest about this)

Railway containers are unprivileged: no nested Docker, gVisor, nsjail, firejail or seccomp profile of our own. So user code **can**:

- **Use the network.** Java's SecurityManager is gone in modern JDKs and there is no reliable JVM-level switch. Submitted code can make outbound connections (SSRF to other Railway services over the private network, data exfiltration, abuse as a proxy or DDoS source). Mitigation is only environmental, see the checklist below.
- **Read anything the `runner` uid can read**: the app tree, the container filesystem, `/proc/<pid>/environ` of the node process (so `RUNNER_SHARED_SECRET` is readable by user code; it only authenticates to this very service, but never put other secrets in this service's variables), and other concurrent runs' work dirs (same uid).
- **Burn resources inside the limits**: CPU for up to ~12s per run, up to ~4GB virtual memory per JVM by ulimit (heap is 256MB), disk in `/tmp` (10MB per file, no total quota), and thread/fork bombs up to the `-u` limit.
- Anything that needs a kernel boundary: a JVM or kernel escape is not prevented.

The `ulimit` and process-group-kill paths run only on Linux; the test suite exercises them on Linux/CI, and skips them on Windows.

**For real isolation use a purpose-built sandbox** such as [Judge0](https://github.com/judge0/judge0) or [Piston](https://github.com/engineer-man/piston) (isolate/nsjail, cgroups, network off, per-run uid) on a host where privileged containers are allowed, and point the main server at it instead. Treat this service as defense-in-depth for low-stakes use only.

## Deployment checklist (Railway)

1. Create the service from `java-runner/` (Dockerfile builder, see `railway.json`).
2. **Do not generate a public domain.** Remove any existing one (Settings > Networking > delete the domain). Only the main Pandora server should reach it, over Railway private networking: `http://<service-name>.railway.internal:3001` (set `PORT=3001` explicitly so the URL is stable).
3. Generate a long random secret (e.g. `openssl rand -hex 32`) and set `RUNNER_SHARED_SECRET` on **both** services: the java-runner and the main Pandora server.
4. On the main server, set the runner URL variable to the private URL and make sure its `/api/run` fetch sends the header `X-Runner-Secret: process.env.RUNNER_SHARED_SECRET`. Calls without it get 401.
5. Keep this service's variables minimal: no database URLs, API keys or other secrets (user code can read the process environment of the same uid).
6. Egress: if your Railway plan or an upstream firewall allows restricting outbound traffic, deny everything except what the JDK image needs at runtime (nothing). Otherwise accept the open-egress risk, and ideally keep the project free of services that trust the private network without auth.
7. Set resource limits on the service (e.g. 1 vCPU / 1GB RAM) so a runaway run cannot starve neighbours; `MAX_CONCURRENT_RUNS=2` fits that.
8. Verify: `GET /health` works; `POST /run` without the header returns 401; a `while(true){}` program returns code 124 after ~10s.

## Local development

```
npm ci
RUNNER_SHARED_SECRET=dev-secret node server.js     # needs JDK 17+ on PATH
npm test                                           # JDK integration tests are skipped if javac is missing
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `RUNNER_SHARED_SECRET` | none | required in production |
| `PORT` | 3001 | listen port |
| `MAX_CONCURRENT_RUNS` | 2 | parallel compile+run jobs |
| `MAX_QUEUE` | 4 | waiting jobs before 429 |
| `ULIMIT_NPROC` | 128 | `ulimit -u` |
| `ULIMIT_VMEM_KB` | 4194304 | `ulimit -v` |
