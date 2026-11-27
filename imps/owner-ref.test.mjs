import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { repoRef, repoSlug, refDirName, targetCheckout, duplicateImpPrs, pickIssues } from './lib.mjs';
import { discoverQueueCandidates } from './queue-discovery.mjs';

test('the default owner keeps the legacy bare ref; any other owner is qualified', () => {
    assert.equal(repoRef('vhs', 'nitsuah'), 'vhs');
    assert.equal(repoRef('vhs', 'NITSUAH'), 'vhs');
    assert.equal(repoRef('vhs', undefined), 'vhs');
    assert.equal(repoRef('vhs', 'Nitsuah-Labs'), 'Nitsuah-Labs/vhs');
    assert.equal(repoSlug('vhs'), 'nitsuah/vhs');
    assert.equal(repoSlug('Nitsuah-Labs/vhs'), 'Nitsuah-Labs/vhs');
    assert.equal(refDirName('Nitsuah-Labs/vhs'), 'Nitsuah-Labs__vhs');
});

test('same-named repos under two owners stay two queue entries and two picks', () => {
    const hit = (owner) => ({ number: 1, createdAt: '2026-01-01', labels: [], repository: { name: 'vhs', nameWithOwner: `${owner}/vhs` } });
    const queue = discoverQueueCandidates([hit('nitsuah'), hit('Nitsuah-Labs')]);
    assert.deepEqual(queue.map((c) => c.repo), ['vhs', 'Nitsuah-Labs/vhs']);
    assert.equal(pickIssues({ candidates: queue, repos: {}, max: 5, wip: 5 }).length, 2);
});

test('two owners never share a checkout', () => {
    const root = 'code';
    const has = (...dirs) => (p) => dirs.some((d) => p === join(root, d, '.git'));
    const origin = (slug) => () => `https://github.com/${slug}.git`;
    const check = (ref, dirs, slug) => targetCheckout(ref, { codeRoot: root, exists: has(...dirs), originOf: origin(slug) });
    assert.equal(check('vhs', ['vhs'], 'nitsuah/vhs').checkedOut, true);
    assert.equal(check('vhs', ['vhs'], 'Nitsuah-Labs/vhs').checkedOut, false);
    assert.equal(check('Nitsuah-Labs/vhs', ['vhs'], 'nitsuah/vhs').checkedOut, false);
    assert.equal(check('Nitsuah-Labs/vhs', ['vhs'], 'Nitsuah-Labs/vhs').path, join(root, 'vhs'));
    assert.equal(check('Nitsuah-Labs/vhs', ['vhs', 'Nitsuah-Labs__vhs'], 'nitsuah/vhs').path, join(root, 'Nitsuah-Labs__vhs'));
    assert.throws(() => targetCheckout('a/b/c'));
    assert.throws(() => targetCheckout('../x'));
});

test('a qualified PR only closes duplicates in its own owner', () => {
    const pr = (repo, url, body = 'Fixes #3') => ({ repo, url, body, number: 1 });
    assert.equal(duplicateImpPrs([pr('vhs', 'a')], [pr('Nitsuah-Labs/vhs', 'b')]).length, 0);
    assert.equal(duplicateImpPrs([pr('Nitsuah-Labs/vhs', 'a', 'Fixes Nitsuah-Labs/vhs#3')], [pr('Nitsuah-Labs/vhs', 'b')]).length, 1);
});

test('the dispatcher never rebuilds a slug or a search from the default owner', () => {
    const src = readFileSync(new URL('./dispatch.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\$\{o\.owner\}|'--owner', o\.owner/);
});
