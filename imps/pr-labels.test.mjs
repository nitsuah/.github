import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImpPrLabels } from './pr-labels.mjs';

test('imp PR labels always include imp, no-changelog, and risk', () => {
    assert.deepEqual(buildImpPrLabels('low', 'risk:low', 'imp:needs-human'), [
        'imp',
        'no-changelog',
        'risk:low',
    ]);
});

test('high-risk imp PRs also require human review', () => {
    assert.deepEqual(buildImpPrLabels('high', 'risk:high', 'imp:needs-human'), [
        'imp',
        'no-changelog',
        'risk:high',
        'imp:needs-human',
    ]);
});
