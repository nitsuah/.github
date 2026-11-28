// node --test imps/ci-guard.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardFailures, validateChangelogPatch } from './ci-guard.mjs';

const owners = ['nitsuah'];
const acked = { labels: ['risk-ack'], ackEvents: [{ event: 'labeled', actor: 'nitsuah' }] };
const check = (over) => guardFailures({ owners, ...over });

// Sample patches for testing
const validPatchRoot = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog
+* Added new feature X
 * Fixed bug Y
`;
const validPatchDocs = `diff --git a/docs/CHANGELOG.md b/docs/CHANGELOG.md
--- a/docs/CHANGELOG.md
+++ b/docs/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog
+* Added new feature X
 * Fixed bug Y
`;
const typoPatch = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,3 @@
 # Changelog
-* Fixed bug Y
+* Fixed bug Y (typo fix)
 * Added feature Z
`;
const headingOnlyPatch = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,2 +1,3 @@
 # Changelog
+## v1.2.3
 * Fixed bug Y
`;
const deletedFilePatch = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ /dev/null
@@ -1,3 +0,0 @@
-# Changelog
-* Fixed bug Y
-* Added feature Z
`;
const numberedListPatch = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog
+1. Added new feature X
 * Fixed bug Y
`;
const dashListPatch = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog
+- Added new feature X
 * Fixed bug Y
`;

test('a docs-only PR passes with no CHANGELOG', () => {
    assert.deepEqual(check({ paths: ['README.md', 'docs/TASKS.md', 'docs/shot.png'] }), []);
});

test('a non-docs change needs a root or docs/ CHANGELOG.md line, or the no-changelog label', () => {
    for (const path of ['src/app.ts', 'tests/app.test.ts']) {
        assert.match(check({ paths: [path] })[0], /CHANGELOG/, path);
        // Now requires a valid changelog patch with net-new list entry
        assert.deepEqual(check({ paths: [path, 'CHANGELOG.md'], changelogPatch: validPatchRoot }), []);
        assert.deepEqual(check({ paths: [path, 'docs/CHANGELOG.md'], changelogPatch: validPatchDocs }), []);
        assert.deepEqual(check({ paths: [path], labels: ['no-changelog'] }), []);
    }
    assert.match(check({ paths: ['src/app.ts', 'packages/x/CHANGELOG.md'] })[0], /CHANGELOG/, 'only the root or docs/ CHANGELOG counts');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG'] })[0], /CHANGELOG/, 'the .md file is required');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG.md'], currentPaths: ['src/app.ts', 'docs/archive.md'] })[0], /CHANGELOG/, 'renamed-away root CHANGELOG does not count');
    assert.match(check({ paths: ['src/app.ts', 'CHANGELOG.md'], currentPaths: ['src/app.ts'] })[0], /CHANGELOG/, 'deleted root CHANGELOG does not count');
    assert.match(check({ paths: ['src/app.ts', 'docs/CHANGELOG.md'], currentPaths: ['src/app.ts'] })[0], /CHANGELOG/, 'deleted docs CHANGELOG does not count');
    assert.match(check({ paths: ['src/app.ts', 'docs/x/CHANGELOG.md'] })[0], /CHANGELOG/, 'nested docs CHANGELOG does not count');
});

test('validateChangelogPatch accepts valid new bullet in root CHANGELOG', () => {
    assert.ok(validateChangelogPatch(validPatchRoot), 'root CHANGELOG with new bullet passes');
});

test('validateChangelogPatch accepts valid new bullet in docs/CHANGELOG', () => {
    assert.ok(validateChangelogPatch(validPatchDocs), 'docs/CHANGELOG with new bullet passes');
});

test('validateChangelogPatch accepts numbered list items', () => {
    assert.ok(validateChangelogPatch(numberedListPatch), 'numbered list item passes');
});

test('validateChangelogPatch accepts dash list items', () => {
    assert.ok(validateChangelogPatch(dashListPatch), 'dash list item passes');
});

test('validateChangelogPatch accepts a one-for-one replacement', () => {
    assert.ok(validateChangelogPatch(typoPatch), 'a rewritten list item is a changelog edit');
});

test('validateChangelogPatch accepts multiple replacements, rejects removal only', () => {
    assert.ok(validateChangelogPatch('@@ -1,2 +1,2 @@\n-- old a\n-- old b\n+- new a\n+- new b'));
    assert.ok(!validateChangelogPatch('@@ -1,2 +1,0 @@\n-- old a\n-- old b'));
    assert.ok(!validateChangelogPatch('@@ -1 +1 @@\n-- old a\n+- '), 'an emptied item does not count');
});

test('validateChangelogPatch rejects heading-only addition', () => {
    assert.ok(!validateChangelogPatch(headingOnlyPatch), 'heading-only fails - no list item added');
});

test('validateChangelogPatch rejects deleted file', () => {
    assert.ok(!validateChangelogPatch(deletedFilePatch), 'deleted file fails');
});

test('validateChangelogPatch rejects missing patch', () => {
    assert.ok(!validateChangelogPatch(null), 'null patch fails');
    assert.ok(!validateChangelogPatch(''), 'empty patch fails');
    assert.ok(!validateChangelogPatch('not a diff'), 'non-diff patch fails');
});

test('guardFailures passes with valid changelog patch for root CHANGELOG', () => {
    assert.deepEqual(check({ paths: ['src/app.ts'], changelogPatch: validPatchRoot }), []);
});

test('guardFailures passes with valid changelog patch for docs/CHANGELOG', () => {
    assert.deepEqual(check({ paths: ['src/app.ts'], changelogPatch: validPatchDocs }), []);
});

test('guardFailures passes with a one-for-one replacement patch', () => {
    const failures = check({ paths: ['src/app.ts'], changelogPatch: typoPatch });
    assert.deepEqual(failures, [], 'a rewritten entry satisfies the changelog check');
});

test('guardFailures fails with heading-only patch', () => {
    const failures = check({ paths: ['src/app.ts'], changelogPatch: headingOnlyPatch });
    assert.match(failures[0], /CHANGELOG/, 'heading-only fails changelog check');
});

test('guardFailures fails with deleted file patch', () => {
    const failures = check({ paths: ['src/app.ts'], changelogPatch: deletedFilePatch });
    assert.match(failures[0], /CHANGELOG/, 'deleted file fails changelog check');
});

test('guardFailures fails with missing patch', () => {
    const failures = check({ paths: ['src/app.ts'], changelogPatch: null });
    assert.match(failures[0], /CHANGELOG/, 'missing patch fails changelog check');
});

test('guardFailures passes with no-changelog label regardless of patch', () => {
    assert.deepEqual(check({ paths: ['src/app.ts'], labels: ['no-changelog'], changelogPatch: null }), []);
    assert.deepEqual(check({ paths: ['src/app.ts'], labels: ['no-changelog'], changelogPatch: typoPatch }), []);
    assert.deepEqual(check({ paths: ['src/app.ts'], labels: ['no-changelog'], changelogPatch: headingOnlyPatch }), []);
});

test('a PR labelled risk:high fails without an owner risk-ack', () => {
    const paths = ['README.md'];
    assert.match(check({ paths, labels: ['risk:high'] })[0], /risk-ack/);
    assert.deepEqual(check({ paths, labels: ['risk:high', 'risk-ack'], ackEvents: acked.ackEvents }), []);
    assert.equal(check({ paths, labels: ['risk:high', 'risk-ack'], ackEvents: [{ event: 'labeled', actor: 'someone' }] }).length, 1);
});

test('high-risk paths need the acknowledgement even when the label is missing', () => {
    const paths = ['.github/workflows/ci.yml', 'CHANGELOG.md'];
    // Need a valid changelog patch to isolate the risk:high check
    assert.match(check({ paths, changelogPatch: validPatchRoot })[0], /risk-ack/);
    assert.deepEqual(check({ paths, changelogPatch: validPatchRoot, ...acked }), []);
});

test('an unreadable file list fails the guard', () => {
    assert.match(check({ paths: [], error: 'HTTP 502' })[0], /HTTP 502/);
    assert.ok(check({ paths: [], error: 'HTTP 502', ...acked }).length, 'an acknowledgement does not pass an unread PR');
});
