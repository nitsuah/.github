// node --test imps/groom-select.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEpic, groomEligible, namedPaths, fetchNamedFiles } from './groom-select.mjs';
import { ensureFinalNewlines, needsFinalNewline } from './eol.mjs';

const own = { owner: 'nitsuah' };
const iss = (over = {}) => ({ title: 'Fix the stats chip rounding', body: 'In `src/stats/chips.js` round the count.', labels: [], author: 'nitsuah', ...over });

test('groomEligible: owner issues need no bug/enhancement label', () => {
    assert.deepEqual(groomEligible(iss(), own), { ok: true, reason: '' });
    assert.equal(groomEligible(iss({ labels: [{ name: 'area:app' }] }), own).ok, true);
});

test('groomEligible: skips untrusted authors so they cannot burn the cap', () => {
    assert.match(groomEligible(iss({ author: 'github-actions[bot]' }), own).reason, /not trusted/);
    assert.equal(groomEligible(iss({ author: 'helper' }), { owner: 'nitsuah', trustedAuthors: ['Helper'] }).ok, true);
});

test('groomEligible: skips imp-labelled, security, design and epic issues', () => {
    assert.match(groomEligible(iss({ labels: ['imp:failed'] }), own).reason, /imp:\*/);
    assert.match(groomEligible(iss({ labels: ['enhancement', 'security'] }), own).reason, /label security/);
    assert.match(groomEligible(iss({ labels: ['design'] }), own).reason, /label design/);
    assert.match(groomEligible(iss({ title: 'Epic: metrics platform' }), own).reason, /epic/);
});

test('groomEligible: skips off-limits repos, safety-critical, heartbeat and report issues', () => {
    assert.match(groomEligible(iss({ repo: 'security-program' }), own).reason, /never groomed/);
    assert.match(groomEligible(iss({ repo: '9router' }), own).reason, /never groomed/);
    assert.match(groomEligible(iss({ labels: ['safety-critical'] }), own).reason, /safety-critical/);
    assert.match(groomEligible(iss({ labels: ['imp'], title: 'imps heartbeat: YOKAI' }), own).reason, /label imp/);
    for (const title of ['QA fast crawl (post-Cloudflare move): findings', '[Audit] Owned-repo maintenance roll-up', 'chore(triage): human-review backlog queue', 'Brand & link pass (2026-11-20): index of imp-ready issues', 'Owned-repository field audit: CI']) {
        assert.match(groomEligible(iss({ title }), own).reason, /report or bookkeeping/, title);
    }
    assert.equal(groomEligible(iss({ repo: 'fire', title: 'Quick Start Hub: feed real state into the card' }), own).ok, true);
});

test('isEpic: phased plans and long checklists are epics, short ones are not', () => {
    assert.equal(isEpic({ body: '## Phase 1\nx\n## Phase 2\ny' }), true);
    assert.equal(isEpic({ body: '- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d' }), true);
    assert.equal(isEpic({ body: '- [ ] a\n- [x] b\n- [ ] c' }), false);
    assert.equal(isEpic({ labels: [{ name: 'tracking' }] }), true);
    assert.equal(isEpic(iss()), false);
});

test('namedPaths: repo paths in order, no URLs, no .github or .env, capped', () => {
    const text = 'Edit `app/lib/tables/dashboard.js` and app/lib/css/layout.css; see https://github.com/x/y/blob/main/app/z.js and www.example.com/a.js. Not .github/workflows/ci.yml or config/.env.local. Also tests/e2e-ui/a.spec.js, docs/x.md, src/one.ts';
    assert.deepEqual(namedPaths(text), ['app/lib/tables/dashboard.js', 'app/lib/css/layout.css', 'tests/e2e-ui/a.spec.js', 'docs/x.md']);
    assert.deepEqual(namedPaths('dashboard.js only, no dir'), []);
    assert.deepEqual(namedPaths('a/b.js a/b.js'), ['a/b.js']);
    assert.deepEqual(namedPaths('config/secrets.json certs/server.pem keys/id_rsa.pub app/token-store.js data/credentials.yml src/ok.js'), ['src/ok.js']);
});

test('fetchNamedFiles: decodes, truncates and skips missing files', () => {
    const files = { 'a/one.js': 'x'.repeat(10), 'a/big.js': 'y'.repeat(50) };
    const gh = (args) => {
        const p = args[1].split('/contents/')[1];
        if (!(p in files)) throw new Error('404');
        return Buffer.from(files[p]).toString('base64');
    };
    const out = fetchNamedFiles(gh, 'o', 'r', ['a/one.js', 'a/missing.js', 'a/big.js'], { maxChars: 20 });
    assert.deepEqual(Object.keys(out), ['file: a/one.js', 'file: a/big.js']);
    assert.equal(out['file: a/one.js'], 'x'.repeat(10));
    assert.match(out['file: a/big.js'], /^y{20}\n… \(truncated, 50 chars\)$/);
});

test('ensureFinalNewlines: fixes text files, keeps CRLF style, skips binary, empty and missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'eol-'));
    mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'test', 'a.mjs'), 'x;');
    writeFileSync(join(d, 'b.md'), 'one\r\ntwo');
    writeFileSync(join(d, 'ok.js'), 'y;\n');
    writeFileSync(join(d, 'empty.txt'), '');
    writeFileSync(join(d, 'img.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(d, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const changed = ensureFinalNewlines(d, ['test/a.mjs', 'b.md', 'ok.js', 'empty.txt', 'img.png', 'blob.dat', 'gone.js']);
    assert.deepEqual(changed, ['test/a.mjs', 'b.md']);
    assert.equal(readFileSync(join(d, 'test', 'a.mjs'), 'utf8'), 'x;\n');
    assert.equal(readFileSync(join(d, 'b.md'), 'utf8'), 'one\r\ntwo\r\n');
    assert.equal(readFileSync(join(d, 'ok.js'), 'utf8'), 'y;\n');
    assert.equal(needsFinalNewline(Buffer.from('')), false);
});

test('fetchRepoTree / treeExists / treeContext', async () => {
    const { fetchRepoTree, treeExists, treeContext } = await import('./groom-select.mjs');
    const calls = [];
    const gh = (args) => { calls.push(args); return 'src/a.js\nsrc/lib/b.js\r\npackage.json\nassets/logo.png\nnode_modules/x/y.js\n'; };
    const tree = fetchRepoTree(gh, 'nitsuah', 'vhs');
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /^repos\/nitsuah\/vhs\/git\/trees\/HEAD\?recursive=1$/);
    assert.deepEqual(tree, ['src/a.js', 'src/lib/b.js', 'package.json', 'assets/logo.png', 'node_modules/x/y.js']);
    assert.equal(fetchRepoTree(() => { throw new Error('404'); }, 'o', 'r'), null);
    assert.equal(fetchRepoTree(() => '', 'o', 'r'), null);
    const ex = treeExists(tree);
    for (const p of ['src/a.js', 'src/', 'src', 'src/lib/', './src/lib/b.js', 'package.json']) assert.ok(ex(p), p);
    for (const p of ['src/worker/', 'src/a', 'lib/', 'src/lib/c.js']) assert.ok(!ex(p), p);
    const ctx = treeContext(tree);
    assert.match(ctx, /src\/lib\/b\.js/);
    assert.doesNotMatch(ctx, /logo\.png|node_modules/);
    assert.match(treeContext(['a/1.js', 'a/2.js', 'a/3.js'], { max: 2 }), /1 more/);
});
