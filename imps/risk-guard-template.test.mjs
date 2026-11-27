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

    test('always runs the trusted Actions guard and opts into the App check only when configured', () => {
        assert.match(content, /guard:[\\s\\S]*?uses: nitsuah\\/\\.github\\/\\.github\\/workflows\\/risk-guard\\.yml@REPLACE_WITH_KIT_SHA/);
        assert.match(content, /app:[\\s\\S]*?if: vars\\.RISK_GUARD_APP_CLIENT_ID != ''[\\s\\S]*?uses: nitsuah\\/\\.github\\/\\.github\\/workflows\\/risk-guard-app\\.yml@REPLACE_WITH_KIT_SHA/);
    });

    test('passes only the App credentials to the opt-in reusable workflow', () => {
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
        assert.match(reusable, /RISK_GUARD_APP_PRIVATE_KEY/);\n        assert.doesNotMatch(reusable, /issues: read/);
        assert.ok(reusable.includes('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'));
        assert.match(reusable, /permission-checks: write/);
        assert.match(reusable, /GUARD_OWNERS: nitsuah/);
        assert.match(reusable, /CHECK_MODE: start/);
        assert.match(reusable, /CHECK_MODE: finish/);\n        assert.match(reusable, /Complete the dedicated App check run \\(success\\)[\\s\\S]*?CHECK_CONCLUSION: success/);\n        assert.match(reusable, /Complete the dedicated App check run \\(failure\\)[\\s\\S]*?CHECK_CONCLUSION: failure/);\n        assert.doesNotMatch(reusable, /CHECK_CONCLUSION: \\$\\{\\{/);
        assert.ok(reusable.includes('node .risk-guard-kit/imps/ci-guard.mjs'));
    });
});
