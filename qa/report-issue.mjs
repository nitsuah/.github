// Upsert a sticky issue on this repo from qa/out/*.json findings.
// Usage: node report-issue.mjs --kind qa|uptime
// Env: GH_TOKEN or GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), GITHUB_REPOSITORY_OWNER
// Never applies imp:ready (outages and sweep reports need a human brief first).

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out/');
const kind = (process.argv.includes('--kind') ? process.argv[process.argv.indexOf('--kind') + 1] : 'qa');
const REPO = process.env.GITHUB_REPOSITORY || 'nitsuah/.github';
const OWNER = process.env.GITHUB_REPOSITORY_OWNER || REPO.split('/')[0];
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GH_TOKEN / GITHUB_TOKEN required');
  process.exit(2);
}

const META = {
  qa: { title: 'QA sweep (live apps + profile links)', label: 'bot:qa', labelDesc: 'Filed by the scheduled QA / link-sweep workflow', marker: '<!-- qa-sweep -->' },
  uptime: { title: 'Uptime: live apps', label: 'bot:uptime', labelDesc: 'Filed by the scheduled uptime workflow', marker: '<!-- uptime-sweep -->' },
}[kind];
if (!META) {
  console.error('unknown --kind');
  process.exit(2);
}

function readJson(name) {
  const p = join(OUT, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function linesFrom(results, limit = 40) {
  const fails = (results || []).filter((r) => r.ok === false || r.level === 'fail');
  return fails.slice(0, limit).map((r) => {
    const where = r.url || r.id || r.path || '';
    const msg = r.error || r.msg || r.message || JSON.stringify(r);
    const src = r.source ? `${r.source}: ` : '';
    return `- ${src}${msg} (${where})`;
  });
}

const health = readJson('health.json');
const links = readJson('links.json');
const crawl = readJson('results.json');
const crawlFails = Array.isArray(crawl)
  ? crawl.flatMap((A) => (A.findings || []).filter((f) => f.level === 'fail').map((f) => ({ ...f, source: A.id, url: f.url || A.base, ok: false })))
  : [];

const sections = [];
let failed = 0;
if (health) {
  const fails = health.results.filter((r) => !r.ok);
  failed += fails.length;
  sections.push(`## Health / uptime\n\n${fails.length ? linesFrom(fails).join('\n') : `All ${health.results.length} checks passed at ${health.checkedAt}.`}`);
}
if (links && kind === 'qa') {
  const fails = links.results.filter((r) => !r.ok);
  failed += fails.length;
  sections.push(`## Profile + repo homepage links\n\n${fails.length ? linesFrom(fails).join('\n') : `All ${links.results.length} links passed at ${links.checkedAt}.`}`);
}
if (crawl && kind === 'qa') {
  failed += crawlFails.length;
  const summary = Array.isArray(crawl)
    ? crawl.map((A) => `- ${A.id}: ${(A.findings || []).filter((f) => f.level === 'fail').length} fail, ${(A.findings || []).filter((f) => f.level === 'warn').length} warn`).join('\n')
    : '';
  sections.push(`## Playwright crawl\n\n${summary}\n\n${crawlFails.length ? linesFrom(crawlFails).join('\n') : 'No crawl failures.'}`);
}

const now = new Date().toISOString();
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : '';
const status = failed ? 'FAIL' : 'PASS';
const body = `${META.marker}
**Status:** ${status} at ${now}${runUrl ? ` ([run](${runUrl}))` : ''}

This issue is updated by a scheduled GitHub Actions workflow. It does not need Grok Bot. Do not label it \`imp:ready\` without a per-repo brief (see imps/STANDARD.md). Outages are owner-gated.

${sections.join('\n\n')}
`;

function gh(args, input) {
  const r = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

gh(['label', 'create', META.label, '-R', REPO, '-c', kind === 'uptime' ? 'B60205' : '0052CC', '-d', META.labelDesc, '--force']);

const found = JSON.parse(gh(['issue', 'list', '-R', REPO, '--state', 'all', '--search', `${JSON.stringify(META.title)} in:title`, '--limit', '20', '--json', 'number,title,state,labels']));
let issue = (found || []).find((i) => i.title === META.title);
if (!issue) {
  const created = gh(['issue', 'create', '-R', REPO, '--title', META.title, '--label', META.label, '--body', body]);
  console.log('created', created.trim());
  issue = { number: Number((created.match(/\/issues\/(\d+)/) || [])[1]), state: 'OPEN' };
} else {
  // write body via a temp file to avoid shell quoting
  const tmp = join(OUT, `issue-body-${kind}.md`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(tmp, body);
  gh(['issue', 'edit', String(issue.number), '-R', REPO, '--body-file', tmp, '--add-label', META.label]);
  const comment = failed
    ? `${META.marker}\n**${status}** at ${now}${runUrl ? ` ([run](${runUrl}))` : ''}. ${failed} finding(s). The issue body has the details.`
    : `${META.marker}\n**${status}** at ${now}${runUrl ? ` ([run](${runUrl}))` : ''}.`;
  gh(['issue', 'comment', String(issue.number), '-R', REPO, '--body', comment]);
  if (failed && issue.state !== 'OPEN') gh(['issue', 'reopen', String(issue.number), '-R', REPO]);
  if (!failed && issue.state === 'OPEN' && kind === 'uptime') {
    // Close only the uptime issue when recovered so it is not a permanent open outage.
    gh(['issue', 'close', String(issue.number), '-R', REPO, '--reason', 'completed', '--comment', `${META.marker}\nRecovered at ${now}.`]);
  }
  console.log('updated', issue.number, status);
}

// One owner ping per new uptime outage (same idea as imps-watchdog).
if (kind === 'uptime' && failed && issue?.number) {
  const comments = JSON.parse(gh(['issue', 'view', String(issue.number), '-R', REPO, '--json', 'comments']));
  const last = [...(comments.comments || [])].map((c) => c.body).reverse().find((b) => b.includes('<!-- uptime-watchdog:')) || '';
  if (!last.includes('<!-- uptime-watchdog:down -->')) {
    gh(['issue', 'comment', String(issue.number), '-R', REPO, '--body', `<!-- uptime-watchdog:down -->\n@${OWNER} a live app check failed. See the issue body. This workflow does not need Grok Bot.`]);
  }
}
