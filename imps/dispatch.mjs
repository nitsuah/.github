#!/usr/bin/env node
// The hourly imps dispatcher. No LLM of its own: it reads the GitHub queue,
// picks issues, and runs each through imp.mjs run → gate → pr.
//
//   node dispatch.mjs [--max 5] [--wip 8] [--per-repo 4] [--concurrency 4] [--owner nitsuah] [--dry-run] [--rsi]
//
// Queue: open issues labelled `imp:ready` that carry a brief comment (see
// BRIEF_MARK in lib.mjs; Opus triage / rsi.mjs write them). Each issue moves to
// `imp:working`, then `imp:pr` (PR opened) or `imp:failed` (gate reasons
// commented, needs a new brief). Defaults: imps/defaults.mjs. Contract: STANDARD.md.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pickIssues, briefFromComments, loopBudget, claimBody, staleClaim } from './lib.mjs';
import { kitSha, machineName } from './runner.mjs';
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
const PROVENANCE = { machine: machineName(), kitSha: kitSha() };
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
const LOCK = join(HOME, 'dispatch.lock');
if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < DEFAULTS.lockMaxAgeMs) {
    log({ event: 'skip', reason: 'previous cycle still running (lock < 3h old)' });
    process.exit(0);
}
if (!dry) writeFileSync(LOCK, String(process.pid));
const unlock = () => { if (!dry) rmSync(LOCK, { force: true }); };
process.on('exit', unlock);

// ── 9router must be up ────────────────────────────────────────────────────
async function routerUp() {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
    const base = (s.ANTHROPIC_BASE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
    try {
        const r = await fetch(`${base}/messages`, {
            method: 'POST',
            signal: AbortSignal.timeout(60_000),
            headers: { 'content-type': 'application/json', 'x-api-key': s.NINEROUTER_KEY || s.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'MAX', max_tokens: 5, messages: [{ role: 'user', content: 'say ok' }] }),
        });
        return r.ok;
    } catch {
        return false;
    }
}

// ── labels ────────────────────────────────────────────────────────────────
const LABELS = {
    'imp:ready': ['0e8a16', 'Has an imp brief; the hourly dispatcher may take it'],
    'imp:working': ['fbca04', 'An imp is working on this now'],
    'imp:pr': ['6f42c1', 'An imp opened a PR for this'],
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

// ── release stranded claims ───────────────────────────────────────────────
// A claim has no lease in GitHub itself, so a machine that dies mid-run leaves
// its issue on imp:working and no other machine can release it (runs.jsonl is
// per machine). Reclaim rather than escalate: the work is idempotent and the
// brief is still valid. See lib.mjs staleClaim and WARLOCK.md.
async function releaseStrandedClaims() {
    const stranded = [];
    const liveHere = new Set(ledger().filter((r) => !r.endedAt).map((r) => r.issue));
    for (const issue of ghJson(['search', 'issues', '--owner', o.owner, '--state', 'open', '--label', 'imp:working', '--limit', '100', '--json', 'repository,number,labels'])) {
        const repo = issue.repository.name;
        const labels = issue.labels.map((l) => l.name);
        const comments = ghJson(['issue', 'view', String(issue.number), '-R', `${o.owner}/${repo}`, '--json', 'comments']).comments || [];
        const why = staleClaim({ labels, comments, ledgerHasRow: liveHere.has(issue.number), machine: MACHINE });
        if (!why) continue;
        log({ event: 'reclaim', repo, number: issue.number, why });
        if (dry) continue;
        comment(repo, issue.number, `<!-- imp-reclaim -->\nReclaiming: ${why}. Putting this back on \`imp:ready\` so any machine can take it.`);
        relabel(repo, issue.number, 'imp:ready', ['imp:working']);
        stranded.push(`${repo}#${issue.number}`);
    }
    return stranded;
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
const ledgerRow = (id) => readFileSync(join(HOME, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((r) => r.id === id);
const MACHINE = machineName();

async function work(issue) {
    const { repo, number } = issue;
    relabel(repo, number, 'imp:working', ['imp:ready']);
    // A label has no owner, so write one down. Without this a machine that dies
    // leaves the issue on imp:working for the whole fleet (#60).
    comment(repo, number, claimBody({ machine: MACHINE }));
    const run = await node(['run', '--brief', issue.briefPath, '--model', 'MAX']);
    const id = (run.out.match(/^(imp_\S+)/m) || [])[1];
    if (!id) {
        relabel(repo, number, 'imp:failed', ['imp:working']);
        comment(repo, number, `Imp run didn't start:\n\n\`\`\`\n${run.out.slice(-1500)}\n\`\`\``);
        return log({ event: 'run-error', repo, number, out: run.out.slice(-500) });
    }
    await node(['gate', id]);
    const row = ledgerRow(id);
    const m = row.metrics || {};
    const stats = `${m.turns ?? '?'} turns, ${m.toolErrors ?? '?'} tool errors, served ${(m.served || []).join(', ') || '?'}`;
    if (row.gate?.pass) {
        const pr = await node(['pr', id]);
        const url = (pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
        if (url) {
            relabel(repo, number, 'imp:pr', ['imp:working']);
            comment(repo, number, `An imp opened a PR: ${url} (run \`${id}\`: ${stats}). Auto-merge runs only after review approve, every check green, and earned trust.`);
            // The review + merge decision live inside `imp.mjs pr`.
            return log({ event: 'pr', repo, number, id, url, review: (pr.out.match(/posted (\w+)/) || [])[1] || 'failed' });
        }
        relabel(repo, number, 'imp:failed', ['imp:working']);
        comment(repo, number, `The imp passed the gate but the PR couldn't be opened (run \`${id}\`).`);
        return log({ event: 'pr-error', repo, number, id, out: pr.out.slice(-500) });
    }
    relabel(repo, number, 'imp:failed', ['imp:working']);
    comment(repo, number, `The imp didn't pass the gate (run \`${id}\`: ${stats}).\n\n${(row.gate?.reasons || ['no gate result']).map((x) => `- ${x}`).join('\n')}\n\nNeeds a new brief or a human.`);
    log({ event: 'gate-fail', repo, number, id, reasons: row.gate?.reasons });
}

// ── the cycle ─────────────────────────────────────────────────────────────
if (!(await routerUp())) {
    log({ event: 'skip', reason: '9router did not answer a MAX probe' });
    process.exit(0);
}

// Release claims left behind by a machine that stopped mid-run, before picking
// anything: otherwise the queue looks emptier than it is (#60).
const reclaimed = await releaseStrandedClaims();
if (reclaimed.length) console.log(`reclaimed ${reclaimed.length}: ${reclaimed.join(', ')}`);

// Sweep the open imp PRs first (owner-approved 2026-10-22): answer review
// feedback and red CI with a 9router fix round. fix.mjs pushes only to the
// imp's own PR branch, stops after 2 rounds or on a conflict, and labels
// imp:needs-human. A PR with nothing to act on costs only gh calls.
const openImp = ghJson(['search', 'prs', '--owner', o.owner, '--state', 'open', '--label', 'imp', '--limit', '100', '--json', 'url,labels'])
    .filter((p) => !p.labels.some((l) => l.name === 'imp:needs-human'));
const ledger = readFileSync(join(HOME, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
for (const p of openImp) {
    const row = ledger.find((r) => r.pr === p.url);
    if (!row) continue; // opened from another machine's ledger
    const f = await node(['fix', row.id, ...(dry ? ['--dry-run'] : [])], 'fix.mjs');
    const last = f.out.trim().split('\n').reverse().find((l) => l.startsWith('{"id"'));
    log({ event: 'fix-sweep', pr: p.url, id: row.id, result: last ? JSON.parse(last).event : `exit ${f.code}` });
}

const queued = ghJson(['search', 'issues', '--owner', o.owner, '--state', 'open', '--label', 'imp:ready', '--limit', '100',
    '--json', 'repository,number,labels,createdAt,title'])
    .map((i) => ({ repo: i.repository.name, number: i.number, title: i.title, createdAt: i.createdAt, labels: i.labels.map((l) => l.name) }))
    .filter((i) => !i.labels.some((l) => ['imp:working', 'imp:pr'].includes(l)));
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
const budget = loopBudget(readFileSync(join(HOME, 'runs.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
for (const i of pickIssues({ candidates: queued, repos, max: Number(o.max), wip: Number(o.wip), perRepo, dailyCap: Number(o['daily-cap']), ...budget })) {
    const brief = briefFromComments(ghJson(['issue', 'view', String(i.number), '-R', `${o.owner}/${i.repo}`, '--json', 'comments']).comments);
    if (!brief) {
        log({ event: 'no-brief', repo: i.repo, number: i.number });
        continue;
    }
    i.briefPath = join(HOME, 'briefs', `${i.repo}-${i.number}.md`);
    writeFileSync(i.briefPath, brief);
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
