// node --test imps/brieflint.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLines, extractBriefInput, lintBrief } from './brieflint.mjs';
import { briefFromComments, validateBriefMeta } from './lib.mjs';

const brief = (front, body = '## Issue o/r#1\nDo the thing.\n') => `---\nrepo: r\nissue: 1\ntest: docker run x --config config/v.mjs y\nmaxLines: 100\nallow: a.js, a.test.js\n${front}---\n${body}`;
const code = (n) => `~~~js\n${'x();\n'.repeat(n)}~~~\n`;

const targetBrief = (repo, issue) => `---\nrepo: ${repo}\nissue: ${issue}\ntest: node --test imps/brieflint.test.mjs\n---\n## Issue nitsuah/.github#410\nUpdate imps/lib.mjs.\n`;

test('repo metadata accepts bare and explicit default-owner names', () => {
    assert.equal(validateBriefMeta(targetBrief('fire', 166), 'fire', 166), null);
    assert.equal(validateBriefMeta(targetBrief('nitsuah/fire', 166), 'fire', 166), null);
    assert.match(
        validateBriefMeta(targetBrief('other/fire', 166), 'fire', 166),
        /does not match the target repository/,
    );
});

test('repo metadata accepts bare and matching explicit Nitsuah-Labs names', () => {
    assert.equal(validateBriefMeta(targetBrief('nitsuah-io', 632), 'Nitsuah-Labs/nitsuah-io', 632), null);
    assert.equal(validateBriefMeta(targetBrief('Nitsuah-Labs/nitsuah-io', 632), 'Nitsuah-Labs/nitsuah-io', 632), null);
});

test('repo metadata rejects a wrong explicit owner and shows the target slug', () => {
    const error = validateBriefMeta(
        targetBrief('nitsuah/nitsuah-io', 632),
        'Nitsuah-Labs/nitsuah-io',
        632,
    );
    assert.match(error, /does not match the target repository/);
    assert.match(error, /repo: Nitsuah-Labs\/nitsuah-io/);
});

test('missing repo diagnostic shows the target owner for org repositories', () => {
    const brief = `---\nissue: 632\ntest: node --test imps/brieflint.test.mjs\n---\n## Issue nitsuah/.github#410\nUpdate imps/lib.mjs.\n`;
    const error = validateBriefMeta(brief, 'Nitsuah-Labs/nitsuah-io', 632);
    assert.match(error, /repo: Nitsuah-Labs\/nitsuah-io/);
});

test('a well-formed brief passes', () => {
    const r = lintBrief(brief(''), { exists: () => true });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, []);
});

test('missing keys and a trailing # comment are problems', () => {
    const r = lintBrief('---\nrepo: r\nallow: a.js # why\n---\nbody\n');
    assert.ok(r.problems.includes('missing front matter: test'));
    assert.ok(r.problems.includes('missing front matter: maxLines'));
    assert.ok(r.problems.includes('trailing # comment in allow'));
});

test('a nested ``` fence would truncate the brief and is a problem', () => {
    const r = lintBrief(brief('', '## Issue o/r#1\n```js\nx\n```\n'));
    assert.ok(r.problems.some((p) => p.includes('nested ``` fence')));
});

test('codeLines counts only lines inside ~~~ blocks', () => {
    assert.equal(codeLines(`intro\n${code(3)}text\n${code(2)}`), 5);
});

test('inline code that outgrows maxLines warns with a suggested cap (vigil#359: 56 lines, 136 diff)', () => {
    const r = lintBrief(brief('', `## Issue o/r#1\n${code(56)}`));
    assert.deepEqual(r.problems, []);
    assert.match(r.warnings[0], /56 inline code lines but maxLines 100.*Suggest maxLines: 140/);
    assert.deepEqual(lintBrief(brief('', `## Issue o/r#1\n${code(10)}`)).warnings, []);
});

test('a test config missing on origin/main is a problem; a new allow file is only a warning', () => {
    const r = lintBrief(brief(''), { exists: (p) => p === 'a.js' });
    assert.deepEqual(r.problems, ['test config not on origin/main: config/v.mjs']);
    assert.deepEqual(r.warnings, ['allow path not on origin/main (new file?): a.test.js']);
});

test('a body that talks about a dependency needs a `depends:` line', () => {
    const body = '## Issue o/r#1\nThis needs the helper from #318: if the #318 PR has not merged yet, stop.\n';
    const r = lintBrief(brief('', body));
    assert.ok(r.warnings.some((w) => w.includes('depends:')));
    assert.deepEqual(lintBrief(brief('depends: #318\n', body)).warnings, []);
});

test('a full marker-first comment extracts and preserves the brief body', () => {
    const source = brief('depends: none\n', '## Issue o/r#1\nPreserve this body exactly.\n');
    const comment = '<!-- imp-brief -->\n' + '\x60\x60\x60markdown\n' + source.trim() + '\n' + '\x60\x60\x60\n';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, null);
    assert.equal(extracted.brief, source.trim() + '\n');

    const r = lintBrief(comment, { exists: () => true });
    assert.deepEqual(r.problems, []);
    assert.equal(r.meta.repo, 'r');
    assert.equal(r.meta.issue, '1');
});

test('a raw marker-first comment matches dispatcher extraction', () => {
    const source = brief('depends: none\n', '## Issue o/r#1\nPreserve this body exactly.\n');
    const comment = '<!-- imp-brief -->\n' + source.trim() + '\n';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, null);
    assert.equal(extracted.brief, source.trim() + '\n');

    const r = lintBrief(comment, { exists: () => true });
    assert.deepEqual(r.problems, []);
    assert.equal(r.meta.repo, 'r');
    assert.equal(r.meta.issue, '1');
});

test('a groom-promoted comment with an intro line before the fence lints clean', () => {
    const source = brief('depends: none\n', '## Issue o/r#1\nPreserve this body exactly.\n');
    const comment = '<!-- imp-brief -->\nGroomed brief, auto-promoted to `imp:ready`. Remove `imp:ready` to stop it.\n'
        + '\x60\x60\x60markdown\n' + source.trim() + '\n' + '\x60\x60\x60\n';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, null);
    assert.equal(extracted.brief, source.trim() + '\n');
    assert.equal(extracted.brief, briefFromComments([{ body: comment, author: { login: 'nitsuah' } }]));
    assert.deepEqual(lintBrief(comment, { exists: () => true }).problems, []);
});

test('front matter before a later fence is still a raw brief with an inner fence', () => {
    const source = brief('', '## Issue o/r#1\n```markdown\nx\n```\n');
    const comment = '<!-- imp-brief -->\n' + source.trim() + '\n';
    assert.equal(extractBriefInput(comment).error, 'raw marker-first brief contains a triple fence; use ~~~ for inner code or wrap the whole brief');
});

test('a raw marker-first brief with an inner triple fence fails closed', () => {
    const source = brief('', '## Issue o/r#1\n```js\nx\n```\n');
    const comment = '<!-- imp-brief -->\n' + source.trim() + '\n';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, 'raw marker-first brief contains a triple fence; use ~~~ for inner code or wrap the whole brief');
    const r = lintBrief(comment);
    assert.deepEqual(r.problems, [extracted.error]);
});

test('a nested triple fence inside a fenced marker-first comment fails closed', () => {
    const source = brief('', '## Issue o/r#1\n```js\nx\n```\n');
    const comment = '<!-- imp-brief -->\n' + '\x60\x60\x60markdown\n' + source.trim() + '\n' + '\x60\x60\x60\n';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, 'nested triple fence inside outer marker-first fence; use ~~~ for inner code');
    const r = lintBrief(comment);
    assert.deepEqual(r.problems, [extracted.error]);
});

test('content after a fenced marker-first brief is rejected', () => {
    const source = brief('').trim();
    const comment = '<!-- imp-brief -->\n' + '\x60\x60\x60markdown\n' + source + '\n' + '\x60\x60\x60\nextra';
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, 'content after outer fence');
    const r = lintBrief(comment);
    assert.deepEqual(r.problems, ['content after outer fence']);
});

test('an unclosed marker-first outer fence gets a precise diagnostic', () => {
    const source = brief('').trim();
    const comment = '<!-- imp-brief -->\n' + '\x60\x60\x60markdown\n' + source;
    const extracted = extractBriefInput(comment);
    assert.equal(extracted.error, 'unclosed outer fence');
    const r = lintBrief(comment);
    assert.deepEqual(r.problems, ['unclosed outer fence']);
    assert.equal(r.meta.repo, undefined);
});

test('allow entries the gate always denies or can never match are problems (motor-pool#148 .env.example)', () => {
    const mk = (allow) => lintBrief(brief('').replace('allow: a.js, a.test.js', `allow: ${allow}`)).problems.join('|');
    assert.match(mk('a.js, .env.example'), /always denied.*\.env\.example/);
    assert.match(mk('package-lock.json'), /always denied/);
    assert.match(mk('.github/workflows/x.yml'), /always denied/);
    assert.match(mk('./src/'), /repo-relative/);
    assert.match(mk('src\\\\a.js'), /repo-relative/);
    assert.match(mk('src/**/*.js'), /glob/);
    assert.equal(mk('src/, docs/CHANGELOG.md'), '');
});

test('an unparseable depends: is a problem, a note after ; is fine', () => {
    assert.match(lintBrief(brief('depends: "fire#444"\n')).problems.join(), /no parseable reference/);
    assert.deepEqual(lintBrief(brief('depends: #444; must merge first\n')).problems, []);
});
