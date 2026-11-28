#!/usr/bin/env node
// Deterministic read-only "fast crawl" across the moved apps.
// Usage: node crawl.mjs [appId ...]   (env BASE_OVERRIDE_<ID>=https://preview-url to point at a preview)
// Output: out/results.json, out/report.md, out/shots/*.png. Exit 1 on any hard failure.
import { chromium, request as pwRequest } from 'playwright';
import fs from 'node:fs';
import { apps } from './apps.mjs';
import { journeys } from './journeys.mjs';

const only = process.argv.slice(2);
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT + 'shots', { recursive: true });
const NAV_TIMEOUT = 30000;
const IGNORE_CONSOLE = [/Download the React DevTools/i, /\[HMR\]/];
const THIRD_PARTY_NOISE = [/google-analytics|googletagmanager|cloudflareinsights|static\.cloudflareinsights|doubleclick|vercel-insights|_vercel\/insights|_vercel\/speed-insights/];

const results = [];
const sev = (level, msg, url) => ({ level, msg, url });

async function checkPage(ctx, app, url) {
  const page = await ctx.newPage();
  const r = { url, status: null, finalUrl: null, title: null, consoleErrors: [], pageErrors: [], badResponses: [], failedRequests: [], ms: 0 };
  const origin = new URL(app.base).origin;
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE_CONSOLE.some((re) => re.test(m.text()))) r.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => r.pageErrors.push(String(e.message || e).slice(0, 300)));
  page.on('response', (res) => { const s = res.status(); if (s >= 400) r.badResponses.push(`${s} ${res.request().method()} ${res.url().slice(0, 200)}`); });
  page.on('requestfailed', (req) => {
    const f = req.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(f) && (req.resourceType() === 'media' || req.method() === 'HEAD')) return; // video preload + Next.js HEAD prefetch aborts are normal
    r.failedRequests.push(`${f} ${req.method()} ${req.url().slice(0, 200)}`);
  });
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    r.status = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500); // let lazy hydration errors surface
    r.finalUrl = page.url();
    r.title = await page.title();
    r.bodyTextLen = (await page.locator('body').innerText().catch(() => '')).trim().length;
    r.headers = resp ? resp.headers() : {};
  } catch (e) { r.navError = String(e.message).split('\n')[0]; }
  r.ms = Date.now() - t0;
  r.thirdPartyBad = r.badResponses.filter((x) => !x.includes(origin));
  r.badResponses = r.badResponses.filter((x) => x.includes(origin));
  r.failedRequests = r.failedRequests.filter((x) => !THIRD_PARTY_NOISE.some((re) => re.test(x)));
  return { page, r };
}

async function main() {
  const browser = await chromium.launch();
  const api = await pwRequest.newContext({ maxRedirects: 0, ignoreHTTPSErrors: false });
  for (const app0 of apps) {
    if (only.length && !only.includes(app0.id)) continue;
    const app = { ...app0, base: (process.env[`BASE_OVERRIDE_${app0.id.replace(/-/g, '_').toUpperCase()}`] || (only.length === 1 && process.env.BASE_OVERRIDE) || app0.base).replace(/\/$/, '') };
    const A = { id: app.id, repo: app.repo, base: app.base, host: app.host, pages: [], api: [], redirects: [], headers: [], journey: null, findings: [] };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce' });
    await ctx.addInitScript(() => { Math.random = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })(); });

    // 1) Pages
    const urls = new Set(app.routes.map((p) => app.base + p));
    const seen = new Set();
    const origin0 = new URL(app.base).origin;
    for (const url of urls) {
      if (seen.has(url)) continue; seen.add(url);
      const { page, r } = await checkPage(ctx, app, url);
      if (app.discoverLinks && url === app.base + '/') {
        const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
        r.discovered = [...new Set(links.filter((h) => h.startsWith(origin0)).map((h) => h.split('#')[0].split('?')[0]))].sort();
        for (const h of r.discovered) if (!urls.has(h) && h.startsWith(app.base) && !/\/auth\/|\.(csv|zip|json|pdf)$/.test(h)) urls.add(h);
        await page.screenshot({ path: `${OUT}shots/${app.id}-home.png` }).catch(() => {});
      }
      await page.close();
      A.pages.push(r);
      const isAsset = /\.(txt|xml|js)$/.test(url);
      if (r.navError) A.findings.push(sev('fail', `navigation error: ${r.navError}`, url));
      else if (r.status >= 400) A.findings.push(sev('fail', `HTTP ${r.status}`, url));
      if (!isAsset && !r.navError && r.bodyTextLen < 20) A.findings.push(sev('warn', `page renders almost no text (${r.bodyTextLen} chars)`, url));
      for (const e of r.pageErrors) A.findings.push(sev('fail', `uncaught page error: ${e}`, url));
      for (const e of r.consoleErrors) A.findings.push(sev('warn', `console error: ${e}`, url));
      for (const e of r.badResponses) A.findings.push(sev('warn', `first-party ${e}`, url));
      for (const e of r.failedRequests) A.findings.push(sev('warn', `request failed: ${e}`, url));
      for (const e of r.thirdPartyBad) A.findings.push(sev('info', `third-party ${e}`, url));
    }
    // 2) 404 behaviour
    if (app.notFound) {
      const res = await api.get(app.base + app.notFound).catch((e) => null);
      const s = res?.status();
      A.notFound = s;
      if (s !== 404) A.findings.push(sev('warn', `unknown path returns ${s} (expected 404)`, app.base + app.notFound));
    }
    // 3) Redirects
    for (const rd of app.redirects || []) {
      const res = await api.get(rd.from).catch(() => null);
      const s = res?.status(); const loc = res?.headers()['location'];
      A.redirects.push({ ...rd, got: s, location: loc });
      if (!rd.status.includes(s) || loc !== rd.to) A.findings.push(sev('warn', `redirect ${rd.from} -> ${s} ${loc || '(none)'}; expected ${rd.status.join('/')} -> ${rd.to}`, rd.from));
    }
    // 4) API / health / auth gates
    for (const c of app.api) {
      const res = await api.get(app.base + c.path, { headers: { accept: 'application/json' } }).catch((e) => null);
      const s = res?.status(); const ct = res?.headers()['content-type'] || '';
      let body = null; try { body = await res.json(); } catch { body = null; }
      const row = { path: c.path, status: s, contentType: ct.split(';')[0], keys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 10) : Array.isArray(body) ? `array(${body.length})` : null };
      A.api.push(row);
      if (!c.status.includes(s)) A.findings.push(sev(s >= 500 ? 'fail' : 'warn', `API ${c.path} -> ${s} (expected ${c.status.join('/')})${c.note ? ' — ' + c.note : ''}`, app.base + c.path));
      if (c.json && (!body || c.json.some((k) => !(k in body)))) A.findings.push(sev('warn', `API ${c.path} missing keys ${c.json.join(',')}`, app.base + c.path));
      if ((c.jsonBody || c.json) && !ct.includes('json')) A.findings.push(sev('warn', `API ${c.path} returns ${ct.split(';')[0] || 'no content-type'} instead of JSON`, app.base + c.path));
    }
    // 5) Headers
    for (const [p, want] of Object.entries(app.headers || {})) {
      const pg = A.pages.find((x) => x.url === app.base + p);
      const h = pg?.headers || {};
      const missing = want.filter((k) => !(k in h));
      A.headers.push({ path: p, server: h.server, cache: h['cache-control'], cfCache: h['cf-cache-status'], vercelCache: h['x-vercel-cache'], missing });
      if (missing.length) A.findings.push(sev('warn', `missing security headers on ${p}: ${missing.join(', ')}`, app.base + p));
    }
    // 6) Happy-path journey (clicks only, no writes)
    if (journeys[app.id]) {
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 300)));
      const steps = [];
      const step = async (name, fn) => { const t = Date.now(); try { await fn(); steps.push({ name, ok: true, ms: Date.now() - t }); } catch (e) { steps.push({ name, ok: false, err: String(e.message).split('\n')[0].slice(0, 300) }); A.findings.push(sev('fail', `journey step failed: ${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`, page.url())); } };
      await journeys[app.id]({ page, base: app.base, step, shot: (n) => page.screenshot({ path: `${OUT}shots/${app.id}-${n}.png` }).catch(() => {}) });
      for (const e of errs) A.findings.push(sev('fail', `uncaught page error during journey: ${e}`, page.url()));
      A.journey = steps; await page.close();
    }
    await ctx.close();
    results.push(A);
    const f = A.findings; console.log(`${app.id}: ${A.pages.length} pages, ${f.filter((x) => x.level === 'fail').length} fail, ${f.filter((x) => x.level === 'warn').length} warn`);
  }
  await browser.close(); await api.dispose();
  fs.writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 2));
  let md = `# Fast crawl report\n\n`;
  for (const A of results) {
    md += `## ${A.id} (${A.base}, ${A.host})\n\n| URL | status | ms | console | pageerr | 4xx/5xx |\n|---|---|---|---|---|---|\n`;
    for (const p of A.pages) md += `| ${p.url.replace(A.base, '') || '/'} | ${p.navError ? 'ERR' : p.status} | ${p.ms} | ${p.consoleErrors.length} | ${p.pageErrors.length} | ${p.badResponses.length} |\n`;
    if (A.api.length) { md += `\n| API | status | type |\n|---|---|---|\n`; for (const a of A.api) md += `| ${a.path} | ${a.status} | ${a.contentType} |\n`; }
    if (A.journey) { md += `\nJourney:\n`; for (const s of A.journey) md += `- ${s.ok ? 'PASS' : 'FAIL'} ${s.name}${s.err ? ' — ' + s.err : ''}\n`; }
    md += `\nFindings:\n`; const uniq = [...new Map(A.findings.map((f) => [f.level + f.msg, f])).values()];
    for (const f of uniq) md += `- **${f.level}** ${f.msg} (${f.url})\n`;
    md += '\n';
  }
  fs.writeFileSync(OUT + 'report.md', md);
  process.exit(results.some((A) => A.findings.some((f) => f.level === 'fail')) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
