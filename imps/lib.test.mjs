// node --test imps/*.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief, summarizeRun, errorKind, gate, report, pickIssues, briefFromComments, BRIEF_MARK } from './lib.mjs';

test('pickIssues: one per repo, skips repos with an imp PR, quiet repos first, respects wip', () => {
    const c = (repo, number, labels, createdAt) => ({ repo, number, labels, createdAt });
    const candidates = [
        c('fire', 1, ['enhancement'], '2026-10-01'), c('fire', 2, ['bug', 'bot:review'], '2026-10-05'),
        c('vigil', 3, ['bug'], '2026-10-02'), c('vhs', 4, ['bot:review'], '2026-10-03'), c('busy', 5, ['bot:review'], '2026-09-01'),
        c('darkmoon', 6, ['bug'], '2026-10-04'),
    ];
    const repos = {
        fire: { humanPRs: 0, impPRs: 0, lastCommitHours: 30 }, vigil: { humanPRs: 0, impPRs: 0, lastCommitHours: 48 },
        vhs: { humanPRs: 0, impPRs: 1, lastCommitHours: 50 }, busy: { humanPRs: 2, impPRs: 0, lastCommitHours: 1 },
        darkmoon: { humanPRs: 0, impPRs: 0, lastCommitHours: 2 },
    };
    const picked = pickIssues({ candidates, repos, max: 5, wip: 8 });
    assert.deepEqual(picked.map((i) => `${i.repo}#${i.number}`), ['fire#2', 'vigil#3', 'darkmoon#6', 'busy#5']);
    assert.equal(pickIssues({ candidates, repos, max: 5, wip: 3 }).length, 2); // 1 imp PR open, room for 2
    assert.equal(pickIssues({ candidates, repos, max: 1 }).length, 1);
});

test('briefFromComments takes the newest marked comment and strips a code fence', () => {
    const body = `${BRIEF_MARK}\n\`\`\`markdown\n---\nrepo: fire\nissue: 1\n---\nfix it\n\`\`\``;
    assert.equal(briefFromComments([{ body: 'hi' }, { body: `${BRIEF_MARK}\nold` }, { body }]), '---\nrepo: fire\nissue: 1\n---\nfix it\n');
    assert.equal(briefFromComments([{ body: 'no brief' }]), null);
    // Intro prose before the fence, CRLF from GitHub, and a fenced test: command inside.
    const withProse = `${BRIEF_MARK}\r\nImp brief (written by Opus triage).\r\n\r\n\`\`\`markdown\r\n---\r\nrepo: vigil\r\nissue: 277\r\n---\r\nbody\r\n\`\`\`\r\n`;
    assert.equal(briefFromComments([{ body: withProse }]), '---\nrepo: vigil\nissue: 277\n---\nbody\n');
});

test('parseBrief reads front matter and leaves the body', () => {
    const { meta, body } = parseBrief('---\nrepo: fire\nissue: 166\nallow: app/lib/, docs/CHANGELOG.md\n---\n## Issue\nfix it');
    assert.deepEqual(meta, { repo: 'fire', issue: '166', allow: 'app/lib/, docs/CHANGELOG.md' });
    assert.equal(body, '## Issue\nfix it');
    assert.deepEqual(parseBrief('no front matter').meta, {});
});

test('summarizeRun counts turns, tool errors, denials, tokens and model switches', () => {
    const ev = [
        { type: 'assistant', _ts: 1000, message: { model: 'a', content: [{ type: 'tool_use', name: 'Edit' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: '<tool_use_error>String to replace not found in file.' }] } },
        { type: 'system', subtype: 'permission_denied' },
        { type: 'assistant', _ts: 4000, message: { model: 'b', content: [{ type: 'tool_use', name: 'Read' }] } },
        { type: 'assistant', _ts: 5000, message: { model: 'a', content: [] } },
        { type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 3, duration_ms: 9000, total_cost_usd: 3.1,
            result: 'gave up', usage: { input_tokens: 700, output_tokens: 5, cache_read_input_tokens: 0 } },
    ];
    const s = summarizeRun(ev);
    assert.equal(s.turns, 3);
    assert.equal(s.toolErrors, 1);
    assert.deepEqual(s.errorKinds, { 'edit-miss': 1 });
    assert.equal(s.denials, 1);
    assert.deepEqual(s.served, ['a', 'b']);
    assert.equal(s.modelSwitches, 2);
    assert.deepEqual(s.tools, { Edit: 1, Read: 1 });
    assert.equal(s.tokens.input, 700);
    assert.equal(s.end, 'error_max_budget_usd');
    assert.deepEqual(s.turnMs, { max: 3000, median: 3000 });
});

test('errorKind buckets common tool failures', () => {
    assert.equal(errorKind('String to replace not found in file.'), 'edit-miss');
    assert.equal(errorKind('File has not been read yet. Read it first'), 'edit-unread');
    assert.equal(errorKind('Exit code 1\nnpm ERR!'), 'command-failed');
    assert.equal(errorKind('Permission to use Bash has been denied'), 'denied');
    assert.equal(errorKind('This command requires approval'), 'denied');
    assert.equal(errorKind('InputValidationError: Edit failed: The required parameter `new_string` is missing'), 'bad-tool-call');
    assert.equal(errorKind('Exit code 2 grep: C:Usersajharcode: No such file or directory'), 'missing-path');
    assert.equal(errorKind('something odd'), 'other');
});

const ok = 'fix(privacy): strip nav row\n\nFixes #166\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>';

test('gate passes a small in-scope tested diff', () => {
    const g = gate({ numstat: '6\t0\tapp/lib/privacy.js\n20\t0\tapp/lib/privacy.test.js\n1\t0\tdocs/CHANGELOG.md', commits: [ok], testExit: 0, maxLines: 40, allow: ['app/lib/', 'docs/CHANGELOG.md'] });
    assert.equal(g.pass, true, g.reasons.join());
    assert.equal(g.lines, 27);
});

test('gate fails on size, scope, deny paths, trailer and tests', () => {
    const g = gate({
        numstat: '70\t59\tapp/lib/privacy.js\n1\t0\t.github/workflows/x.yml\n3\t1\tapp/app.js',
        commits: ['fix: x'], testExit: 1, maxLines: 40, allow: ['app/lib/'],
    });
    assert.equal(g.pass, false);
    assert.ok(g.reasons.includes('diff 134 lines > 40'));
    assert.ok(g.reasons.includes('denied path .github/workflows/x.yml'));
    assert.ok(g.reasons.includes('outside scope app/app.js'));
    assert.ok(g.reasons.includes('commit missing imp trailer'));
    assert.ok(g.reasons.includes('tests exit 1'));
    assert.deepEqual(gate({ numstat: '', commits: [], testExit: null }).reasons, ['no commits', 'tests not run']);
    assert.ok(gate({ numstat: '1\t0\tyarn.lock\n1\t0\tsub/pnpm-lock.yaml', commits: [ok], testExit: 0 }).reasons.includes('denied path yarn.lock'));
    assert.ok(gate({ numstat: '1\t0\tsub/pnpm-lock.yaml', commits: [ok], testExit: 0 }).reasons.includes('denied path sub/pnpm-lock.yaml'));
    assert.ok(gate({ numstat: '1\t0\ta.js', commits: [ok], testExit: 0, maxLines: NaN }).reasons.includes('diff 1 lines > NaN'));
    // A runner formatter commit counts for scope, not for the size budget.
    const f = gate({ numstat: '30\t0\tapp/lib/a.js\n14\t0\tapp/lib/b.js', sizeNumstat: '26\t0\tapp/lib/a.js\n14\t0\tapp/lib/b.js', commits: [ok], testExit: 0, maxLines: 40, allow: ['app/lib/'] });
    assert.equal(f.pass, true, f.reasons.join());
    assert.equal(f.lines, 40);
});

test('report tallies runs, tokens, error kinds and recurring gate failures', () => {
    const rows = [
        { id: 'r1', repo: 'fire', issue: 166, model: 'MAX', metrics: { turns: 47, served: ['a', 'b'], tokens: { input: 788, cacheRead: 0, output: 5 }, errorKinds: { 'edit-miss': 7 } }, gate: { pass: false, reasons: ['diff 129 lines > 40'] } },
        { id: 'r2', repo: 'fire', issue: 166, model: 'MAX', metrics: { turns: 12, served: ['a'], tokens: { input: 100, cacheRead: 50, output: 9 }, errorKinds: { 'edit-miss': 1 } }, gate: { pass: true, reasons: [] }, outcome: 'merged' },
    ];
    const out = report(rows);
    assert.match(out, /runs 2 · gate pass 1 · merged 1/);
    assert.match(out, /tokens in 888 \(cache read 50\) · out 14/);
    assert.match(out, /edit-miss 8/);
    assert.match(out, /diff N lines > N ×1/);
    assert.match(out, /\| r1 \| fire#166 \|/);
});
