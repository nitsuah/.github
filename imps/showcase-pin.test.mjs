import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    assert.throws(() => pinnedTag('main', 'x'));
});
