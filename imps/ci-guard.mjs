#!/usr/bin/env node
// The CI half of the risk controls, run by .github/workflows/risk-guard.yml on a
// caller's pull request. It reads the PR through the API and never checks out or
// runs the PR's code. Rules: imps/STANDARD.md § Risk controls.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDocPath } from './lib.mjs';
import { prRisk, fetchPrPaths, fetchAckEvents, ownerAcknowledged, RISK_ACK_LABEL } from './checks.mjs';

export const NO_CHANGELOG_LABEL = 'no-changelog';
// The root CHANGELOG.md, or docs/CHANGELOG.md for repos that keep it there (most of the fleet).
const CHANGELOG = /^(docs\/)?CHANGELOG\.md$/i;

/**
 * Validate that a changelog patch adds a net-new, non-empty Markdown list entry.
 * Counts added and removed list-item lines; net added must be > 0.
 * Heading-only additions, one-for-one replacements, deleted files, or unavailable patches fail.
 * @param {string|null} patch - The unified diff patch for CHANGELOG.md or docs/CHANGELOG.md
 * @returns {boolean} true if valid, false otherwise
 */
export function validateChangelogPatch(patch) {
    if (!patch || typeof patch !== 'string' || !patch.trim()) return false;

    // Parse unified diff: look for lines starting with + or - (not +++ or --- file headers)
    const lines = patch.split('\n');
    let addedListItems = 0;
    let removedListItems = 0;
    let inHunk = false;

    for (const line of lines) {
        // Detect hunk header
        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;

        // Skip file headers (+++ b/CHANGELOG.md, --- a/CHANGELOG.md)
        if (line.startsWith('+++') || line.startsWith('---')) continue;

        // Added line
        if (line.startsWith('+')) {
            const content = line.slice(1).trimStart();
            // Check if it's a markdown list item: *, -, +, or numbered (1., 2., etc.)
            if (/^[\*\-\+]\s+\S/.test(content) || /^\d+\.\s+\S/.test(content)) {
                addedListItems++;
            }
            // Headings don't count as list items
        }
        // Removed line
        else if (line.startsWith('-')) {
            const content = line.slice(1).trimStart();
            if (/^[\*\-\+]\s+\S/.test(content) || /^\d+\.\s+\S/.test(content)) {
                removedListItems++;
            }
        }
    }

    // Net new list items must be positive
    return addedListItems - removedListItems > 0;
}

/**
 * Fetch the patch for CHANGELOG.md or docs/CHANGELOG.md from the PR.
 * Only fetches for the two supported changelog paths.
 * @param {string} slug - Repository slug (owner/repo)
 * @param {number} number - PR number
 * @param {Function} run - Function to run gh commands
 * @returns {string|null} The patch text or null if not available/error
 */
export function fetchChangelogPatch(slug, number, { run }) {
    // Get the diff for the PR, but only for CHANGELOG.md and docs/CHANGELOG.md
    const r = run([
        'api',
        `repos/${slug}/pulls/${number}`,
        '--jq',
        '.diff_url'
    ]);
    if (r.code || !r.out) return null;

    // Fetch the full diff and filter to changelog files only
    // Use gh api with accept header to get raw diff
    const diff = run([
        'api',
        `repos/${slug}/pulls/${number}`,
        '-H', 'Accept: application/vnd.github.v3.diff'
    ]);
    if (diff.code || !diff.out) return null;

    // Filter the diff to only include CHANGELOG.md and docs/CHANGELOG.md hunks
    const fullDiff = diff.out;
    const changelogDiff = filterChangelogDiff(fullDiff);
    return changelogDiff || null;
}

/**
 * Filter a unified diff to only include hunks for CHANGELOG.md or docs/CHANGELOG.md.
 * @param {string} diff - Full unified diff
 * @returns {string|null} Filtered diff or null if no changelog hunks
 */
function filterChangelogDiff(diff) {
    const lines = diff.split('\n');
    const output = [];
    let inChangelogHunk = false;
    let currentHunk = [];
    let hasChangelogContent = false;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            // Output previous hunk if it was a changelog file
            if (inChangelogHunk && hasChangelogContent) {
                output.push(...currentHunk);
            }
            // Extract filename from diff header: "diff --git a/<path> b/<path>"
            const match = line.match(/^diff --git a\/(.+) b\//);
            const filepath = match ? match[1] : '';
            inChangelogHunk = CHANGELOG.test(filepath);
            hasChangelogContent = false;
            currentHunk = [line];
        } else if (line.startsWith('@@')) {
            // New hunk within the same file
            if (inChangelogHunk && hasChangelogContent) {
                output.push(...currentHunk);
            }
            currentHunk = [line];
            hasChangelogContent = false;
        } else {
            currentHunk.push(line);
            // Track if this hunk has actual content changes (not just headers)
            if (inChangelogHunk && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
                hasChangelogContent = true;
            }
        }
    }
    // Don't forget the last hunk
    if (inChangelogHunk && hasChangelogContent) {
        output.push(...currentHunk);
    }

    return output.length ? output.join('\n') : null;
}

/** Why the PR fails the guard; an empty list passes. `error` is a failed file listing. */
export function guardFailures({
    paths = [],
    currentPaths = paths,
    error = null,
    labels = [],
    ackEvents = [],
    owners = [],
    changelogPatch = null,
} = {}) {
    const failures = [];
    if (error) failures.push(`could not read the PR's files: ${error}`);
    else if (paths.some((p) => !isDocPath(p))) {
        // Non-docs changes need a valid changelog patch (or no-changelog label)
        if (labels.includes(NO_CHANGELOG_LABEL)) {
            // Bypass: explicit label
        } else if (!validateChangelogPatch(changelogPatch)) {
            failures.push(`non-docs files changed but CHANGELOG.md (root or docs/) has no net-new list entry. Add a line, or label the PR ${NO_CHANGELOG_LABEL}.`);
        }
    }
    // Classed from the paths as well as the label, so removing `risk:high` changes nothing.
    if (prRisk({ paths, error, labels }) === 'high' && !ownerAcknowledged({ labels, events: ackEvents, owners }))
        failures.push(`risk:high needs the ${RISK_ACK_LABEL} label, added by an owner (${owners.join(', ')}).`);
    return failures;
}

function main(env = process.env) {
    const slug = env.GUARD_REPO;
    const number = Number(env.GUARD_PR);
    if (!slug || !Number.isInteger(number) || number < 1) throw new Error('GUARD_REPO and GUARD_PR are required');
    const run = (args) => {
        const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        return { code: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
    };
    // Read live: the event payload is stale on a re-run.
    const view = run(['api', `repos/${slug}/pulls/${number}`, '--jq', '.labels[].name']);
    if (view.code) throw new Error(`could not read the PR's labels: ${view.err}`);
    const pathsData = fetchPrPaths(slug, number, { run });
    const changelogPatch = fetchChangelogPatch(slug, number, { run });
    const failures = guardFailures({
        ...pathsData,
        labels: view.out.split('\n').filter(Boolean),
        ackEvents: fetchAckEvents(slug, number, { run }),
        owners: String(env.GUARD_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean),
        changelogPatch,
    });
    for (const f of failures) console.log(`::error title=Risk guard::${f}`);
    console.log(failures.length ? `risk guard failed (${failures.length})` : 'risk guard passed');
    process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
