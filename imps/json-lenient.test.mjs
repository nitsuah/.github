// node --test imps/json-lenient.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLenient, parseReview } from './lib.mjs';
import { parseThreadJudgement } from './bugbot-lib.mjs';

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

test('parseJsonLenient: strict JSON passes through unchanged', () => {
    assert.deepEqual(parseJsonLenient('{"a":"b\\nc","n":1}'), { a: `b${NL}c`, n: 1 });
});

test('parseJsonLenient: raw newlines and tabs inside strings are escaped (bb-mcp#189)', () => {
    const raw = `{"verdict":"comment","summary":"line one${NL}line two${TAB}tabbed","findings":[]}`;
    assert.throws(() => JSON.parse(raw), /control character/i);
    assert.deepEqual(parseJsonLenient(raw), { verdict: 'comment', summary: `line one${NL}line two${TAB}tabbed`, findings: [] });
});

test('parseJsonLenient: whitespace between tokens is left alone, and real garbage still throws', () => {
    assert.deepEqual(parseJsonLenient(`{${NL}  "a": 1${NL}}`), { a: 1 });
    assert.throws(() => parseJsonLenient('{"a": }'));
});

test('parseReview and parseThreadJudgement accept a block with a raw newline in a string', () => {
    const review = `x${NL}\`\`\`json${NL}{"verdict":"approve","summary":"ok${NL}fine","findings":[]}${NL}\`\`\``;
    assert.equal(parseReview(review).verdict, 'approve');
    const judge = `\`\`\`json${NL}{"decision":"accept","reply":"fixed${NL}in abc"}${NL}\`\`\``;
    assert.equal(parseThreadJudgement(judge).decision, 'accept');
});
