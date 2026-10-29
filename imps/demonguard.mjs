#!/usr/bin/env node
// demonguard: the deterministic watch over imp PRs that linger.
//   node demonguard.mjs [--dry-run] [--min-minutes 30]
//
// `imp.mjs pr` decides about auto-merge once, at the moment it opens a PR. Anything not ready then (CI still
// running, trust not earned, a reviewer that never answered) just sat open until it ate the open-PR cap and
// stalled dispatch. Each tick this looks at every open imp PR, picks ONE action with a pure function
// (assessPr), and does only what the existing rules already allow:
//   merge                squash-merge when the imp review approved, checks are green and trust is earned
//   rereview             rerun the 9router reviewer when no review was recorded
//   dismiss-stale-review drop a bot's CHANGES_REQUESTED once none of its threads is open any more
//   owner                everything is fine but trust is not earned: surface it, never merge
//   needs-human          stuck for a day (red CI, conflicts, a non-approve review): label the PR and say so
//   wait / wait-fix      too young, or checks pending / red and the fix-sweep is on it
// Kill switch: IMPS_DEMONGUARD=0 (the dispatcher skips it). It never uses --admin.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS } from './defaults.mjs';
import { evaluateChecks, cleanMergesForRepo, fetchGithubSeedTrust, mayAutoMerge } from './checks.mjs';
import { HOME, rows, update, sh, kitSha, machineName } from './runner.mjs';

export const MIN_AGE_MS = 30 * 60_000;
export const HUMAN_AFTER_MS = 24 * 3600_000;

/**
 * Decide what to do with one open imp PR. Pure: every input is passed in.
 * @param {object} p
 * @param {number} p.now
 * @param {string} p.createdAt          PR creation time
 * @param {string} [p.state]            OPEN | MERGED | CLOSED
 * @param {string} [p.mergeState]       GitHub mergeStateStatus
 * @param {object[]} [p.checks]         [{ name, state }] as `gh pr checks --json name,state`
 * @param {string} [p.verdict]          the imp review verdict recorded in the ledger
 * @param {{ok:boolean, reason:string}} [p.trust]  mayAutoMerge() result for this repo
 * @param {boolean} [p.botChangesRequested]  a bot's latest review is CHANGES_REQUESTED
 * @param {number} [p.openThreads]      unresolved review threads
 */
export function assessPr({ now = Date.now(), createdAt, state = 'OPEN', mergeState = '', checks = [], verdict, trust = { ok: false, reason: 'trust unknown' }, botChangesRequested = false, openThreads = 0, minAgeMs = MIN_AGE_MS, humanAfterMs = HUMAN_AFTER_MS } = {}) {
    if (state !== 'OPEN') return { action: 'none', reason: `PR is ${state.toLowerCase()}` };
    const age = now - Date.parse(createdAt || '') || 0;
    const old = age >= humanAfterMs;
    if (age < minAgeMs) return { action: 'wait', reason: 'young; give review and CI time' };
    if (mergeState === 'DIRTY') return old ? { action: 'needs-human', reason: 'merge conflicts for over a day' } : { action: 'wait-fix', reason: 'merge conflicts' };
    if (botChangesRequested && openThreads === 0) return { action: 'dismiss-stale-review', reason: 'a bot review still requests changes but none of its threads is open' };
    if (!verdict) return { action: 'rereview', reason: 'no imp review is recorded' };
    if (verdict !== 'approve') return old ? { action: 'needs-human', reason: `review ${verdict} for over a day` } : { action: 'wait-fix', reason: `review was ${verdict}; the fix-sweep handles it` };
    const ev = evaluateChecks(checks);
    if (!ev.green) return old ? { action: 'needs-human', reason: `checks not green for over a day (${ev.reason})` } : { action: 'wait', reason: `checks: ${ev.reason}` };
    if (botChangesRequested) return { action: 'wait', reason: 'a bot still requests changes and has open threads' };
    if (!trust.ok) return { action: 'owner', reason: trust.reason };
    return { action: 'merge', reason: trust.reason };
}

const gh = (args) => sh('gh', args);
const ghJson = (args) => { const r = gh(args); try { return JSON.parse(r.out || 'null'); } catch { return null; } };

function openThreadCount(slug, number) {
    const [owner, name] = slug.split('/');
    const q = `query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){reviewThreads(first:100){nodes{isResolved}}}}}`;
    const r = ghJson(['api', 'graphql', '-f', `query=${q}`]);
    const nodes = r?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(nodes) ? nodes.filter((n) => !n.isResolved).length : 0;
}

function botReviews(reviews = []) {
    const latest = new Map();
    for (const r of reviews) {
        const login = r.author?.login || '';
        if (/bot\]?$|coderabbit/i.test(login)) latest.set(login, r);
    }
    return [...latest.values()];
}

async function main() {
    const { values: o } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, 'min-minutes': { type: 'string', default: '30' } } });
    const dry = o['dry-run'];
    const minAgeMs = Number(o['min-minutes']) * 60_000;
    const cfg = existsSync(join(HOME, 'config.json')) ? JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')) : {};
    const threshold = Number(cfg.autoMergeTrust ?? DEFAULTS.autoMergeTrust);
    const ledger = rows();
    const open = ledger.filter((r) => r.pr && (!r.outcome || r.outcome === 'open')).slice(-30);
    const summary = { assessed: 0, actions: {}, owner: [], humans: [] };
    const out = [];
    for (const r of open) {
        const m = r.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!m) continue;
        const [, slug, num] = m;
        const pr = ghJson(['pr', 'view', r.pr, '--json', 'state,mergeStateStatus,headRefOid,createdAt,reviews']);
        if (!pr) continue; // GitHub unreachable this tick: try again next one
        const checks = ghJson(['pr', 'checks', r.pr, '--json', 'name,state']) || [];
        const bots = botReviews(pr.reviews);
        const botChangesRequested = bots.some((b) => b.state === 'CHANGES_REQUESTED');
        const openThreads = botChangesRequested ? openThreadCount(slug, num) : 0;
        const verdict = r.review?.verdict;
        const ledgerCount = cleanMergesForRepo(ledger, r.repo);
        let githubCount = 0, githubSeedError = null;
        if (!(ledgerCount >= threshold)) {
            const seed = fetchGithubSeedTrust(slug, { run: (args) => sh('gh', args), need: threshold });
            githubCount = seed.count;
            githubSeedError = seed.error;
        }
        const trust = mayAutoMerge({ repo: r.repo, reviewVerdict: verdict, rows: ledger, trust: threshold, githubCount, githubSeedError });
        const a = assessPr({ createdAt: pr.createdAt, state: pr.state, mergeState: pr.mergeStateStatus, checks, verdict, trust, botChangesRequested, openThreads, minAgeMs });
        summary.assessed++;
        summary.actions[a.action] = (summary.actions[a.action] || 0) + 1;
        const tag = `${r.repo}#${num}`;
        if (a.action === 'owner') summary.owner.push(r.pr);
        if (a.action === 'needs-human') summary.humans.push(r.pr);
        out.push(`${tag} ${a.action}: ${a.reason}`);
        if (dry || ['none', 'wait', 'wait-fix', 'owner'].includes(a.action)) continue;

        if (a.action === 'dismiss-stale-review') {
            // gh pr view gives GraphQL node ids; the dismissal endpoint wants the numeric REST id.
            const rest = ghJson(['api', `repos/${slug}/pulls/${num}/reviews`, '--paginate']) || [];
            for (const b of rest.filter((x) => /bot\]?$|coderabbit/i.test(x.user?.login || '') && x.state === 'CHANGES_REQUESTED')) {
                gh(['api', '-X', 'PUT', `repos/${slug}/pulls/${num}/reviews/${b.id}/dismissals`, '-f', 'message=Stale: none of this review\'s threads is open any more (demonguard).']);
            }
        } else if (a.action === 'rereview') {
            sh(process.execPath, [fileURLToPath(new URL('./review.mjs', import.meta.url)), r.id]);
        } else if (a.action === 'merge') {
            const merge = gh(['pr', 'merge', r.pr, '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid]);
            if (!merge.code) update(r.id, { outcome: 'merged', mergedAt: new Date().toISOString(), autoMerged: true, mergedBy: 'demonguard' });
            else out.push(`${tag} merge refused: ${String(merge.err).slice(0, 120)}`);
        } else if (a.action === 'needs-human') {
            gh(['pr', 'edit', r.pr, '--add-label', 'imp:needs-human']);
        }
    }
    const line = { at: new Date().toISOString(), machine: machineName(), kitSha: kitSha(), event: 'demonguard', dry, ...summary };
    console.log(out.join('\n'));
    console.log(JSON.stringify(line));
    if (!dry && summary.assessed) appendFileSync(join(HOME, 'dispatch.jsonl'), JSON.stringify(line) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
