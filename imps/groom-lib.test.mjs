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
    fenceFrontMatter,
    alreadyGroomed,
    DRAFT_MARK,
    NEEDS_BRIEF_LABEL,
    runGroom,
    postGroomed,
} from './groom-lib.mjs';
import { DEFAULTS } from './defaults.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseGroomConfig parses valid JSON', () => {
    const cfg = parseGroomConfig('{"groom": true, "groomDailyIssueCap": 5}');
    assert.equal(cfg.groom, true);
    assert.equal(cfg.groomDailyIssueCap, 5);
});

test('parseGroomConfig returns empty object for invalid JSON', () => {
    const cfg = parseGroomConfig('not json');
    assert.deepEqual(cfg, {});
});

test('groomEnabled is opt-in: off by default, on only with IMPS_GROOM=1', () => {
    assert.equal(groomEnabled(), false);
    assert.equal(groomEnabled({}, {}), false);
    assert.equal(groomEnabled({ groom: true }, {}), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: '0' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: 'false' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: 'true' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: '' }), false);
    assert.equal(groomEnabled({}, { IMPS_GROOM: '1' }), true);
    assert.equal(groomEnabled({ groom: true }, { IMPS_GROOM: '1' }), true);
});

test('groomEnabled: config.groom=false is a kill switch even with IMPS_GROOM=1', () => {
    assert.equal(groomEnabled({ groom: false }, { IMPS_GROOM: '1' }), false);
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
const comments2 = [{ body: briefBody, user: { login: 'nitsuah' } }];
    assert.equal(alreadyGroomed(comments2), true);
    const untrustedBrief = [{ body: briefBody, user: { login: 'random-user' } }];
    assert.equal(alreadyGroomed(untrustedBrief), false);
});

test('runGroom attempts each issue once even when search leaks other repos', async () => {
    process.env.IMPS_HOME = mkdtempSync(join(tmpdir(), 'groom-'));
    const leak = [
        { repository: { name: 'repo-a' }, number: 1, title: 'Bug', body: '', labels: [{ name: 'bug' }], createdAt: '', author: { login: 'nitsuah' } },
        { repository: { name: 'repo-b' }, number: 2, title: 'Bug', body: '', labels: [{ name: 'bug' }], createdAt: '', author: { login: 'nitsuah' } },
    ];
    const ghJson = (args) => {
        if (args[0] === 'search' && args[1] === 'issues') return leak; // same results for every repo query
        if (args[0] === 'issue' && args[1] === 'view') return { comments: [] };
        return [];
    };
    const gh = () => { throw new Error('no network in tests'); };
    // Port 9 refuses at once, so each draft fails fast and shows up once in errors per attempt.
    const results = await runGroom({
        gh, ghJson, owner: 'nitsuah', repos: { 'repo-a': {}, 'repo-b': {}, 'repo-c': {} },
        router: { baseUrl: 'http://127.0.0.1:9/v1', key: 'k' }, dryRun: true, dailyCap: 10, searchPaceMs: 0,
    });
    const tried = results.errors.filter((e) => e.startsWith('draft failed for')).map((e) => e.split(' ')[3].replace(/:$/, ''));
    assert.deepEqual(tried.sort(), ['repo-a#1', 'repo-b#2']);
    assert.equal(results.candidates, 2);
});

test('postGroomed: comment ok, label ok -> ok true, no DELETE', async () => {
    const calls = [];
    const gh = (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'comment') return 'https://github.com/owner/repo/issues/1#issuecomment-123456789';
        return '';
    };
    const res = await postGroomed({ gh, owner: 'owner', repo: 'repo', number: 1, commentBody: 'body', label: 'imp:ready' });
    assert.equal(res.ok, true);
    assert.deepEqual(calls.filter(c => c[0] === 'issue' && c[1] === 'comment').length, 1);
    assert.deepEqual(calls.filter(c => c[0] === 'issue' && c[1] === 'edit').length, 1);
    assert.deepEqual(calls.filter(c => c[0] === 'api' && c[1] === '-X' && c[2] === 'DELETE').length, 0);
});

test('postGroomed: comment ok, label fails once then succeeds -> ok true, label tried twice, no DELETE', async () => {
    const calls = [];
    let labelAttempt = 0;
    const gh = (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'comment') return 'https://github.com/owner/repo/issues/1#issuecomment-123456789';
        if (args[0] === 'issue' && args[1] === 'edit') {
            labelAttempt++;
            if (labelAttempt === 1) throw new Error('rate limited');
            return '';
        }
        return '';
    };
    const res = await postGroomed({ gh, owner: 'owner', repo: 'repo', number: 1, commentBody: 'body', label: 'imp:ready' });
    assert.equal(res.ok, true);
    assert.deepEqual(calls.filter(c => c[0] === 'issue' && c[1] === 'edit').length, 2);
    assert.deepEqual(calls.filter(c => c[0] === 'api' && c[1] === '-X' && c[2] === 'DELETE').length, 0);
});

test('postGroomed: comment ok, label fails twice -> ok false, DELETE called with parsed comment id', async () => {
    const calls = [];
    let labelAttempt = 0;
    const gh = (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'comment') return 'https://github.com/owner/repo/issues/1#issuecomment-123456789';
        if (args[0] === 'issue' && args[1] === 'edit') {
            labelAttempt++;
            throw new Error('rate limited');
        }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
            assert.match(args[3], /repos\/owner\/repo\/issues\/comments\/123456789$/);
            return '';
        }
        return '';
    };
    const res = await postGroomed({ gh, owner: 'owner', repo: 'repo', number: 1, commentBody: 'body', label: 'imp:ready' });
    assert.equal(res.ok, false);
    assert.match(res.error, /comment removed so the next run regrooms it/);
    assert.deepEqual(calls.filter(c => c[0] === 'issue' && c[1] === 'edit').length, 2);
    assert.deepEqual(calls.filter(c => c[0] === 'api' && c[1] === '-X' && c[2] === 'DELETE').length, 1);
});

test('postGroomed: comment ok, label fails twice, DELETE throws -> ok false, error mentions removal failed', async () => {
    const calls = [];
    let labelAttempt = 0;
    let deleteAttempt = 0;
    const gh = (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'comment') return 'https://github.com/owner/repo/issues/1#issuecomment-123456789';
        if (args[0] === 'issue' && args[1] === 'edit') {
            labelAttempt++;
            throw new Error('rate limited');
        }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
            deleteAttempt++;
            throw new Error('not found');
        }
        return '';
    };
    const res = await postGroomed({ gh, owner: 'owner', repo: 'repo', number: 1, commentBody: 'body', label: 'imp:ready' });
    assert.equal(res.ok, false);
    assert.match(res.error, /comment removal failed too/);
    assert.deepEqual(calls.filter(c => c[0] === 'issue' && c[1] === 'edit').length, 2);
    assert.deepEqual(calls.filter(c => c[0] === 'api' && c[1] === '-X' && c[2] === 'DELETE').length, 1);
});

test('clipLines keeps whole lines and marks what it dropped', async () => {
    const { clipLines } = await import('./groom-lib.mjs');
    assert.equal(clipLines('a/1.js\nb/2.js', 100), 'a/1.js\nb/2.js');
    const out = clipLines('src/aaaa.js\nsrc/bbbb.js\nsrc/cccc.js', 30);
    assert.equal(out, 'src/aaaa.js\n… (2 more lines)');
    // Never longer than max, marker included, and only whole lines survive.
    const many = Array.from({ length: 500 }, (_, i) => `src/dir${i}/file${i}.js`).join('\n');
    for (const max of [30, 100, 999, 6000]) {
        const c = clipLines(many, max);
        assert.ok(c.length <= max, `${c.length} > ${max}`);
        const body = c.split('\n').slice(0, -1);
        for (const l of body) assert.match(l, /^src\/dir\d+\/file\d+\.js$/);
        assert.match(c, /more lines\)$/);
    }
});

test('fenceFrontMatter wraps an unfenced leading key run so lintBrief sees the fields', () => {
    const raw = 'repo: vhs\nissue: 244\ntest: docker run --rm img sh -c "npm test"\nmaxLines: 80\nallow: src/,tests/\n\n## Issue nitsuah/vhs#244\n## The fix\nx';
    const fenced = fenceFrontMatter(raw);
    assert.ok(fenced.startsWith('---\nrepo: vhs\n'));
    assert.match(fenced, /allow: src\/,tests\/\n---\n\n## Issue/);
    assert.equal(lintBrief(fenced, 180).ok, true);
    assert.equal(lintBrief(raw, 180).ok, false); // the failure groom.log showed
});

test('fenceFrontMatter drops a lone closing fence and leaves good or non-brief text alone', () => {
    assert.equal(fenceFrontMatter('repo: a\nissue: 1\n---\nbody'), '---\nrepo: a\nissue: 1\n---\nbody');
    const good = '---\nrepo: a\nissue: 1\n---\nbody';
    assert.equal(fenceFrontMatter(good), good);
    assert.equal(fenceFrontMatter('Here is the brief:\nrepo: a'), 'Here is the brief:\nrepo: a');
    assert.equal(fenceFrontMatter('repo: a\n\nbody'), 'repo: a\n\nbody'); // a single key is not a header
});
