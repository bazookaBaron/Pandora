/**
 * java-runner/server.js
 *
 * Minimal Java code execution service.
 * Accepts: POST /run { files: [{ name: string, content: string }] }
 * Returns: { run: { stdout, stderr, code }, compile: { stdout, stderr, code } }
 *
 * Deploy on Railway (see Dockerfile + railway.json).
 * Local dev: node server.js (requires JDK 11+ on PATH)
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const app = express();
app.use(express.json({ limit: '512kb' }));

const TIMEOUT_MS = 10_000; // 10 seconds per phase
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Run a command, collect stdout+stderr, resolve when done or timeout.
 * Returns { stdout, stderr, code }.
 */
function runProcess(cmd, args, cwd) {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { cwd, shell: false });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const settle = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 1 });
        };

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            stderr += '\n[Execution timed out after 10 s]';
            settle(124);
        }, TIMEOUT_MS);

        proc.stdout.on('data', (d) => { stdout += d.toString() });
        proc.stderr.on('data', (d) => { stderr += d.toString() });
        proc.on('close', settle);
        proc.on('error', (err) => {
            stderr += `\n[Process error: ${err.message}]`;
            settle(1);
        });
    });
}

/**
 * Detect the main class from file content (looks for `public static void main`).
 * Returns the file name without `.java`, or falls back to "Main".
 */
function detectMainClass(files) {
    for (const f of files) {
        if (f.content.includes('public static void main')) {
            return path.basename(f.name, '.java');
        }
    }
    return 'Main';
}

// ── routes ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/run', async (req, res) => {
    const { files } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required' });
    }

    // Validate all files have name + content strings
    for (const f of files) {
        if (typeof f.name !== 'string' || typeof f.content !== 'string') {
            return res.status(400).json({ error: 'each file must have name and content strings' });
        }
    }

    // Create isolated temp directory
    const workDir = path.join(tmpdir(), `java-run-${randomUUID()}`);
    try {
        await fs.mkdir(workDir, { recursive: true });

        // Write all source files
        await Promise.all(
            files.map((f) => fs.writeFile(path.join(workDir, f.name), f.content, 'utf-8'))
        );

        // Compile
        const javaFiles = files.map((f) => f.name);
        const compile = await runProcess('javac', javaFiles, workDir);

        if (compile.code !== 0) {
            return res.json({
                compile: { stdout: compile.stdout, stderr: compile.stderr, code: compile.code },
                run: { stdout: '', stderr: 'Compilation failed — fix errors above.', code: 1 },
            });
        }

        // Run
        const mainClass = detectMainClass(files);
        const run = await runProcess('java', ['-cp', '.', mainClass], workDir);

        res.json({
            compile: { stdout: compile.stdout, stderr: compile.stderr, code: compile.code },
            run: { stdout: run.stdout, stderr: run.stderr, code: run.code },
        });
    } catch (err) {
        console.error('[java-runner]', err);
        res.status(500).json({ error: err.message });
    } finally {
        // Best-effort cleanup
        fs.rm(workDir, { recursive: true, force: true }).catch(() => { });
    }
});

app.listen(PORT, () => {
    console.log(`[java-runner] listening on :${PORT}`);
});
