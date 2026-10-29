// node --test imps/watch.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render } from './watch.mjs';

const WATCH = join(dirname(fileURLToPath(import.meta.url)), 'watch.mjs');
const NOW = Date.parse('2026-10-28T22:10:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const jl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

const home = () => mkdtempSync(join(tmpdir(), 'imps-watch-'));
const put = (h, name, text) => { mkdirSync(dirname(join(h, name)), { recursive: true }); writeFileSync(join(h, name), text); };
const frame = (h, o = {}) => render(collect(h, NOW), { color: false, ...o });
const cycle = (min, picked = ['vhs#102']) => ({ at: at(min), event: 'cycle', queued: 7, picked });
const toolUse = (name, input, ts) => ({ type: 'assistant', _ts: ts, message: { content: [{ type: 'tool_use', name, input }] } });

test('idle: no lock, last cycle, quota, no lanes', () => {
    const h = home();
    put(h, 'dispatch.jsonl', jl([cycle(50), { at: at(49), event: 'done' }]));
    put(h, 'model_quota.json', JSON.stringify({ MAX: { used: 3, window: 1 }, other: { used: 0, window: 1 } }));
    const out = frame(h);
    assert.match(out, /^○ imps idle │ queue 7 (6 waiting) │ picked 1 │ last cycle 50m00s ago │ quota MAX 3/);
    assert.doesNotMatch(out, /other/);
    rmSync(h, { recursive: true });
});

test('one running imp: lock elapsed, lane with turns, errors and last tool', () => {
    const h = home();
    put(h, 'dispatch.lock', JSON.stringify({ pid: process.pid, startedAt: at(4) }));
    put(h, 'dispatch.jsonl', jl([cycle(4)]));
    put(h, 'runs.jsonl', jl([{ id: 'imp_a', repo: 'vhs', issue: 102, pid: process.pid, startedAt: at(3.2), metrics: { turns: 14, toolErrors: 0 } }]));
    put(h, 'runs/imp_a.jsonl', jl([toolUse('Read', { file_path: 'C:\\x\\a.js' }, 1), toolUse('Edit', { file_path: 'C:\\x\\src\\auth.js', old_string: 'SECRET' }, 2)]));
    const out = frame(h);
    assert.match(out, /^● imps running 4m00s/);
    assert.match(out, /vhs#102\s+3m12s\s+t14\s+e0 Edit auth\.js/);
    assert.doesNotMatch(out, /SECRET/);
    rmSync(h, { recursive: true });
});

test('tool detail: Bash shows only the first token, long patterns are cut, control chars stripped', () => {
    const h = home();
    put(h, 'runs.jsonl', jl([{ id: 'imp_b', repo: 'r', issue: 1, startedAt: at(1), metrics: {} }]));
    put(h, 'runs/imp_b.jsonl', jl([toolUse('Bash', { command: 'curl -H "Authorization: Bearer abc123" https://x' }, NOW)]));
    assert.match(frame(h), /Bash curl$/m);
    put(h, 'runs/imp_b.jsonl', jl([toolUse('Grep', { pattern: `a\x1b[31m${'z'.repeat(80)}` }, 1)]));
    const out = frame(h);
    assert.doesNotMatch(out, /\x1b/);
    assert.match(out, /Grep az+…/);
    rmSync(h, { recursive: true });
});

test('finished imp with PR: not a lane, pr event is green-numbered', () => {
    const h = home();
    put(h, 'runs.jsonl', jl([{ id: 'imp_c', repo: 'vhs', issue: 102, startedAt: at(9), endedAt: at(5), metrics: { turns: 11 }, pr: 'https://github.com/nitsuah/vhs/pull/103' }]));
    put(h, 'dispatch.jsonl', jl([cycle(9), { at: at(4), event: 'pr', repo: 'vhs', number: 102, id: 'imp_c', url: 'https://github.com/nitsuah/vhs/pull/103' }, { at: at(4), event: 'done' }]));
    const out = frame(h);
    assert.doesNotMatch(out, /t11/);
    assert.match(out, /✓ PR #103 vhs#102 4m00s ago/);
    assert.match(render(collect(h, NOW), { color: true }), /\x1b\[32m✓ PR #103/);
    rmSync(h, { recursive: true });
});

test('gate-fail is red with reasons; fix-sweep is cyan', () => {
    const h = home();
    put(h, 'dispatch.jsonl', jl([
        cycle(20),
        { at: at(10), event: 'gate-fail', repo: 'vhs', number: 102, reasons: ['no commits', 'tests not run'] },
        { at: at(2), event: 'fix-sweep', pr: 'https://github.com/nitsuah/vhs/pull/103', result: 'pushed' },
    ]));
    const color = render(collect(h, NOW), { color: true });
    assert.match(color, /\x1b\[31m✗ gate-fail\x1b\[0m vhs#102 .*no commits, tests not run/);
    assert.match(color, /\x1b\[36m↻ fix-sweep #103/);
    assert.ok(color.indexOf('fix-sweep') < color.indexOf('gate-fail'), 'newest first');
    rmSync(h, { recursive: true });
});

test('missing files and a bad home render a calm frame, never throw', () => {
    const out = frame(join(tmpdir(), 'imps-watch-does-not-exist'));
    assert.match(out, /^○ imps idle\nno dispatch events yet$/);
});

test('truncated last line and garbage lines are ignored', () => {
    const h = home();
    put(h, 'dispatch.jsonl', `${jl([cycle(5)])}not json\n{"at":"${at(1)}","event":"gate-fa`);
    put(h, 'runs.jsonl', `${jl([{ id: 'imp_d', repo: 'vhs', issue: 5, startedAt: at(2), metrics: { turns: 2 } }])}{"id":"imp_e","repo":"x","iss`);
    put(h, 'runs/imp_d.jsonl', `${jl([toolUse('Glob', { pattern: '**/*.js' }, 1)])}{"type":"assistant","message":{"content":[{"type":"tool_use","na`);
    const out = frame(h);
    assert.match(out, /vhs#5\s+2m00s\s+t2\s+e0 Glob \*\*\/\*\.js/);
    assert.doesNotMatch(out, /imp_e|gate-fa/);
    rmSync(h, { recursive: true });
});

test('dead pid or old unfinished row is not a lane', () => {
    const h = home();
    put(h, 'runs.jsonl', jl([
        { id: 'imp_old', repo: 'a', issue: 1, startedAt: at(60 * 8), metrics: {} },
        { id: 'imp_dead', repo: 'b', issue: 2, pid: 2 ** 22 + 12345, startedAt: at(2), metrics: {} },
    ]));
    assert.doesNotMatch(frame(h), /a#1|b#2/);
    rmSync(h, { recursive: true });
});

test('throughput: 24h pr/fail counts, top gate reason, budget and cooldown in the header', () => {
    const h = home();
    put(h, 'dispatch.jsonl', jl([
        { at: at(60 * 30), event: 'gate-fail', repo: 'old', number: 1, reasons: ['too old'] },
        { at: at(50), event: 'gate-fail', repo: 'a', number: 1, reasons: ['tests not run', 'no commits'] },
        { at: at(40), event: 'gate-fail', repo: 'b', number: 2, reasons: ['tests not run'] },
        { at: at(30), event: 'pr', repo: 'c', number: 3, url: 'https://github.com/x/c/pull/9' },
        { ...cycle(5), queued: 6, picked: ['a#1', 'b#2'], runsLast24h: 3, cooldown: { vhs: {} } },
    ]));
    const out = frame(h);
    assert.match(out, /queue 6 \(4 waiting\) │ picked 2 │ runs 3\/24h │ cooldown vhs/);
    assert.match(out, /24h: 1 pr 2 fail · top: tests not run ×2/);
    assert.doesNotMatch(out, /too old/);
    rmSync(h, { recursive: true });
});

test('stall: a lane with no transcript activity for over 2 minutes is flagged', () => {
    const h = home();
    put(h, 'runs.jsonl', jl([{ id: 'imp_s', repo: 'vhs', issue: 1, startedAt: at(10), metrics: { turns: 4 } }]));
    put(h, 'runs/imp_s.jsonl', jl([toolUse('Read', { file_path: 'a.js' }, NOW - 5 * 60000)]));
    assert.match(frame(h), /Read a\.js stalled 5m00s/);
    put(h, 'runs/imp_s.jsonl', jl([toolUse('Read', { file_path: 'a.js' }, NOW - 20000)]));
    assert.doesNotMatch(frame(h), /stalled/);
    rmSync(h, { recursive: true });
});

test('--statusline: does not wait for stdin, prints the rows, writes nothing', () => {
    const h = home();
    put(h, 'dispatch.jsonl', jl([cycle(5)]));
    const r = spawnSync(process.execPath, [WATCH, '--statusline', '--no-color', '--home', h], { input: undefined, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /imps idle/);
    assert.equal(r.stderr, '');
    rmSync(h, { recursive: true });
});

test('--once prints one frame without a TTY', () => {
    const h = home();
    put(h, 'dispatch.jsonl', jl([cycle(5)]));
    const r = spawnSync(process.execPath, [WATCH, '--once', '--no-color', '--home', h], { encoding: 'utf8', timeout: 5000 });
    assert.match(r.stdout, /imps idle/);
    rmSync(h, { recursive: true });
});

test('latency: a 50k-line dispatch.jsonl and big ledger render in under 100 ms', () => {
    const h = home();
    const rows = [];
    for (let i = 0; i < 50000; i++) rows.push({ at: at(1000 - i / 100), machine: 'M', kitSha: 'abc', event: i % 7 === 0 ? 'gate-fail' : 'cycle', repo: 'vhs', number: i, queued: 7, picked: ['vhs#1'] });
    put(h, 'dispatch.jsonl', jl(rows));
    put(h, 'runs.jsonl', jl(Array.from({ length: 5000 }, (_, i) => ({ id: `imp_${i}`, repo: 'vhs', issue: i, startedAt: at(900), endedAt: at(899), metrics: { turns: 3 } }))));
    collect(h, NOW); // warm the JIT like the long-lived tests above would
    const t0 = performance.now();
    const out = frame(h);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `render took ${ms.toFixed(1)} ms`);
    assert.match(out, /queue 7/);
    rmSync(h, { recursive: true });
});
