#!/usr/bin/env node
// The hourly imps dispatcher. No LLM of its own: it reads the GitHub queue,
// picks issues, and runs each through imp.mjs run → gate → pr.
//
//   node dispatch.mjs [--max 5] [--wip 12] [--per-repo 6] [--concurrency 6] [--owner nitsuah] [--dry-run] [--rsi] [--only repo#N,...]
//
// Queue: open issues labelled `imp:ready` that carry a brief comment (see
// BRIEF_MARK in lib.mjs; Opus triage / rsi.mjs write them). Each issue moves to
// `imp:working`, then `imp:pr` (PR opened), `imp:failed` (gate reasons commented),
// or an unlabelled non-consuming `commit-recovery-failed` outcome. Defaults: imps/defaults.mjs. Contract: STANDARD.md.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { readLock, lockOwnedBy, acquireLock, releaseLock, writeLockAtomic } from './locks.mjs';
import { homedir, hostname, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isNoopRun, noopRetryOk, feedbackEligible, feedbackSection, parseBrief, parseDepends, unmetDepends, INFRA_RETRY_CAP, infraRuns, isApiInfraError, sweepIsRepeat, isTransientNetworkError, isReadOnlyGh, runGhWithReadRetry, outputSection, pickIssues, briefFromComments, missingBriefRequiresUnready, loopBudget, configNumber, claimBody, latestClaim, staleClaim, staleImpLabels, STALE_ON_CLOSE, lockIsStale, routerWaitDelays, parseClaim, claimExpired, prGuard, duplicateImpPrs, issueFailures, briefCommentAt, hasMark, isEpicIssueBody, resolveImpsCodeRoot, targetCheckout, normalizeModelStrategy, resolveQueueOwners, normalizeRepoExclusions, parseBriefAuthors, withKind, outcomeFromPr, CAP_MARK, NO_BRIEF_MARK, resolveRouter, validateBriefMeta, failureDiagnosticSummary, COMMIT_RECOVERY_FAILED, COMMIT_RECOVERY_IN_PROGRESS, COMMIT_RECOVERY_FAILED_MARK, commitRecoveryFailureBlocksReclaim, mayOverflow, lockBusyRepos, pendingPicks, briefSourceHash, coveringMergeAt, foreignLiveClaim, repoRef, repoSlug, refDirName } from './lib.mjs';
import { MODEL_MISMATCH_MARK, expectedFamilies } from './served-model.mjs';
import { retryModel, allowedRequestModels } from './model-pin.mjs';
import { kitSha, machineName, lookupIssueGuard, originUrl, update as updateRun } from './runner.mjs';
import { DEFAULTS } from './defaults.mjs';
import { hasExplicitOwnerArg, discoverQueueCandidates } from './queue-discovery.mjs';
import { rsiDue } from './rsi-lib.mjs';

function loadHomeConfig() {
    try {
        const p = join(HOME, 'config.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    } catch { return {}; }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
const HOME_CONFIG = loadHomeConfig();
const { values: o } = parseArgs({
    options: {
        max: { type: 'string', default: String(DEFAULTS.max) },
        wip: { type: 'string', default: String(DEFAULTS.wip) },
        'per-repo': { type: 'string', default: String(DEFAULTS.perRepo) },
        concurrency: { type: 'string', default: String(DEFAULTS.concurrency) },
        'daily-cap': { type: 'string', default: String(configNumber(HOME_CONFIG, 'dailyCap', DEFAULTS.dailyCap)) },
        owner: { type: 'string', default: DEFAULTS.owner },
        'dry-run': { type: 'boolean', default: false },
        only: { type: 'string', default: '' }, // controlled runs: --only vhs#102,skyview#213
        rsi: { type: 'boolean', default: false },
    },
});
const ownerWasExplicit = hasExplicitOwnerArg(process.argv.slice(2));
const queueOwners = resolveQueueOwners(HOME_CONFIG, ownerWasExplicit ? o.owner : null, DEFAULTS.owner);
const excludedRepos = new Set(normalizeRepoExclusions(HOME_CONFIG.excludeRepos));
let briefAuthors;
try {
    briefAuthors = parseBriefAuthors(process.env.IMPS_BRIEF_AUTHORS);
} catch (e) {
    console.error(e.message);
    process.exit(2);
}
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
    const r = runGhWithReadRetry(args,
        (command) => spawnSync('gh', command, { encoding: 'utf8', windowsHide: true }),
        () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000));
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
const OVERFLOW_LOCK = join(HOME, 'dispatch-overflow.lock');
// The lock protocol (exclusive create, guarded stale takeover, owner-only release, atomic updates) lives in
// locks.mjs, where it is tested against a temp directory.
const lockState = readLock;
const stalenessOf = (st) => lockIsStale({
    text: st.text,
    mtimeMs: st.mtimeMs,
    now: Date.now(),
    bootTimeMs: Date.now() - uptime() * 1000,
    host: hostname(),
    alive,
    maxAgeMs: DEFAULTS.lockMaxAgeMs,
});
/** Why a lock file is stale, null when it is live, 'gone' when it no longer exists. */
const staleness = (file) => {
    const st = lockState(file);
    return st ? stalenessOf(st) : 'gone';
};
const lockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
/** Take `file` if it is free or stale. Returns true when this process now holds it (always, in a dry run). */
const acquire = (file, info) => dry || acquireLock(file, info, stalenessOf, {
    onCleared: (why, st) => log({ event: 'lock-cleared', lock: file === LOCK ? 'main' : 'overflow', reason: why, text: st.text.slice(0, 200) }),
});
// An overflow cycle only picks and runs new issues, in repos the main cycle is not touching. It skips the
// sweeps, hygiene, RSI and heartbeat: the main cycle owns those, and running them twice at once would race.
let overflow = false;
if (!acquire(LOCK, lockInfo)) {
    const main = lockState(LOCK);
    const overflowAfterMs = Number(loadHomeConfig().overflowAfterMs ?? DEFAULTS.overflowAfterMs);
    const ok = !!main && process.env.IMPS_OVERFLOW !== '0' && !o.only && mayOverflow({
        mainText: main.text,
        mainMtimeMs: main.mtimeMs,
        overflow: existsSync(OVERFLOW_LOCK) ? OVERFLOW_LOCK : null,
        now: Date.now(),
        overflowAfterMs,
        staleCheck: (file) => { try { return staleness(file); } catch { return 'unreadable'; } },
    });
    if (!ok || !acquire(OVERFLOW_LOCK, { ...lockInfo, overflow: true })) {
        log({ event: 'skip', reason: main ? 'previous cycle still running (lock < 3h old)' : 'lock contention' });
        process.exit(0);
    }
    overflow = true;
}
const MY_LOCK = overflow ? OVERFLOW_LOCK : LOCK;
const myInfo = { ...lockInfo, ...(overflow ? { overflow: true } : {}) };
// Release only a lock this process still owns: never one another cycle took over after ours went stale.
const unlock = () => { if (!dry) releaseLock(MY_LOCK, lockInfo); };
process.on('exit', unlock);
if (overflow) log({ event: 'overflow-start', mainBusy: lockBusyRepos(lockState(LOCK)?.text || '') });
/**
 * Record which repos this cycle is working in (imps and fix rounds), so the other cycle leaves them alone,
 * and which issues it has picked but not started, so both cycles count them against the daily cap.
 */
let myBusy = [];
let myPicks = [];
// Atomic (temp file + rename): the other cycle must never read a truncated lock as an empty busy list.
const writeMine = () => { if (!dry && lockOwnedBy(MY_LOCK, lockInfo)) writeLockAtomic(MY_LOCK, { ...myInfo, busy: myBusy, picks: myPicks }); };
const markBusy = (repos) => { myBusy = repos; writeMine(); };
const markPicks = (picks) => { myPicks = picks; writeMine(); };
const otherLock = () => {
    const other = overflow ? LOCK : OVERFLOW_LOCK;
    try {
        const st = lockState(other);
        return st && !stalenessOf(st) ? st.text : '';
    } catch {
        return '';
    }
};
/** Repos the other cycle (main or overflow) is working in right now. */
const otherBusy = () => lockBusyRepos(otherLock());
/**
 * Claim `repo` for this cycle, then check the other cycle has not: mark first, check second, so two cycles
 * racing for one repo can both back off but never both proceed. Returns false (and unclaims) on a clash.
 */
const reserveRepo = (repo, base = []) => {
    markBusy([...new Set([...base, repo])]);
    if (!otherBusy().includes(repo)) return true;
    markBusy(base);
    return false;
};

// ── 9router must be up ────────────────────────────────────────────────────
async function routerUp() {
    const { baseUrl: base, key } = resolveRouter();
    if (!key) return false; // never probe keyless (or with a refused anthropic.com config)
    try {
        const r = await fetch(`${base}/messages`, {
            method: 'POST',
            signal: AbortSignal.timeout(60_000),
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'MAX', max_tokens: 5, stream: false, messages: [{ role: 'user', content: 'say ok' }] }),
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

/** `gh search issues|prs` across every queue owner, each hit tagged with its ref; excluded repos are never swept. */
const searchOwners = (kind, args) => queueOwners.flatMap((owner) => (ghJson(['search', kind, '--owner', owner, ...args]) || [])
    .filter((hit) => !excludedRepos.has(`${owner}/${hit.repository.name}`.toLowerCase()))
    .map((hit) => ({ ...hit, repo: repoRef(hit.repository.name, owner) })));

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
    const slug = repoSlug(repo);
    for (const l of [add, ...remove]) {
        if (ensured.has(`${slug}:${l}`)) continue;
        spawnSync('gh', ['label', 'create', l, '-R', slug, '-c', LABELS[l][0], '-d', LABELS[l][1], '--force'], { encoding: 'utf8', windowsHide: true });
        ensured.add(`${slug}:${l}`);
    }
    gh(['issue', 'edit', String(number), '-R', slug, '--add-label', add, ...remove.flatMap((l) => ['--remove-label', l])]);
}
const comment = (repo, number, body) => !dry && gh(['issue', 'comment', String(number), '-R', repoSlug(repo), '-b', body]);
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
            if (commentId) gh(['api', '-X', 'PATCH', `repos/${repoSlug(repo)}/issues/comments/${commentId}`, '-f', `body=${body}`]);
            else {
                const out = gh(['issue', 'comment', String(number), '-R', repoSlug(repo), '-b', body]);
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
        issues = searchOwners('issues', ['--state', 'open', '--label', 'imp:working', '--limit', '100', '--json', 'repository,number,labels']);
    } catch (e) {
        log({ event: 'label-cleanup-error', error: e.message });
    }
    for (const issue of issues) {
        const repo = issue.repo;
        const number = issue.number;
        const key = `${repo}#${number}`;
        const labels = issue.labels.map((l) => l.name);
        let comments = [];
        try {
            comments = ghJson(['issue', 'view', String(number), '-R', repoSlug(repo), '--json', 'comments']).comments || [];
        } catch (e) {
            log({ event: 'label-cleanup-error', repo, number, error: e.message });
            continue;
        }
        const row = ledgerRows.filter((r) => `${r.repo}#${r.issue}` === key).at(-1);
        if (commitRecoveryFailureBlocksReclaim(comments)) {
            log({ event: 'commit-recovery-reclaim-held', repo, number });
            continue;
        }
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
            hits = searchOwners('issues', ['--state', 'closed', '--label', label, '--limit', '100', '--json', 'repository,number,labels']);
        } catch (e) {
            log({ event: 'label-cleanup-error', error: e.message });
            continue;
        }
        for (const i of hits) seen.set(`${i.repo}#${i.number}`, i);
    }
    for (const issue of seen.values()) {
        const repo = issue.repo;
        const stale = staleImpLabels(issue.labels);
        if (!stale.length) continue;
        // Log only what happened: a dry run names what it would remove, and a failed edit is not logged as a removal (friction #8).
        if (dry) { log({ event: 'label-cleanup', dry: true, repo, number: issue.number, removed: stale }); continue; }
        try {
            gh(['issue', 'edit', String(issue.number), '-R', repoSlug(repo), ...stale.flatMap((l) => ['--remove-label', l])]);
            log({ event: 'label-cleanup', dry: false, repo, number: issue.number, removed: stale });
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
    const slug = repoSlug(repo);
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
        const cfg = loadHomeConfig();
        const modelStrategy = normalizeModelStrategy(cfg);
        const run = await node(['run', '--brief', issue.briefPath, '--model', 'MAX', '--modelStrategy', modelStrategy]);
        let id = (run.out.match(/^(imp_\S+)/m) || [])[1];
        if (!id && /claude binary not found/.test(run.out)) {
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return log({ event: 'infra-fail', repo, number, reason: 'claude binary not found (set IMPS_CLAUDE_BIN or install Claude Code)' });
        }
        if (!id && run.out.includes(MODEL_MISMATCH_MARK)) {
            // The router served a different model family than expected (#258). The run stopped before
            // quota, worktree or ledger row, so no attempt was consumed: put the issue back.
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return log({ event: 'infra-fail', repo, number, reason: 'model-mismatch', out: run.out.slice(-300) });
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
        // Which brief this run was given, so a later re-brief retires its failure from the repo cooldown.
        try {
            updateRun(id, { sourceBriefHash: issue.sourceBriefHash });
        } catch (e) {
            log({ event: 'ledger-note-error', repo, number, id, error: String(e.message).slice(0, 200) });
        }
        if (ledgerRow(id)?.metrics?.end === 'spawn-failed') {
            // No claude binary here: nothing was tried on the issue, so put it back
            // and say nothing on it. `doctor.ps1` reports the missing binary.
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return log({ event: 'infra-fail', repo, number, id, reason: 'claude binary not found (set IMPS_CLAUDE_BIN or install Claude Code)' });
        }
        if (isApiInfraError(ledgerRow(id)?.metrics)) {
            // The router's upstream dropped before the imp did anything: put the issue back and don't count an attempt.
            const why = String(ledgerRow(id)?.metrics?.finalText || '').slice(0, 120);
            updateRun(id, { infra: 'api-error' });
            const recent = infraRuns(readLedger(), repo, number, Date.now() - 6 * 3600_000);
            if (recent >= INFRA_RETRY_CAP) {
                // The router keeps failing this issue: stop re-queueing it every cycle (each retry still spends a daily slot).
                relabel(repo, number, 'imp:failed', ['imp:working']);
                note(repo, number, `Stopped retrying: ${recent} runs in 6 hours ended on a router error before the imp did anything (\`${why}\`). Re-queue it with imp:ready once the router is healthy.`);
                return log({ event: 'infra-giveup', repo, number, id, runs: recent, reason: `api error: ${why}` });
            }
            log({ event: 'infra-fail', repo, number, id, reason: `api error: ${why}` });
            relabel(repo, number, 'imp:ready', ['imp:working']);
            return;
        }
        if (ledgerRow(id)?.metrics?.end === 'brief-broken') {
            // The brief's own test command could not run on the unchanged base (see imp.mjs base preflight):
            // no model ran, and rerunning the same brief cannot help, so it goes straight back to its author.
            // finalText is a fixed category (brokenCommandSignature never returns raw output, which can carry
            // arguments); the output itself stays in the local ledger as baseTest.tail.
            const why = String(ledgerRow(id)?.metrics?.finalText || 'test command broken').slice(0, 300);
            relabel(repo, number, 'imp:failed', ['imp:working']);
            note(repo, number, `<!-- imp-brief-broken -->\nNo model ran: the brief's \`test:\` command fails on the unchanged base before any change (run \`${id}\`).\n\n- ${why}\n\nThe command's output is kept in the runner's local ledger, not posted here. Fix the command in the \`<!-- imp-brief -->\` comment (try it on main first) and re-add \`imp:ready\`.`);
            return log({ event: 'brief-broken', repo, number, id, reason: why });
        }
        const sm = ledgerRow(id)?.metrics;
        if (sm && (sm.end === 'script-failed' || (sm.end === 'script' && sm.isError))) {
            // A `mode: script` run that failed or committed nothing: the gate would only say "no commits", so
            // the author gets the runner's reason instead. It is a fixed phrase (exit code, timeout, "changed no
            // allowed file", "git commit failed"); raw output stays in the local ledger. A rerun of the same
            // script brief cannot change the result, so it goes back to its author like a broken brief.
            const why = String(sm.finalText || 'script run failed').slice(0, 300);
            relabel(repo, number, 'imp:failed', ['imp:working']);
            note(repo, number, `<!-- imp-script-failed -->\nThe \`mode: script\` run made no commit (run \`${id}\`).\n\n- ${why}\n\nThe command's output is kept in the runner's local ledger, not posted here. Check the brief's \`test:\` command and \`allow:\` list on main, then re-add \`imp:ready\`.`);
            return log({ event: 'script-failed', repo, number, id, reason: why });
        }
        const gateRun = await node(['gate', id]);
        let row = ledgerRow(id);
        if (row?.outcome === COMMIT_RECOVERY_FAILED || gateRun.code === 75) {
            const reason = row?.commitRecovery?.reason || 'new commit and clean status were not verified';
            if (!dry) {
                let labelRemoved = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        gh(['issue', 'edit', String(number), '-R', slug, '--remove-label', 'imp:working']);
                        labelRemoved = true;
                        break;
                    } catch (e) {
                        log({ event: 'commit-recovery-label-error', repo, number, id, attempt, error: String(e.message).slice(0, 200) });
                        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                    }
                }
                const labelState = labelRemoved
                    ? 'The imp:working label was removed; the issue is left unlabelled.'
                    : 'Removal of imp:working was not confirmed after three attempts; the label may remain, but the failure marker prevents automatic requeue until a newer claim is posted.';
                try {
                    note(repo, number, COMMIT_RECOVERY_FAILED_MARK + String.fromCharCode(10) + 'Commit recovery for run `' + id + '` failed: ' + reason + '. No normal gate ran. This is the distinct `commit-recovery-failed` outcome and does not consume the issue attempt or repo cooldown. ' + labelState + ' Inspect the worktree and requeue only after a corrected brief/manual recovery.');
                } catch (e) {
                    log({ event: 'commit-recovery-note-error', repo, number, id, error: String(e.message).slice(0, 200) });
                }
            }
            return log({ event: 'commit-recovery-failed', repo, number, id, reason });
        }
        if (row?.commitRecovery?.inProgress || gateRun.code === 76) {
            return log({ event: 'commit-recovery-in-progress', repo, number, id });
        }
        // One retry, inside the same claim, for a run that drowned in tool errors (#388). The first row
        // keeps its diagnostics and is marked `retriedBy`, so the pair counts as one attempt.
        const next = retryModel({
            row, rows: readLedger(),
            allowed: cfg.pinModels === false ? [] : allowedRequestModels({ pinned: cfg.pinnedModels ?? DEFAULTS.pinnedModels, expected: expectedFamilies(cfg, process.env) }),
        });
        if (next) {
            log({ event: 'tool-error-retry', repo, number, id, toolErrors: row.metrics.toolErrors, model: next });
            const again = await node(['run', '--brief', issue.briefPath, '--model', next, '--modelStrategy', modelStrategy]);
            const retryId = (again.out.match(/^(imp_\S+)/m) || [])[1];
            if (retryId) {
                updateRun(retryId, { retryOf: id, sourceBriefHash: issue.sourceBriefHash });
                await node(['gate', retryId]);
            }
            const retried = retryId ? ledgerRow(retryId) : null;
            // A retry that never reached a gate verdict changes nothing: the first failure stands.
            if (retried?.gate) {
                updateRun(id, { retriedBy: retryId });
                id = retryId;
                row = retried;
            } else {
                log({ event: 'tool-error-retry-void', repo, number, id, retryId: retryId || null });
            }
        }
        const m = row.metrics || {};
        const stats = `${m.turns ?? '?'} turns, ${m.toolErrors ?? '?'} tool errors, served ${(m.served || []).join(', ') || '?'}`;
        if (row.gate?.pass) {
            const prUrl = (out) => (out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
            let pr = await node(['pr', id]);
            let url = prUrl(pr.out);
            // The work already passed the gate: a GitHub blip while opening the PR (stash#344, "see githubstatus.com")
            // is retried instead of failing the issue. The PR may exist even though its URL never came back (response
            // lost after creation), and a retry then fails the "already has an open imp PR" guard, which is not a
            // transient error. So remember that a transient failure happened and look the branch up before retrying
            // and again at the end; an adopted PR skips imp.mjs's review/merge step (a fix-sweep and the owner cover it).
            let adopted = false;
            let transientSeen = !url && isTransientNetworkError(pr.out);
            const adoptByBranch = () => {
                try {
                    const branch = ledgerRow(id)?.branch;
                    const found = branch ? ghJson(['pr', 'list', '-R', slug, '--head', branch, '--state', 'open', '--json', 'url']) : [];
                    if (found?.[0]?.url) {
                        updateRun(id, { pr: found[0].url });
                        adopted = true;
                        return found[0].url;
                    }
                } catch (e) {
                    log({ event: 'pr-lookup-error', repo, number, id, error: String(e.message).slice(0, 200) });
                }
                return undefined;
            };
            for (const waitMs of [20_000, 60_000]) {
                if (url || !transientSeen) break;
                url = adoptByBranch();
                if (url) break;
                log({ event: 'pr-retry', repo, number, id, waitMs });
                await new Promise((r) => setTimeout(r, waitMs));
                pr = await node(['pr', id]);
                url = prUrl(pr.out);
                if (!url && isTransientNetworkError(pr.out)) transientSeen = true;
            }
            if (!url && transientSeen) url = adoptByBranch();
            if (url) {
                beat(url);
                relabel(repo, number, 'imp:pr', ['imp:working']);
                note(repo, number, `An imp opened a PR: ${url} (run \`${id}\`: ${stats}). Auto-merge runs only after review approve, every check green, and earned trust.`);
                // The review + merge decision live inside `imp.mjs pr`.
                return log({ event: 'pr', repo, number, id, url, review: adopted ? 'skipped (adopted after a lost response)' : (pr.out.match(/posted (\w+)/) || [])[1] || 'failed' });
            }
            relabel(repo, number, 'imp:failed', ['imp:working']);
            note(repo, number, `The imp passed the gate but the PR couldn't be opened (run \`${id}\`).`);
            return log({ event: 'pr-error', repo, number, id, out: pr.out.slice(-500) });
        }
        // A run the model ended almost at once with nothing done (a failover model that answers and stops) is the router's fault:
        // put the issue straight back on imp:ready, at most NOOP_FREE times (see noopRetryOk), without spending an attempt.
        if (isNoopRun(row) && noopRetryOk(readLedger(), repo, number, issue.briefAt || 0)) {
            relabel(repo, number, 'imp:ready', ['imp:working']);
            note(repo, number, `The model ended the run without doing anything (run ${id}: ${stats}). That is not counted against this issue; retrying automatically.`);
            return log({ event: 'retry-noop', repo, number, id });
        }
        const diagSummary = failureDiagnosticSummary(row.gate);
        // One automatic second attempt, with the failing output in the brief, when a second try can plausibly fix it.
        // The same safe summary is included on retry and terminal failure comments.
        // Kill switch: IMPS_RETRY_FEEDBACK=0.
        if (process.env.IMPS_RETRY_FEEDBACK !== '0' && feedbackEligible(row.gate) && issueFailures(readLedger(), repo, number) <= 1) {
            relabel(repo, number, 'imp:ready', ['imp:working']);
            note(repo, number, "The imp didn't pass the gate (run " + id + ": " + stats + "): " + row.gate.reasons.join('; ') + "." + diagSummary + "\n\nRetrying once with the failing output.");
            return log({ event: 'retry-feedback', repo, number, id, reasons: row.gate.reasons });
        }
        relabel(repo, number, 'imp:failed', ['imp:working']);
        note(repo, number, "The imp didn't pass the gate (run " + id + ": " + stats + ").\n\n" + (row.gate?.reasons || ['no gate result']).map((x) => "- " + x).join('\n') + diagSummary + (process.env.IMPS_COMMENT_OUTPUT === '1' ? outputSection('Test', 1, row.gate?.testTail) + outputSection('Lint', 1, row.gate?.lintTail) : '') + "\n\nNeeds a new brief or a human.");
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

// Housekeeping and the PR sweeps belong to the main cycle only (see the overflow note at the lock).
if (!overflow) {
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
    const openImpAll = searchOwners('prs', ['--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'url,labels,body,number,repository']);

    // One PR per issue: close open imp PRs whose issue a merged imp PR already fixed.
    try {
        const mergedImp = searchOwners('prs', ['--merged', '--label', 'imp', '--limit', '100', '--sort', 'updated', '--json', 'url,body,number,repository']);
        ledger = readLedger();
        for (const d of duplicateImpPrs(openImpAll, mergedImp)) {
            log({ event: 'duplicate-closed', pr: d.pr.url, mergedPr: d.mergedPr.url, issue: d.key });
            if (dry) continue;
            const slug = repoSlug(d.pr.repo);
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
    const recentEvents = (() => {
        try {
            return readFileSync(LOG, 'utf8').trim().split('\n').filter((x) => x.includes('"event":"fix-sweep"')).map((x) => {
                try {
                    return JSON.parse(x);
                } catch {
                    return null;
                }
            });
        } catch {
            return [];
        }
    })();
    for (const p of openImp) {
        const row = ledger.find((r) => r.pr === p.url);
        if (!row) continue; // opened from another machine's ledger
        // A fix round runs the repo's gate on its imp-nm-<repo> volume: hold the repo so an overflow cycle
        // does not start an imp there meanwhile, and skip it if overflow already has.
        if (!reserveRepo(p.repo)) {
            log({ event: 'fix-sweep-skip', pr: p.url, reason: 'repo busy in the overflow cycle' });
            continue;
        }
        const f = await node(['fix', row.id, ...(dry ? ['--dry-run'] : [])], 'fix.mjs');
        markBusy([]);
        const last = f.out.trim().split('\n').reverse().find((l) => l.startsWith('{"id"'));
        const result = last ? JSON.parse(last).event : `exit ${f.code}`;
        if (!sweepIsRepeat(recentEvents, p.url, result)) log({ event: 'fix-sweep', pr: p.url, id: row.id, result });
    }

    // demonguard: the deterministic watch over imp PRs that linger. imp.mjs decides about auto-merge once, when it
    // opens a PR, so anything not ready then sat open and ate the open-PR cap. Kill switch: IMPS_DEMONGUARD=0.
    if (process.env.IMPS_DEMONGUARD !== '0' && !dry) {
        try {
            // node() resolves { code, out } and never rejects, so a crash only shows in code.
            const dg = await node(['demonguard'], 'demonguard.mjs');
            if (dg.code) log({ event: 'demonguard-error', code: dg.code, out: String(dg.out || '').slice(-300) });
        } catch (e) {
            log({ event: 'demonguard-error', error: String(e.message).slice(0, 200) });
        }
    }

    // bugbot: the fallback reviewer for every open PR (not just imp ones) whose head CodeRabbit cannot review
    // (rate-limited, silent past the grace period, or absent). It posts inline threads and a `bugbot` status,
    // never edits code, and lifts CodeRabbit's stale block only once its own review passed with every thread
    // resolved and checks green. A PR CodeRabbit is handling costs only gh calls. Kill switch: IMPS_BUGBOT=0.
    if (process.env.IMPS_BUGBOT !== '0' && !dry) {
        try {
            const bb = await node(['bugbot', 'sweep'], 'bugbot.mjs');
            if (bb.code) log({ event: 'bugbot-error', code: bb.code, out: String(bb.out || '').slice(-300) });
        } catch (e) {
            log({ event: 'bugbot-error', error: String(e.message).slice(0, 200) });
        }
    }

    // Release stale imp:working claims whose heartbeat is older than 90 min (#69).
    for (const w of searchOwners('issues', ['--state', 'open', '--label', 'imp:working', '--limit', '100', '--json', 'repository,number'])) {
        const slug = repoSlug(w.repo);
        const comments = ghJson(['issue', 'view', String(w.number), '-R', slug, '--json', 'comments']).comments;
        const c = comments.map((x) => parseClaim(x.body)).filter(Boolean).pop();
        if (!claimExpired(c, Date.now())) continue;
        relabel(w.repo, w.number, 'imp:ready', ['imp:working']);
        comment(w.repo, w.number, `Released: ${c.machine}'s claim had no heartbeat since ${c.heartbeatAt} (TTL 90 min). Back to imp:ready.`);
        log({ event: 'claim-released', repo: w.repo, number: w.number, machine: c.machine });
    }
}

const queueRows = queueOwners.flatMap((owner) => ghJson(['search', 'issues', '--owner', owner, '--state', 'open', '--label', 'imp:ready', '--limit', '100',
    '--json', 'repository,number,labels,createdAt,title']).map((issue) => ({ ...issue, searchedOwner: owner })));
const queuedRaw = discoverQueueCandidates(queueRows, [...excludedRepos], o.only)
    // Main and overflow dispatchers must never claim the same repo concurrently.
    .filter((issue) => !otherBusy().includes(issue.repo));

// Preflight target checkouts before pickIssues so a missing repo neither consumes
// a --max slot nor gets claimed/relabeled. `.git` may be a directory or worktree file.
const codeRoot = resolveImpsCodeRoot();
const queued = [];
const missingCheckoutRepos = new Set();
for (const i of queuedRaw) {
    const target = targetCheckout(i.repo, { codeRoot, exists: existsSync, originOf: originUrl });
    if (target.checkedOut) {
        queued.push(i);
        continue;
    }
    if (!missingCheckoutRepos.has(i.repo)) {
        log({ event: 'skip-missing-checkout', repo: i.repo, path: target.path });
        missingCheckoutRepos.add(i.repo);
    }
}
const impPRs = searchOwners('prs', ['--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'repository']).map((p) => p.repo);

const repos = {};
for (const name of new Set([...queued.map((i) => i.repo), ...impPRs])) {
    const prs = ghJson(['pr', 'list', '-R', repoSlug(name), '--state', 'open', '--json', 'labels,author']);
    const branch = gh(['api', `repos/${repoSlug(name)}`, '--jq', '.default_branch']);
    const last = gh(['api', `repos/${repoSlug(name)}/commits/${branch}`, '--jq', '.commit.committer.date']);
    repos[name] = {
        impPRs: prs.filter((p) => p.labels.some((l) => l.name === 'imp')).length,
        humanPRs: prs.filter((p) => !p.labels.some((l) => l.name === 'imp') && !p.author.is_bot && !/\[bot\]|^app\//.test(p.author.login)).length,
        lastCommitHours: Math.round((Date.now() - Date.parse(last)) / 3600_000),
    };
}

const picked = [];
// Read the ledger again: the fix sweep above may have added rounds.
// readLedger, not readFileSync: a fresh machine has no runs.jsonl yet.
// Live GitHub state for the failures behind a cooldown. A failed lookup returns null: the failure still counts.
const evidenceCache = new Map();
const mergedPrCache = new Map();
const cooldownEvidence = (repo, issue) => {
    const key = `${repo}#${issue}`;
    if (!evidenceCache.has(key)) {
        let found = null;
        try {
            const slug = repoSlug(repo);
            const data = ghJson(['issue', 'view', String(issue), '-R', slug, '--json', 'state,comments']);
            const current = briefFromComments(data.comments || [], { allowedAuthors: briefAuthors });
            found = { closed: data.state === 'CLOSED', mergedAt: null, briefHash: current ? briefSourceHash(current) : null };
            // Looked up last: if it fails, what the issue itself showed still stands.
            if (!mergedPrCache.has(repo)) mergedPrCache.set(repo, ghJson(['pr', 'list', '-R', slug, '--state', 'merged', '--limit', '100', '--json', 'body,mergedAt,closingIssuesReferences']));
            found.mergedAt = coveringMergeAt(mergedPrCache.get(repo), issue, slug);
        } catch (e) {
            log({ event: 'cooldown-evidence-error', repo, number: issue, error: String(e.message).slice(0, 200) });
        }
        evidenceCache.set(key, found);
    }
    return evidenceCache.get(key);
};
const budget = loopBudget(readLedger(), Date.now(), { kit: PROVENANCE.kitSha, evidence: cooldownEvidence, cooldownMs: configNumber(HOME_CONFIG, 'cooldownMs', DEFAULTS.cooldownMs) });
// The other cycle's accepted-but-unstarted picks have no ledger row yet; count them so main and overflow
// together never exceed the daily cap.
budget.runsLast24h += pendingPicks(otherLock(), readLedger());
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
    const issueData = ghJson(['issue', 'view', String(i.number), '-R', repoSlug(i.repo), '--json', 'body,comments']);
    const comments = issueData.comments || [];
    if (isEpicIssueBody(issueData.body)) {
        log({ event: 'skip-epic', repo: i.repo, number: i.number });
        continue;
    }
    const brief = briefFromComments(comments, { allowedAuthors: briefAuthors });
    if (!brief) {
        log({ event: 'no-brief', repo: i.repo, number: i.number });
        if (!dry && missingBriefRequiresUnready(i.labels, brief)) {
            try {
                gh(['issue', 'edit', String(i.number), '-R', repoSlug(i.repo), '--remove-label', 'imp:ready']);
                log({ event: 'unready-no-brief', repo: i.repo, number: i.number });
            } catch (e) {
                log({ event: 'label-cleanup-error', repo: i.repo, number: i.number, out: String(e.message).slice(-300) });
            }
        }
        if (!hasMark(comments, NO_BRIEF_MARK)) {
            try {
                comment(i.repo, i.number, NO_BRIEF_MARK + "\nThis issue was labelled `imp:ready` but has no trusted marker-first brief comment, so the dispatcher skipped it. Keep `imp:ready` off until a trusted comment starting with `<!-- imp-brief -->` is added (see imps/STANDARD.md). Not repeating this note.");
            } catch (e) {
                log({ event: 'issue-note-error', repo: i.repo, number: i.number, error: e.message });
            }
        }
        continue;
    }
    // Preflight: validate brief front matter has matching repo/issue before any run starts
    const metaErr = validateBriefMeta(brief, i.repo, i.number);
    if (metaErr) {
        log({ event: 'invalid-brief', repo: i.repo, number: i.number, reason: metaErr });
        if (!dry) {
            try {
                relabel(i.repo, i.number, 'imp:failed', ['imp:ready']);
                comment(i.repo, i.number, `<!-- imp-invalid-brief -->\nInvalid brief:\n\n${metaErr}\n\nFix the \`<!-- imp-brief -->\` comment (\`node imps/brieflint.mjs <file>\` checks it) and re-add \`imp:ready\`. Front matter needs \`repo:\` and \`issue:\` matching this issue (e.g., \`repo: fire\`, \`issue: 166\`).`);
            } catch (e) {
                log({ event: 'issue-note-error', repo: i.repo, number: i.number, error: e.message });
            }
        }
        continue;
    }
    // Per-issue attempt cap: stop feeding an issue that keeps failing. A newer
    // brief comment (a human re-brief) resets the count.
    const briefAt = briefCommentAt(comments, { allowedAuthors: briefAuthors });
    i.briefAt = briefAt;
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
    // A brief can name issues it cannot start before (front matter `depends:`). Hold it until they are closed or merged.
    const blockers = unmetDepends(parseDepends(parseBrief(brief).meta.depends, i.repo), {
        rows: readLedger(),
        isOpen: (dep) => {
            try {
                return ghJson(['issue', 'view', String(dep.number), '-R', dep.owner ? `${dep.owner}/${dep.repo}` : repoSlug(dep.repo), '--json', 'state']).state === 'OPEN';
            } catch {
                return true;
            }
        },
    });
    if (blockers.length) {
        log({ event: 'blocked-dep', repo: i.repo, number: i.number, on: blockers.map((b) => `${b.owner ? b.owner + '/' : ''}${b.repo}#${b.number}`) });
        continue;
    }
    // Skip if another machine has a live claim on this issue
    if (foreignLiveClaim(comments, MACHINE, Date.now())) {
        log({ event: 'skip-foreign-claim', repo: i.repo, number: i.number });
        continue;
    }
    i.briefPath = join(HOME, 'briefs', `${refDirName(i.repo)}-${i.number}.md`);
    i.sourceBriefHash = briefSourceHash(brief);
    // A second attempt gets the first one's recorded failing output (see retry-feedback above).
    let briefText = withKind(brief, i.labels);
    if (process.env.IMPS_RETRY_FEEDBACK !== '0' && fails === 1) {
        const prev = readLedger().filter((r) => r.repo === i.repo && Number(r.issue) === i.number && r.gate && r.gate.pass === false && feedbackEligible(r.gate)).at(-1);
        if (prev) briefText += feedbackSection(prev.gate, prev.id);
    }
    writeFileSync(i.briefPath, briefText);
    picked.push(i);
}
log({ event: 'cycle', ...(overflow ? { overflow: true } : {}), queued: queued.length, queuedBeforePreflight: queuedRaw.length, skippedMissingCheckout: missingCheckoutRepos.size, openImpPRs: impPRs.length, runsLast24h: budget.runsLast24h, cooldown: budget.cooldown, repos, picked: picked.map((i) => `${i.repo}#${i.number}`) });
if (dry) process.exit(0);

// Run up to `concurrency` repos at once. Imps for the same repo run one after another:
// they share the repo's `imp-nm-<repo>` node_modules volume, and two `npm ci` runs on it would race.
// A cycle that picks nothing still goes on to RSI and the heartbeat below: it used to exit here, so an
// idle machine never beat and the watchdog would have called it down after 4 quiet hours.
if (picked.length) {
    // Mark first, check second (see reserveRepo): a repo the other cycle took meanwhile is dropped from this
    // cycle untouched. Nothing is claimed yet, so a dropped issue stays imp:ready for the next tick.
    markBusy([...new Set(picked.map((i) => i.repo))]);
    const clash = new Set(otherBusy());
    for (const i of picked.filter((x) => clash.has(x.repo))) log({ event: 'pick-dropped', repo: i.repo, number: i.number, reason: 'repo busy in the other cycle' });
    picked.splice(0, picked.length, ...picked.filter((x) => !clash.has(x.repo)));
    markBusy([...new Set(picked.map((i) => i.repo))]);
    // Picked but not started counts against the daily cap in both cycles, until it starts or this cycle ends.
    markPicks(picked.map((i) => `${i.repo}#${i.number}`));
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
                markPicks(myPicks.filter((k) => k !== `${i.repo}#${i.number}`));
            }
        }
    }));
    log({ event: 'done', ...(overflow ? { overflow: true } : {}) });
}
// An overflow cycle stops here: RSI and the heartbeat belong to the main cycle.
if (overflow) process.exit(0);

// RSI pass (also runnable via `node rsi.mjs`). Runs with --rsi or IMPS_RSI=1,
// and once a UTC day when config.json has `"rsi": true`: that setting existed
// but nothing read it, so RSI never ran on the hourly loop (2026-11-19).
// Kill switch: IMPS_RSI=0.
/** The last `bytes` of a file as text ('' when missing). */
function tailText(file, bytes) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const size = statSync(file).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}
if (rsiDue({ flag: o.rsi, env: process.env, config: loadHomeConfig(), dispatchLines: tailText(join(HOME, 'dispatch.jsonl'), 256 * 1024).split(/\r?\n/) })) {
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
