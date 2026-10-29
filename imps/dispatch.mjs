#!/usr/bin/env node
// The hourly imps dispatcher. No LLM of its own: it reads the GitHub queue,
// picks issues, and runs each through imp.mjs run → gate → pr.
//
//   node dispatch.mjs [--max 5] [--wip 12] [--per-repo 6] [--concurrency 6] [--owner nitsuah] [--dry-run] [--rsi] [--only repo#N,...]
//
// Queue: open issues labelled `imp:ready` that carry a brief comment (see
// BRIEF_MARK in lib.mjs; Opus triage / rsi.mjs write them). Each issue moves to
// `imp:working`, then `imp:pr` (PR opened) or `imp:failed` (gate reasons
// commented, needs a new brief). Defaults: imps/defaults.mjs. Contract: STANDARD.md.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isTransientNetworkError, pickIssues, briefFromComments, loopBudget, claimBody, latestClaim, staleClaim, staleImpLabels, STALE_ON_CLOSE, lockIsStale, routerWaitDelays, parseClaim, claimExpired, prGuard, duplicateImpPrs, issueFailures, briefCommentAt, hasMark, withKind, outcomeFromPr, CAP_MARK, NO_BRIEF_MARK, resolveRouter } from './lib.mjs';
import { kitSha, machineName, lookupIssueGuard, update as updateRun } from './runner.mjs';
import { DEFAULTS } from './defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
const { values: o } = parseArgs({
    options: {
        max: { type: 'string', default: String(DEFAULTS.max) },
        wip: { type: 'string', default: String(DEFAULTS.wip) },
        'per-repo': { type: 'string', default: String(DEFAULTS.perRepo) },
        concurrency: { type: 'string', default: String(DEFAULTS.concurrency) },
        'daily-cap': { type: 'string', default: String(DEFAULTS.dailyCap) },
        owner: { type: 'string', default: DEFAULTS.owner },
        'dry-run': { type: 'boolean', default: false },
        only: { type: 'string', default: '' }, // controlled runs: --only vhs#102,skyview#213
        rsi: { type: 'boolean', default: false },
    },
});
const perRepo = Number(o['per-repo']);
if (!Number.isInteger(perRepo) || perRepo < 1) {
    console.error('--per-repo must be a positive integer');
    process.exit(2);
}
const dry = o['dry-run'];
mkdirSync(join(HOME, 'briefs'), { recursive: true });
const LOG = join(HOME, 'dispatch.jsonl');
// Every event carries which machine and which kit commit produced it (#61).
const MACHINE = machineName();
const PROVENANCE = { machine: MACHINE, kitSha: kitSha() };
const log = (ev) => {
    const line = { at: new Date().toISOString(), ...PROVENANCE, ...ev };
    console.log(JSON.stringify(line));
    if (!dry) appendFileSync(LOG, JSON.stringify(line) + '\n');
};
const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
    if (r.status) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
};
const ghJson = (args) => JSON.parse(gh(args) || 'null');

// ── one cycle at a time ───────────────────────────────────────────────────
// A crash or a reboot skips the exit handler, and a lock nobody can clear then
// blocks every tick for three hours. Staleness is decided from the lock's own
// contents — dead pid, or written before this boot — with age as the backstop (#68).
const LOCK = join(HOME, 'dispatch.lock');
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // exists, owned by someone else
    }
};
if (existsSync(LOCK)) {
    const why = lockIsStale({
        text: readFileSync(LOCK, 'utf8'),
        mtimeMs: statSync(LOCK).mtimeMs,
        now: Date.now(),
        bootTimeMs: Date.now() - uptime() * 1000,
        host: hostname(),
        alive,
        maxAgeMs: DEFAULTS.lockMaxAgeMs,
    });
    if (!why) {
        log({ event: 'skip', reason: 'previous cycle still running (lock < 3h old)' });
        process.exit(0);
    }
    log({ event: 'lock-cleared', reason: why, lock: readFileSync(LOCK, 'utf8').slice(0, 200) });
    if (!dry) rmSync(LOCK, { force: true });
}
if (!dry) writeFileSync(LOCK, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
const unlock = () => { if (!dry) rmSync(LOCK, { force: true }); };
process.on('exit', unlock);

// ── 9router must be up ────────────────────────────────────────────────────
async function routerUp() {
    const { baseUrl: base, key } = resolveRouter();
    if (!key) return false; // never probe keyless (or with a refused anthropic.com config)
    try {
        const r = await fetch(`${base}/messages`, {
            method: 'POST',
            signal: AbortSignal.timeout(60_000),
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'MAX', max_tokens: 5, messages: [{ role: 'user', content: 'say ok' }] }),
        });
        return r.ok;
    } catch {
        return false;
    }
}

// At boot, and after a provider blip, one failed probe used to cost the whole
// hour. Wait a bounded time instead — the lock is already held, so label-watch
// ticks skip rather than pile up behind it (#65).
async function waitForRouter() {
    if (await routerUp()) return { up: true, attempts: 1, waitedMs: 0 };
    const delays = routerWaitDelays();
    let waited = 0;
    for (let i = 0; i < delays.length; i++) {
        await new Promise((r) => setTimeout(r, delays[i]));
        waited += delays[i];
        if (await routerUp()) return { up: true, attempts: i + 2, waitedMs: waited };
    }
    return { up: false, attempts: delays.length + 1, waitedMs: waited };
}

// ── labels ────────────────────────────────────────────────────────────────
const LABELS = {
    'imp:ready': ['0e8a16', 'Has an imp brief; the hourly dispatcher may take it'],
    'imp:working': ['fbca04', 'An imp is working on this now'],
    'imp:pr': ['6f42c1', 'An imp opened a PR for this'],
    'imp:needs-human': ['d93f0b', 'An imp could not finish this; a human or the hypervisor should look'],
    'imp:failed': ['b60205', 'The imp did not pass the gate; needs a new brief or a human'],
};
const ensured = new Set();
function relabel(repo, number, add, remove = []) {
    if (dry) return;
    const slug = `${o.owner}/${repo}`;
    for (const l of [add, ...remove]) {
        if (ensured.has(`${slug}:${l}`)) continue;
        spawnSync('gh', ['label', 'create', l, '-R', slug, '-c', LABELS[l][0], '-d', LABELS[l][1], '--force'], { encoding: 'utf8', windowsHide: true });
        ensured.add(`${slug}:${l}`);
    }
    gh(['issue', 'edit', String(number), '-R', slug, '--add-label', add, ...remove.flatMap((l) => ['--remove-label', l])]);
}
const comment = (repo, number, body) => !dry && gh(['issue', 'comment', String(number), '-R', `${o.owner}/${repo}`, '-b', body]);
// Outcome comments are advisory: a GitHub blip while posting one must not throw out of work() after the
// label already changed (fire#335 went imp:failed with no gate-fail event).
const note = (repo, number, body) => {
    try {
        comment(repo, number, body);
    } catch (e) {
        log({ event: 'comment-error', repo, number, error: String(e.message).slice(0, 200) });
    }
};

// ── claim heartbeat ───────────────────────────────────────────────────────
// A run can take 25 minutes plus gate, PR and review, and while it runs the
// issue looks identical to one whose imp died. Editing the claim comment on a
// timer makes liveness visible from the issue alone (#67), and gives the TTL
// sweep a clock it can trust (#69). Every failure here is logged and dropped:
// a heartbeat must never fail a run.
function startClaimBeat(repo, number, id) {
    const startedAt = new Date().toISOString();
    let commentId = null;
    let pr = null;
    let at = startedAt;
    const beat = () => {
        if (dry) return;
        const body = claimBody({ machine: MACHINE, id, startedAt, heartbeatAt: at, pr });
        try {
            if (commentId) gh(['api', '-X', 'PATCH', `repos/${o.owner}/${repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
            else {
                const out = gh(['issue', 'comment', String(number), '-R', `${o.owner}/${repo}`, '-b', body]);
                commentId = (String(out).match(/issuecomment-(\d+)/) || [])[1] || null;
            }
        } catch (e) {
            console.log(`claim heartbeat failed: ${e.message}`);
        }
    };
    beat();
    const timer = setInterval(() => {
        at = new Date().toISOString();
        beat();
    }, CLAIM_BEAT_MS);
    timer.unref?.(); // never keep the process alive for a heartbeat
    return {
        pr(url) { pr = url || pr; at = new Date().toISOString(); beat(); },
        stop() { clearInterval(timer); },
    };
}

// ── release stranded claims ───────────────────────────────────────────────
// A claim has no lease in GitHub itself, so a machine that dies mid-run leaves
// its issue on imp:working and no other machine can release it (runs.jsonl is
// per machine). Reclaim rather than escalate: the work is idempotent and the
// brief is still valid. See lib.mjs staleClaim and WARLOCK.md.
async function releaseStrandedClaims(ledgerRows) {
    const stranded = [];
    const liveHere = new Set(ledgerRows.filter((r) => !r.endedAt).map((r) => `${r.repo}#${r.issue}`));
    let issues = [];
    try {
        issues = ghJson(['search', 'issues', '--owner', o.owner, '--state', 'open', '--label', 'imp:working', '--limit', '100', '--json', 'repository,number,labels']) || [];
    } catch (e) {
        log({ event: 'label-cleanup-error', error: e.message });
    }
    for (const issue of issues) {
        const repo = issue.repository.name;
        const number = issue.number;
        const key = `${repo}#${number}`;
        const labels = issue.labels.map((l) => l.name);
        let comments = [];
        try {
            comments = ghJson(['issue', 'view', String(number), '-R', `${o.owner}/${repo}`, '--json', 'comments']).comments || [];
        } catch (e) {
            log({ event: 'label-cleanup-error', repo, number, error: e.message });
            continue;
        }
        const row = ledgerRows.filter((r) => `${r.repo}#${r.issue}` === key).at(-1);
        const why = staleClaim({ labels, comments, ledgerHasRow: !!row, ledgerRow: row || null, machine: MACHINE });
        if (!why) continue;
        // A heartbeat that stopped is a dead run even before the claim is old:
        // release it so a long-but-live run is never stolen (#69).
        const claim = parseClaim((latestClaim(comments) || {}).body || '');
        const expired = claimExpired(claim);
        log({ event: expired ? 'claim-released' : 'reclaim', repo, number, why, machine: claim?.machine });
        if (dry) continue;
        try {
            comment(repo, number, expired
                ? `<!-- imp-reclaim -->\nReleased: ${claim.machine || 'a machine'}'s claim had no heartbeat since ${claim.heartbeatAt || '?'} (TTL 90 min). Back to \`imp:ready\`.`
                : `<!-- imp-reclaim -->\nReclaiming: ${why}. Putting this back on \`imp:ready\` so any machine can take it.`);
        } catch (e) {
            log({ event: 'label-cleanup-error', repo, number, error: e.message });
        }
        try {
            relabel(repo, number, 'imp:ready', ['imp:working']);
        } catch (e) {
            log({ event: 'label-cleanup-error', repo, number, error: e.message });
        }
        stranded.push(key);
    }
    return stranded;
}

// ── closed issues keep imp:* state labels forever ─────────────────────────
// A closed issue still carrying imp:working or imp:failed reads as live queue
// state to every machine's search, and a human triaging the list sees work
// that is not real. imp:pr stays: it is the "an imp shipped this" marker (#58).
async function clearStaleLabels() {
    const cleared = [];
    const seen = new Map();
    for (const label of ['imp:ready', 'imp:working', 'imp:failed', 'imp:needs-human']) {
        let hits = [];
        try {
            hits = ghJson(['search', 'issues', '--owner', o.owner, '--state', 'closed', '--label', label, '--limit', '100', '--json', 'repository,number,labels']) || [];
        } catch (e) {
            log({ event: 'label-cleanup-error', error: e.message });
            continue;
        }
        for (const i of hits) seen.set(`${i.repository.name}#${i.number}`, i);
    }
    for (const issue of seen.values()) {
        const repo = issue.repository.name;
        const stale = staleImpLabels(issue.labels);
        if (!stale.length) continue;
        log({ event: 'label-cleanup', repo, number: issue.number, removed: stale });
        if (dry) continue;
        try {
            gh(['issue', 'edit', String(issue.number), '-R', `${o.owner}/${repo}`, ...stale.flatMap((l) => ['--remove-label', l])]);
            cleared.push(`${repo}#${issue.number}`);
        } catch (e) {
            log({ event: 'label-cleanup-error', repo, number: issue.number, out: String(e.message).slice(-300) });
        }
    }
    return cleared;
}

// ── an imp, end to end ────────────────────────────────────────────────────
const IMP = join(HERE, 'imp.mjs');
const node = (args, script) => new Promise((done) => {
    const p = spawn(process.execPath, script ? [join(HERE, script), ...args.slice(1)] : [IMP, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done({ code, out }));
});
// The ledger is read fresh each time it is needed: a fix round appended rows
// while this cycle was running. A missing file is an empty ledger, not a crash.
function readLedger() {
    try {
        return readFileSync(join(HOME, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
        return [];
    }
}
const ledgerRow = (id) => readLedger().find((r) => r.id === id);
// How often a running claim refreshes its heartbeat. Well under the 90 min TTL
// so a live run always looks alive, and cheap enough to ignore.
const CLAIM_BEAT_MS = 10 * 60_000;

async function work(issue) {
    const { repo, number } = issue;
    const slug = `${o.owner}/${repo}`;
    // One PR per issue: look again right before claiming. The issue may have been
    // fixed, or a PR opened, since the cycle picked it.
    let guard;
    try {
        guard = prGuard({ branch: null, issue: number, slug, ...lookupIssueGuard(slug, number) });
    } catch (e) {
        return log({ event: 'guard-error', repo, number, error: e.message });
    }
    if (!guard.ok) {
        log({ event: 'skip-handled', repo, number, reason: guard.reason });
        if (/already fixed/.test(guard.reason)) {
            // Relabel first: once off imp:ready the issue is not picked again, so a
            // failing comment cannot repeat hourly.
            try {
                relabel(repo, number, 'imp:needs-human', ['imp:ready']);
                comment(repo, number, `Not running an imp: ${guard.reason}. Taking it off \`imp:ready\`; close the issue if it is done.`);
            } catch (e) {
                log({ event: 'issue-note-error', repo, number, error: e.message });
            }
        }
        return;
    }
    const claim = { machine: hostname(), startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), pr: null };
    let cid = null;
    if (!dry) {
        try {
            cid = gh(['api', `repos/${slug}/issues/${number}/comments`, '-f', `body=${claimBody(claim)}`, '--jq', '.id']);
        } catch (e) {
            log({ event: 'claim-comment-error', repo, number });
        }
    }
    const beat = (pr) => {
        if (!cid) return;
        claim.heartbeatAt = new Date().toISOString();
        if (pr) claim.pr = pr;
        try {
            gh(['api', '-X', 'PATCH', `repos/${slug}/issues/comments/${cid}`, '-f', `body=${claimBody(claim)}`]);
        } catch {}
    };
    const hb = setInterval(beat, CLAIM_BEAT_MS);
    hb.unref?.();
    // Post the claim comment BEFORE relabeling to imp:working, so another dispatcher
    // sees the claim and does not reclaim it while this run is starting.
    try {
        relabel(repo, number, 'imp:working', ['imp:ready']);
    } catch (e) {
        clearInterval(hb);
        throw e;
    }
    try {
        const run = await node(['run', '--brief', issue.briefPath, '--model', 'MAX']);
        const id = (run.out.match(/^(imp_\S+)/m) || [])[1];
        if (!id && /claude binary not found/.test(run.out)) {
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return log({ event: 'infra-fail', repo, number, reason: 'claude binary not found (set IMPS_CLAUDE_BIN or install Claude Code)' });
        }
        if (!id && isTransientNetworkError(run.out)) {
            // GitHub or the network was unreachable before the imp started: nothing was tried on the issue.
            // Record first: if the network is still down the relabel below throws, and the issue (left on
            // imp:working) is released by the stale-claim sweep, with this event explaining why.
            log({ event: 'infra-fail', repo, number, reason: 'network', out: run.out.slice(-300) });
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return;
        }
        if (!id) {
            relabel(repo, number, 'imp:failed', ['imp:working']);
            note(repo, number, `Imp run didn't start:\n\n\`\`\`\n${run.out.slice(-1500)}\n\`\`\``);
            return log({ event: 'run-error', repo, number, out: run.out.slice(-500) });
        }
        if (ledgerRow(id)?.metrics?.end === 'spawn-failed') {
            // No claude binary here: nothing was tried on the issue, so put it back
            // and say nothing on it. `doctor.ps1` reports the missing binary.
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return log({ event: 'infra-fail', repo, number, id, reason: 'claude binary not found (set IMPS_CLAUDE_BIN or install Claude Code)' });
        }
        await node(['gate', id]);
        const row = ledgerRow(id);
        const m = row.metrics || {};
        const stats = `${m.turns ?? '?'} turns, ${m.toolErrors ?? '?'} tool errors, served ${(m.served || []).join(', ') || '?'}`;
        if (row.gate?.pass) {
            const pr = await node(['pr', id]);
            const url = (pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
            if (url) {
                beat(url);
                relabel(repo, number, 'imp:pr', ['imp:working']);
                note(repo, number, `An imp opened a PR: ${url} (run \`${id}\`: ${stats}). Auto-merge runs only after review approve, every check green, and earned trust.`);
                // The review + merge decision live inside `imp.mjs pr`.
                return log({ event: 'pr', repo, number, id, url, review: (pr.out.match(/posted (\w+)/) || [])[1] || 'failed' });
            }
            relabel(repo, number, 'imp:failed', ['imp:working']);
            note(repo, number, `The imp passed the gate but the PR couldn't be opened (run \`${id}\`).`);
            return log({ event: 'pr-error', repo, number, id, out: pr.out.slice(-500) });
        }
        relabel(repo, number, 'imp:failed', ['imp:working']);
        note(repo, number, `The imp didn't pass the gate (run \`${id}\`: ${stats}).\n\n${(row.gate?.reasons || ['no gate result']).map((x) => `- ${x}`).join('\n')}\n\nNeeds a new brief or a human.`);
        log({ event: 'gate-fail', repo, number, id, reasons: row.gate?.reasons });
    } finally {
        clearInterval(hb);
    }
}

// ── the cycle ─────────────────────────────────────────────────────────────
const router = await waitForRouter();
if (!router.up) {
    log({ event: 'skip', reason: '9router not up after 10 min', attempts: router.attempts, waitedMs: router.waitedMs });
    process.exit(0);
}
if (router.attempts > 1) log({ event: 'router-up', attempts: router.attempts, waitedMs: router.waitedMs });

// Strip stale imp state labels from closed issues (stash#289, stash#290, vigil#313).
try {
    const seen = new Set();
    for (const l of STALE_ON_CLOSE) {
        const res = ghJson(['search', 'issues', '--owner', o.owner, '--state', 'closed', '--label', l, '--limit', '100', '--json', 'repository,number,labels']);
        for (const i of res) {
            const key = `${i.repository.name}#${i.number}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const rm = staleImpLabels(i.labels);
            if (rm.length && !dry) {
                gh(['issue', 'edit', String(i.number), '-R', `${o.owner}/${i.repository.name}`, ...rm.flatMap((x) => ['--remove-label', x])]);
            }
            log({ event: 'label-cleanup', repo: i.repository.name, number: i.number, removed: rm });
        }
    }
} catch (e) {
    log({ event: 'label-cleanup-error', error: e.message });
}

// Release claims left behind by a machine that stopped mid-run, before picking
// anything: otherwise the queue looks emptier than it is (#60).
let ledger = readLedger();
const reclaimed = await releaseStrandedClaims(ledger);
if (reclaimed.length) console.log(`reclaimed ${reclaimed.length}: ${reclaimed.join(', ')}`);

const labelCleared = await clearStaleLabels();
if (labelCleared.length) console.log(`cleared stale imp:* labels on ${labelCleared.length}: ${labelCleared.join(', ')}`);

// Sweep the open imp PRs first (owner-approved 2026-10-22): answer review
// feedback and red CI with a 9router fix round. fix.mjs pushes only to the
// imp's own PR branch, stops after 2 rounds or on a conflict, and labels
// imp:needs-human. A PR with nothing to act on costs only gh calls.
const openImpAll = ghJson(['search', 'prs', '--owner', o.owner, '--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'url,labels,body,number,repository'])
    .map((p) => ({ ...p, repo: p.repository.name, owner: o.owner }));

// One PR per issue: close open imp PRs whose issue a merged imp PR already fixed.
try {
    const mergedImp = ghJson(['search', 'prs', '--owner', o.owner, '--merged', '--label', 'imp', '--limit', '100', '--sort', 'updated', '--json', 'url,body,number,repository'])
        .map((p) => ({ ...p, repo: p.repository.name, owner: o.owner }));
    ledger = readLedger();
    for (const d of duplicateImpPrs(openImpAll, mergedImp)) {
        log({ event: 'duplicate-closed', pr: d.pr.url, mergedPr: d.mergedPr.url, issue: d.key });
        if (dry) continue;
        const slug = `${o.owner}/${d.pr.repo}`;
        gh(['pr', 'close', String(d.pr.number), '-R', slug, '--comment', `<!-- imp-duplicate -->
Closing: ${d.key} was already fixed by merged PR ${d.mergedPr.url}. One PR per issue.`]);
        const row = ledger.find((r) => r.pr === d.pr.url);
        if (row) updateRun(row.id, { outcome: 'closed-duplicate' });
        d.pr.closed = true;
    }
} catch (e) {
    log({ event: 'duplicate-sweep-error', error: e.message });
}

// Ledger hygiene: fill in `outcome` for runs whose PR has since merged or closed
// (a human merge, a closed PR). At most 40 gh calls a cycle, oldest first.
ledger = readLedger();
for (const r of ledger.filter((x) => x.pr && (!x.outcome || x.outcome === 'open')).slice(0, 40)) {
    try {
        const v = ghJson(['pr', 'view', r.pr, '--json', 'state,mergedAt']);
        const outcome = outcomeFromPr(v);
        if (outcome === 'open' || dry) continue;
        updateRun(r.id, { outcome, ...(v.mergedAt ? { mergedAt: v.mergedAt } : {}) });
        log({ event: 'outcome', id: r.id, outcome });
    } catch (e) {
        log({ event: 'outcome-error', id: r.id, error: e.message });
    }
}

const openImp = openImpAll.filter((p) => !p.closed && !p.labels.some((l) => l.name === 'imp:needs-human'));
ledger = readLedger();
for (const p of openImp) {
    const row = ledger.find((r) => r.pr === p.url);
    if (!row) continue; // opened from another machine's ledger
    const f = await node(['fix', row.id, ...(dry ? ['--dry-run'] : [])], 'fix.mjs');
    const last = f.out.trim().split('\n').reverse().find((l) => l.startsWith('{"id"'));
    log({ event: 'fix-sweep', pr: p.url, id: row.id, result: last ? JSON.parse(last).event : `exit ${f.code}` });
}

// Release stale imp:working claims whose heartbeat is older than 90 min (#69).
for (const w of ghJson(['search', 'issues', '--owner', o.owner, '--state', 'open', '--label', 'imp:working', '--limit', '100', '--json', 'repository,number'])) {
    const slug = `${o.owner}/${w.repository.name}`;
    const comments = ghJson(['issue', 'view', String(w.number), '-R', slug, '--json', 'comments']).comments;
    const c = comments.map((x) => parseClaim(x.body)).filter(Boolean).pop();
    if (!claimExpired(c, Date.now())) continue;
    relabel(w.repository.name, w.number, 'imp:ready', ['imp:working']);
    comment(w.repository.name, w.number, `Released: ${c.machine}'s claim had no heartbeat since ${c.heartbeatAt} (TTL 90 min). Back to imp:ready.`);
    log({ event: 'claim-released', repo: w.repository.name, number: w.number, machine: c.machine });
}

const queued = ghJson(['search', 'issues', '--owner', o.owner, '--state', 'open', '--label', 'imp:ready', '--limit', '100',
    '--json', 'repository,number,labels,createdAt,title'])
    .map((i) => ({ repo: i.repository.name, number: i.number, title: i.title, createdAt: i.createdAt, labels: i.labels.map((l) => l.name) }))
    .filter((i) => !i.labels.some((l) => ['imp:working', 'imp:pr'].includes(l)))
    .filter((i) => !o.only || o.only.split(',').map((s) => s.trim()).includes(`${i.repo}#${i.number}`));
const impPRs = ghJson(['search', 'prs', '--owner', o.owner, '--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'repository'])
    .map((p) => p.repository.name);

const repos = {};
for (const name of new Set([...queued.map((i) => i.repo), ...impPRs])) {
    const prs = ghJson(['pr', 'list', '-R', `${o.owner}/${name}`, '--state', 'open', '--json', 'labels,author']);
    const branch = gh(['api', `repos/${o.owner}/${name}`, '--jq', '.default_branch']);
    const last = gh(['api', `repos/${o.owner}/${name}/commits/${branch}`, '--jq', '.commit.committer.date']);
    repos[name] = {
        impPRs: prs.filter((p) => p.labels.some((l) => l.name === 'imp')).length,
        humanPRs: prs.filter((p) => !p.labels.some((l) => l.name === 'imp') && !p.author.is_bot && !/\[bot\]|^app\//.test(p.author.login)).length,
        lastCommitHours: Math.round((Date.now() - Date.parse(last)) / 3600_000),
    };
}

const picked = [];
// Read the ledger again: the fix sweep above may have added rounds.
// readLedger, not readFileSync: a fresh machine has no runs.jsonl yet.
const budget = loopBudget(readLedger());
// An issue with no brief is skipped below, so it must not use up one of the --max
// slots (with --max 1 a briefless issue at the head of the queue starved the cycle
// every hour). Pick in batches until the slots hold issues that can run.
function* pickable() {
    let pool = queued;
    while (picked.length < Number(o.max)) {
        const taken = (repo) => picked.filter((p) => p.repo === repo).length;
        const batch = pickIssues({
            candidates: pool,
            repos: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, { ...v, impPRs: (v.impPRs || 0) + taken(k) }])),
            // wip is not reduced here: the impPRs bump above already counts what is picked.
            max: Number(o.max) - picked.length, wip: Number(o.wip), perRepo,
            dailyCap: Number(o['daily-cap']) - picked.length, ...budget,
        });
        if (!batch.length) return;
        pool = pool.filter((c) => !batch.includes(c));
        yield* batch;
    }
}
for (const i of pickable()) {
    const comments = ghJson(['issue', 'view', String(i.number), '-R', `${o.owner}/${i.repo}`, '--json', 'comments']).comments;
    const brief = briefFromComments(comments);
    if (!brief) {
        log({ event: 'no-brief', repo: i.repo, number: i.number });
        if (!hasMark(comments, NO_BRIEF_MARK)) {
            try {
                comment(i.repo, i.number, `${NO_BRIEF_MARK}
This is labelled \`imp:ready\` but has no brief comment, so no imp will run on it. A brief is a comment starting with \`<!-- imp-brief -->\` (see imps/STANDARD.md). Not repeating this note.`);
            } catch (e) {
                log({ event: 'issue-note-error', repo: i.repo, number: i.number, error: e.message });
            }
        }
        continue;
    }
    // Per-issue attempt cap: stop feeding an issue that keeps failing. A newer
    // brief comment (a human re-brief) resets the count.
    const briefAt = briefCommentAt(comments);
    const fails = issueFailures(readLedger(), i.repo, i.number, briefAt);
    if (fails >= DEFAULTS.maxIssueFailures) {
        log({ event: 'issue-cap', repo: i.repo, number: i.number, failures: fails });
        if (!dry) {
            try {
                // Relabel first so a failing comment cannot repeat every cycle.
                relabel(i.repo, i.number, 'imp:needs-human', ['imp:ready']);
                if (!hasMark(comments.filter((c) => Date.parse(c.createdAt || '') >= briefAt), CAP_MARK))
                    comment(i.repo, i.number, `${CAP_MARK}
${fails} imp attempts on this issue failed or were killed without a PR, so the dispatcher stops here. Labelled \`imp:needs-human\`: re-brief it (a new brief comment resets the count) or fix it by hand.`);
            } catch (e) {
                log({ event: 'issue-note-error', repo: i.repo, number: i.number, error: e.message });
            }
        }
        continue;
    }
    i.briefPath = join(HOME, 'briefs', `${i.repo}-${i.number}.md`);
    writeFileSync(i.briefPath, withKind(brief, i.labels));
    picked.push(i);
}
log({ event: 'cycle', queued: queued.length, openImpPRs: impPRs.length, runsLast24h: budget.runsLast24h, cooldown: budget.cooldown, repos, picked: picked.map((i) => `${i.repo}#${i.number}`) });
if (dry || !picked.length) process.exit(0);

// Run up to `concurrency` repos at once. Imps for the same repo run one after another:
// they share the repo's `imp-nm-<repo>` node_modules volume, and two `npm ci` runs on it would race.
const byRepo = new Map();
for (const i of picked) byRepo.set(i.repo, [...(byRepo.get(i.repo) || []), i]);
const pool = [...byRepo.values()];
await Promise.all(Array.from({ length: Math.min(Number(o.concurrency), pool.length) }, async () => {
    while (pool.length) {
        for (const i of pool.shift()) {
            try {
                await work(i);
            } catch (e) {
                log({ event: 'error', repo: i.repo, number: i.number, error: e.message });
            }
        }
    }
}));
log({ event: 'done' });

// Optional RSI pass (also runnable via `node rsi.mjs`). Off by default on the
// hourly tick; enable with --rsi or IMPS_RSI=1. Kill switch: IMPS_RSI=0.
if (o.rsi || process.env.IMPS_RSI === '1') {
    if (process.env.IMPS_RSI === '0') {
        log({ event: 'rsi-skip', reason: 'IMPS_RSI=0' });
    } else {
        const rsi = await node(['rsi', ...(dry ? ['--dry-run'] : [])], 'rsi.mjs');
        log({ event: 'rsi', code: rsi.code, out: rsi.out.trim().split('\n').slice(-5) });
    }
}

// Tell the fleet this machine is alive and what it is running. Off unless
// explicitly enabled, and never fatal — see heartbeat.mjs (#61).
const beat = await node(['heartbeat', ...(dry ? ['--dry-run'] : [])], 'heartbeat.mjs');
if (beat.out.trim()) console.log(beat.out.trim());
