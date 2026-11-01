#!/usr/bin/env node
// imps: headless `claude -p` workers that take one GitHub issue to one PR.
// The imp edits and commits in its own worktree; this runner gates the result,
// pushes and opens the PR. Every run lands in a ledger for the RSI loop.
// Contract: imps/STANDARD.md. Defaults: imps/defaults.mjs.
//
//   node imp.mjs run     --brief <brief.md> [--model MAX] [--minutes 25] [--budget 15]
//   node imp.mjs gate    <run-id>          tests in Docker + diff/scope/trailer checks
//   node imp.mjs pr      <run-id>          gate must have passed; opens an `imp` PR (auto-merge when trusted)
//   node imp.mjs outcome <run-id>          records merged / closed / open from GitHub
//   node imp.mjs note    <run-id> "<text>" an observation for the next RSI pass
//   node imp.mjs verdict <run-id> pass|fail "<reason>"   a gate decided by hand
//   node imp.mjs report                    RSI table over every run
//   node imp.mjs ingest  <transcript.jsonl> --brief <brief.md> [--worktree <dir>]   backfill a run made by hand
//   (hourly queue: dispatch.mjs; PR review: review.mjs; RSI: rsi.mjs)
//
// State lives outside any repo: $IMPS_HOME (default ~/.imps): runs.jsonl
// (the ledger), runs/<id>.jsonl (transcripts). Kit code lives in the detached
// imps-runner checkout (see setup.ps1 / STANDARD.md § Install).
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBrief, validateBriefMaxLines, summarizeRun, effectiveMaxLines, gate, report, shouldAutoCommit, prGuard, outcomeFromPr, tailOutput, deriveFormat, extractFailureDiagnostic, sanitizeDiagnostic } from './lib.mjs';
import { DEFAULTS } from './defaults.mjs';
import { evaluateChecks, checksFingerprint, mayAutoMerge, cleanMergesForRepo, fetchGithubSeedTrust, mergeReady } from './checks.mjs';
import { HOME, LEDGER, CODE, rows, save, update, appendRow, sh, git, runClaude, loadBrief, IMP_TOOLS, pickModel, reserveQuota, MODEL_POOL, resolveVaultPrompt, kitSha, machineName, isGitDirty, resolveNoEditTurns, resolveMaxTurns, lookupIssueGuard, gateShell, resolveClaudeBin, claudeBinCandidates } from './runner.mjs';
import { writeTelemetry, runOutcome, gateFailureSignatures } from './telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function loadHomeConfig() {
    try {
        const p = join(HOME, 'config.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    } catch { return {}; }
}

/** Kit self-work and product work both use IMPS_CODE/<repo>, never the detached runner. */
function assertCodeRepoBase(repoDir) {
    const runner = process.env.IMPS_KIT_PATH || process.env.IMPS_RUNNER || '';
    if (!runner) return;
    const a = resolve(repoDir).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const b = resolve(runner).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    if (a === b || a.startsWith(`${b}/`)) {
        throw new Error(
            `refusing to use the imps-runner checkout as a worktree base (${repoDir}). ` +
            `Clone ${DEFAULTS.kitRepo} under IMPS_CODE/${DEFAULTS.kitFolder} and work in a separate worktree.`,
        );
    }
}


const [cmd, ...rest] = process.argv.slice(2);
const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
        brief: { type: 'string' },
        model: { type: 'string', default: 'MAX' },
        minutes: { type: 'string', default: '25' },
        budget: { type: 'string', default: '15' },
        worktree: { type: 'string' },
        slack: { type: 'string', default: '0' },
        modelStrategy: { type: 'string', default: 'fallback' },
    },
});

// ── commands ──────────────────────────────────────────────────────────────
/**
 * Validate brief front‑matter.
 * Ensures required `repo` and `issue` fields exist and that optional `maxLines` is finite.
 * Throws on validation errors.
 */
function validateBrief(meta) {
    if (!meta.repo) throw new Error('Brief must specify repo');
    if (!meta.issue) throw new Error('Brief must specify issue');
    validateBriefMaxLines(meta.maxLines);
    // add more checks as needed
}

// ── run command ─────────────────────────────────────────────────────────────
async function run() {
    // Docker readiness check – abort if Docker Desktop not running
    const dockerInfo = spawnSync('docker', ['info'], { encoding: 'utf8', windowsHide: true });
    if (dockerInfo.status !== 0) {
        console.error('Docker not available – ensure Docker Desktop is running.');
        process.exit(1);
    }
    const { meta } = parseBrief(readFileSync(o.brief, 'utf8'));
    validateBrief(meta);
    // No claude binary means no run can start: say so before reserving quota, so each
    // hourly retry on such a machine does not spend a reservation. dispatch reads this
    // line and puts the issue back on imp:ready instead of labelling it failed.
    if (!resolveClaudeBin()) {
        console.error(`claude binary not found (looked at: ${claudeBinCandidates().join(', ')}). Install Claude Code or set IMPS_CLAUDE_BIN.`);
        process.exit(1);
    }
    // Pick and reserve before the worktree exists: an exhausted pool must cost nothing.
    const chosenModel = reserveQuota(MODEL_POOL, o.modelStrategy || 'fallback');
    if (!chosenModel) {
        console.error(`every model in the pool is out of quota (${join(HOME, 'model_quota.json')}); run stopped`);
        process.exit(1);
    }
    const id =`imp_${new Date().toISOString().replace(/\D/g, '').slice(2, 12)}_${meta.issue}`;
    const repoDir = join(CODE, meta.repo);
    if (!existsSync(repoDir)) {
        throw new Error(
            `missing checkout ${repoDir}. Setup clones ${DEFAULTS.kitRepo} into IMPS_CODE/${DEFAULTS.kitFolder}; ` +
            `other repos must live under IMPS_CODE alongside it.`,
        );
    }
    assertCodeRepoBase(repoDir);
    // Always a separate worktree — never the main CODE/<repo> checkout, never the runner.
    const fetch = sh('git', ['-C', repoDir, 'fetch', '-q', 'origin']);
    if (fetch.code) throw new Error(`git fetch failed: ${fetch.err}`);
    const base = meta.base || git(repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '') || 'main';
    const wt = resolve(CODE, `${meta.repo}-${id}`);
    const branch = `imp/${meta.issue}-${id.slice(4, 14)}`;
    const add = git(repoDir, 'worktree', 'add', '-q', wt, '-b', branch, `origin/${base}`);
    if (add.code) throw new Error(add.err);
    const lock = git(wt, 'remote', 'set-url', '--push', 'origin', 'no_push');
    if (lock.code) throw new Error(`could not disable push: ${lock.err}`);
    // Worktree-local identity: never inherit a repo's stale user (fire had `openhands`).
    git(wt, 'config', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'user.name', '9router imp');
    git(wt, 'config', '--worktree', 'user.email', 'imp@users.noreply.github.com');
    const { meta: bm, prompt, hash } = loadBrief(o.brief, wt);

    const row = {
        id, repo: meta.repo, issue: Number(meta.issue), base, baseSha: git(wt, 'rev-parse', 'HEAD').out,
        branch, worktree: wt, brief: resolve(o.brief), briefHash: hash, model: o.model,
        // Which kit produced this row. Without it, a behaviour change after a
        // kit fix is unattributable — you cannot tell a bad brief from a
        // machine 40 commits behind (#61).
        kitSha: kitSha(), kitDirty: isGitDirty(HERE), machine: machineName(),
        pid: process.pid,
        startedAt: new Date().toISOString(), transcript: join(HOME, 'runs', `${id}.jsonl`),
    };
    appendRow(row);
    console.log(`${id}  ${wt}`);

    const tools = IMP_TOOLS;
    console.log(`using model ${chosenModel}`);
    const homeConfig = loadHomeConfig();
    const metrics = await runClaude({
        cwd: wt,
        prompt,
        model: chosenModel,
        tools,
        minutes: o.minutes,
        budget: o.budget,
        maxTurns: resolveMaxTurns(homeConfig),
        noEditByTurn: resolveNoEditTurns(homeConfig),
        transcript: row.transcript,
    });
    update(id, { endedAt: new Date().toISOString(), metrics });
    writeTelemetry({ home: HOME, runId: id, repo: meta.repo, event: 'run-end', outcome: runOutcome(metrics), failureSignatures: metrics.errorKinds });
    console.log(`${id} ended: ${metrics.end} · ${metrics.turns} turns · ${metrics.toolErrors} tool errors · served ${metrics.served.join(', ')}`);
    console.log(metrics.finalText);
    console.log(`next: node imp.mjs gate ${id}`);
}

function runGate(id) {
    const r = rows().find((x) => x.id === id);
    const { meta } = loadBrief(r.brief, r.worktree);
    // Output is echoed as before, and the tail of 'test' and 'lint' runs is kept for the ledger and the issue comment.
    const tails = {};
    const ends = {};
    const shell = (c, key) => {
        const p = spawnSync(c, { cwd: r.worktree, shell: gateShell(), stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
        process.stdout.write(p.stdout || '');
        process.stderr.write(p.stderr || '');
        // Each stream keeps its own bounded tail so a noisy stderr cannot push the failure out of stdout.
        if (key) {
            const combinedOutput = [p.stdout || '', p.stderr || ''].join('\n');
            tails[key] = [tailOutput(p.stdout, 1200), tailOutput(p.stderr, 800)].filter(Boolean).join('\n');
            // Extract structured diagnostic from full output before tail truncation
            const rawDiag = extractFailureDiagnostic(combinedOutput, id);
            const diag = sanitizeDiagnostic(rawDiag, r.worktree);
            if (!ends[key]) ends[key] = {};
            ends[key].diagnostic = diag;
            // A null status is either a signal (timeout, OOM kill) or a spawn error; say which.
            if (p.signal || p.error) ends[key] = { ...(p.signal ? { signal: p.signal } : {}), ...(p.error ? { error: String(p.error.code || p.error.message).slice(0, 80) } : {}), ...ends[key] };
        }
        return p.status;
    };
    // Formatting is mechanical, so the runner does it, not the model: run the
    // repo's formatter and commit any change as a separate runner commit.
    let formatted = false;
    // On a re-run the runner's format commit is already there; size is
    // measured up to the imp's last commit either way.
    const runnerCommit = git(r.worktree, 'log', '-1', '--format=%s').out.includes('(imp runner)');
    let impHead = git(r.worktree, 'rev-parse', runnerCommit ? 'HEAD~1' : 'HEAD').out;
    // Never format over uncommitted imp work: it would be swept into the runner commit.
    const dirtyBefore = git(r.worktree, 'status', '--porcelain').out;
    const formatCmd = meta.format || deriveFormat(meta.lint);
    if (formatCmd && !runnerCommit && !dirtyBefore && git(r.worktree, 'rev-list', '--count', `${r.baseSha}..HEAD`).out !== '0') {
        console.log(`format: ${formatCmd}`);
        shell(formatCmd);
        if (git(r.worktree, 'status', '--porcelain').out) {
            git(r.worktree, 'add', '-A');
            git(r.worktree, 'commit', '-q', '-m', 'style: apply the repo formatter (imp runner)\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>');
            formatted = true;
        }
    }
    // --no-renames: a rename's numstat path ("a => b") would dodge the scope and deny checks.
    // An imp that edits, verifies, and stops should not lose the work over the
    // one step it forgets (#53/#54). The runner commits instead — only when the
    // imp made no commits of its own and the brief's test passes on that exact
    // tree, so a genuinely red run still fails. The runner writes the trailer,
    // so it cannot be forgotten either.
    let autoCommitted = false;
    let earlyTestExit = null;
    const leftover = git(r.worktree, 'status', '--porcelain').out;
    if (meta.test && leftover && !runnerCommit && git(r.worktree, 'rev-list', '--count', `${r.baseSha}..HEAD`).out === '0') {
        console.log(`tests (dirty tree): ${meta.test}`);
        earlyTestExit = shell(meta.test, 'test');
        const dirtyOut = git(r.worktree, 'status', '--porcelain').out;
        if (shouldAutoCommit({ impCommits: 0, dirty: dirtyOut, testExit: earlyTestExit })) {
            git(r.worktree, 'add', '-A');
            const salvage = git(r.worktree, 'commit', '-q', '-m', `imp: work for #${r.issue} (committed by runner)\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>`);
            if (salvage.code) {
                // A rejected commit (a hook, a lock) means the work is still uncommitted: say so, and do not format over it.
                console.log(`salvage commit failed (${String(salvage.err).slice(0, 200)}); leaving the edits uncommitted`);
            } else {
                autoCommitted = true;
                // The imp's work is this commit. impHead was read before it existed, so the
                // size check below compared baseSha..baseSha and saw zero lines.
                impHead = git(r.worktree, 'rev-parse', 'HEAD').out;
            }
        }
    }
    // The format step above skips a dirty tree, so work the runner just salvaged was never formatted: five of the six
    // recorded lint failures were exactly that. Format it now, as its own style commit (impHead stays at the imp's
    // work, so the size check still measures only the imp's lines).
    if (autoCommitted && formatCmd) {
        console.log(`format (after the runner commit): ${formatCmd}`);
        shell(formatCmd);
        if (git(r.worktree, 'status', '--porcelain').out) {
            git(r.worktree, 'add', '-A');
            const style = git(r.worktree, 'commit', '-q', '-m', 'style: apply the repo formatter (imp runner)\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>');
            if (!style.code) {
                formatted = true;
                // The salvage test ran on the unformatted tree; test the final commit instead.
                earlyTestExit = null;
            }
        }
    }
    const numstat =git(r.worktree, 'diff', '--numstat', '--no-renames', `${r.baseSha}..HEAD`).out;
    // Only the imp's own commits must carry the imp trailer: a human or the
    // hypervisor may push a fix to the PR branch between rounds.
    const log = git(r.worktree, 'log', '--format=%an%x01%B%x00', `${r.baseSha}..HEAD`).out;
    const commits = log.split('\0').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.split('\x01')).filter(([author]) => author === '9router imp').map(([, msg]) => msg.trim());
    const dirty = git(r.worktree, 'status', '--porcelain').out;
    let testExit = earlyTestExit;
    let lintExit = null;
    if (meta.test && commits.length && testExit == null) {
        console.log(`tests: ${meta.test}`);
        testExit = shell(meta.test, 'test');
    }
    if (meta.lint && commits.length) {
        console.log(`lint: ${meta.lint}`);
        lintExit = shell(meta.lint, 'lint');
    }
    const g = gate({
        numstat, commits, testExit, dirty: Boolean(dirty),
        sizeNumstat: git(r.worktree, 'diff', '--numstat', '--no-renames', `${r.baseSha}..${impHead}`).out,
        // A fix round (fix.mjs) passes --slack so its small follow-up commit fits.
        maxLines: effectiveMaxLines(meta.maxLines, o.slack),
        allow: (meta.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
        bugfix: meta.kind === 'bug',
    });
    if (meta.lint && commits.length && lintExit !== 0)
        g.reasons.push(lintExit == null ? 'lint not run' : `lint exit ${lintExit}`), (g.pass = false);
    // `head` binds the verdict to the commit that was gated (checked again by `pr`).
    const head = git(r.worktree, 'rev-parse', 'HEAD').out;
    update(id, { gate: { ...g, formatted, autoCommitted, testExit, lintExit, ...(tails.test && testExit !== 0 ? { testTail: tails.test } : {}), ...(tails.lint && lintExit !== 0 ? { lintTail: tails.lint } : {}), ...(ends.test ? { testEnd: ends.test } : {}), ...(ends.lint ? { lintEnd: ends.lint } : {}), head, at: new Date().toISOString() } });
    writeTelemetry({ home: HOME, runId: id, repo: r.repo, event: 'gate-end', outcome: g.pass ? 'gate-pass' : 'gate-fail', failureSignatures: gateFailureSignatures(g.reasons) });
    console.log(g.pass ? `gate passed: ${g.lines} lines in ${g.files.join(', ')}${autoCommitted ? ' (runner committed the imp\'s edits)' : ''}` : `gate failed: ${g.reasons.join('; ')}`);
}

// Poll `gh pr checks --json` until every check (required *and* optional) is
// finished and green for `DEFAULTS.checkStablePolls` consecutive identical
// polls. Never returns green on pending, red, or an empty list. Returns
// { green, reason }. Does not use --required: that was the stash#305 failure mode.
function waitForChecks(url, tries = DEFAULTS.checkTries) {
    let lastFp = null;
    let stable = 0;
    for (let i = 0; i < tries; i++) {
        const r = sh('gh', ['pr', 'checks', url, '--json', 'name,state']);
        if (r.code && !r.out) return { green: false, reason: `unreadable (${r.err})` };
        let checks = [];
        try { checks = JSON.parse(r.out || '[]'); } catch { return { green: false, reason: 'unreadable' }; }
        const ev = evaluateChecks(checks);
        if (!ev.green) {
            stable = 0;
            lastFp = null;
            if (i === tries - 1) return { green: false, reason: ev.reason };
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DEFAULTS.checkPollMs);
            continue;
        }
        const fp = checksFingerprint(checks);
        if (fp === lastFp) stable++;
        else {
            lastFp = fp;
            stable = 1;
        }
        if (stable >= DEFAULTS.checkStablePolls) return { green: true };
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DEFAULTS.checkPollMs);
    }
    return { green: false, reason: 'timed out' };
}

function openPr(id) {
    const r = rows().find((x) => x.id === id);
    if (!r.gate?.pass) throw new Error('gate has not passed; run `gate` first');
    if (!r.gate.manual && r.gate.head !== git(r.worktree, 'rev-parse', 'HEAD').out)
        throw new Error('worktree changed since the gate ran; run `gate` again');
    const m = r.metrics;
    const repoSlug = git(r.worktree, 'remote', 'get-url', 'origin').out.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
    // Refuse before pushing: a closed issue, a branch already merged, or an
    // issue that already has an open imp PR means the work is done or duplicated
    // (#56).
    const guard = prGuard({ branch: r.branch, issue: r.issue, slug: repoSlug, ...lookupIssueGuard(repoSlug, r.issue) });
    if (!guard.ok) throw new Error(guard.reason);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', git(r.worktree, 'remote', 'get-url', 'origin').out);
    const push = git(r.worktree, 'push', '-q', '-u', 'origin', r.branch);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', 'no_push');
    if (push.code) throw new Error(push.err);
    // The imp's own message, never the runner's format commit.
    const title = git(r.worktree, 'log', '-1', '--format=%s', '--invert-grep', '--fixed-strings', '--grep=(imp runner)', `${r.baseSha}..HEAD`).out;
    const body = [
        `Fixes #${r.issue}`, '',
        '> **Imp PR.** Written by a headless worker through 9router, then gated by the runner (tests in Docker, diff size, scope, trailer). ' +
        'If the imp reviewer approves, every check (required *and* optional) is green, and the repo has earned auto-merge trust, ' +
        'the runner squash-merges immediately. Nothing merges on red or pending CI.', '',
        '### Imp summary', m.finalText || '(none)', '',
        '### Run', `| run | model | served | turns | minutes | tool errors | tokens in / cache read / out |`, '| --- | --- | --- | --- | --- | --- | --- |',
        `| \`${r.id}\` | ${r.model} | ${m.served.join(', ')} | ${m.turns} | ${(m.durationMs / 60000).toFixed(1)} | ${m.toolErrors} | ${m.tokens.input} / ${m.tokens.cacheRead} / ${m.tokens.output} |`, '',
        `Authored by model: \`${(m.served || []).join(', ') || r.model}\` (requested \`${r.model}\`).`, '',
        `Gate: ${r.gate.lines} lines in ${r.gate.files.join(', ')}. Brief \`${r.briefHash.slice(0, 7)}\`.`, '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code) imps',
    ].join('\n');
    sh('gh', ['label', 'create', 'imp', '-R', repoSlug, '-c', '6f42c1', '-d', 'Opened by an imp (headless worker). Needs a human review.'], {});
    const pr = sh('gh', ['pr', 'create', '-R', repoSlug, '--label', 'imp', '--head', r.branch, '--base', r.base, '--title', title, '--body', body]);
    if (pr.code) throw new Error(pr.err);
    update(id, { pr: pr.out, outcome: 'open', authorModel: (m.served || [])[0] || r.model });
    console.log(pr.out);
    // Auto-review, then merge only on approve + all checks green + earned trust.
    // Merge immediately (no `gh pr merge --auto`): GitHub auto-merge only waits
    // for *required* checks, which let stash#305 merge while Products CI was red.
    const rev = spawnSync(process.execPath, [join(HERE, 'review.mjs'), id, '--model', o.model], { encoding: 'utf8', windowsHide: true });
    if (rev.code) return console.error('auto-review failed:', rev.stderr.trim());
    console.log(rev.stdout.trim().split('\n').pop());
    const verdict = (rev.stdout.match(/posted (\w+)/) || [])[1];
    const cfg = loadHomeConfig();
    const trustThreshold = Number(cfg.autoMergeTrust ?? DEFAULTS.autoMergeTrust);
    const ledgerRows = rows();
    const ledgerCount = cleanMergesForRepo(ledgerRows, r.repo);
    // Seed from GitHub history when the local ledger alone is short of trust.
    // Fail closed on seed errors (never treat a fetch failure as zero trust).
    let githubCount = 0;
    let githubSeedError = null;
    if (!(Number.isFinite(trustThreshold) && ledgerCount >= trustThreshold)) {
        const seed = fetchGithubSeedTrust(repoSlug, {
            run: (args) => sh('gh', args),
            need: trustThreshold,
        });
        githubCount = seed.count;
        githubSeedError = seed.error;
    }
    const trust = mayAutoMerge({
        repo: r.repo,
        reviewVerdict: verdict,
        rows: ledgerRows,
        trust: trustThreshold,
        githubCount,
        githubSeedError,
        gate: r.gate,
    });
    if (!trust.ok) return console.log(`not merging: ${trust.reason}`);
    const w = waitForChecks(pr.out);
    if (!w.green) return console.log(`review approved; CI ${w.reason}, leaving the PR open`);
    // Re-read once more right before merge (checks can flip in the last second),
    // and bind that verdict to the commit GitHub says is at the head — not to
    // whatever we last pushed. stash#305 merged because auto-merge waited only
    // on *required* checks; this recheck is the belt to that brace (#55).
    const final = sh('gh', ['pr', 'checks', pr.out, '--json', 'name,state']);
    let finalChecks = [];
    try { finalChecks = JSON.parse(final.out || '[]'); } catch { /* fall through */ }
    const pushedHead = git(r.worktree, 'rev-parse', 'HEAD').out;
    const live = sh('gh', ['pr', 'view', pr.out, '--json', 'headRefOid']);
    let headSha = '';
    try { headSha = String(JSON.parse(live.out || '{}').headRefOid || ''); } catch { /* fall through */ }
    const ready = mergeReady({ headSha, pushedHead, checks: finalChecks });
    if (!ready.ok) return console.log(`pre-merge recheck failed: ${ready.reason}, leaving the PR open`);
    const merge = sh('gh', ['pr', 'merge', pr.out, '--squash', '--delete-branch', '--match-head-commit', pushedHead]);
    if (merge.code) return console.log(`merge refused: ${merge.err}`);
    update(id, { outcome: 'merged', mergedAt: new Date().toISOString(), autoMerged: true });
    console.log('merged (squash); every check was green');
}

function outcome(id) {
    const r = rows().find((x) => x.id === id);
    if (!r.pr) return console.log('no PR');
    const s = sh('gh', ['pr', 'view', r.pr, '--json', 'state,mergedAt,reviews,comments', '--jq', '{state, mergedAt, reviews: (.reviews|length), comments: (.comments|length)}']);
    const v = JSON.parse(s.out);
    update(id, { outcome: r.outcome === 'closed-duplicate' ? r.outcome : outcomeFromPr(v), prActivity: { reviews: v.reviews, comments: v.comments } });
    console.log(`${id}: ${v.state} · ${v.reviews} reviews · ${v.comments} comments`);
}

function ingest(transcript) {
    const { meta } = parseBrief(readFileSync(o.brief, 'utf8'));
    validateBrief(meta);
    const events = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const session = events.find((e) => e.session_id)?.session_id || createHash('sha1').update(resolve(transcript)).digest('hex');
    const id = `imp_manual_${session.slice(0, 6)}_${meta.issue}`;
    const metrics = summarizeRun(events);
    const row = {
        id, repo: meta.repo, issue: Number(meta.issue), model: o.model, brief: resolve(o.brief),
        briefHash: createHash('sha1').update(readFileSync(o.brief)).digest('hex'), transcript: resolve(transcript),
        worktree: o.worktree ? resolve(o.worktree) : null, metrics, ingested: true,
        pid: process.pid,
    };
    const prev = rows().find((x) => x.id === id);
    save([...rows().filter((x) => x.id !== id), { ...prev, ...row }]);
    console.log(`${id}: ${metrics.end} · ${metrics.turns} turns · ${metrics.toolErrors} tool errors`);
}

switch (cmd) {
    case 'run': await run(); break;
    case 'gate': runGate(pos[0]); break;
    case 'pr': openPr(pos[0]); break;
    case 'outcome': outcome(pos[0]); break;
    case 'note': update(pos[0], (r) => ({ notes: [...(r.notes || []), { at: new Date().toISOString(), text: pos[1] }] })); break;
    case 'verdict': { // a gate decided by hand (backfilled runs): verdict <id> pass|fail "<reason>"
        const id = pos[0];
        const pass = pos[1] === 'pass';
        const current = rows().find((r) => r.id === id);
        update(id, (r) => ({ gate: { ...r.gate, pass, reasons: pos[2] ? [pos[2]] : [], manual: true, at: new Date().toISOString() } }));
        writeTelemetry({ home: HOME, runId: id, repo: current?.repo, event: 'gate-end', outcome: pass ? 'gate-pass' : 'gate-fail', failureSignatures: pass ? [] : [{ kind: 'gate-manual-fail', count: 1 }] });
        break;
    }
    case 'report': {
        const vault = resolveVaultPrompt(loadHomeConfig());
        if (vault) console.log(`vault: ${vault}`);
        console.log(report(rows()));
        break;
    }
    case 'ingest': ingest(pos[0]); break;
    default: console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
}
