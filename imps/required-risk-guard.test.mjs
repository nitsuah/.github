import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/required-risk-guard.yml', 'utf8').replace(/\r/g, '');

test('required risk guard is a ruleset-owned pull_request workflow', () => {
    assert.match(workflow, /^name: Required risk guard\n/m);
    assert.match(workflow, /^on:\n  pull_request:\n/m);
    assert.match(workflow, /types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]/);
    assert.doesNotMatch(workflow, /^  pull_request_target:/m);
});

test('workflow is read-only and evaluates PR metadata without checking out PR code', () => {
    assert.match(workflow, /if: github\\.repository != 'nitsuah\\/\\.github'/);
    assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
    assert.match(workflow, /repository: nitsuah\/\.github/);
    assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /GUARD_REPO: \$\{\{ github\.event\.pull_request\.base\.repo\.full_name \}\}/);
    assert.match(workflow, /node \.risk-guard-kit\/imps\/ci-guard\.mjs/);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
    assert.doesNotMatch(workflow, /pull_request\/merge/);
});

test('the workflow never calls an unpinned third-party action', () => {
    for (const match of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
        assert.match(match[1], /@[0-9a-f]{40}$/);
    }
});
