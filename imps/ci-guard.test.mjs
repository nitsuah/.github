// node --test imps/ci-guard.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardFailures } from './ci-guard.mjs';

const owners = ['nitsuah'];
const acked = { labels: ['risk-ack'], ackEvents: [{ event: 'labeled', actor: 'nitsuah' }] };
const check = (over) => guardFailures({ owners, ...over });

test('a docs-only PR passes with no CHANGELOG', () => {
    assert.deepEqual(check({ paths: ['README.md', 'docs/TASKS.md', 'docs/shot.png'] }), []);
});

test('a non-docs change needs the root CHANGELOG.md line, or the no-changelog label', () => {
    for (const path of ['src/app.ts', 'tests/app.test.ts']) {
        assert.match(check({ paths: [path] })[0], /CHANGELOG/, path);
        assert.deepEqual(check({ paths: [path, 'CHANGELOG.md'] }), []);
        assert.match(check({ paths: [path, 'docs/CHANGELOG.md'] })[0], /CHANGELOG/);
        assert.deepEqual(check({ paths: [path], labels: ['no-changelog'] }), []);
    }
    assert.match(check({ paths: ['src/app.ts', 'packages/x/CHANGELOG.md'] })[0], /CHANGELOG/, 'only the repo root CHANGELOG counts');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG'] })[0], /CHANGELOG/, 'the .md file is required');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG.md'], currentPaths: ['src/app.ts', 'docs/archive.md'] })[0], /CHANGELOG/, 'renamed-away root CHANGELOG does not count');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG.md'], currentPaths: ['src/app.ts'] })[0], /CHANGELOG/, 'deleted root CHANGELOG does not count');
});

test('a PR labelled risk:high fails without an owner risk-ack', () => {
    const paths = ['README.md'];
    assert.match(check({ paths, labels: ['risk:high'] })[0], /risk-ack/);
    assert.deepEqual(check({ paths, labels: ['risk:high', 'risk-ack'], ackEvents: acked.ackEvents }), []);
    assert.equal(check({ paths, labels: ['risk:high', 'risk-ack'], ackEvents: [{ event: 'labeled', actor: 'someone' }] }).length, 1);
});

test('high-risk paths need the acknowledgement even when the label is missing', () => {
    const paths = ['.github/workflows/ci.yml', 'CHANGELOG.md'];
    assert.match(check({ paths })[0], /risk-ack/);
    assert.deepEqual(check({ paths, ...acked }), []);
});

test('an unreadable file list fails the guard', () => {
    assert.match(check({ paths: [], error: 'HTTP 502' })[0], /HTTP 502/);
    assert.ok(check({ paths: [], error: 'HTTP 502', ...acked }).length, 'an acknowledgement does not pass an unread PR');
});
