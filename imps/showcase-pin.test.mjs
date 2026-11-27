import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pinnedTag } from '../showcase/pin.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tags = (p) => read(p).match(/<script[^>]*showcase\/expand\.js[^>]*><\/script>/g) || [];
const PINNED = /@[0-9a-f]{40}\/showcase\/expand\.js" integrity="sha384-[A-Za-z0-9+/]{64}" crossorigin="anonymous" defer>/;

test('the page skeleton and the standard load the same pinned, integrity-checked script', () => {
    const found = ['showcase/templates/page-skeleton.html', 'showcase/STANDARD.md'].flatMap(tags);
    assert.equal(found.length, 2);
    for (const tag of found) assert.match(tag, PINNED);
    assert.equal(found[0], found[1]);
});

test('pinnedTag emits that shape and refuses a branch name', () => {
    assert.match(pinnedTag('a'.repeat(40), 'x'), PINNED);
    const want = createHash('sha384').update('x').digest('base64');
    assert.ok(pinnedTag('a'.repeat(40), 'x').includes(`integrity="sha384-${want}"`), 'hash is the sha384 of the content');
    assert.throws(() => pinnedTag('main', 'x'));
});

test('the pinned integrity hash matches expand.js at the pinned commit', (t) => {
    const tag = tags('showcase/templates/page-skeleton.html')[0];
    const [, commit, hash] = tag.match(/@([0-9a-f]{40})\/showcase\/expand\.js" integrity="sha384-([^"]+)"/);
    let bytes;
    try { bytes = execFileSync('git', ['show', `${commit}:showcase/expand.js`], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return t.skip(`pinned commit ${commit.slice(0, 8)} is not in this (shallow) checkout`); }
    assert.equal(hash, createHash('sha384').update(bytes).digest('base64'));
});
