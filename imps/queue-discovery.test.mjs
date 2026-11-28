import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasExplicitOwnerArg, discoverQueueCandidates } from './queue-discovery.mjs';

test('detects both supported --owner argument forms', () => {
    assert.equal(hasExplicitOwnerArg(['--owner', 'Nitsuah-Labs']), true);
    assert.equal(hasExplicitOwnerArg(['--owner=Nitsuah-Labs']), true);
    assert.equal(hasExplicitOwnerArg(['--max', '3']), false);
});

test('multi-owner queue discovery deduplicates candidates and applies case-insensitive exclusions', () => {
    const rows = [
        { searchedOwner: 'nitsuah', repository: { name: 'fire', owner: { login: 'nitsuah' } }, number: 10, title: 'Fire', labels: [{ name: 'imp:ready' }] },
        { searchedOwner: 'nitsuah', repository: { name: 'fire', owner: { login: 'Nitsuah' } }, number: 10, title: 'Duplicate', labels: [{ name: 'imp:ready' }] },
        { searchedOwner: 'Nitsuah-Labs', repository: { name: 'deployer', owner: { login: 'Nitsuah-Labs' } }, number: 2, labels: [{ name: 'imp:ready' }] },
        { searchedOwner: 'Nitsuah-Labs', repository: { name: 'tooling', owner: { login: 'Nitsuah-Labs' } }, number: 3, labels: [{ name: 'imp:ready' }] },
        { searchedOwner: 'Nitsuah-Labs', repository: { name: 'tooling', owner: { login: 'Nitsuah-Labs' } }, number: 4, labels: [{ name: 'imp:working' }] },
    ];
    const found = discoverQueueCandidates(rows, ['NITSUAH-LABS/DEPLOYER']);
    assert.deepEqual(found.map(({ owner, repo, number }) => [owner, repo, number]), [
        ['nitsuah', 'fire', 10],
        ['Nitsuah-Labs', 'Nitsuah-Labs/tooling', 3],
    ]);
});
