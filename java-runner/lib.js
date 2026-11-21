/**
 * java-runner/lib.js - pure helpers (validation, auth, process runner, semaphore).
 * Kept separate from server.js so they can be unit-tested without listening.
 */
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const LIMITS = Object.freeze({
    MAX_FILES: 20,
    MAX_TOTAL_SOURCE_BYTES: 200 * 1024,
    MAX_STDIN_BYTES: 16 * 1024,
    MAX_OUTPUT_BYTES: 64 * 1024,
    COMPILE_TIMEOUT_MS: 15_000,
    RUN_TIMEOUT_MS: 10_000,
});

export const FILE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}\.java$/;

// -- auth -------------------------------------------------------------

/** Constant-time string compare (hash both sides so length is not leaked). */
export function secretsMatch(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

// -- validation -------------------------------------------------------

/**
 * Validate the user-supplied request body.
 * Returns { ok: true, files, stdin } or { ok: false, error }.
 */
export function validateRequest(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'invalid request body' };
    const { files, stdin } = body;
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'files array is required' };
    if (files.length > LIMITS.MAX_FILES) return { ok: false, error: `too many files (max ${LIMITS.MAX_FILES})` };

    const seen = new Set();
    let total = 0;
    const clean = [];
    for (const f of files) {
        if (!f || typeof f !== 'object' || typeof f.name !== 'string' || typeof f.content !== 'string') {
            return { ok: false, error: 'each file must have name and content strings' };
        }
        if (!FILE_NAME_RE.test(f.name)) {
            return { ok: false, error: 'invalid file name (expected Identifier.java)' };
        }
        const key = f.name.toLowerCase();
        if (seen.has(key)) return { ok: false, error: 'duplicate file name' };
        seen.add(key);
        total += Buffer.byteLength(f.content, 'utf8');
        if (total > LIMITS.MAX_TOTAL_SOURCE_BYTES) {
            return { ok: false, error: `source too large (max ${LIMITS.MAX_TOTAL_SOURCE_BYTES} bytes)` };
        }
        clean.push({ name: f.name, content: f.content });
    }

    let stdinStr = '';
    if (stdin !== undefined && stdin !== null) {
        if (typeof stdin !== 'string') return { ok: false, error: 'stdin must be a string' };
        if (Buffer.byteLength(stdin, 'utf8') > LIMITS.MAX_STDIN_BYTES) {
            return { ok: false, error: `stdin too large (max ${LIMITS.MAX_STDIN_BYTES} bytes)` };
        }
        stdinStr = stdin;
    }
    return { ok: true, files: clean, stdin: stdinStr };
}

/** Resolve name inside workDir; throws if it would escape. */
export function safeJoin(workDir, name) {
    const root = path.resolve(workDir);
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) throw new Error('path escapes work dir');
    return full;
}

/** Pick the main class: first file declaring main(), else Main.java, else first file. */
export function detectMainClass(files) {
    const re = /public\s+static\s+void\s+main\s*\(/;
    const hit = files.find((f) => re.test(f.content));
    const chosen = hit || files.find((f) => f.name === 'Main.java') || files[0];
    return chosen.name.replace(/\.java$/, '');
}

// -- process runner ---------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

/** Minimal, secret-free environment for child processes. */
export function childEnv(home) {
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
    if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
    if (IS_WINDOWS && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    return env;
}

/** Wrap a command in `sh -c 'ulimit ...; exec "$@"'` where a POSIX shell is available. */
export function wrapWithUlimit(cmd, args, ul) {
    if (IS_WINDOWS || !ul) return { cmd, args };
    const parts = [];
    if (ul.nproc) parts.push(`ulimit -u ${Number(ul.nproc)}`);
    if (ul.vmemKb) parts.push(`ulimit -v ${Number(ul.vmemKb)}`);
    if (ul.fsizeBlocks) parts.push(`ulimit -f ${Number(ul.fsizeBlocks)}`);
    if (ul.cpuSec) parts.push(`ulimit -t ${Number(ul.cpuSec)}`);
    // each ulimit is best-effort: a failure must not prevent the run
    const script = parts.map((p) => `${p} 2>/dev/null || true`).join('; ') + '; exec "$@"';
    return { cmd: 'sh', args: ['-c', script, 'sh', cmd, ...args] };
}

function killTree(proc) {
    if (!proc.pid) return;
    try {
        if (IS_WINDOWS) proc.kill('SIGKILL');
        else process.kill(-proc.pid, 'SIGKILL'); // whole process group (detached:true)
    } catch {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

/**
 * Run a command with timeout, output caps and process-group kill.
 * Resolves { stdout, stderr, code, timedOut, truncated }; never rejects.
 */
export function runProcess(cmd, args, opts = {}) {
    const {
        cwd, timeoutMs = LIMITS.RUN_TIMEOUT_MS, maxBytes = LIMITS.MAX_OUTPUT_BYTES,
        stdin = '', env, ulimit,
    } = opts;
    const wrapped = wrapWithUlimit(cmd, args, ulimit);

    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(wrapped.cmd, wrapped.args, {
                cwd, env, shell: false, detached: !IS_WINDOWS,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (err) {
            console.error('[java-runner] spawn failed:', err);
            return resolve({ stdout: '', stderr: '[Failed to start process]', code: 1, timedOut: false, truncated: false });
        }

        const out = { stdout: [], stderr: [] };
        const size = { stdout: 0, stderr: 0 };
        let settled = false;
        let timedOut = false;
        let truncated = false;
        let timer;

        const finish = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stdout = Buffer.concat(out.stdout).toString('utf8');
            let stderr = Buffer.concat(out.stderr).toString('utf8');
            if (truncated) stderr += `\n[Output truncated at ${maxBytes} bytes; process killed]`;
            if (timedOut) stderr += `\n[Execution timed out after ${Math.round(timeoutMs / 1000)} s]`;
            resolve({ stdout, stderr, code: timedOut ? 124 : (code ?? 1), timedOut, truncated });
        };

        timer = setTimeout(() => {
            timedOut = true;
            killTree(proc);
            finish(124);
        }, timeoutMs);

        const collect = (key) => (chunk) => {
            if (truncated) return;
            const room = maxBytes - size[key];
            if (chunk.length > room) {
                if (room > 0) out[key].push(chunk.subarray(0, room));
                size[key] = maxBytes;
                truncated = true;
                killTree(proc);
                finish(137);
                return;
            }
            out[key].push(chunk);
            size[key] += chunk.length;
        };
        proc.stdout.on('data', collect('stdout'));
        proc.stderr.on('data', collect('stderr'));
        proc.on('close', (code) => finish(code));
        proc.on('error', (err) => {
            console.error('[java-runner] process error:', err);
            out.stderr.push(Buffer.from('\n[Process error]'));
            finish(1);
        });

        // stdin: write capped input then close (EPIPE is harmless)
        proc.stdin.on('error', () => { });
        proc.stdin.end(stdin ? Buffer.from(stdin, 'utf8').subarray(0, LIMITS.MAX_STDIN_BYTES) : undefined);
    });
}

// -- concurrency ------------------------------------------------------

/** Counting semaphore with bounded wait queue. acquire() resolves a release fn, or null when full. */
export class Semaphore {
    constructor(max, maxQueue) {
        this.max = Math.max(1, max);
        this.maxQueue = Math.max(0, maxQueue);
        this.active = 0;
        this.queue = [];
    }

    acquire() {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve(this._releaser());
        }
        if (this.queue.length >= this.maxQueue) return Promise.resolve(null);
        return new Promise((resolve) => this.queue.push(resolve));
    }

    _releaser() {
        let done = false;
        return () => {
            if (done) return;
            done = true;
            const next = this.queue.shift();
            if (next) next(this._releaser()); // hand the slot over (active unchanged)
            else this.active--;
        };
    }
}
