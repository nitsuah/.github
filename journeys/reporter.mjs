#!/usr/bin/env node
// Journey reporter: turns a Playwright JSON report into GitHub issues.
// No AI, no npm deps (Node 18+). Full contract: journeys/STANDARD.md.
//
//   node reporter.mjs --report journeys-report/report.json \
//     [--mode file|summary] [--features promo/spots.json] [--green-runs 3] \
//     [--max-new 5] [--repro "docker ..."] [--dry-run]
//
// --mode file     nightly/main: create/update/reopen/close bot:journey issues,
//                 publish failure screenshots, BUGS.md and metrics to the
//                 bot/journeys branch.
// --mode summary  PRs: only write the step summary. Never touches issues.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID,
//      GITHUB_SHA, GITHUB_STEP_SUMMARY (all set by Actions).
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import {
    FP_MARK, META_MARK, flattenReport, failureOf, readMarker, pickImages,
    issueTitle, issueBody, plan, bugsMarkdown, coverage, fingerprint, journeyId,
} from './lib.mjs';

const { values: opt } = parseArgs({
    options: {
        report: { type: 'string', default: 'journeys-report/report.json' },
        mode: { type: 'string', default: 'summary' },
        features: { type: 'string', default: 'promo/spots.json' },
        'green-runs': { type: 'string', default: '3' },
        'max-new': { type: 'string', default: '5' },
        repro: { type: 'string', default: '' },
        branch: { type: 'string', default: 'bot/journeys' },
        out: { type: 'string', default: 'journeys-report' },
        'dry-run': { type: 'boolean', default: false },
    },
});

const env = process.env;
const repo = env.GITHUB_REPOSITORY || 'local/repo';
const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : 'about:blank';
const today = new Date().toISOString().slice(0, 10);
const greenRuns = Number(opt['green-runs']);
const dry = opt['dry-run'] || !env.GITHUB_TOKEN;
const LABELS = {
    'bot:journey': ['b60205', 'Filed by the nightly journey run (no AI). Fingerprint-deduped.'],
    'bot:review': ['5319e7', 'Filed by a one-time AI product review pass.'],
};

// ── GitHub API ────────────────────────────────────────────────────────────
async function gh(method, path, body, { ok404 = false } = {}) {
    if (dry && method !== 'GET') {
        console.log(`[dry-run] ${method} ${path}${body?.title ? ` "${body.title}"` : ''}`);
        return { number: 0, sha: 'dryrun', html_url: '' };
    }
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }),
            ...(body && { 'content-type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
    });
    if (ok404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
}

async function listIssues(label, state) {
    const all = [];
    for (let page = 1; ; page++) {
        const batch = await gh('GET', `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=100&page=${page}`);
        all.push(...batch.filter((i) => !i.pull_request));
        if (batch.length < 100) break;
    }
    return all.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        body: i.body || '',
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        createdAt: i.created_at,
        closedAt: i.closed_at,
        fp: readMarker(i.body || '', FP_MARK),
        meta: readMarker(i.body || '', META_MARK),
    }));
}

async function ensureLabels(names) {
    for (const name of names) {
        const [color, description] = LABELS[name] || ['ededed', ''];
        if (await gh('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`, null, { ok404: true })) continue;
        await gh('POST', `/repos/${repo}/labels`, { name, color, description });
    }
}

// One commit on the bot branch via the Git Data API (no git binary needed,
// works in any container). files: [{ path, content: Buffer|string }].
async function commitToBranch(files, message) {
    if (!files.length) return null;
    const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${opt.branch}`, null, { ok404: true });
    const parent = ref?.object?.sha;
    const baseTree = parent ? (await gh('GET', `/repos/${repo}/git/commits/${parent}`)).tree.sha : undefined;
    const tree = [];
    for (const f of files) {
        const blob = await gh('POST', `/repos/${repo}/git/blobs`, {
            content: Buffer.from(f.content).toString('base64'),
            encoding: 'base64',
        });
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree });
    const c = await gh('POST', `/repos/${repo}/git/commits`, { message, tree: t.sha, parents: parent ? [parent] : [] });
    if (parent) await gh('PATCH', `/repos/${repo}/git/refs/heads/${opt.branch}`, { sha: c.sha });
    else await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${opt.branch}`, sha: c.sha });
    return c.sha;
}

async function readBranchFile(path) {
    const f = await gh('GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(opt.branch)}`, null, { ok404: true });
    return f?.content ? Buffer.from(f.content, 'base64').toString('utf8') : '';
}

// ── Load the run ──────────────────────────────────────────────────────────
function loadRun() {
    let report;
    try {
        report = JSON.parse(readFileSync(opt.report, 'utf8'));
    } catch (e) {
        return { records: [], harness: `No readable Playwright JSON report at ${opt.report}: ${e.message}` };
    }
    const records = flattenReport(report);
    const topErr = (report.errors || []).map((e) => e.message || e.value).filter(Boolean)[0];
    if (topErr && !records.some((r) => r.status === 'unexpected'))
        return { records, harness: topErr };
    if (!records.length) return { records, harness: 'The Playwright report contains no journeys.' };
    return { records, harness: null };
}

function harnessFailure(message) {
    const step = '(harness)';
    return {
        fp: fingerprint({ repo, file: '(harness)', journey: 'journey run', step, errClass: 'harness' }),
        journeyId: '(harness)',
        file: opt.report,
        journey: 'journey run',
        step,
        errClass: 'harness',
        message,
        features: [],
        area: 'app',
        attachments: [],
    };
}

// ── Main ──────────────────────────────────────────────────────────────────
const { records, harness } = loadRun();
const failures = records.filter((r) => r.status === 'unexpected').map((r) => failureOf(repo, r));
if (harness) failures.unshift(harnessFailure(harness));
const flaky = records.filter((r) => r.status === 'flaky');
const features = existsSync(opt.features) ? JSON.parse(readFileSync(opt.features, 'utf8')).features : null;
const cov = coverage(records, features);
const counts = {
    total: records.length,
    passed: records.filter((r) => r.status === 'expected').length,
    failed: failures.length,
    flaky: flaky.length,
    skipped: records.filter((r) => r.status === 'skipped').length,
};

const summary = [
    `## Journeys — ${failures.length ? '❌' : '✅'} ${counts.passed}/${counts.total} green` +
        (counts.flaky ? ` · ${counts.flaky} flaky` : ''),
    '',
];
if (cov) summary.push(`Feature coverage: **${cov.covered}/${cov.total}** user-visible features in spots.json have a journey.`, '');
if (cov?.unknownTags.length) summary.push(`⚠️ Unknown \`@feature:\` tags (not in spots.json): ${cov.unknownTags.join(', ')}`, '');
for (const f of failures) summary.push(`- \`${f.fp}\` ${f.journey} › **${f.step}** — \`${f.errClass}\``);
for (const r of flaky) summary.push(`- 🔁 flaky (passed on retry, no issue filed): ${journeyId(r)}`);

let actionsDone = [];
let deferred = [];
if (opt.mode === 'file') {
    await ensureLabels(['bot:journey', 'bot:review']);
    const issues = await listIssues('bot:journey', 'all');
    const p = plan({ failures, records, issues, greenRuns, maxNew: Number(opt['max-new']), today });
    deferred = p.deferred;

    // 1. Failure screenshots first, so issue bodies can pin to the commit.
    const imgFiles = [];
    const imagesByFp = {};
    for (const a of p.actions.filter((x) => x.f)) {
        imagesByFp[a.f.fp] = [];
        for (const im of pickImages(a.f.attachments)) {
            if (!existsSync(im.path)) continue;
            const name = basename(im.path);
            imgFiles.push({ path: `failures/${a.f.fp}/${name}`, content: readFileSync(im.path) });
            imagesByFp[a.f.fp].push({ name, path: `failures/${a.f.fp}/${name}` });
        }
    }
    const imgSha = await commitToBranch(imgFiles, `journeys: failure screenshots for ${today}`);
    const ctxFor = (fp) => ({
        runUrl,
        greenRuns,
        repro: opt.repro,
        images: (imagesByFp[fp] || []).map((im) => ({
            ...im,
            url: `https://raw.githubusercontent.com/${repo}/${imgSha}/${im.path}`,
        })),
    });

    // 2. Issues.
    for (const a of p.actions) {
        const n = a.issue?.number;
        if (a.kind === 'create') {
            const labels = ['bot:journey', 'bug', `area:${a.f.area}`];
            await ensureLabels(labels.filter((l) => l !== 'bug'));
            const made = await gh('POST', `/repos/${repo}/issues`, {
                title: issueTitle(a.f),
                body: issueBody(a.f, a.meta, ctxFor(a.f.fp)),
                labels,
            });
            actionsDone.push(`opened #${made.number} \`${a.f.fp}\``);
        } else if (a.kind === 'update' || a.kind === 'reopen') {
            await gh('PATCH', `/repos/${repo}/issues/${n}`, {
                body: issueBody(a.f, a.meta, ctxFor(a.f.fp)),
                ...(a.kind === 'reopen' && { state: 'open', state_reason: 'reopened' }),
            });
            if (a.kind === 'reopen')
                await gh('POST', `/repos/${repo}/issues/${n}/comments`, {
                    body: `Regressed: the same fingerprint failed again in [this run](${runUrl}). Reopened (reopen #${a.meta.reopens}).`,
                });
            actionsDone.push(`${a.kind === 'reopen' ? 'reopened' : 'updated'} #${n}`);
        } else if (a.kind === 'green' || a.kind === 'close') {
            const body = a.issue.body.replace(new RegExp(`<!-- ${META_MARK} .*? -->`), `<!-- ${META_MARK} ${JSON.stringify(a.meta)} -->`);
            await gh('PATCH', `/repos/${repo}/issues/${n}`, {
                body,
                ...(a.kind === 'close' && { state: 'closed', state_reason: 'completed' }),
            });
            if (a.kind === 'close')
                await gh('POST', `/repos/${repo}/issues/${n}/comments`, {
                    body: `✅ This journey passed ${a.meta.greens} nightly runs in a row ([latest](${runUrl})). Closing as verified. If it fails the same way again, this issue reopens.`,
                });
            actionsDone.push(a.kind === 'close' ? `closed #${n} (verified green)` : `#${n} green ${a.meta.greens}/${greenRuns}`);
        }
    }

    // 3. BUGS.md + metrics on the bot branch.
    const after = [...(await listIssues('bot:journey', 'all')), ...(await listIssues('bot:review', 'open'))];
    const uniq = [...new Map(after.map((i) => [i.number, i])).values()];
    const bugs = bugsMarkdown({ repo, issues: uniq, generatedAt: today, runUrl });
    const month = today.slice(0, 7);
    const line = JSON.stringify({
        date: today,
        run: runUrl,
        sha: env.GITHUB_SHA || null,
        ...counts,
        coverage: cov && { covered: cov.covered, total: cov.total },
        failures: failures.map((f) => f.fp),
        flakyJourneys: flaky.map(journeyId),
        actions: actionsDone,
    });
    const prev = await readBranchFile(`metrics/${month}.jsonl`);
    await commitToBranch(
        [
            { path: 'BUGS.md', content: bugs },
            { path: `metrics/${month}.jsonl`, content: prev + line + '\n' },
        ],
        `journeys: ${counts.passed}/${counts.total} green on ${today}`,
    );
    mkdirSync(opt.out, { recursive: true });
    writeFileSync(`${opt.out}/BUGS.md`, bugs);
}

if (actionsDone.length) summary.push('', '**Issues:** ' + actionsDone.join(' · '));
if (deferred.length) summary.push('', `${deferred.length} more new failure(s) held back by --max-new; they'll be filed on the next run.`);
const text = summary.join('\n') + '\n';
console.log(text);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
