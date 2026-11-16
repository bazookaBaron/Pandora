import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createApp, configProblem } from '../server.js';
import {
    validateRequest, safeJoin, secretsMatch, runProcess, Semaphore, detectMainClass, wrapWithUlimit, LIMITS,
} from '../lib.js';

const hasJdk = spawnSync('javac', ['-version']).status === 0;
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
const SECRET = 'test-secret-value';

const okFile = (name = 'Main.java', content = 'public class Main {}') => ({ name, content });

describe('validateRequest (file names and limits)', () => {
    for (const bad of ['../Evil.java', 'a/b.java', 'a\\b.java', '-J-Dx.java', 'Main.class', 'Main.java ', '1Main.java',
        '.java', 'Ma in.java', 'Main.JAVA', '/etc/passwd', 'Main\u0000.java', 'A'.repeat(65) + '.java']) {
        test(`rejects ${JSON.stringify(bad).slice(0, 30)}`, () => {
            assert.equal(validateRequest({ files: [okFile(bad)] }).ok, false);
        });
    }
    test('accepts valid names', () => {
        assert.equal(validateRequest({ files: [okFile('_Foo9.java'), okFile('A.java'), okFile('B'.repeat(64) + '.java')] }).ok, true);
    });
    test('rejects duplicates (case-insensitive)', () => {
        assert.equal(validateRequest({ files: [okFile('A.java'), okFile('a.java')] }).ok, false);
    });
    test('rejects more than 20 files', () => {
        const files = Array.from({ length: 21 }, (_, i) => okFile(`C${i}.java`));
        assert.equal(validateRequest({ files }).ok, false);
        assert.equal(validateRequest({ files: files.slice(0, 20) }).ok, true);
    });
    test('rejects > 200KB total source', () => {
        const big = 'x'.repeat(150 * 1024);
        assert.equal(validateRequest({ files: [okFile('A.java', big), okFile('B.java', big)] }).ok, false);
        assert.equal(validateRequest({ files: [okFile('A.java', big)] }).ok, true);
    });
    test('rejects non-array / non-string content / bad stdin', () => {
        assert.equal(validateRequest({}).ok, false);
        assert.equal(validateRequest({ files: 'x' }).ok, false);
        assert.equal(validateRequest({ files: [{ name: 'A.java', content: 5 }] }).ok, false);
        assert.equal(validateRequest({ files: [okFile()], stdin: 5 }).ok, false);
        assert.equal(validateRequest({ files: [okFile()], stdin: 'x'.repeat(LIMITS.MAX_STDIN_BYTES + 1) }).ok, false);
    });
});

describe('helpers', () => {
    test('safeJoin keeps paths inside workDir', () => {
        assert.ok(safeJoin('/tmp/w', 'A.java').endsWith('A.java'));
        assert.throws(() => safeJoin('/tmp/w', '../x.java'));
        assert.throws(() => safeJoin('/tmp/w', '..'));
    });
    test('secretsMatch', () => {
        assert.equal(secretsMatch('abc', 'abc'), true);
        assert.equal(secretsMatch('abd', 'abc'), false);
        assert.equal(secretsMatch('', ''), false);
        assert.equal(secretsMatch(undefined, 'abc'), false);
        assert.equal(secretsMatch('abc', undefined), false);
    });
    test('detectMainClass', () => {
        assert.equal(detectMainClass([okFile('A.java', 'class A{}'), okFile('B.java', 'class B{ public static void main(String[] a){} }')]), 'B');
        assert.equal(detectMainClass([okFile('A.java', 'class A{}'), okFile('Main.java', 'class Main{}')]), 'Main');
    });
    test('wrapWithUlimit builds an exec wrapper on POSIX', { skip: process.platform === 'win32' && 'POSIX only' }, () => {
        const w = wrapWithUlimit('java', ['-version'], { nproc: 64, cpuSec: 12 });
        assert.equal(w.cmd, 'sh');
        assert.match(w.args[1], /ulimit -u 64/);
        assert.match(w.args[1], /exec "\$@"/);
        assert.deepEqual(w.args.slice(-2), ['java', '-version']);
    });
    test('configProblem: production requires secret', () => {
        assert.ok(configProblem({ NODE_ENV: 'production' }));
        assert.equal(configProblem({ NODE_ENV: 'production', RUNNER_SHARED_SECRET: 's' }), null);
        assert.equal(configProblem({}), null);
    });
    test('Semaphore bounds concurrency and queue', async () => {
        const s = new Semaphore(1, 1);
        const r1 = await s.acquire();
        const p2 = s.acquire(); // queued
        assert.equal(await s.acquire(), null); // queue full
        r1();
        const r2 = await p2;
        assert.equal(typeof r2, 'function');
        r2();
        assert.equal(s.active, 0);
    });
});

describe('runProcess (node as the child)', () => {
    test('truncates and kills on output flood', async () => {
        const t0 = Date.now();
        const r = await runProcess(process.execPath,
            ['-e', 'setInterval(()=>process.stdout.write("x".repeat(10000)),1)'],
            { timeoutMs: 8000, maxBytes: 1024 });
        assert.equal(r.truncated, true);
        assert.equal(r.stdout.length, 1024);
        assert.match(r.stderr, /truncated/i);
        assert.ok(Date.now() - t0 < 5000, 'should be killed promptly');
    });
    test('kills on timeout', async () => {
        const t0 = Date.now();
        const r = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
        assert.equal(r.timedOut, true);
        assert.equal(r.code, 124);
        assert.match(r.stderr, /timed out/);
        assert.ok(Date.now() - t0 < 3000);
    });
    test('kills the whole process group (grandchildren)', { skip: !hasSh && 'needs POSIX sh' }, async () => {
        const r = await runProcess('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 500 });
        assert.equal(r.timedOut, true);
        const pid = parseInt(r.stdout.trim(), 10);
        await new Promise((res) => setTimeout(res, 200));
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        assert.equal(alive, false, 'grandchild sleep must be dead');
    });
    test('passes stdin', async () => {
        const r = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 5000, stdin: 'hello' });
        assert.equal(r.stdout, 'hello');
    });
});

describe('HTTP API', () => {
    const listen = (opts) => new Promise((resolve) => {
        const server = createApp({ secret: SECRET, ...opts }).listen(0, '127.0.0.1', () => {
            resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
        });
    });
    const post = (base, body, headers = {}) => fetch(`${base}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    test('/health needs no auth', async () => {
        const { server, base } = await listen();
        try {
            const r = await fetch(`${base}/health`);
            assert.equal(r.status, 200);
        } finally { server.close(); }
    });

    test('rejects missing / wrong secret with 401', async () => {
        const { server, base } = await listen();
        try {
            assert.equal((await post(base, { files: [okFile()] })).status, 401);
            assert.equal((await post(base, { files: [okFile()] }, { 'x-runner-secret': 'nope' })).status, 401);
        } finally { server.close(); }
    });

    test('rejects everything when no secret is configured', async () => {
        const { server, base } = await listen({ secret: '' });
        try {
            assert.equal((await post(base, { files: [okFile()] }, { 'x-runner-secret': '' })).status, 401);
        } finally { server.close(); }
    });

    test('bad file name -> 400, oversize body -> 413, bad JSON -> 400 (generic)', async () => {
        const { server, base } = await listen();
        const h = { 'x-runner-secret': SECRET };
        try {
            assert.equal((await post(base, { files: [okFile('../x.java')] }, h)).status, 400);
            assert.equal((await post(base, { files: [okFile('A.java', 'x'.repeat(400 * 1024))] }, h)).status, 413);
            const r = await fetch(`${base}/run`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{bad' });
            assert.equal(r.status, 400);
            assert.deepEqual(await r.json(), { error: 'invalid JSON' });
        } finally { server.close(); }
    });

    const jdk = { skip: !hasJdk && 'JDK (javac) not installed locally - integration test skipped' };

    test('compiles and runs Java, with stdin', jdk, async () => {
        const { server, base } = await listen();
        try {
            const src = 'import java.util.*; public class Main { public static void main(String[] a){ Scanner s=new Scanner(System.in); System.out.println("hi "+s.nextLine()); } }';
            const r = await post(base, { files: [okFile('Main.java', src)], stdin: 'bob\n' }, { 'x-runner-secret': SECRET });
            const j = await r.json();
            assert.equal(r.status, 200);
            assert.equal(j.compile.code, 0);
            assert.equal(j.run.stdout.trim(), 'hi bob');
        } finally { server.close(); }
    });

    test('infinite loop is killed by the run timeout', jdk, async () => {
        const { server, base } = await listen({ runTimeoutMs: 1500 });
        try {
            const src = 'public class Main { public static void main(String[] a){ while(true){} } }';
            const t0 = Date.now();
            const j = await (await post(base, { files: [okFile('Main.java', src)] }, { 'x-runner-secret': SECRET })).json();
            assert.equal(j.run.code, 124);
            assert.match(j.run.stderr, /timed out/);
            assert.ok(Date.now() - t0 < 12000);
        } finally { server.close(); }
    });

    test('output flood is truncated', jdk, async () => {
        const { server, base } = await listen({ maxOutputBytes: 2048 });
        try {
            const src = 'public class Main { public static void main(String[] a){ while(true){ System.out.println("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); } } }';
            const j = await (await post(base, { files: [okFile('Main.java', src)] }, { 'x-runner-secret': SECRET })).json();
            assert.ok(j.run.stdout.length <= 2048);
            assert.match(j.run.stderr, /truncated/i);
        } finally { server.close(); }
    });

    test('child cannot see RUNNER_SHARED_SECRET env', jdk, async () => {
        process.env.RUNNER_SHARED_SECRET = SECRET;
        const { server, base } = await listen();
        try {
            const src = 'public class Main { public static void main(String[] a){ System.out.println(System.getenv("RUNNER_SHARED_SECRET")); } }';
            const j = await (await post(base, { files: [okFile('Main.java', src)] }, { 'x-runner-secret': SECRET })).json();
            assert.equal(j.run.stdout.trim(), 'null');
        } finally { server.close(); delete process.env.RUNNER_SHARED_SECRET; }
    });

    test('returns 429 when saturated', jdk, async () => {
        const { server, base } = await listen({ maxConcurrent: 1, maxQueue: 0, runTimeoutMs: 3000 });
        try {
            const src = 'public class Main { public static void main(String[] a) throws Exception { Thread.sleep(2500); } }';
            const h = { 'x-runner-secret': SECRET };
            const first = post(base, { files: [okFile('Main.java', src)] }, h);
            await new Promise((r) => setTimeout(r, 300));
            const second = await post(base, { files: [okFile('Main.java', src)] }, h);
            assert.equal(second.status, 429);
            await first;
        } finally { server.close(); }
    });
});
