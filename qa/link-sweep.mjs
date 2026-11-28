// Check links in the profile README and the homepage URL of every public repo.
// Read-only. Exit 1 when a link is dead (not 2xx after redirects, or 4xx/5xx).
// Usage: node link-sweep.mjs
// Env: GITHUB_TOKEN (optional, raises API rate limits).
// Output: out/links.json

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ROOT, '..');
const OUT = join(ROOT, 'out/');
const UA = 'nitsuah-qa-links/1.0 (+https://github.com/nitsuah/.github)';
const SKIP_HOSTS = new Set(['example.com', 'localhost', '127.0.0.1']);
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function extractUrls(text) {
  const out = new Set();
  const re = /https?:\/\/[^\s)<>"'`]+/gi;
  let m;
  while ((m = re.exec(text))) {
    let u = m[0].replace(/[.,;:!?]+$/, '').replace(/\)+$/, '');
    try {
      const url = new URL(u);
      if (SKIP_HOSTS.has(url.hostname) || url.hostname.endsWith('.example')) continue;
      url.hash = '';
      out.add(url.toString());
    } catch { /* ignore */ }
  }
  return [...out];
}

async function probe(url) {
  const headers = { 'user-agent': UA, accept: '*/*' };
  const row = { url, ok: false };
  try {
    let res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    // Some hosts refuse HEAD.
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    }
    row.status = res.status;
    row.final = res.url;
    if (res.status >= 200 && res.status < 400) row.ok = true;
    else row.error = `status ${res.status}`;
  } catch (e) {
    row.error = String(e.message || e);
  }
  return row;
}

async function gh(path) {
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

async function listRepos(kind, name) {
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const path = kind === 'org'
      ? `/orgs/${name}/repos?per_page=100&page=${page}&type=public`
      : `/users/${name}/repos?per_page=100&page=${page}&type=owner`;
    const batch = await gh(path);
    items.push(...batch.filter((r) => !r.private && !r.fork));
    if (batch.length < 100) break;
  }
  return items;
}

const readmePath = join(REPO_ROOT, 'profile/README.md');
const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
const readmeUrls = extractUrls(readme);
if (!readme) console.warn('profile/README.md not found; skipping README links');

const readmeResults = [];
for (const url of readmeUrls) readmeResults.push({ source: 'profile/README.md', ...(await probe(url)) });

const repos = [...await listRepos('user', 'nitsuah'), ...await listRepos('org', 'Nitsuah-Labs')];
const seen = new Set();
const homepageResults = [];
for (const r of repos) {
  const home = (r.homepage || '').trim();
  if (!home) continue;
  const url = home.startsWith('http') ? home : `https://${home}`;
  if (seen.has(url)) continue;
  seen.add(url);
  homepageResults.push({ source: `${r.full_name} homepage`, ...(await probe(url)) });
}

const results = [...readmeResults, ...homepageResults];
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(join(OUT, 'links.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
const fails = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.status ?? ''} ${r.source} ${r.url} ${r.error || ''}`.trim());
if (fails.length) {
  console.error(`${fails.length}/${results.length} links failed`);
  process.exit(1);
}
console.log(`all ${results.length} links passed`);
