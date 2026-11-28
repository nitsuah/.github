import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMergedByAgentTrailer, mergedByAgentCommitBody } from './merge-attribution.mjs';

test('formats the exact imp machine trailer', () => {
    assert.equal(formatMergedByAgentTrailer('build-box-01'), 'Merged-by-agent: imp-build-box-01');
    assert.equal(formatMergedByAgentTrailer(' YOKAI '), 'Merged-by-agent: imp-YOKAI');
});

test('missing machine identity cannot produce an attribution trailer or merge body', () => {
    for (const machine of [undefined, null, '', '   ']) {
        assert.equal(formatMergedByAgentTrailer(machine), null);
        assert.equal(mergedByAgentCommitBody([], machine), null);
    }
});

test('squash body preserves commit headlines and unique co-author trailers', () => {
    const body = mergedByAgentCommitBody([
        { messageHeadline: 'first change', messageBody: 'Details\nCo-Authored-By: Agent <agent@example.com>' },
        { messageHeadline: 'second change', messageBody: 'Co-Authored-By: Agent <agent@example.com>\nCo-Authored-By: Human <human@example.com>' },
    ], 'build-box');
    assert.match(body, /\* first change/);
    assert.match(body, /\* second change/);
    assert.equal((body.match(/Co-Authored-By:/g) || []).length, 2);
    assert.match(body, /Merged-by-agent: imp-build-box$/);
});
