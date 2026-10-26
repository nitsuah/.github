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
import { parseBrief, summarizeRun, gate, report } from './lib.mjs';
import { DEFAULTS } from './defaults.mjs';
import { evaluateChecks, checksFingerprint, mayAutoMerge } from './checks.mjs';
import { HOME, LEDGER, CODE, rows, save, update, sh, git, runClaude, loadBrief, IMP_TOOLS, pickModel, decrementQuota, MODEL_POOL } from './runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function loadHomeConfig() {
    try {
        const p = join(HOME, 'config.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    } catch { return {}; }
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
 * Ensures required `repo` and `issue` fields exist and that `maxLines` is numeric.
 * Throws on validation errors.
 */
function validateBrief(meta) {
    if (!meta.repo) throw new Error('Brief must specify repo');
    if (!meta.issue) throw new Error('Brief must specify issue');
    if (meta.maxLines && isNaN(Number(meta.maxLines))) throw new Error('Brief maxLines must be numeric');
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
    // Pick before the worktree exists: an exhausted pool must cost nothing.
    const chosenModel = pickModel(MODEL_POOL, o.modelStrategy || 'fallback');
    if (!chosenModel) {
        console.error(`every model in the pool is out of quota (${join(HERE, 'model_quota.json')}); run stopped`);
        process.exit(1);
    }
    const id =`imp_${new Date().toISOString().replace(/\D/g, '').slice(2, 12)}_${meta.issue}`;
    const repoDir = join(CODE, meta.repo);
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
        startedAt: new Date().toISOString(), transcript: join(HOME, 'runs', `${id}.jsonl`),
    };
    appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    console.log(`${id}  ${wt}`);

    const tools = IMP_TOOLS;
    decrementQuota(chosenModel);
    console.log(`using model ${chosenModel}`);
    const metrics = await runClaude({ cwd: wt, prompt, model: chosenModel, tools, minutes: o.minutes, budget: o.budget, maxTurns: 40, noEditByTurn: 15, transcript: row.transcript });
    update(id, { endedAt: new Date().toISOString(), metrics });
    console.log(`${id} ended: ${metrics.end} · ${metrics.turns} turns · ${metrics.toolErrors} tool errors · served ${metrics.served.join(', ')}`);
    console.log(metrics.finalText);
    console.log(`next: node imp.mjs gate ${id}`);
}

function runGate(id) {
    const r = rows().find((x) => x.id === id);
    const { meta } = loadBrief(r.brief, r.worktree);
    const shell = (c) => spawnSync(c, { cwd: r.worktree, shell: true, stdio: 'inherit', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).status;
    // Formatting is mechanical, so the runner does it, not the model: run the
    // repo's formatter and commit any change as a separate runner commit.
    let formatted = false;
    // On a re-run the runner's format commit is already there; size is
    // measured up to the imp's last commit either way.
    const runnerCommit = git(r.worktree, 'log', '-1', '--format=%s').out.includes('(imp runner)');
    const impHead = git(r.worktree, 'rev-parse', runnerCommit ? 'HEAD~1' : 'HEAD').out;
    // Never format over uncommitted imp work: it would be swept into the runner commit.
    const dirtyBefore = git(r.worktree, 'status', '--porcelain').out;
    if (meta.format && !runnerCommit && !dirtyBefore && git(r.worktree, 'rev-list', '--count', `${r.baseSha}..HEAD`).out !== '0') {
        console.log(`format: ${meta.format}`);
        shell(meta.format);
        if (git(r.worktree, 'status', '--porcelain').out) {
            git(r.worktree, 'add', '-A');
            git(r.worktree, 'commit', '-q', '-m', 'style: apply the repo formatter (imp runner)\n\nCo-Authored-By: 9router imp <noreply@anthropic.com>');
            formatted = true;
        }
    }
    // --no-renames: a rename's numstat path ("a => b") would dodge the scope and deny checks.
    const numstat = git(r.worktree, 'diff', '--numstat', '--no-renames', `${r.baseSha}..HEAD`).out;
    // Only the imp's own commits must carry the imp trailer: a human or the
    // hypervisor may push a fix to the PR branch between rounds.
    const log = git(r.worktree, 'log', '--format=%an%x01%B%x00', `${r.baseSha}..HEAD`).out;
    const commits = log.split('\0').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.split('\x01')).filter(([author]) => author === '9router imp').map(([, msg]) => msg.trim());
    const dirty = git(r.worktree, 'status', '--porcelain').out;
    let testExit = null;
    let lintExit = null;
    if (meta.test && commits.length) {
        console.log(`tests: ${meta.test}`);
        testExit = shell(meta.test);
    }
    if (meta.lint && commits.length) {
        console.log(`lint: ${meta.lint}`);
        lintExit = shell(meta.lint);
    }
    const g = gate({
        numstat, commits, testExit,
        sizeNumstat: git(r.worktree, 'diff', '--numstat', '--no-renames', `${r.baseSha}..${impHead}`).out,
        // A fix round (fix.mjs) passes --slack so its small follow-up commit fits.
        maxLines: Number(meta.maxLines || DEFAULTS.maxLines) + Number(o.slack),
        allow: (meta.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    if (dirty) g.reasons.push('uncommitted changes left behind'), (g.pass = false);
    if (meta.lint && commits.length && lintExit !== 0)
        g.reasons.push(lintExit == null ? 'lint not run' : `lint exit ${lintExit}`), (g.pass = false);
    // `head` binds the verdict to the commit that was gated (checked again by `pr`).
    const head = git(r.worktree, 'rev-parse', 'HEAD').out;
    update(id, { gate: { ...g, formatted, lintExit, head, at: new Date().toISOString() } });
    console.log(g.pass ? `gate passed: ${g.lines} lines in ${g.files.join(', ')}` : `gate failed: ${g.reasons.join('; ')}`);
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
        `Gate: ${r.gate.lines} lines in ${r.gate.files.join(', ')}. Brief \`${r.briefHash.slice(0, 7)}\`.`, '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code) imps',
    ].join('\n');
    const repoSlug = git(r.worktree, 'remote', 'get-url', 'origin').out.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
    sh('gh', ['label', 'create', 'imp', '-R', repoSlug, '-c', '6f42c1', '-d', 'Opened by an imp (headless worker). Needs a human review.'], {});
    const pr = sh('gh', ['pr', 'create', '-R', repoSlug, '--label', 'imp', '--head', r.branch, '--base', r.base, '--title', title, '--body', body]);
    if (pr.code) throw new Error(pr.err);
    update(id, { pr: pr.out, outcome: 'open' });
    console.log(pr.out);
    // Auto-review, then merge only on approve + all checks green + earned trust.
    // Merge immediately (no `gh pr merge --auto`): GitHub auto-merge only waits
    // for *required* checks, which let stash#305 merge while Products CI was red.
    const rev = spawnSync(process.execPath, [join(HERE, 'review.mjs'), id, '--model', o.model], { encoding: 'utf8', windowsHide: true });
    if (rev.code) return console.error('auto-review failed:', rev.stderr.trim());
    console.log(rev.stdout.trim().split('\n').pop());
    const verdict = (rev.stdout.match(/posted (\w+)/) || [])[1];
    const cfg = loadHomeConfig();
    const trust = mayAutoMerge({
        repo: r.repo,
        reviewVerdict: verdict,
        rows: rows(),
        trust: Number(cfg.autoMergeTrust ?? DEFAULTS.autoMergeTrust),
    });
    if (!trust.ok) return console.log(`not merging: ${trust.reason}`);
    const w = waitForChecks(pr.out);
    if (!w.green) return console.log(`review approved; CI ${w.reason}, leaving the PR open`);
    // Re-read once more right before merge (checks can flip in the last second).
    const final = sh('gh', ['pr', 'checks', pr.out, '--json', 'name,state']);
    let finalChecks = [];
    try { finalChecks = JSON.parse(final.out || '[]'); } catch { /* fall through */ }
    const finalEv = evaluateChecks(finalChecks);
    if (!finalEv.green) return console.log(`pre-merge recheck failed: ${finalEv.reason}, leaving the PR open`);
    const merge = sh('gh', ['pr', 'merge', pr.out, '--squash', '--delete-branch']);
    if (merge.code) return console.log(`merge refused: ${merge.err}`);
    update(id, { outcome: 'merged', mergedAt: new Date().toISOString(), autoMerged: true });
    console.log('merged (squash); every check was green');
}

function outcome(id) {
    const r = rows().find((x) => x.id === id);
    if (!r.pr) return console.log('no PR');
    const s = sh('gh', ['pr', 'view', r.pr, '--json', 'state,reviews,comments', '--jq', '{state, reviews: (.reviews|length), comments: (.comments|length)}']);
    const v = JSON.parse(s.out);
    update(id, { outcome: v.state.toLowerCase(), prActivity: { reviews: v.reviews, comments: v.comments } });
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
    case 'verdict': // a gate decided by hand (backfilled runs): verdict <id> pass|fail "<reason>"
        update(pos[0], (r) => ({ gate: { ...r.gate, pass: pos[1] === 'pass', reasons: pos[2] ? [pos[2]] : [], manual: true, at: new Date().toISOString() } }));
        break;
    case 'report': console.log(report(rows())); break;
    case 'ingest': ingest(pos[0]); break;
    default: console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
}
