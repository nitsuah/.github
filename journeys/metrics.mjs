#!/usr/bin/env node
// Monthly journey metrics for RSI. No AI, no deps (Node 18+).
//
//   GITHUB_TOKEN=... node metrics.mjs --repos nitsuah/fire,nitsuah/vigil [--month 2026-10] [--append <file>]
//
// Reads each repo's bot/journeys branch (metrics/<month>.jsonl, written by
// reporter.mjs) and its bot:journey issues, and prints one markdown table.
// Token spend isn't knowable here: the RSI pass fills that column from
// USAGE.md. Definitions live in journeys/STANDARD.md § Metrics.
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readMarker, META_MARK } from './lib.mjs';

const { values: opt } = parseArgs({
    options: {
        repos: { type: 'string' },
        month: { type: 'string' },
        branch: { type: 'string', default: 'bot/journeys' },
        append: { type: 'string' },
    },
});
if (!opt.repos) {
    console.error('usage: metrics.mjs --repos owner/a,owner/b [--month YYYY-MM] [--append file]');
    process.exit(2);
}
const prev = new Date();
prev.setUTCDate(1);
prev.setUTCMonth(prev.getUTCMonth() - 1);
const month = opt.month || prev.toISOString().slice(0, 7);

async function gh(path) {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            accept: 'application/vnd.github+json',
            ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
        },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}

async function issues(repo) {
    const all = [];
    for (let page = 1; ; page++) {
        const b = await gh(`/repos/${repo}/issues?labels=bot:journey&state=all&per_page=100&page=${page}`);
        if (!b) break;
        all.push(...b.filter((i) => !i.pull_request));
        if (b.length < 100) break;
    }
    return all;
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [];
for (const repo of opt.repos.split(',').map((s) => s.trim()).filter(Boolean)) {
    const f = await gh(`/repos/${repo}/contents/metrics/${month}.jsonl?ref=${encodeURIComponent(opt.branch)}`);
    const runs = f ? Buffer.from(f.content, 'base64').toString('utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const iss = await issues(repo);
    const inMonth = (d) => d && d.startsWith(month);
    const closed = iss.filter((i) => inMonth(i.closed_at));
    const everClosed = iss.filter((i) => i.state === 'closed' || (readMarker(i.body || '', META_MARK)?.reopens || 0) > 0);
    const reopened = iss.filter((i) => (readMarker(i.body || '', META_MARK)?.reopens || 0) > 0);
    const ttf = closed.map((i) => (new Date(i.closed_at) - new Date(i.created_at)) / 864e5);
    const tests = runs.reduce((a, r) => a + r.total, 0);
    const flaky = runs.reduce((a, r) => a + r.flaky, 0);
    const last = runs[runs.length - 1];
    rows.push({
        repo,
        runs: runs.length,
        green: runs.filter((r) => r.failed === 0).length,
        flaky: pct(flaky, tests),
        opened: iss.filter((i) => inMonth(i.created_at)).length,
        closed: closed.length,
        open: iss.filter((i) => i.state === 'open').length,
        reopen: pct(reopened.length, everClosed.length),
        ttf: median(ttf),
        cov: last?.coverage ? `${last.coverage.covered}/${last.coverage.total}` : '—',
    });
}

const out = [
    `### Journey metrics · ${month}`,
    '',
    '| repo | runs (green) | flaky rate | issues opened / closed / open | reopen rate (all-time) | median time-to-fix | feature coverage | tokens |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
        (r) =>
            `| ${r.repo} | ${r.runs} (${r.green}) | ${r.flaky} | ${r.opened} / ${r.closed} / ${r.open} | ${r.reopen} | ${r.ttf === null ? '—' : r.ttf.toFixed(1) + ' d'} | ${r.cov} | _from USAGE_ |`,
    ),
    '',
    '_Time-to-fix runs from issue opened to auto-close, so it includes the N-green verification window._',
    '',
].join('\n');
console.log(out);
if (opt.append) appendFileSync(opt.append, '\n' + out);
