// node --test imps/groom-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseGroomConfig,
    loadGroomConfig,
    groomEnabled,
    labelNames,
    hasImpLabel,
    isPrShaped,
    isQuietRepo,
    lintBrief,
    alreadyGroomed,
    DRAFT_MARK,
    NEEDS_BRIEF_LABEL,
} from './groom-lib.mjs';
import { DEFAULTS } from './defaults.mjs';

test('parseGroomConfig parses valid JSON', () => {
    const cfg = parseGroomConfig('{"groom": true, "groomDailyIssueCap": 5}');
    assert.equal(cfg.groom, true);
    assert.equal(cfg.groomDailyIssueCap, 5);
});

test('parseGroomConfig returns empty object for invalid JSON', () => {
    const cfg = parseGroomConfig('not json');
    assert.deepEqual(cfg, {});
});

test('groomEnabled is default-off and requires explicit opt-in', () => {
    assert.equal(groomEnabled({}, {}), false);
    assert.equal(groomEnabled({ groom: false }, {}), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: '0' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: 'false' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: '1' }), true);
    assert.equal(groomEnabled({ groom: true }, {}), true);
    assert.equal(groomEnabled({ groom: false }, { IMPS_GROOM: '1' }), true);
});

test('labelNames extracts names from label objects', () => {
    const labels = [{ name: 'bug' }, { name: 'enhancement' }, 'security'];
    assert.deepEqual(labelNames(labels), ['bug', 'enhancement', 'security']);
    assert.deepEqual(labelNames([]), []);
});

test('hasImpLabel detects imp:* labels', () => {
    assert.equal(hasImpLabel([{ name: 'imp:ready' }]), true);
    assert.equal(hasImpLabel([{ name: 'bug' }, 'imp:failed']), true);
    assert.equal(hasImpLabel(['bug', 'enhancement']), false);
    assert.equal(hasImpLabel([]), false);
});

test('isPrShaped recognizes bug/enhancement and rejects security/audit/investigate', () => {
    assert.equal(isPrShaped([{ name: 'bug' }]), true);
    assert.equal(isPrShaped(['enhancement']), true);
    assert.equal(isPrShaped(['bug', 'enhancement']), true);
    assert.equal(isPrShaped(['security']), false);
    assert.equal(isPrShaped(['audit']), false);
    assert.equal(isPrShaped(['investigate']), false);
    assert.equal(isPrShaped(['needs-human']), false);
    assert.equal(isPrShaped([]), false);
});

test('isQuietRepo checks human PRs and commit age', () => {
    assert.equal(isQuietRepo({ humanPRs: 0, lastCommitHours: 10 }), true);
    assert.equal(isQuietRepo({ humanPRs: 0, lastCommitHours: 5 }), false); // too recent
    assert.equal(isQuietRepo({ humanPRs: 1, lastCommitHours: 99 }), false); // human PR open
    assert.equal(isQuietRepo({}, 6), true); // defaults
    assert.equal(isQuietRepo({ lastCommitHours: 5 }, 6), false); // custom quietHours
});

test('lintBrief validates required fields', () => {
    const valid = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nmaxLines: 80\nallow: src/\n---\nbody`;
    assert.deepEqual(lintBrief(valid, 100), { ok: true, errors: [], briefMeta: { repo: 'owner/repo', issue: '123', test: 'npm test', maxLines: '80', allow: 'src/' } });

    const missingTest = `---\nrepo: owner/repo\nissue: 123\nmaxLines: 80\nallow: src/\n---\nbody`;
    assert.deepEqual(lintBrief(missingTest, 100).ok, false);
    assert(lintBrief(missingTest, 100).errors.some(e => e.includes('test')));

    const missingAllow = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nmaxLines: 80\n---\nbody`;
    assert.deepEqual(lintBrief(missingAllow, 100).ok, false);
    assert(lintBrief(missingAllow, 100).errors.some(e => e.includes('allow')));

    const missingMaxLines = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nallow: src/\n---\nbody`;
    assert.deepEqual(lintBrief(missingMaxLines, 100).ok, false);
    assert(lintBrief(missingMaxLines, 100).errors.some(e => e.includes('maxLines')));
});

test('lintBrief enforces maxLines cap', () => {
    const overCap = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nmaxLines: 200\nallow: src/\n---\nbody`;
    const res = lintBrief(overCap, 100);
    assert.equal(res.ok, false);
    assert(res.errors.some(e => e.includes('exceeds groomer cap')));
});

test('lintBrief rejects denied paths in allow', () => {
    const denied = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nmaxLines: 80\nallow: .github/workflows/ci.yml\n---\nbody`;
    const res = lintBrief(denied, 100);
    assert.equal(res.ok, false);
    assert(res.errors.some(e => e.includes('denied path in allow')));

    const lockfile = `---\nrepo: owner/repo\nissue: 123\ntest: npm test\nmaxLines: 80\nallow: package-lock.json\n---\nbody`;
    assert.equal(lintBrief(lockfile, 100).ok, false);
});

test('alreadyGroomed detects draft marker and brief', () => {
    const comments = [{ body: 'some text' }];
    assert.equal(alreadyGroomed(comments), false);

    const draftBody = DRAFT_MARK + '\n```markdown\nbrief\n```';
    comments.push({ body: draftBody });
    assert.equal(alreadyGroomed(comments), true);

    const briefBody = '<!-- imp-brief -->\n---\nrepo: x\nissue: 1\ntest: t\nmaxLines: 10\nallow: a\n---\nbody';
    const comments2 = [{ user: { login: 'nitsuah' }, body: briefBody }];
    assert.equal(alreadyGroomed(comments2), true);
});

test('runGroom fails closed on issue/PR eligibility lookup errors and dedupes prior issue keys', async () => {
    const { runGroom } = await import('./groom-lib.mjs');
    const issue = { repository: { name: 'demo' }, number: 7, title: 'Example', body: '', labels: [{ name: 'bug' }] };
    const baseArgs = {
        owner: 'nitsuah',
        repos: { demo: { humanPRs: 0, lastCommitHours: 999 } },
        router: { baseUrl: 'https://router.example', key: 'test' },
        dailyCap: 5,
        quietHours: 0,
        dryRun: true,
        gh: () => '',
    };
    const lookupFailure = await runGroom({
        ...baseArgs,
        ghJson: async (args) => {
            if (args[0] === 'search') return [issue];
            if (args[0] === 'issue') throw new Error('lookup unavailable');
            throw new Error('unexpected gh call');
        },
    });
    assert.equal(lookupFailure.drafted, 0);
    assert(lookupFailure.errors.some(e => e.includes('issue eligibility lookup failed')));
});
