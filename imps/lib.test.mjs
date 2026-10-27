// node --test imps/*.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief, summarizeRun, errorKind, gate, report, pickIssues, repoTable, tokenTable, triageWork, briefFromComments, BRIEF_MARK, parseReview, renderReview,
    feedbackItems, shouldAskCodeRabbitApprove, parseFixDecisions, latestDecisiveReviews, loopBudget, shouldAutoCommit, prGuard, staleImpLabels, STALE_ON_CLOSE } from './lib.mjs';

test('loopBudget counts the last 24 h and cools down a repo after two straight gate failures', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const run = (id, repo, at, pass) => ({ id, repo, startedAt: at, gate: pass == null ? undefined : { pass } });
    const rows = [
        run('imp_1', 'vhs', '2026-10-23T09:00:00Z', false), run('imp_2', 'vhs', '2026-10-23T10:00:00Z', false),
        run('imp_3', 'fire', '2026-10-23T09:00:00Z', false), run('imp_4', 'fire', '2026-10-23T10:00:00Z', true),
        run('imp_5', 'vigil', '2026-10-21T09:00:00Z', false), run('imp_6', 'vigil', '2026-10-21T10:00:00Z', false),
        { id: 'imp_manual_x_1', repo: 'vhs', startedAt: '2026-10-23T11:00:00Z', ingested: true },
    ];
    const b = loopBudget(rows, now);
    assert.equal(b.runsLast24h, 4);
    assert.deepEqual(Object.keys(b.cooldown), ['vhs']); // vigil's failures are older than 24 h; fire's last run passed
    const cands = [{ repo: 'vhs', number: 1, labels: [], createdAt: '1' }, { repo: 'fire', number: 2, labels: [], createdAt: '2' }];
    assert.deepEqual(pickIssues({ candidates: cands, repos: {}, ...b }).map((i) => i.repo), ['fire']);
    assert.equal(pickIssues({ candidates: cands, repos: {}, dailyCap: 4, runsLast24h: 4 }).length, 0);
});

test('latestDecisiveReviews ignores COMMENTED, like GitHub reviewDecision', () => {
    const latest = latestDecisiveReviews([
        { author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED' },
        { author: { login: 'nitsuah' }, state: 'COMMENTED' },
        { author: { login: 'coderabbitai' }, state: 'COMMENTED' },
    ]);
    assert.deepEqual(latest, { coderabbitai: 'CHANGES_REQUESTED' });
    assert.equal(shouldAskCodeRabbitApprove({ reviewDecision: 'CHANGES_REQUESTED', latestBy: latest, threads: [{ isResolved: true }], checks: [{ name: 'test', state: 'SUCCESS' }] }), true);
});

test('feedbackItems keeps real feedback and drops the noise', () => {
    const items = feedbackItems({
        threads: [
            { id: 'T1', isResolved: false, path: 'a.js', line: 3, comments: [{ databaseId: 11, author: 'coderabbitai', body: '<!-- x -->**Bug**: off by one' }] },
            { id: 'T2', isResolved: true, comments: [{ databaseId: 12, author: 'coderabbitai', body: 'old' }] },
            { id: 'T3', isResolved: false, isOutdated: true, comments: [{ databaseId: 13, author: 'coderabbitai', body: 'stale' }] },
            { id: 'T4', isResolved: false, comments: [{ databaseId: 14, author: 'coderabbitai', body: 'q' }, { databaseId: 15, author: 'nitsuah', body: '<!-- imp-fix -->\nPushed back: …' }] },
        ],
        comments: [
            { id: 1, author: 'coderabbitai[bot]', body: '## Review limit reached' },
            { id: 2, author: 'netlify[bot]', body: 'Deploy Preview ready' },
            { id: 3, author: 'nitsuah', body: '<!-- imp-review -->\n### Imp review' },
            { id: 4, author: 'nitsuah', body: '@coderabbitai approve' },
            { id: 5, author: 'nitsuah', body: 'Please also handle the empty list case', createdAt: '2026-10-22T09:00:00Z' },
            { id: 6, author: 'nitsuah', body: 'handled already', createdAt: '2026-10-22T07:00:00Z' },
        ],
        checks: [{ name: 'test', state: 'FAILURE' }, { name: 'Pages changed - lifefire', state: 'FAILURE' }, { name: 'lint', state: 'SUCCESS' }],
        impReview: { verdict: 'request_changes', findings: [{ severity: 'major', file: 'b.js', line: 2, title: 'Breaks caller', detail: 'd' }, { severity: 'nit', title: 'n' }] },
        since: '2026-10-22T08:00:00Z',
    });
    assert.deepEqual(items.map((i) => i.id), ['T1', 'c5', 'r0', 'ci:test']);
    assert.equal(items[0].author, 'coderabbitai');
    assert.match(items[0].text, /^coderabbitai: \*\*Bug\*\*: off by one$/);
    assert.equal(feedbackItems({ impReview: { verdict: 'request_changes', handled: true, findings: [{ severity: 'major', title: 'x' }] } }).length, 0);
});

test('shouldAskCodeRabbitApprove only when CodeRabbit alone blocks and everything is clean', () => {
    const ok = { reviewDecision: 'CHANGES_REQUESTED', latestBy: { 'coderabbitai[bot]': 'CHANGES_REQUESTED' }, threads: [{ isResolved: true }], checks: [{ name: 'test', state: 'SUCCESS' }, { name: 'CodeRabbit', state: 'PENDING' }] };
    assert.equal(shouldAskCodeRabbitApprove(ok), true);
    assert.equal(shouldAskCodeRabbitApprove({ ...ok, askedAt: 'x' }), false);
    assert.equal(shouldAskCodeRabbitApprove({ ...ok, latestBy: { ...ok.latestBy, nitsuah: 'CHANGES_REQUESTED' } }), false);
    assert.equal(shouldAskCodeRabbitApprove({ ...ok, threads: [{ isResolved: false }] }), false);
    assert.equal(shouldAskCodeRabbitApprove({ ...ok, checks: [{ name: 'test', state: 'FAILURE' }] }), false);
    assert.equal(shouldAskCodeRabbitApprove({ ...ok, reviewDecision: 'APPROVED' }), false);
});

test('parseFixDecisions maps answers onto items and defaults the rest to skip', () => {
    const items = [{ id: 'T1', kind: 'thread' }, { id: 'c5', kind: 'comment' }, { id: 'ci:test', kind: 'ci' }];
    const text = '```json\n{"decisions":[{"id":"T1","action":"fix","reply":"Fixed the bound."},{"id":"c5","action":"pushback","reply":"Out of scope: #12 tracks it."},{"id":"zzz","action":"fix"}]}\n```';
    const d = parseFixDecisions(text, items);
    assert.deepEqual(d.map((x) => [x.id, x.action, x.answered]), [['T1', 'fix', true], ['c5', 'pushback', true], ['ci:test', 'skip', false]]);
    assert.equal(d[2].reply, 'Not addressed in this round.');
    assert.deepEqual(parseFixDecisions('garbage', items).map((x) => x.action), ['skip', 'skip', 'skip']);
});

test('parseReview takes the last json block and recomputes the verdict from findings', () => {
    const text = 'thinking…\n```json\n{"verdict":"approve","findings":[]}\n```\nthen\n```json\n' +
        JSON.stringify({ verdict: 'approve', summary: 'Fixes it.', findings: [
            { severity: 'major', file: 'a.ts', line: 3, title: 'Breaks caller', detail: 'x' },
            { severity: 'weird', file: 'b.ts', title: 'Unknown severity becomes minor' },
            { severity: 'nit', title: 'spacing' },
            { detail: 'no title, dropped' },
        ] }) + '\n```';
    const rv = parseReview(text);
    assert.equal(rv.verdict, 'request_changes'); // model said approve; a major finding wins
    assert.equal(rv.modelVerdict, 'approve');
    assert.deepEqual(rv.counts, { blocker: 0, major: 1, minor: 1, nit: 1 });
    assert.equal(rv.findings[1].severity, 'minor');
    assert.equal(parseReview('```json\n{"findings":[{"severity":"nit","title":"n"}]}\n```').verdict, 'approve');
    assert.equal(parseReview('```json\n{"findings":[{"severity":"minor","title":"m"}]}\n```').verdict, 'comment');
    assert.match(parseReview('no block').error, /no json block/);
    assert.match(parseReview('```json\n{oops\n```').error, /unparseable/);
});

test('renderReview has the marker, a findings table, and escapes pipes', () => {
    const rv = parseReview('```json\n{"summary":"S","findings":[{"severity":"major","file":"x.js","line":9,"title":"a|b","detail":"d"}]}\n```');
    const md = renderReview(rv, { runId: 'imp_1', model: 'MAX', served: ['m'], turns: 4, minutes: '1.0' });
    assert.match(md, /^<!-- imp-review -->/);
    assert.match(md, /Changes needed/);
    assert.match(md, /\| \*\*major\*\* \| a\\\|b \| `x\.js:9` \|/);
    assert.match(md, /never approves or merges/);
});

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

test('pickIssues: perRepo allows several per repo, counting open imp PRs', () => {
    const c = (repo, number, labels, createdAt) => ({ repo, number, labels, createdAt });
    const candidates = [c('fire', 1, ['bug'], '2026-10-01'), c('fire', 2, ['bug'], '2026-10-02'), c('fire', 3, ['bug'], '2026-10-03'), c('vhs', 4, ['bug'], '2026-10-04')];
    const repos = { fire: { impPRs: 0, lastCommitHours: 30 }, vhs: { impPRs: 1, lastCommitHours: 30 } };
    const ids = (o) => pickIssues({ candidates, repos, max: 5, wip: 8, ...o }).map((i) => i.number).sort();
    assert.deepEqual(ids({ perRepo: 2 }), [1, 2, 4]); // fire gets two, vhs has one open so one more
    assert.deepEqual(ids({}), [1]); // default 1: vhs is full, fire gets one
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

test('triageWork: idle when nothing is open, otherwise says why', () => {
    assert.deepEqual(triageWork({}), { work: false, reasons: [], unbriefed: [] });
    const issue = (o) => ({ repo: 'fire', number: 1, title: 'x', labels: ['bug'], comments: [], ...o });
    assert.equal(triageWork({ issues: [issue({ comments: ['<!-- imp-triage -->'] })] }).work, false);
    assert.equal(triageWork({ issues: [issue({ labels: ['bug', 'imp:ready'] })] }).work, false);
    assert.equal(triageWork({ issues: [issue({ repo: 'kryptos' }), issue({ title: 'Revisit: foo' })] }).work, false);
    assert.deepEqual(triageWork({ issues: [issue({ number: 7 })] }).unbriefed, ['fire#7']);
    const r = triageWork({ impPRs: [{ labels: ['imp'] }, { labels: ['imp', 'imp:needs-human'] }], failed: [issue({})] });
    assert.equal(r.reasons.length, 3);
});

test('summarizeRun records context size, first edit and whether tokens were metered', () => {
    const asst = (name) => ({ type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', name, input: {} }] } });
    const killed = summarizeRun([{ type: 'system', subtype: 'init', tools: [1, 2], slash_commands: [], skills: [] }, asst('Read'), asst('Edit')]);
    assert.deepEqual(killed.init, { tools: 2, slashCommands: 0, skills: 0 });
    assert.equal(killed.firstEditTurn, 2);
    assert.equal(killed.unmetered, true); // no result event: no usage numbers
    const done = summarizeRun([asst('Read'), { type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 5 } }]);
    assert.equal(done.unmetered, false);
    assert.equal(done.firstEditTurn, null);
});

test('repoTable counts issues, bugs, PRs and imp labels per repo, with a total row', () => {
    const issue = (repo, ...labels) => ({ repository: { name: repo }, labels: labels.map((name) => ({ name })) });
    const t = repoTable([issue('fire', 'bug', 'imp:ready'), issue('fire'), issue('vhs', 'bug', 'imp:failed')], [{ repository: { name: 'fire' }, labels: [{ name: 'imp' }] }]);
    assert.deepEqual(t[0], { repo: 'fire', issues: 2, bugs: 1, prs: 1, impPrs: 1, ready: 1, failed: 0 });
    assert.deepEqual(t.at(-1), { repo: 'TOTAL', issues: 3, bugs: 2, prs: 1, impPrs: 1, ready: 1, failed: 1 });
});

test('tokenTable estimates killed runs from the median input per turn and totals the waste', () => {
    const run = (id, m, gate) => ({ id, repo: 'r', issue: 1, startedAt: '2026-10-23T00:00:00Z', metrics: m, gate });
    const ok = run('imp_1', { turns: 10, toolTurns: 10, unmetered: false, tokens: { input: 300_000 }, durationMs: 60000 }, { pass: true });
    const killed = run('imp_2', { turns: 0, toolTurns: 40, unmetered: true, tokens: { input: 0 }, end: 'killed-max-turns' }, undefined);
    const t = tokenTable([ok, killed]);
    assert.equal(t.medianInPerTurn, 30_000);
    assert.equal(t.lines[1].input, 1_200_000);
    assert.equal(t.lines[1].estimated, true);
    assert.equal(t.totals.wastedInput, 1_200_000);
});


test('shouldAutoCommit salvages a verified but uncommitted run (#54)', () => {
    assert.equal(shouldAutoCommit({ impCommits: 0, dirty: true, testExit: 0 }), true);
    assert.equal(shouldAutoCommit({ impCommits: 0, dirty: false, testExit: 0 }), false);
    assert.equal(shouldAutoCommit({ impCommits: 0, dirty: true, testExit: 1 }), false);
    assert.equal(shouldAutoCommit({ impCommits: 1, dirty: true, testExit: 0 }), false);
    assert.equal(shouldAutoCommit({}), false);
});

test('gate collapses uncommitted edits into one reason (#53)', () => {
    assert.deepEqual(gate({ numstat: '', commits: [], testExit: 0, dirty: true }).reasons, ['edits left uncommitted']);
    assert.deepEqual(gate({ numstat: '', commits: [], testExit: 0 }).reasons, ['no commits']);
    assert.deepEqual(gate({ numstat: '', commits: [], testExit: null, dirty: false }).reasons, ['no commits', 'tests not run']);
    const g = gate({ numstat: '1\t0\ta.js', commits: [], testExit: 0, dirty: true });
    assert.equal(g.pass, false);
    assert.deepEqual(g.reasons, ['edits left uncommitted']);
});

test('gate denies the kit defaults and imps-config at any depth (#57)', () => {
    const ok = 'fix: x\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>';
    for (const p of ['.github/imps-config.yml', 'imps/defaults.mjs', 'config/imps-config.yaml']) {
        const g = gate({ numstat: `1\t0\t${p}`, commits: [ok], testExit: 0 });
        assert.ok(g.reasons.includes(`denied path ${p}`), `${p} not denied: ${g.reasons.join()}`);
        assert.equal(g.pass, false);
    }
    assert.equal(gate({ numstat: '1\t0\timps/lib.mjs', commits: [ok], testExit: 0 }).pass, true);
});

test('prGuard refuses a closed or unknown issue (#56)', () => {
    assert.deepEqual(prGuard({ issue: { number: 54, state: 'CLOSED' } }), { ok: false, reason: 'issue #54 is closed' });
    assert.deepEqual(prGuard({ issue: { number: 54 } }), { ok: false, reason: 'cannot confirm issue #54 is open' });
    assert.deepEqual(prGuard({}), { ok: false, reason: 'cannot confirm issue #? is open' });
    assert.deepEqual(prGuard(), { ok: false, reason: 'cannot confirm issue #? is open' });
    assert.deepEqual(prGuard({ issue: { number: 54, state: 'OPEN' } }), { ok: true });
});

test('staleImpLabels strips state labels but keeps imp:pr (#58)', () => {
    const want = ['imp:ready', 'imp:working', 'imp:failed', 'imp:needs-human'];
    assert.deepEqual(staleImpLabels(want.map((name) => ({ name }))), want);
    assert.deepEqual(staleImpLabels(want), want);
    assert.deepEqual(staleImpLabels([{ name: 'imp:pr' }, 'imp:pr', 'bug', { name: 'docs' }, { name: 'imp:ready' }]), ['imp:ready']);
    assert.deepEqual(staleImpLabels(['bug', 'imp:failed', 'imp:pr']), ['imp:failed']);
    assert.deepEqual(staleImpLabels([{ name: 'imp:ready' }]), ['imp:ready']);
    assert.deepEqual(staleImpLabels(['imp:pr']), []);
    assert.deepEqual(staleImpLabels([]), []);
    assert.deepEqual(staleImpLabels(), []);
    assert.deepEqual(staleImpLabels(undefined), []);
});
