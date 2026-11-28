// Lightweight, Playwright-free uptime check of the live custom domains.
// Read-only GETs. Exit 1 on any unexpected status or missing header.
// Usage: node health.mjs
// Output: out/health.json

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out/');
const UA = 'nitsuah-qa-health/1.0 (+https://github.com/nitsuah/.github)';

const checks = [
  { id: 'nitsuah-io', url: 'https://nitsuah.io/', status: [200], headers: ['strict-transport-security', 'x-content-type-options'] },
  { id: 'nitsuah-io-www', url: 'https://www.nitsuah.io/', status: [301, 308], redirect: 'https://nitsuah.io/' },
  { id: 'fire-home', url: 'https://fire.nitsuah.io/', status: [200], headers: ['strict-transport-security', 'x-content-type-options'] },
  { id: 'fire-health', url: 'https://fire.nitsuah.io/api/health', status: [200], json: ['status'] },
  { id: 'fire-ebay-deletion', url: 'https://fire.nitsuah.io/api/sync/ebay/marketplace-account-deletion?challenge_code=qa', status: [200, 503], note: '503 only if EBAY_VERIFICATION_TOKEN is unset; 500 is a crash' },
  { id: 'vigil-home-cookie', url: 'https://vigil.nitsuah.io/', status: [200], cookie: 'qa=1', headers: ['strict-transport-security', 'x-content-type-options'], note: 'cookie-bearing request; 500/1101 is the OpenNext cookie-parse regression' },
  { id: 'vigil-login-cookie', url: 'https://vigil.nitsuah.io/login', status: [200], cookie: 'qa=1' },
  { id: 'vigil-version-cookie', url: 'https://vigil.nitsuah.io/api/version', status: [200], cookie: 'qa=1', json: ['commit'] },
  { id: 'vigil-health-cookie', url: 'https://vigil.nitsuah.io/api/health', status: [200, 503], cookie: 'qa=1', json: ['status'] },
  { id: 'vhs-home', url: 'https://vhs.nitsuah.io/', status: [200], headers: ['strict-transport-security'] },
  { id: 'vhs-health', url: 'https://vhs.nitsuah.io/api/health', status: [200], json: ['status'] },
  { id: 'darkmoon', url: 'https://darkmoon.dev/', status: [200] },
  { id: 'kryptos', url: 'https://kryptos.nitsuah.io/', status: [200] },
  { id: 'arcade', url: 'https://arcade.nitsuah.io/', status: [200] },
];

async function one(c) {
  const headers = { accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'user-agent': UA };
  if (c.cookie) headers.cookie = c.cookie;
  const row = { id: c.id, url: c.url, ok: false };
  let res;
  try {
    res = await fetch(c.url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    row.error = String(e.message || e);
    return row;
  }
  row.status = res.status;
  const loc = res.headers.get('location');
  if (loc) row.location = loc;
  if (!c.status.includes(res.status)) {
    row.error = `status ${res.status} (expected ${c.status.join('/')})${c.note ? ' — ' + c.note : ''}`;
    return row;
  }
  if (c.redirect) {
    const got = loc || '';
    if (!got.startsWith(c.redirect)) {
      row.error = `redirect ${got || '(none)'} (expected ${c.redirect})`;
      return row;
    }
  }
  if (c.headers) {
    const missing = c.headers.filter((h) => !res.headers.get(h));
    if (missing.length) {
      row.error = `missing headers: ${missing.join(', ')}`;
      return row;
    }
  }
  if (c.json) {
    const ct = res.headers.get('content-type') || '';
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!ct.includes('json') || !body || typeof body !== 'object') {
      row.error = `expected JSON, got ${ct || 'no content-type'}`;
      return row;
    }
    const miss = c.json.filter((k) => !(k in body));
    if (miss.length) {
      row.error = `missing JSON keys: ${miss.join(', ')}`;
      return row;
    }
  }
  row.ok = true;
  return row;
}

const results = [];
for (const c of checks) results.push(await one(c));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(join(OUT, 'health.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
const fails = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.status ?? ''} ${r.error || ''}`.trim());
if (fails.length) {
  console.error(`${fails.length}/${results.length} checks failed`);
  process.exit(1);
}
console.log(`all ${results.length} checks passed`);
