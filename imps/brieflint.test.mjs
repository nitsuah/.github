// node --test imps/brieflint.test.mjs   (no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLines, lintBrief } from './brieflint.mjs';

const brief = (front, body = '## Issue o/r#1\nDo the thing.\n') => `---\nrepo: r\nissue: 1\ntest: docker run x --config config/v.mjs y\nmaxLines: 100\nallow: a.js, a.test.js\n${front}---\n${body}`;
const code = (n) => `~~~js\n${'x();\n'.repeat(n)}~~~\n`;

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
