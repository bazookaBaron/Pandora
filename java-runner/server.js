/**
 * java-runner/server.js
 *
 * Java code execution service (untrusted code!). See README.md for the threat
 * model and what is NOT isolated.
 *
 * POST /run   (header X-Runner-Secret required)
 *   { files: [{ name: 'Main.java', content: '...' }], stdin?: string }
 *   -> { compile: { stdout, stderr, code }, run: { stdout, stderr, code } }
 * GET  /health  (no auth)
 */

import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    LIMITS, Semaphore, childEnv, detectMainClass, killUid, runProcess, safeJoin, secretsMatch, validateRequest,
} from './lib.js';

const intEnv = (name, dflt) => {
    const n = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
};

// Best-effort ulimits applied through `sh -c 'ulimit ...; exec ...'` (POSIX only).
// -u counts threads per UID across the whole container, so keep headroom for
// node itself and concurrent runs (default 128; raise if javac fails to fork).
const ulimitFor = (cpuSec) => ({
    nproc: intEnv('ULIMIT_NPROC', 128),
    vmemKb: intEnv('ULIMIT_VMEM_KB', 4 * 1024 * 1024),
    fsizeBlocks: 10240, // ~10 MB per written file
    cpuSec,
});

/**
 * Build the express app. Options exist for tests; production uses env defaults.
 */
export function createApp(opts = {}) {
    const secret = opts.secret ?? process.env.RUNNER_SHARED_SECRET ?? '';
    const sem = new Semaphore(
        opts.maxConcurrent ?? intEnv('MAX_CONCURRENT_RUNS', 2),
        opts.maxQueue ?? intEnv('MAX_QUEUE', 4),
    );
    const compileTimeout = opts.compileTimeoutMs ?? LIMITS.COMPILE_TIMEOUT_MS;
    const runTimeout = opts.runTimeoutMs ?? LIMITS.RUN_TIMEOUT_MS;
    const maxOutput = opts.maxOutputBytes ?? LIMITS.MAX_OUTPUT_BYTES;

    // Sandbox uids: when RUNNER_SANDBOX_UID_BASE is set (Docker; server runs as root
    // only to drop privileges for children) every concurrent run gets its own uid
    // BASE+slot, no write access to /app, no access to other runs' work dirs.
    const uidBase = opts.sandboxUidBase ?? intEnv('RUNNER_SANDBOX_UID_BASE', 0);
    const freeSlots = [];
    for (let i = 0; i < (opts.maxConcurrent ?? intEnv('MAX_CONCURRENT_RUNS', 2)); i++) freeSlots.push(i);

    const app = express();
    app.disable('x-powered-by');

    // Unauthenticated liveness probe (Railway healthcheck). Reveals nothing.
    app.get('/health', (_req, res) => res.json({ ok: true }));

    // Auth BEFORE body parsing so unauthenticated callers cannot make us buffer 300kb.
    const requireSecret = (req, res, next) => {
        if (!secretsMatch(req.get('x-runner-secret'), secret)) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    };

    app.post('/run', requireSecret, express.json({ limit: '300kb' }), async (req, res) => {
        const v = validateRequest(req.body);
        if (!v.ok) return res.status(400).json({ error: v.error });

        const release = await sem.acquire();
        if (!release) {
            res.set('Retry-After', '5');
            return res.status(429).json({ error: 'runner busy, try again shortly' });
        }

        let workDir;
        const slot = uidBase ? freeSlots.pop() : undefined;
        const sandbox = slot !== undefined ? { uid: uidBase + slot, gid: uidBase + slot } : undefined;
        try {
            workDir = await fs.mkdtemp(path.join(tmpdir(), 'java-run-'));
            await fs.chmod(workDir, 0o700).catch(() => { });
            if (sandbox) await fs.chown(workDir, sandbox.uid, sandbox.gid);
            const env = childEnv(workDir);

            for (const f of v.files) {
                await fs.writeFile(safeJoin(workDir, f.name), f.content, 'utf-8');
            }

            // File names are regex-validated, so none can start with '-' or be treated as an option.
            const compile = await runProcess(
                'javac',
                ['-J-Xmx256m', '-encoding', 'UTF-8', '-proc:none', '-d', '.', ...v.files.map((f) => f.name)],
                { cwd: workDir, env, timeoutMs: compileTimeout, maxBytes: maxOutput, ulimit: ulimitFor(30), sandbox },
            );
            const compileOut = { stdout: compile.stdout, stderr: compile.stderr, code: compile.code };

            if (compile.code !== 0) {
                return res.json({
                    compile: compileOut,
                    run: { stdout: '', stderr: 'Compilation failed - fix errors above.', code: 1 },
                });
            }

            const run = await runProcess(
                'java',
                ['-Xmx256m', '-Xss8m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-XX:ActiveProcessorCount=1',
                    '-Djava.io.tmpdir=' + workDir, '-cp', '.', detectMainClass(v.files)],
                { cwd: workDir, env, timeoutMs: runTimeout, maxBytes: maxOutput, stdin: v.stdin, ulimit: ulimitFor(12), sandbox },
            );
            res.json({ compile: compileOut, run: { stdout: run.stdout, stderr: run.stderr, code: run.code } });
        } catch (err) {
            console.error('[java-runner] run failed:', err);
            res.status(500).json({ error: 'internal error' });
        } finally {
            if (sandbox) {
                killUid(sandbox.uid, sandbox.gid);
                freeSlots.push(slot);
            }
            release();
            if (workDir) fs.rm(workDir, { recursive: true, force: true }).catch(() => { });
        }
    });

    // Generic error handler: never leak parser/internal messages.
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
        if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
        console.error('[java-runner] unhandled:', err);
        res.status(500).json({ error: 'internal error' });
    });

    return app;
}

/** Start-up guard: returns an error string if the config is unsafe. */
export function configProblem(env = process.env) {
    if (env.NODE_ENV === 'production' && !env.RUNNER_SHARED_SECRET) {
        return 'RUNNER_SHARED_SECRET must be set in production';
    }
    return null;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const problem = configProblem();
    if (problem) {
        console.error(`[java-runner] FATAL: ${problem}`);
        process.exit(1);
    }
    if (!process.env.RUNNER_SHARED_SECRET) {
        console.warn('[java-runner] RUNNER_SHARED_SECRET not set: /run will reject every request');
    }
    const PORT = intEnv('PORT', 3001);
    createApp().listen(PORT, () => console.log(`[java-runner] listening on :${PORT}`));
}
