import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const templatePath = 'repo-health/templates/risk-guard.yml';
const content = fs.readFileSync(templatePath, 'utf8').replace(/\r/g, '');

describe('risk-guard.yml template', () => {
  test('uses pull_request_target trigger', () => {
    assert.match(content, /on:[\s\S]*?pull_request_target:/, 'missing pull_request_target trigger');
  });

  test('includes edited event alongside opened/synchronize/reopened/labeled/unlabeled', () => {
    const typesSection = content.match(/pull_request_target:[\s\S]*?types:\s*\[([^\]]+)\]/);
    assert.ok(typesSection, 'missing types array under pull_request_target');
    const types = typesSection[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    const required = ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled', 'edited'];
    for (const evt of required) {
      assert.ok(types.includes(evt), `missing event type: ${evt}`);
    }
  });

  test('has least-privilege permissions (contents: read, pull-requests: read)', () => {
    assert.match(content, /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/m, 'missing least-privilege permissions');
  });

  test('job calls reusable workflow with SHA-pinned reference (or placeholder)', () => {
    assert.match(content, /uses:\s*nitsuah\/\.github\/\.github\/workflows\/risk-guard\.yml@(REPLACE_WITH_KIT_SHA|[0-9a-f]{40})/, 'uses must reference nitsuah/.github risk-guard.yml with SHA or placeholder');
  });

  test('job permissions mirror least-privilege', () => {
    assert.match(content, /jobs:[\s\S]*?guard:[\s\S]*?permissions:[\s\S]*?contents:\s*read[\s\S]*?pull-requests:\s*read/, 'job permissions must mirror least-privilege');
  });

  test('rejects inline PR-head checkout (no uses: actions/checkout or similar)', () => {
    assert.doesNotMatch(content, /uses:\s*actions\/checkout/, 'caller template must not use actions/checkout');
  });

  test('rejects shell run: step in caller template', () => {
    assert.doesNotMatch(content, /^\s*run:/m, 'caller template must not define run steps');
  });
});
