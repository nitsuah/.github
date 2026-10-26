// Pure helpers for imps: brief parsing, run metrics, the pre-push gate and
// the RSI report. No I/O, no deps. Tested in lib.test.mjs (node --test).

// A brief is markdown with an optional `---` front matter of `key: value`
// lines (repo, issue, test, maxLines, allow). Returns { meta, body }.
export function parseBrief(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
    }
    return { meta, body: text.slice(m[0].length) };
}

// One pass over a `claude -p --output-format stream-json` transcript.
// Everything the RSI loop wants per run: turns and their timing, tool use and
// tool errors by kind, permission denials, tokens, served models (and how
// often the router switched model mid-run), and how the run ended.
export function summarizeRun(events, { startedAt, endedAt } = {}) {
    const s = {
        turns: 0, tools: {}, toolErrors: 0, errorKinds: {}, denials: 0,
        served: [], modelSwitches: 0, turnMs: { max: 0, median: 0 },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costEstimateUsd: null, end: 'no-result', isError: true, durationMs: null, finalText: '',
        // How big the per-turn context was, and how long the worker explored before its first edit.
        init: null, firstEditTurn: null, unmetered: true,
    };
    let toolTurn = 0;
    const stamps = [];
    let last = null;
    for (const e of events) {
        if (e.type === 'assistant') {
            const model = e.message?.model;
            if (model) {
                if (!s.served.includes(model)) s.served.push(model);
                if (last && model !== last) s.modelSwitches++;
                last = model;
            }
            if (e._ts) stamps.push(e._ts);
            const uses = (e.message?.content || []).filter((c) => c.type === 'tool_use');
            if (uses.length) toolTurn++;
            for (const c of uses) {
                s.tools[c.name] = (s.tools[c.name] || 0) + 1;
                if (s.firstEditTurn == null && (c.name === 'Edit' || c.name === 'Write')) s.firstEditTurn = toolTurn;
            }
        } else if (e.type === 'user') {
            for (const c of e.message?.content || []) {
                if (c.type !== 'tool_result' || !c.is_error) continue;
                s.toolErrors++;
                const k = errorKind(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
                s.errorKinds[k] = (s.errorKinds[k] || 0) + 1;
            }
        } else if (e.type === 'system' && e.subtype === 'init') {
            s.init = { tools: (e.tools || []).length, slashCommands: (e.slash_commands || []).length, skills: (e.skills || []).length };
        } else if (e.type === 'system' && e.subtype === 'permission_denied') {
            s.denials++;
        } else if (e.type === 'result') {
            s.turns = e.num_turns ?? s.turns;
            s.end = e.subtype || 'result';
            s.isError = !!e.is_error;
            s.durationMs = e.duration_ms ?? null;
            s.costEstimateUsd = e.total_cost_usd ?? null;
            s.finalText = String(e.result ?? '').slice(0, 2000);
            const u = e.usage || {};
            s.unmetered = false;
            s.tokens = {
                input: u.input_tokens || 0,
                output: u.output_tokens || 0,
                cacheRead: u.cache_read_input_tokens || 0,
                cacheWrite: u.cache_creation_input_tokens || 0,
            };
        }
    }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    if (gaps.length) s.turnMs = { max: gaps[gaps.length - 1], median: gaps[Math.floor(gaps.length / 2)] };
    if (s.durationMs == null && startedAt && endedAt) s.durationMs = endedAt - startedAt;
    return s;
}

// Coarse buckets so errors aggregate across runs.
export function errorKind(text = '') {
    if (/String to replace not found/i.test(text)) return 'edit-miss';
    if (/File has not been read yet|must read/i.test(text)) return 'edit-unread';
    if (/InputValidationError|No changes to make/i.test(text)) return 'bad-tool-call';
    if (/permission|not allowed|denied|requires approval/i.test(text)) return 'denied';
    if (/No such file|ENOENT|does not exist/i.test(text)) return 'missing-path';
    if (/exit code [1-9]|Exit code [1-9]/.test(text)) return 'command-failed';
    if (/timed? ?out/i.test(text)) return 'timeout';
    return 'other';
}

const DENY = [/^\.github\//, /(^|\/)\.env/, /(^|\/)secrets?\//i,
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/];

// The pre-push gate. Deterministic: numstat lines from
// `git diff --numstat <base>..HEAD`, commit messages, and the test exit code.
// sizeNumstat (optional) is the imp's own commits only, so a runner-side
// formatter commit counts toward scope but not toward the size budget.
export function gate({ numstat, sizeNumstat = numstat, commits, testExit, maxLines = 15, allow = [] }) {
    const parse = (s) => s
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [a, d, path] = l.split('\t');
            return { path, lines: (Number(a) || 0) + (Number(d) || 0) };
        });
    const files = parse(numstat);
    const lines = parse(sizeNumstat).reduce((n, f) => n + f.lines, 0);
    const reasons = [];
    if (!commits.length) reasons.push('no commits');
    for (const f of files) {
        if (DENY.some((re) => re.test(f.path))) reasons.push(`denied path ${f.path}`);
        if (allow.length && !allow.some((p) => f.path.startsWith(p))) reasons.push(`outside scope ${f.path}`);
    }
    // Written so a non-numeric maxLines (NaN) fails instead of disabling the check.
    if (!(lines <= maxLines)) reasons.push(`diff ${lines} lines > ${maxLines}`);
    if (commits.length && !commits.every((c) => /Co-Authored-By: .*imp/i.test(c))) reasons.push('commit missing imp trailer');
    if (testExit !== 0) reasons.push(testExit == null ? 'tests not run' : `tests exit ${testExit}`);
    return { pass: reasons.length === 0, reasons, lines, files: files.map((f) => f.path) };
}

// The hourly dispatcher's choice. Pure so it can be tested.
//   candidates: [{ repo, number, labels, createdAt }]  open `imp:ready` issues that have a brief
//   repos: { [repo]: { humanPRs, impPRs, lastCommitHours } }
// Rules: at most `max` issues, at most `perRepo` per repo counting imp PRs
// already open there (default 1: one in flight avoids conflicting PRs), and never past
// `wip` imp PRs open in total (review is the bottleneck). Quiet repos first:
// no open human PRs, no commit in the last few hours. Within a repo,
// bot:review (already diagnosed) before bugs, then oldest first.
// Limits learned from the ledger, so a bad day can't turn into a runaway:
// `runsLast24h` counts imp runs in the last 24 h (the daily cap), and a repo
// whose last two gated runs both failed sits out for 24 h after the latest
// failure (`cooldown`), until triage fixes the brief or the cause.
export function loopBudget(rows, now = Date.now()) {
    const day = 24 * 3600_000;
    const runs = rows.filter((r) => r.startedAt && !r.ingested && /^imp_\d/.test(r.id));
    const runsLast24h = runs.filter((r) => now - Date.parse(r.startedAt) < day).length;
    const cooldown = {};
    for (const repo of new Set(runs.map((r) => r.repo))) {
        const gated = runs.filter((r) => r.repo === repo && r.gate).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
        const [a, b] = gated.slice(-2);
        if (a && b && !a.gate.pass && !b.gate.pass && now - Date.parse(b.startedAt) < day) cooldown[repo] = b.startedAt;
    }
    return { runsLast24h, cooldown };
}

export function pickIssues({ candidates, repos, max = 5, wip = 8, perRepo = 1, quietHours = 6, dailyCap = Infinity, runsLast24h = 0, cooldown = {} }) {
    const openImp = Object.values(repos).reduce((n, r) => n + (r.impPRs || 0), 0);
    const room = Math.max(0, Math.min(max, wip - openImp, dailyCap - runsLast24h));
    const kind = (i) => (i.labels.includes('bot:review') ? 0 : i.labels.includes('bug') ? 1 : 2);
    const busy = (r) => (r.humanPRs || 0) * 10 + ((r.lastCommitHours ?? 99) < quietHours ? 20 : 0);
    const byRepo = new Map();
    for (const i of candidates) {
        const r = repos[i.repo] || {};
        if (cooldown[i.repo] || (r.impPRs || 0) >= perRepo) continue;
        byRepo.set(i.repo, [...(byRepo.get(i.repo) || []), i]);
    }
    const picks = [];
    for (const [repo, list] of byRepo) {
        list.sort((a, b) => kind(a) - kind(b) || (a.createdAt < b.createdAt ? -1 : 1));
        picks.push(...list.slice(0, perRepo - ((repos[repo] || {}).impPRs || 0)));
    }
    return picks
        .sort((a, b) => busy(repos[a.repo] || {}) - busy(repos[b.repo] || {}) || kind(a) - kind(b) || (a.createdAt < b.createdAt ? -1 : 1))
        .slice(0, room);
}

// A brief lives on the issue as a comment that starts with this marker, so
// it's reviewable on GitHub and the dispatcher needs no local state.
export const BRIEF_MARK = '<!-- imp-brief -->';
export function briefFromComments(comments = []) {
    const c = [...comments].reverse().find((x) => (x.body || '').trimStart().startsWith(BRIEF_MARK));
    if (!c) return null;
    // Prose may sit around the brief: take the fenced block if there is one.
    const body = c.body.trimStart().slice(BRIEF_MARK.length).replace(/\r\n/g, '\n');
    const fenced = body.match(/```(?:markdown|md)?\n([\s\S]*?)\n```/);
    return (fenced ? fenced[1] : body).trim() + '\n';
}

// The reviewer's answer is the last ```json block in its final text. The
// verdict is recomputed from the findings, so a model that says "approve"
// with a blocker in its list can't wave a PR through.
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
export function parseReview(text = '') {
    const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    if (!blocks.length) return { error: 'no json block in the reviewer output' };
    let raw;
    try {
        raw = JSON.parse(blocks[blocks.length - 1][1]);
    } catch (e) {
        return { error: `unparseable json: ${e.message}` };
    }
    const findings = (Array.isArray(raw.findings) ? raw.findings : [])
        .filter((f) => f && f.title)
        .map((f) => ({
            severity: SEVERITIES.includes(f.severity) ? f.severity : 'minor',
            file: String(f.file || ''),
            line: Number.isFinite(Number(f.line)) ? Number(f.line) : null,
            title: String(f.title),
            detail: String(f.detail || ''),
        }));
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
    const verdict = counts.blocker || counts.major ? 'request_changes' : findings.some((f) => f.severity !== 'nit') ? 'comment' : 'approve';
    return { verdict, modelVerdict: raw.verdict || null, summary: String(raw.summary || ''), findings, counts };
}

// ── fix rounds ────────────────────────────────────────────────────────────
// Everything a runner posts carries an `<!-- imp-` marker, so it never
// mistakes its own replies for feedback.
export const IMP_MARK = /<!-- imp-[a-z-]+ -->/;
const botLogin = (login = '') => /\[bot\]$|^app\/|^(coderabbitai|netlify|dependabot|github-actions|copilot-pull-request-reviewer)$/i.test(login);
const norm = (login = '') => login.replace(/\[bot\]$/, '').toLowerCase();

// Turn a PR's raw state into the items a fix round should act on. Pure.
//   threads: [{ id, isResolved, isOutdated, path, line, comments: [{ databaseId, author, body }] }]
//   comments: PR conversation comments [{ id, author, body, createdAt }]
//   checks: [{ name, state }]   impReview: the run's ledger review (or null)
// Noise (bot summaries, skip/rate-limit notices, deploy previews, confirmations,
// our own replies) never becomes an item: no model is woken for it.
export function feedbackItems({ threads = [], comments = [], checks = [], impReview = null, since = null }) {
    const items = [];
    for (const t of threads) {
        if (t.isResolved || t.isOutdated || !t.comments?.length) continue;
        const last = t.comments[t.comments.length - 1];
        if (IMP_MARK.test(last.body || '')) continue; // we answered it last; waiting on them
        const first = t.comments[0];
        items.push({
            kind: 'thread', id: t.id, commentId: first.databaseId, author: norm(first.author), path: t.path, line: t.line,
            text: t.comments.map((c) => `${norm(c.author)}: ${(c.body || '').replace(/<!--[\s\S]*?-->/g, '').trim()}`).join('\n\n').slice(0, 4000),
        });
    }
    for (const c of comments) {
        if (botLogin(c.author) || IMP_MARK.test(c.body || '')) continue;
        if (since && c.createdAt <= since) continue;
        if (!(c.body || '').trim() || /^@coderabbitai\b/i.test(c.body.trim())) continue;
        items.push({ kind: 'comment', id: `c${c.id}`, author: norm(c.author), text: c.body.slice(0, 4000) });
    }
    if (impReview && !impReview.error && impReview.verdict === 'request_changes' && !impReview.handled)
        for (const [i, f] of (impReview.findings || []).entries())
            if (f.severity === 'blocker' || f.severity === 'major')
                items.push({ kind: 'review', id: `r${i}`, author: 'imp-reviewer', path: f.file, line: f.line, text: `${f.severity}: ${f.title}\n${f.detail}` });
    for (const c of checks)
        // Netlify's deploy checks ("Pages changed - x", "Header rules - x", "Redirect rules - x") aren't code feedback.
        if (/^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|fail)$/i.test(c.state || '') && !/netlify|coderabbit|^(Pages changed|Header rules|Redirect rules) - /i.test(c.name))
            items.push({ kind: 'ci', id: `ci:${c.name}`, author: 'ci', text: `Check "${c.name}" is failing.${c.log ? `\n\n${c.log}` : ''}` });
    return items;
}

// CodeRabbit keeps its old CHANGES_REQUESTED after the fixes land (and often
// can't re-review because of the free-tier limit). When CI is green and every
// thread is resolved, one `@coderabbitai approve` clears it.
// Each reviewer's latest *decisive* review, the way GitHub computes
// reviewDecision: COMMENTED reviews don't replace an earlier CHANGES_REQUESTED.
export function latestDecisiveReviews(reviews = []) {
    const out = {};
    for (const rv of reviews)
        if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(rv.state)) out[rv.author?.login || rv.author] = rv.state;
    return out;
}

export function shouldAskCodeRabbitApprove({ reviewDecision, latestBy = {}, threads = [], checks = [], askedAt = null }) {
    if (askedAt || reviewDecision !== 'CHANGES_REQUESTED') return false;
    const blockers = Object.entries(latestBy).filter(([, s]) => s === 'CHANGES_REQUESTED').map(([who]) => norm(who));
    if (!blockers.length || blockers.some((who) => who !== 'coderabbitai')) return false;
    if (threads.some((t) => !t.isResolved && !t.isOutdated)) return false;
    return checks.every((c) => /^(SUCCESS|NEUTRAL|SKIPPED|pass|skipping)$/i.test(c.state || '') || /coderabbit/i.test(c.name));
}

// The fix imp ends with a json block: { "decisions": [{ id, action, reply }] }.
// Unknown ids are dropped; items it didn't answer come back as `skip` with a
// note, so every thread gets a reply.
export function parseFixDecisions(text = '', items = []) {
    const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    let raw = [];
    try {
        raw = blocks.length ? JSON.parse(blocks[blocks.length - 1][1]).decisions || [] : [];
    } catch {
        raw = [];
    }
    const byId = new Map(raw.filter((d) => d && d.id).map((d) => [String(d.id), d]));
    return items.map((it) => {
        const d = byId.get(it.id);
        const action = ['fix', 'pushback', 'skip'].includes(d?.action) ? d.action : 'skip';
        return { id: it.id, kind: it.kind, action, reply: String(d?.reply || (d ? '' : 'Not addressed in this round.')).slice(0, 1500), answered: !!d };
    });
}

const VERDICT_LABEL = { approve: '✅ No issues found', comment: '💬 Minor findings', request_changes: '⛔ Changes needed' };
export function renderReview(rv, { runId, model, served = [], turns, minutes }) {
    const lines = ['<!-- imp-review -->', `### Imp review: ${VERDICT_LABEL[rv.verdict]}`, '', rv.summary || '(no summary)', ''];
    if (rv.findings.length) {
        lines.push('| | Finding | Where |', '| --- | --- | --- |');
        for (const f of rv.findings) lines.push(`| **${f.severity}** | ${f.title.replace(/\|/g, '\\|')} | \`${f.file}${f.line ? `:${f.line}` : ''}\` |`);
        lines.push('');
        for (const f of rv.findings.filter((x) => x.severity !== 'nit'))
            lines.push(`<details><summary><b>${f.severity}</b>: ${f.title}</summary>\n\n${f.detail}\n\n</details>`);
        lines.push('');
    }
    lines.push(`<sub>Read-only review by an imp reviewer through 9router (\`${model}\`, served ${served.join(', ') || '?'}; ${turns ?? '?'} turns, ${minutes ?? '?'} min; run \`${runId}\`). It never approves or merges; a human does.</sub>`);
    return lines.join('\n');
}

// RSI report over ledger rows: one line per model mix, plus the error kinds and
// gate reasons that keep coming back (those are what the next preamble fixes).
export function report(rows) {
    const out = [];
    const n = rows.length;
    const passed = rows.filter((r) => r.gate?.pass).length;
    const merged = rows.filter((r) => r.outcome === 'merged').length;
    out.push(`runs ${n} · gate pass ${passed} · merged ${merged}`);
    const sum = (k) => rows.reduce((a, r) => a + (r.metrics?.tokens?.[k] || 0), 0);
    out.push(`tokens in ${sum('input')} (cache read ${sum('cacheRead')}) · out ${sum('output')}`);
    const tally = (pick) => {
        const t = {};
        for (const r of rows) for (const [k, v] of Object.entries(pick(r) || {})) t[k] = (t[k] || 0) + v;
        return Object.entries(t).sort((a, b) => b[1] - a[1]);
    };
    out.push('', '| run | issue | brief | model | turns | min | tool err | switches | gate | review | outcome |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
        const m = r.metrics || {};
        out.push(`| ${r.id} | ${r.repo}#${r.issue ?? '?'} | ${r.briefHash?.slice(0, 7) ?? ''} | ${r.model}${m.served?.length > 1 ? ` (${m.served.length} served)` : ''} | ${m.turns ?? ''} | ${m.durationMs ? (m.durationMs / 60000).toFixed(1) : ''} | ${m.toolErrors ?? ''} | ${m.modelSwitches ?? ''} | ${r.gate ? (r.gate.pass ? 'pass' : 'fail') : '…'} | ${r.review ? (r.review.error ? 'error' : `${r.review.verdict}${r.review.counts ? ` (${r.review.counts.blocker}B/${r.review.counts.major}M/${r.review.counts.minor}m)` : ''}`) : ''} | ${r.outcome ?? ''} |`);
    }
    const errs = tally((r) => r.metrics?.errorKinds);
    if (errs.length) out.push('', 'tool errors: ' + errs.map(([k, v]) => `${k} ${v}`).join(' · '));
    const reasons = {};
    for (const r of rows) for (const x of r.gate?.reasons || []) {
        const k = x.replace(/\d+/g, 'N').replace(/ \S+\/\S+$/, ' <path>');
        reasons[k] = (reasons[k] || 0) + 1;
    }
    const rs = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    if (rs.length) out.push('gate failures: ' + rs.map(([k, v]) => `${k} ×${v}`).join(' · '));
    return out.join('\n');
}

// Does the daily hypervisor have anything to do? Pure, so the model session can be
// skipped (zero tokens) on quiet days. Mirrors the triage prompt's own filters:
//   impPRs: [{ labels: [name] }]   open `imp` PRs
//   issues: [{ repo, title, labels: [name], comments: [body] }]   open bug / bot:review issues
//   failed: [issue]   open `imp:failed` issues
export function triageWork({ impPRs = [], issues = [], failed = [] }) {
    const reasons = [];
    const escalate = impPRs.filter((p) => p.labels.includes('imp:needs-human')).length;
    const mergeable = impPRs.length - escalate;
    if (mergeable) reasons.push(`${mergeable} imp PR(s) to check for merge`);
    if (escalate) reasons.push(`${escalate} imp PR(s) need a human`);
    if (failed.length) reasons.push(`${failed.length} imp:failed issue(s) to re-brief`);
    const unbriefed = issues.filter(
        (i) =>
            i.repo !== 'kryptos' &&
            !i.title.startsWith('Revisit') &&
            !i.labels.some((l) => l.startsWith('imp:')) &&
            !i.comments.some((c) => c.trimStart().startsWith('<!-- imp-')),
    );
    if (unbriefed.length) reasons.push(`${unbriefed.length} issue(s) with no brief or triage note`);
    return { work: reasons.length > 0, reasons, unbriefed: unbriefed.map((i) => `${i.repo}#${i.number}`) };
}

// ── stats tables (used by stats.mjs) ──
export function repoTable(issues, prs) {
    const by = {};
    const row = (n) => (by[n] ||= { repo: n, issues: 0, bugs: 0, prs: 0, impPrs: 0, ready: 0, failed: 0 });
    for (const i of issues) {
        const r = row(i.repository.name);
        const L = i.labels.map((l) => l.name);
        r.issues++;
        if (L.includes('bug')) r.bugs++;
        if (L.includes('imp:ready')) r.ready++;
        if (L.includes('imp:failed')) r.failed++;
    }
    for (const p of prs) {
        const r = row(p.repository.name);
        r.prs++;
        if (p.labels.some((l) => l.name === 'imp')) r.impPrs++;
    }
    const list = Object.values(by).sort((a, b) => b.issues - a.issues || b.prs - a.prs);
    const total = list.reduce((t, r) => { for (const k of Object.keys(r)) if (k !== 'repo') t[k] += r[k]; return t; }, { repo: 'TOTAL', issues: 0, bugs: 0, prs: 0, impPrs: 0, ready: 0, failed: 0 });
    return [...list, total];
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

export function tokenTable(all, { sinceMs = 0, now = Date.now() } = {}) {
    const runs = all.filter((r) => r.startedAt && /^imp_\d/.test(r.id) && (!sinceMs || now - Date.parse(r.startedAt) < sinceMs));
    const metered = runs.filter((r) => r.metrics && !r.metrics.unmetered && r.metrics.tokens?.input);
    const inPerTurn = median(metered.map((r) => r.metrics.tokens.input / Math.max(1, r.metrics.turns || 1)));
    const lines = runs.map((r) => {
        const m = r.metrics || {};
        const input = m.tokens?.input || 0;
        const est = !input && (m.toolTurns || m.turns);
        const turns = m.turns || m.toolTurns || 0;
        return {
            id: r.id, issue: `${r.repo}#${r.issue}`, turns, input: input || Math.round((m.toolTurns || 0) * inPerTurn),
            estimated: !!est, inPerTurn: input ? Math.round(input / Math.max(1, turns)) : Math.round(inPerTurn),
            minutes: m.durationMs ? +(m.durationMs / 60000).toFixed(1) : null, firstEdit: m.firstEditTurn ?? null,
            ctxTools: m.init?.tools ?? null, end: m.end, gate: r.gate ? (r.gate.pass ? 'pass' : 'fail') : '-',
            switches: m.modelSwitches ?? 0,
        };
    });
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const wasted = lines.filter((l) => l.gate !== 'pass');
    const rv = runs.map((r) => r.review).filter((v) => v?.tokens);
    const reviews = {};
    for (const v of rv) {
        const k = v.mode || 'agent';
        reviews[k] ||= { n: 0, input: 0, output: 0 };
        reviews[k].n++;
        reviews[k].input += v.tokens.input || 0;
        reviews[k].output += v.tokens.output || 0;
    }
    return {
        medianInPerTurn: Math.round(inPerTurn), lines,
        totals: { runs: runs.length, input: sum(lines.map((l) => l.input)), wastedInput: sum(wasted.map((l) => l.input)), wastedRuns: wasted.length, pass: lines.filter((l) => l.gate === 'pass').length },
        reviews: Object.entries(reviews).map(([mode, v]) => ({ mode, runs: v.n, avgInput: Math.round(v.input / v.n), avgOutput: Math.round(v.output / v.n) })),
    };
}
