#!/usr/bin/env node
// imps: headless `claude -p` workers that take one GitHub issue to a draft PR.
// The imp edits and commits in its own worktree; this runner gates the result,
// pushes and opens the PR. Every run lands in a ledger for the RSI loop.
// Contract: imps/STANDARD.md.
//
//   node imp.mjs run     --brief <brief.md> [--model MAX] [--minutes 25] [--budget 15]
//   node imp.mjs gate    <run-id>          tests in Docker + diff/scope/trailer checks
//   node imp.mjs pr      <run-id>          gate must have passed; opens a draft PR labelled `imp`
//   node imp.mjs outcome <run-id>          records merged / closed / open from GitHub
//   node imp.mjs note    <run-id> "<text>" an observation for the next RSI pass
//   node imp.mjs verdict <run-id> pass|fail "<reason>"   a gate decided by hand
//   node imp.mjs report                    RSI table over every run
//   node imp.mjs ingest  <transcript.jsonl> --brief <brief.md> [--worktree <dir>]   backfill a run made by hand
//
// State lives outside any repo: $IMPS_HOME (default ~/.imps): runs.jsonl
// (the ledger), runs/<id>.jsonl (transcripts).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBrief, summarizeRun, gate, report } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
const LEDGER = join(HOME, 'runs.jsonl');
const CODE = process.env.IMPS_CODE || join(homedir(), 'code');
mkdirSync(join(HOME, 'runs'), { recursive: true });

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
    },
});

// ── ledger ────────────────────────────────────────────────────────────────
const rows = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const save = (all) => writeFileSync(LEDGER, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
function update(id, patch) {
    const all = rows();
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error(`no run ${id} in ${LEDGER}`);
    Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
    save(all);
    return r;
}
const sh = (bin, args, opts = {}) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', ...opts });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const git = (wt, ...args) => sh('git', ['-C', wt, ...args]);

// ── brief ─────────────────────────────────────────────────────────────────
// Every brief gets PREAMBLE.md (the shared, RSI-maintained rules) in front.
// The hash of the combined prompt ties each outcome to a prompt version.
function loadBrief(path, wt) {
    const { meta, body } = parseBrief(readFileSync(path, 'utf8'));
    const preamble = readFileSync(join(HERE, 'PREAMBLE.md'), 'utf8');
    const fill = (s) => s.replaceAll('{wt}', wt.replaceAll('\\', '/')).replaceAll('{issue}', meta.issue || '');
    // The gate's scope and size limits go in the prompt too, so the imp knows them.
    const limits = [
        meta.allow && `- You may only change files under: ${meta.allow}. Anything else fails the gate.`,
        `- The whole diff must stay under ${meta.maxLines || 80} changed lines.`,
    ].filter(Boolean).join('\n');
    const prompt = fill(`${preamble}\n\n## Gate limits for this run\n${limits}\n\n---\n\n${body}`);
    const hash = createHash('sha1').update(prompt.replaceAll(wt.replaceAll('\\', '/'), '{wt}')).digest('hex');
    return { meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, fill(v)])), prompt, hash };
}

function cleanEnv() {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
    const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'DOCKER_HOST'];
    const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    // Nothing from the dispatching session leaks in: no Claude/GitHub tokens.
    env.ANTHROPIC_BASE_URL = s.ANTHROPIC_BASE_URL || 'http://localhost:20128/v1';
    env.ANTHROPIC_API_KEY = s.NINEROUTER_KEY || s.ANTHROPIC_API_KEY;
    return env;
}

// ── commands ──────────────────────────────────────────────────────────────
async function run() {
    const { meta } = parseBrief(readFileSync(o.brief, 'utf8'));
    if (!meta.repo || !meta.issue) throw new Error('brief front matter needs repo and issue');
    const id = `imp_${new Date().toISOString().replace(/\D/g, '').slice(2, 12)}_${meta.issue}`;
    const repoDir = join(CODE, meta.repo);
    sh('git', ['-C', repoDir, 'fetch', '-q', 'origin']);
    const base = meta.base || git(repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '') || 'main';
    const wt = resolve(CODE, `${meta.repo}-${id}`);
    const branch = `imp/${meta.issue}-${id.slice(4, 14)}`;
    const add = git(repoDir, 'worktree', 'add', '-q', wt, '-b', branch, `origin/${base}`);
    if (add.code) throw new Error(add.err);
    git(wt, 'remote', 'set-url', '--push', 'origin', 'no_push');
    // Worktree-local identity: never inherit a repo's stale user (fire had `openhands`).
    git(wt, 'config', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'user.name', '9router imp');
    git(wt, 'config', '--worktree', 'user.email', 'imp@users.noreply.github.com');
    const { prompt, hash } = loadBrief(o.brief, wt);

    const row = {
        id, repo: meta.repo, issue: Number(meta.issue), base, baseSha: git(wt, 'rev-parse', 'HEAD').out,
        branch, worktree: wt, brief: resolve(o.brief), briefHash: hash, model: o.model,
        startedAt: new Date().toISOString(), transcript: join(HOME, 'runs', `${id}.jsonl`),
    };
    appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    console.log(`${id}  ${wt}`);

    const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)',
        'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git checkout -- :*)', 'Bash(docker run:*)'];
    const args = ['-p', prompt, '--model', o.model, '--permission-mode', 'acceptEdits', '--strict-mcp-config',
        '--setting-sources', 'project', '--allowedTools', tools.join(' '), '--max-budget-usd', o.budget,
        '--output-format', 'stream-json', '--verbose'];
    // Spawn the binary itself: a shell (the npm .cmd shim) splits multi-word args.
    const bin = process.platform === 'win32'
        ? join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
        : 'claude';
    const out = createWriteStream(row.transcript);
    const events = [];
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd: wt, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            ev._ts = Date.now();
            events.push(ev);
            out.write(JSON.stringify(ev) + '\n');
            if (ev.type === 'assistant')
                for (const c of ev.message?.content || [])
                    if (c.type === 'tool_use') console.log(`  ${c.name} ${JSON.stringify(c.input).slice(0, 110)}`);
        }
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(o.minutes) * 60_000);
    const code = await new Promise((r) => child.on('exit', r));
    clearTimeout(timer);
    out.end();
    const metrics = summarizeRun(events, { startedAt: t0, endedAt: Date.now() });
    if (metrics.end === 'no-result') metrics.end = code == null ? 'killed-timeout' : `exit-${code}`;
    update(id, { endedAt: new Date().toISOString(), metrics });
    console.log(`${id} ended: ${metrics.end} · ${metrics.turns} turns · ${metrics.toolErrors} tool errors · served ${metrics.served.join(', ')}`);
    console.log(metrics.finalText);
    console.log(`next: node imp.mjs gate ${id}`);
}

function runGate(id) {
    const r = rows().find((x) => x.id === id);
    const { meta } = loadBrief(r.brief, r.worktree);
    const numstat = git(r.worktree, 'diff', '--numstat', `${r.baseSha}..HEAD`).out;
    const log = git(r.worktree, 'log', '--format=%B%x00', `${r.baseSha}..HEAD`).out;
    const commits = log.split('\0').map((s) => s.trim()).filter(Boolean);
    const dirty = git(r.worktree, 'status', '--porcelain').out;
    let testExit = null;
    if (meta.test && commits.length) {
        console.log(`tests: ${meta.test}`);
        const t = spawnSync(meta.test, { cwd: r.worktree, shell: true, stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
        testExit = t.status;
    }
    const g = gate({
        numstat, commits, testExit,
        maxLines: Number(meta.maxLines || 80),
        allow: (meta.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    if (dirty) g.reasons.push('uncommitted changes left behind'), (g.pass = false);
    update(id, { gate: { ...g, at: new Date().toISOString() } });
    console.log(g.pass ? `gate PASS (${g.lines} lines: ${g.files.join(', ')})` : `gate FAIL: ${g.reasons.join('; ')}`);
}

function openPr(id) {
    const r = rows().find((x) => x.id === id);
    if (!r.gate?.pass) throw new Error('gate has not passed; run `gate` first');
    const m = r.metrics;
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', git(r.worktree, 'remote', 'get-url', 'origin').out);
    const push = git(r.worktree, 'push', '-q', '-u', 'origin', r.branch);
    git(r.worktree, 'remote', 'set-url', '--push', 'origin', 'no_push');
    if (push.code) throw new Error(push.err);
    const title = git(r.worktree, 'log', '-1', '--format=%s').out;
    const body = [
        `Fixes #${r.issue}`, '',
        '> **Imp PR.** Written by a headless worker through 9router, then gated by the runner (tests in Docker, diff size, scope, trailer). ' +
        'It stays a draft until @nitsuah marks it ready, and it is never auto-merged.', '',
        '### Imp summary', m.finalText || '(none)', '',
        '### Run', `| run | model | served | turns | minutes | tool errors | tokens in / cache read / out |`, '| --- | --- | --- | --- | --- | --- | --- |',
        `| \`${r.id}\` | ${r.model} | ${m.served.join(', ')} | ${m.turns} | ${(m.durationMs / 60000).toFixed(1)} | ${m.toolErrors} | ${m.tokens.input} / ${m.tokens.cacheRead} / ${m.tokens.output} |`, '',
        `Gate: ${r.gate.lines} lines in ${r.gate.files.join(', ')}. Brief \`${r.briefHash.slice(0, 7)}\`.`, '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code) imps',
    ].join('\n');
    const repoSlug = git(r.worktree, 'remote', 'get-url', 'origin').out.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
    sh('gh', ['label', 'create', 'imp', '-R', repoSlug, '-c', '6f42c1', '-d', 'Opened by an imp (headless worker). Needs a human review.'], {});
    const pr = sh('gh', ['pr', 'create', '-R', repoSlug, '--draft', '--label', 'imp', '--head', r.branch, '--base', r.base, '--title', title, '--body', body]);
    if (pr.code) throw new Error(pr.err);
    update(id, { pr: pr.out, outcome: 'open' });
    console.log(pr.out);
}

function outcome(id) {
    const r = rows().find((x) => x.id === id);
    if (!r.pr) return console.log('no PR');
    const s = sh('gh', ['pr', 'view', r.pr, '--json', 'state,reviews,comments', '--jq', '{state, reviews: (.reviews|length), comments: (.comments|length)}']);
    const v = JSON.parse(s.out);
    update(id, { outcome: v.state.toLowerCase(), review: { reviews: v.reviews, comments: v.comments } });
    console.log(`${id}: ${v.state} · ${v.reviews} reviews · ${v.comments} comments`);
}

function ingest(transcript) {
    const { meta } = parseBrief(readFileSync(o.brief, 'utf8'));
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
