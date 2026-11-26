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
import { isNoopRun, noopRetryOk, feedbackEligible, feedbackSection, parseBrief, parseDepends, unmetDepends, INFRA_RETRY_CAP, infraRuns, isApiInfraError, sweepIsRepeat, isTransientNetworkError, isReadOnlyGh, runGhWithReadRetry, outputSection, pickIssues, briefFromComments, missingBriefRequiresUnready, loopBudget, configNumber, claimBody, latestClaim, staleClaim, staleImpLabels, STALE_ON_CLOSE, lockIsStale, routerWaitDelays, parseClaim, claimExpired, prGuard, duplicateImpPrs, issueFailures, briefCommentAt, hasMark, isEpicIssueBody, resolveImpsCodeRoot, targetCheckout, normalizeModelStrategy, resolveQueueOwners, normalizeRepoExclusions, parseBriefAuthors, withKind, outcomeFromPr, CAP_MARK, NO_BRIEF_MARK, resolveRouter, validateBriefMeta, failureDiagnosticSummary, COMMIT_RECOVERY_FAILED, COMMIT_RECOVERY_IN_PROGRESS, COMMIT_RECOVERY_FAILED_MARK, commitRecoveryFailureBlocksReclaim, mayOverflow, lockBusyRepos, pendingPicks, briefSourceHash, coveringMergeAt, foreignLiveClaim } from './lib.mjs';
import { MODEL_MISMATCH_MARK } from './served-model.mjs';
import { kitSha, machineName, lookupIssueGuard, update as updateRun } from './runner.mjs';
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
    if (!dry) appendFileSync(LOG, JSON.stringify(line) + '\\n');
};
const gh = (args) => {
    const r = runGhWithReadRetry(args,
        (command) => spawnSync('gh', command, { encoding: 'utf8', windowsHide: true }),
        () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000));
    if (r.status) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
};
const ghJson = (args) => JSON.parse(gh(args) || 'null');

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
    const target = targetCheckout(i.repo, { codeRoot, exists: existsSync });
    if (target.checkedOut) {
        queued.push(i);
        continue;
    }
    if (!missingCheckoutRepos.has(i.repo)) {
        log({ event: 'skip-missing-checkout', repo: i.repo, path: target.path });
        missingCheckoutRepos.add(i.repo);
    }
}
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
// Live GitHub state for the failures behind a cooldown. A failed lookup returns null: the failure still counts.
const evidenceCache = new Map();
const mergedPrCache = new Map();
const cooldownEvidence = (repo, issue) => {
    const key = `${repo}#${issue}`;
    if (!evidenceCache.has(key)) {
        let found = null;
        try {
            const slug = `${o.owner}/${repo}`;
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
    const issueData = ghJson(['issue', 'view', String(i.number), '-R', `${o.owner}/${i.repo}`, '--json', 'body,comments']);
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
                gh(['issue', 'edit', String(i.number), '-R', `${o.owner}/${i.repo}`, '--remove-label', 'imp:ready']);
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
                return ghJson(['issue', 'view', String(dep.number), '-R', `${dep.owner || o.owner}/${dep.repo}`, '--json', 'state']).state === 'OPEN';
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
    i.briefPath = join(HOME, 'briefs', `${i.repo}-${i.number}.md`);
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
