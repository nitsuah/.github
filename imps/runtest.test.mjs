// node --test imps/runtest.test.mjs
// Runs the real imps/runtest.mjs against a fake run (temp IMPS_HOME, temp worktree, fake test commands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const fwd = (p) => p.replaceAll('\\', '/');

// Prints `lines` numbered lines, then exits with `code`.
const GEN = "const [n, code] = process.argv.slice(2).map(Number); for (let i = 1; i <= n; i++) console.log('line' + i); process.exit(code);";
// Prints ~`mb` MiB (more than the old 64 MiB capture buffer when mb is large), then exits 0.
const BIG = "const mb = Number(process.argv[2]); const chunk = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < mb * 1024; i++) process.stdout.write(chunk); console.log('done');";

function runtest(testCmd, setup = () => {}) {
    const home = mkdtempSync(join(tmpdir(), 'runtest-home-'));
    const wt = mkdtempSync(join(tmpdir(), 'runtest-wt-'));
    try {
        writeFileSync(join(wt, 'gen.js'), GEN);
        writeFileSync(join(wt, 'big.js'), BIG);
        const brief = join(home, 'brief.md');
        writeFileSync(brief, `---\nrepo: r\nissue: 1\ntest: ${testCmd.replaceAll('{wt}', fwd(wt))}\nmaxLines: 100\nallow: a.js\n---\n## Issue\nx\n`);
        writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ id: 'imp_1', repo: 'r', issue: 1, worktree: wt, brief }) + '\n');
        setup(wt);
        const r = spawnSync(process.execPath, [join(HERE, 'runtest.mjs')], { cwd: wt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, IMPS_HOME: home } });
        return { status: r.status, out: r.stdout + r.stderr };
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(wt, { recursive: true, force: true });
    }
}

test('runtest prints short output unchanged and exits 0', () => {
    const r = runtest('node "{wt}/gen.js" 5 0');
    assert.equal(r.status, 0);
    assert.match(r.out, /line1\r?\nline2\r?\nline3\r?\nline4\r?\nline5/);
    assert.doesNotMatch(r.out, /omitted/);
    assert.match(r.out, /── test exit 0/);
});

test('runtest prints only the last 60 lines of long output', () => {
    const r = runtest('node "{wt}/gen.js" 200 0');
    assert.equal(r.status, 0);
    assert.match(r.out, /\.\.\. 140 earlier lines omitted/);
    assert.match(r.out, /line200/);
    assert.match(r.out, /line141\b/);
    assert.doesNotMatch(r.out, /line140\b/);
    assert.doesNotMatch(r.out, /line1\b/);
});

test('runtest passes a failing command exit status through', () => {
    const r = runtest('node "{wt}/gen.js" 200 3');
    assert.equal(r.status, 3);
    assert.match(r.out, /── test exit 3/);
});

test('runtest does not turn a successful command with huge output into a failure', () => {
    const r = runtest('node "{wt}/big.js" 80');
    assert.equal(r.status, 0, 'success must survive output larger than any capture buffer');
    assert.match(r.out, /done/);
    assert.match(r.out, /── test exit 0/);
});
