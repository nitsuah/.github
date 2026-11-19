// node --test imps/statusline.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vulnActive, vulnIdleLine, vulnRows, vulnDir, statusRows } from './statusline.mjs';
import { collect, compact, tiles, loopHealth } from './watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const nl = String.fromCharCode(10);
const home = () => mkdtempSync(join(tmpdir(), 'imps-statusline-'));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('loopHealth: ok under 75 min or with the lock, stale to 3 h, down after, with the skip reason', () => {
    const now = Date.now();
    const cyc = (ago) => ({ event: 'cycle', at: new Date(now - ago).toISOString() });
    assert.equal(loopHealth([cyc(10 * 60e3)], null, now).state, 'ok');
    assert.equal(loopHealth([cyc(2 * 3600e3)], null, now).state, 'stale');
    const down = loopHealth([cyc(5 * 3600e3), { event: 'skip', reason: '9router not up after 10 min' }], null, now);
    assert.equal(down.state, 'down');
    assert.match(down.skip, /9router not up/);
    assert.equal(loopHealth([cyc(5 * 3600e3)], { startedAt: now }, now).state, 'ok');
    assert.equal(loopHealth([cyc(5 * 3600e3), { event: 'skip', reason: 'previous cycle still running (lock < 3h old)' }], null, now).skip, null);
});

test('collect + tiles: running imps, PRs that need you, waiting PRs, queue and 24 h marks', () => {
    const h = home();
    mkdirSync(join(h, 'runs'));
    writeFileSync(join(h, 'dispatch.jsonl'), [
        { event: 'cycle', at: iso(60e3), queued: 4, picked: ['a#1'] },
        { event: 'pr', at: iso(50e3), url: 'https://github.com/o/a/pull/7' },
        { event: 'gate-fail', at: iso(40e3), reasons: ['tests exit 1'] },
        { event: 'fix-sweep', at: iso(30e3), pr: 'https://github.com/o/b/pull/9', result: 'needs-human' },
    ].map((e) => JSON.stringify(e)).join(nl) + nl);
    writeFileSync(join(h, 'runs.jsonl'), [
        { id: 'r1', repo: 'a', issue: 1, pr: 'https://github.com/o/a/pull/7', startedAt: iso(3600e3), endedAt: iso(60e3) },
        { id: 'r2', repo: 'b', issue: 2, pr: 'https://github.com/o/b/pull/9', startedAt: iso(3600e3), endedAt: iso(60e3) },
        { id: 'r3', repo: 'c', issue: 3, pr: 'https://github.com/o/c/pull/11', outcome: 'merged', startedAt: iso(3600e3), endedAt: iso(60e3) },
    ].map((e) => JSON.stringify(e)).join(nl) + nl);
    const d = collect(h);
    assert.deepEqual(d.prs.map((p) => [p.repo, p.needsYou]).sort(), [['a', false], ['b', true]]);
    assert.equal(tiles(d, { color: false }), '■ ■ □ □ □  ▪▪');
    const rows = compact(d, { color: false }).split(nl);
    assert.match(rows[0], /^○ imps idle · last cycle .* ago · ■ ■ □ □ □  ▪▪ · ⚠ 1 needs you · 24h 1 pr 1 fail/);
    assert.ok(rows.some((r) => /b PR #9 needs-human/.test(r)));
});

test('vuln section: full rows only while active, one dim line when idle', () => {
    const idle = { open: 0, running: 0, attention: [], merged: 11, lastTick: { t: iso(12 * 86400e3) } };
    assert.equal(vulnActive(idle), false);
    assert.equal(vulnIdleLine(idle, { color: false }), '○ vuln idle · 11 merged · train 12d ago');
    const busy = { open: 2, running: 1, attention: [{ r: { repo: 'o/fire', number: 5 }, a: { action: 'needs-human' } }], merged: 3, latest: new Map(), lastTick: { t: iso(60e3) } };
    assert.equal(vulnActive(busy), true);
    const rows = vulnRows(busy, { color: false, tiles: () => '■ ■' });
    assert.match(rows[0], /^● vuln · ■ ■ · 2 open · 1 worker · ⚠ 1 needs you · train 60s ago/);
    assert.match(rows[1], /fire#5 needs-human/);
});

test('statusRows: imps rows alone when there is no vuln checkout; vulnDir honours IMPS_VULN=0', async () => {
    const h = home();
    const out = await statusRows({ home: h, vuln: null, color: false });
    assert.match(out, /imps/);
    assert.equal(vulnDir({}, { IMPS_VULN: '0' }), null);
    assert.equal(vulnDir({ vuln: join(h, 'nope') }, {}), null);
});

test('statusline.mjs runs fast against an empty home and prints one block', () => {
    const h = home();
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [join(HERE, 'statusline.mjs'), '--no-color', '--home', h, '--vuln', join(h, 'none')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /imps/);
    assert.ok(Date.now() - t0 < 3000);
});
