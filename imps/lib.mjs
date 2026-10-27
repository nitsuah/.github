// Pure helpers for imps: brief parsing, run metrics, the pre-push gate and
// the RSI report. No I/O beyond defaults.mjs. Tested in lib.test.mjs (node --test).
import { DEFAULTS } from './defaults.mjs';

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

// The kit's own defaults and each repo's guardrail config are off limits: an
// imp that can edit its own limits can widen the gate it is judged by (#57).
const DENY = [/^\.github\//, /(^|\/)\.env/, /(^|\/)secrets?\//i,
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
    /^imps\/defaults\.mjs$/, /(^|\/)imps-config\.ya?ml$/];

// An imp that edited and verified but never committed is salvageable: the
// runner commits for it rather than failing a run whose work is already done (#54).
export function shouldAutoCommit({ impCommits, dirty, testExit } = {}) {
    return impCommits === 0 && !!dirty && testExit === 0;
}

// The pre-push gate. Deterministic: numstat lines from
// `git diff --numstat <base>..HEAD`, commit messages, and the test exit code.
// sizeNumstat (optional) is the imp's own commits only, so a runner-side
// formatter commit counts toward scope but not toward the size budget.
// dirty (optional) collapses "no commits" and the uncommitted edits behind it
// into one reason, so RSI files one issue instead of three (#53).
export function gate({ numstat, sizeNumstat = numstat, commits, testExit, dirty = false, maxLines = DEFAULTS.maxLines, allow = [] }) {
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
    if (!commits.length) reasons.push(dirty ? 'edits left uncommitted' : 'no commits');
    for (const f of files) {
        if (DENY.some((re) => re.test(f.path))) reasons.push(`denied path ${f.path}`);
        if (allow.length && !allow.some((p) => f.path.startsWith(p))) reasons.push(`outside scope ${f.path}`);
    }
    // Written so a non-numeric maxLines (NaN) fails instead of disabling the check.
    if (!(lines <= maxLines)) reasons.push(`diff ${lines} lines > ${maxLines}`);
    if (commits.length && !commits.every((c) => /Co-Authored-By: .*imp/i.test(c))) reasons.push('commit missing imp trailer');
    // "tests not run" is not a second fact when there was nothing to run them
    // on: it is the same uncommitted-edit cause wearing another name (#53).
    if (testExit !== 0 && !(testExit == null && dirty && !commits.length))
        reasons.push(testExit == null ? 'tests not run' : `tests exit ${testExit}`);
    return { pass: reasons.length === 0, reasons, lines, files: files.map((f) => f.path) };
}

// Refuse to open a PR for an issue that closed while the imp was working (#56).
// A failed lookup is not proof the issue is open, so it fails closed.
export function prGuard({ issue } = {}) {
    const n = issue?.number ?? '?';
    if (issue?.state === 'CLOSED') return { ok: false, reason: `issue #${n} is closed` };
    if (!issue?.state) return { ok: false, reason: `cannot confirm issue #${n} is open` };
    return { ok: true };
}

// Labels to strip when an issue closes. imp:pr is kept: it records that an imp
// shipped here, so the dispatcher will not pick the repo up again (#58).
export const STALE_ON_CLOSE = ['imp:ready', 'imp:working', 'imp:failed', 'imp:needs-human'];
const STALE_IMP = new Set(STALE_ON_CLOSE);

export function staleImpLabels(labels = []) {
    if (!Array.isArray(labels)) return [];
    return labels
        .map((l) => (typeof l === 'string' ? l : l?.name))
        .filter((n) => STALE_IMP.has(n));
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

export function pickIssues({
    candidates, repos,
    max = DEFAULTS.max, wip = DEFAULTS.wip, perRepo = 1,
    quietHours = DEFAULTS.quietHours, dailyCap = Infinity,
    runsLast24h = 0, cooldown = {},
}) {
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

// ── claim lease ───────────────────────────────────────────────────────────
// `imp:ready` → `imp:working` is the queue lock across machines, but a label
// has no owner and no expiry: a machine that dies mid-run leaves the issue on
// imp:working for everyone, and no other machine can release it because
// runs.jsonl is per machine (#60). So a claim is written as a comment carrying
// who took it and when, and the dispatcher reclaims stale ones.
export const CLAIM_MARK = '<!-- imp-claim -->';
export const RECLAIM_MARK = '<!-- imp-reclaim -->';

// Generous: an imp run is `--minutes 25`, plus gate, PR, review. A claim older
// than this with no ledger row on this machine is stranded, not slow.
export const CLAIM_TTL_MS = 3 * 3600_000;

export function claimBody({ machine = '', at = '', id = '', heartbeatAt = '', startedAt = '', pr = null } = {}) {
    const meta = JSON.stringify({ machine: machine || '?', startedAt: startedAt || at || new Date().toISOString(), heartbeatAt: heartbeatAt || at || new Date().toISOString(), pr });
    return `${CLAIM_MARK}\n${CLAIM_META_OPEN}${meta}${CLAIM_META_CLOSE}\n` +
        `Imp claim: **${machine || '?'}**${id ? ` (\`${id}\`)` : ''}, started ${startedAt || at || new Date().toISOString()}` +
        `${heartbeatAt ? `, heartbeat ${heartbeatAt}` : ''}.` +
        ' Released when the run ends; reclaimed automatically if the heartbeat stops.';
}

// The hidden JSON line makes a claim machine-readable (who, when, last heartbeat,
// PR) without a second comment. Kept as a marker pair so an imp reviewer does
// not read it as feedback.
export const CLAIM_META_OPEN = '<!-- imp-claim-meta ';
export const CLAIM_META_CLOSE = ' -->';

export function parseClaim(body = '') {
    const s = String(body || '');
    if (!s.trimStart().startsWith(CLAIM_MARK)) return null;
    const m = s.match(/<!-- imp-claim-meta (\{[\s\S]*?\}) -->/);
    if (m) {
        try {
            const j = JSON.parse(m[1]);
            return { machine: j.machine || '', startedAt: j.startedAt || '', heartbeatAt: j.heartbeatAt || j.startedAt || '', pr: j.pr || null, legacy: false };
        } catch { /* fall through to the prose form */ }
    }
    // Claims written before the JSON line existed: keep them usable rather than
    // dropping them, so #60's sweep still has a clock to read.
    const who = (s.match(/Claimed by `([^`]+)`/) || s.match(/Imp claim: \*\*([^*]+)\*\*/) || [])[1] || '';
    const at = ((s.match(/at (\S+?)\.\s/) || [])[1] || '');
    return { machine: who, startedAt: at, heartbeatAt: at, pr: null, legacy: true };
}

export const CLAIM_HEARTBEAT_TTL_MS = 90 * 60_000;

// A live run refreshes the claim's heartbeat; a dead one cannot. Age since the
// last heartbeat is therefore the only honest liveness signal a label has (#69).
export function claimExpired(claim, now = Date.now(), ttlMs = CLAIM_HEARTBEAT_TTL_MS) {
    if (!claim) return false;
    const at = Date.parse(claim.heartbeatAt || claim.startedAt || '');
    if (!Number.isFinite(at)) return false;
    return now - at > ttlMs;
}

// The newest claim comment on an issue, or null. Comments come from the API
// in creation order.
export function latestClaim(comments = []) {
    return [...comments].reverse().find((c) => (c.body || '').trimStart().startsWith(CLAIM_MARK)) || null;
}

// Check if a PID is alive (cross-platform).
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // exists, owned by someone else
    }
}

// Is the claim on this issue stale? Staleness needs all three: the issue is on
// imp:working, the newest claim is older than ttl, and this machine has no
// ledger row for it (a row means a run may still be alive here — the hourly
// lock already serialises this machine). Returns a reason string or null.
// ledgerRow can be the full row to check endedAt; if true, treat as row without endedAt.
// If the claim has a PR (claim.pr), do not reclaim — the PR is the delivery artifact.
export function staleClaim({ labels = [], comments = [], ledgerHasRow = false, ledgerRow = null, machine = '', ttl = CLAIM_HEARTBEAT_TTL_MS, now = Date.now() } = {}) {
    if (!labels.includes('imp:working')) return null;
    // A ledger row only exempts the claim if the run is still alive (no endedAt).
    // If the row exists but endedAt is set, the run finished and the claim is stranded.
    const rowEnded = ledgerRow && ledgerRow.endedAt;
    if (ledgerHasRow && !rowEnded) return null;
    const claim = latestClaim(comments);
    if (!claim) return 'imp:working with no claim comment — pre-lease claim, or the label was set by hand';
    const parsed = parseClaim(claim.body);
    // If the claim has an associated PR, don't reclaim — the work has been delivered.
    if (parsed?.pr) return null;
    const at = Date.parse((parsed && (parsed.heartbeatAt || parsed.startedAt)) || claim.createdAt || '');
    if (!Number.isFinite(at)) return `unparseable claim time on ${claim.createdAt || 'comment'}`;
    if (now - at < ttl) return null;
    const who = (parsed && parsed.machine) || 'unknown';
    // If the claim is from this machine but the local run has ended (or never started a row),
    // the claim is stranded and recoverable — the lock only guards a live run.
    if (who === machine && rowEnded) return `claimed by ${machine}, run ended — claim stranded`;
    if (who === machine && !ledgerHasRow) return `claimed by ${machine}, no local row — machine likely crashed before row creation`;
    // If the claim is from this machine and a row exists, check if the local run is still alive.
    // A run is alive if it has no endedAt AND the process is still running (PID exists).
    if (who === machine && ledgerHasRow && !rowEnded) {
        const pid = ledgerRow?.pid;
        if (pid && isPidAlive(pid)) return null; // our run is still alive, claim is valid
        return `claimed by ${machine}, run ${pid || 'unknown pid'} not alive — claim stranded`;
    }
    return `claimed by ${who}, no heartbeat for ${Math.round((now - at) / 60_000)}min, and no run here`;
}

// ── the cycle lock ────────────────────────────────────────────────────────
// A hard kill or a reboot skips the exit handler, so the lock file survives and
// every tick skips for three hours. Staleness is therefore decided from what the
// lock says, not only from its age (#68).
export function lockBody({ pid = process.pid, host = '', startedAt = new Date().toISOString() } = {}) {
    return JSON.stringify({ pid, host, startedAt });
}

export function lockIsStale({ text = '', mtimeMs = 0, now = Date.now(), bootTimeMs = 0, host = '', alive = () => false, maxAgeMs = DEFAULTS.lockMaxAgeMs } = {}) {
    let lock = null;
    try {
        lock = JSON.parse(text);
    } catch { /* legacy plain-PID lock, or a truncated write */ }
    if (!lock || typeof lock !== 'object') {
        // Legacy: a bare PID. Only the mtime is trustworthy.
        if (bootTimeMs && mtimeMs && mtimeMs < bootTimeMs) return 'before-boot';
        if (mtimeMs && now - mtimeMs > maxAgeMs) return 'expired';
        return null;
    }
    const started = Date.parse(lock.startedAt || '');
    if (bootTimeMs && Number.isFinite(started) && started < bootTimeMs) return 'before-boot';
    // Only this host can answer for its own PID; another machine's lock is judged by age.
    if (lock.host && host && lock.host === host && Number.isFinite(lock.pid) && !alive(lock.pid)) return 'pid-dead';
    const since = Number.isFinite(started) ? started : mtimeMs;
    if (since && now - since > maxAgeMs) return 'expired';
    return null;
}

// ── waiting for 9router ───────────────────────────────────────────────────
// One failed probe used to cost the whole hour, which meant a boot or a provider
// blip silently skipped a cycle (#65). Backoff is bounded so the lock is held for
// minutes, not for the hour.
export function routerWaitDelays({ windowMs = 600_000, firstMs = 15_000, maxMs = 120_000 } = {}) {
    const out = [];
    let total = 0;
    let d = firstMs;
    while (d > 0 && total + d <= windowMs) {
        out.push(d);
        total += d;
        d = Math.min(d * 2, maxMs);
    }
    return out;
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
