import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = readFileSync('repo-health/templates/risk-guard.yml', 'utf8').replace(/\r/g, '');
const reusable = readFileSync('.github/workflows/risk-guard-app.yml', 'utf8').replace(/\r/g, '');

describe('App-backed risk-guard caller template', () => {
    test('runs from pull_request_target and reevaluates owner-label changes', () => {
        assert.match(content, /pull_request_target:/);
        assert.match(content, /types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]/);
    });

    test('calls the pinned shared App-backed workflow and passes only required credentials', () => {
        assert.match(content, /uses: nitsuah\/\.github\/\.github\/workflows\/risk-guard-app\.yml@REPLACE_WITH_KIT_SHA/);
        assert.match(content, /app_client_id: \$\{\{ vars\.RISK_GUARD_APP_CLIENT_ID \}\}/);
        assert.match(content, /RISK_GUARD_APP_PRIVATE_KEY: \$\{\{ secrets\.RISK_GUARD_APP_PRIVATE_KEY \}\}/);
        assert.doesNotMatch(content, /secrets:\s*inherit/);
    });

    test('uses read-only Actions token permissions and never checks out PR code', () => {
        assert.match(content, /contents: read/);
        assert.match(content, /issues: read/);
        assert.match(content, /pull-requests: read/);
        assert.doesNotMatch(content, /uses: actions\/checkout/);
        assert.doesNotMatch(content, /^\s*run:/m);
    });
    test('reusable workflow creates the required check with the dedicated App identity', () => {
        assert.match(reusable, /workflow_call:/);
        assert.match(reusable, /RISK_GUARD_APP_PRIVATE_KEY/);
        assert.ok(reusable.includes('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'));
        assert.match(reusable, /permission-checks: write/);
        assert.match(reusable, /GUARD_OWNERS: nitsuah/);
        assert.match(reusable, /CHECK_MODE: start/);
        assert.match(reusable, /CHECK_MODE: finish/);
        assert.ok(reusable.includes('node .risk-guard-kit/imps/ci-guard.mjs'));
    });

});
