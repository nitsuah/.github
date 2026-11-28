// node --test imps/bugbot-statusline.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugbotSummary, bugbotActive } from './bugbot-lib.mjs';
import { bugbotRows } from './statusline.mjs';

const NOW = Date.parse('2026-11-21T20:00:00Z');
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const PR = (n) => `https://github.com/nitsuah/fire/pull/${n}`;

const events = [
    { event: 'bugbot-review', pr: PR(1), sha: 'a', verdict: 'request_changes', counts: { blocker: 1, major: 1 }, at: at(50) },
    { event: 'bugbot-review', pr: PR(2), sha: 'b', verdict: 'comment', partial: true, counts: {}, at: at(40) },
    { event: 'bugbot-review', pr: PR(3), sha: 'c', verdict: 'request_changes', counts: { major: 1 }, at: at(30) },
    { event: 'bugbot-verdict-cleared', pr: PR(3), sha: 'c', at: at(20) },
    { event: 'bugbot-review', pr: PR(4), sha: 'd', verdict: 'approve', counts: {}, at: at(10) },
    { event: 'bugbot-thread', decision: 'accept', at: at(9) },
    { event: 'bugbot-thread', decision: 'keep', at: at(8) },
    { event: 'bugbot-dismiss', pr: PR(4), at: at(5) },
    { event: 'bugbot-review', pr: PR(9), sha: 'z', verdict: 'request_changes', at: at(3), dryRun: true },
    { event: 'bugbot-review', pr: PR(8), sha: 'y', verdict: 'request_changes', at: at(25 * 60) },
];

test('bugbotSummary: 24 h counts, dry runs and old events left out, cleared verdicts not blocking', () => {
    const s = bugbotSummary(events, NOW);
    assert.equal(s.reviews, 4);
    assert.equal(s.changes, 2);
    assert.equal(s.partial, 1);
    assert.equal(s.passed, 1);
    assert.deepEqual([s.accepted, s.kept, s.lifted], [1, 1, 1]);
    assert.deepEqual(s.blocked.map((b) => b.pr), ['fire#1', 'fire#2']);
    assert.equal(s.blocked[0].why, '2 blocking');
    assert.equal(s.blocked[1].why, 'partial');
});

test('bugbotSummary: only PRs the last sweep saw open can be blocked', () => {
    const s = bugbotSummary(events, NOW, { open: new Set([PR(2)]) });
    assert.deepEqual(s.blocked.map((b) => b.pr), ['fire#2']);
});

test('bugbotRows: full rows while busy or blocking, one dim line when idle', () => {
    const busy = bugbotRows(bugbotSummary(events, NOW), { color: false, now: NOW });
    assert.match(busy[0], /^● bugbot · 24h 4 reviews · 2 ⛔ · 1 ✓ · 1 partial · threads 1✓ 1✗ · 1 CodeRabbit block lifted/);
    assert.match(busy[1], /✗ fire#1 2 blocking │ fire#2 partial/);

    const quiet = bugbotSummary([{ event: 'bugbot-review', pr: PR(4), verdict: 'approve', at: at(120) }], NOW);
    assert.equal(bugbotActive(quiet, NOW), false);
    assert.deepEqual(bugbotRows(quiet, { color: false, now: NOW }), ['○ bugbot idle · 24h 1 review · 0 lifted · last 2h ago']);
});

test('a sweep heartbeat shows as "swept" but is not activity', () => {
    const s = bugbotSummary([
        { event: 'bugbot-review', pr: PR(4), verdict: 'approve', at: at(120) },
        { event: 'bugbot-sweep', prs: 7, acted: 0, at: at(3) },
    ], NOW);
    assert.equal(bugbotActive(s, NOW), false);
    assert.deepEqual(bugbotRows(s, { color: false, now: NOW }), ['○ bugbot idle · 24h 1 review · 0 lifted · last 2h ago · swept 3m ago']);
});
