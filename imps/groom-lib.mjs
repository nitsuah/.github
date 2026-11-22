// Pure groomer helpers: turn untriaged issues into brief drafts.
// File I/O is limited to config. Tested in groom-lib.test.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from './defaults.mjs';
import { BRIEF_MARK, parseBrief, briefFromComments, closesIssue } from './lib.mjs';
import { promotionVerdict, groomedComment } from './groom-promote.mjs';
import { groomEligible, namedPaths, fetchNamedFiles, fetchRepoTree, treeExists, treeContext, DRAFT_CHECKLIST } from './groom-select.mjs';

export const DRAFT_MARK = '<!-- imp-brief-draft -->';
export const NEEDS_BRIEF_LABEL = 'imp:needs-brief';
export const READY_LABEL = 'imp:ready';

/** Parse ~/.imps/config.json text. Missing/invalid → {}. */
export function parseGroomConfig(text = '') {
    try {
        const j = JSON.parse(text || '{}');
        return j && typeof j === 'object' ? j : {};
    } catch {
        return {};
    }
}

export function loadGroomConfig(path) {
    if (!path || !existsSync(path)) return parseGroomConfig('{}');
    return parseGroomConfig(readFileSync(path, 'utf8'));
}

// Opt-in: the groomer posts public draft comments and labels, so it stays off
// unless IMPS_GROOM=1 is set. config.groom=false is a kill switch that wins
// even when IMPS_GROOM=1 (the scheduled wrapper sets IMPS_GROOM=1 itself).
export function groomEnabled(config = {}, env = {}) {
    if (config.groom === false) return false;
    return env.IMPS_GROOM === '1';
}

/** Normalize an issue label array to just names. */
export function labelNames(labels = []) {
    return labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

/** Check if an issue has any imp:* label. */
export function hasImpLabel(labels) {
    return labelNames(labels).some((l) => l.startsWith('imp:'));
}

/** Check if issue has PR-shaped labels (bug, enhancement, etc.). */
export function isPrShaped(labels = []) {
    const names = labelNames(labels);
    // Must be a bug or small enhancement; skip security, audit, investigate, etc.
    if (names.includes('security') || names.includes('audit') || names.includes('investigate')) return false;
    if (names.includes('needs-human')) return false;
    return names.includes('bug') || names.includes('enhancement');
}

/** Check if repo is "quiet" - no open human PRs, no recent commits. */
export function isQuietRepo(repoInfo, quietHours = DEFAULTS.quietHours) {
    const { humanPRs = 0, lastCommitHours = 99 } = repoInfo || {};
    return humanPRs === 0 && lastCommitHours >= quietHours;
}

/** Check if an issue has an open PR referencing it. */
export async function hasOpenPr(ghJson, owner, repo, issueNumber) {
    try {
        const prs = await ghJson([
            'search', 'prs', '--owner', owner, '--state', 'open',
            '--limit', '50', '--json', 'repository,number,body',
            '--', `repo:${owner}/${repo} is:pr is:open ${issueNumber}`
        ]);
        return prs.some((p) => closesIssue(p.body, issueNumber, `${owner}/${repo}`));
    } catch {
        return false;
    }
}

/** Fetch repo context (README, TASKS.md) for brief drafting. */
export async function fetchRepoContext(gh, owner, repo) {
    const files = ['README.md', 'TASKS.md', 'AGENTS.md', 'CLAUDE.md'];
    const out = {};
    for (const f of files) {
        try {
            const content = gh(['api', `repos/${owner}/${repo}/contents/${f}`, '--jq', '.content']);
            if (content) out[f] = Buffer.from(content, 'base64').toString('utf8');
        } catch {
            // File doesn't exist or not accessible
        }
    }
    return out;
}

/** The newest trusted brief posted in `repo`, as a style and test-command example (or null). */
export function recentBrief(ghJson, owner, repo, { exclude } = {}) {
    try {
        const hits = ghJson([
            'search', 'issues', '--owner', owner, '--limit', '5', '--sort', 'updated', '--json', 'number',
            '--', `repo:${owner}/${repo} "imp-brief" in:comments`,
        ]) || [];
        for (const h of hits) {
            if (h.number === exclude) continue;
            const comments = ghJson(['issue', 'view', String(h.number), '-R', `${owner}/${repo}`, '--json', 'comments'])?.comments || [];
            const b = briefFromComments(comments, { allowedAuthors: [owner] });
            if (b) return b;
        }
    } catch { /* no example: the prompt's template still applies */ }
    return null;
}

/** Draft a brief via 9router chat completion. Retry once after 2s; use [::1] for localhost. */
export async function draftBrief({ router, owner, repo, issue, title, body, context, maxLines, allow, example }) {
    const sys = `You are an imps groomer. Write a brief in the STANDARD.md format for an imp to implement.

The brief MUST be valid front-matter + body:
- Front matter keys: repo, issue, test, maxLines, allow (lint and format optional)
- repo: ${repo}
- issue: ${issue}
- test: one Docker command, exactly this shape (the gate runs it literally on the host):
  docker run --rm -v "{wt}:/app" -v imp-nm-${repo}:/app/node_modules -w /app node:22 sh -c "npm ci --no-audit --no-fund && <focused test command>"
  Use python:3.12-slim, golang:1.23 or rust:1 instead of node:22 when the repo is not Node (then drop the node_modules volume).
  Never use $, backticks, %, ! or backslashes inside the quotes. Add "npx tsc --noEmit &&" before the tests for TypeScript repos.
- maxLines: at most ${maxLines}
- allow: comma-separated repo-relative path prefixes the imp may touch (e.g. "src/lib/,tests/lib/,CHANGELOG.md"); no globs
- no inline # comments in the front matter; no depends: line unless the issue names an unmerged dependency
- The imp must NOT touch .github/, lockfiles, .env files, or secrets
- Body: "## Issue ${owner}/${repo}#${issue}", then "## The fix" (file, function and change) and "## Done when". Inner code blocks use ~~~ fences, never triple backticks.
${example ? `\nA recent brief in this repo (copy its test command and style):\n~~~\n${example.slice(0, 3000)}\n~~~\n` : ''}
Context from the repo:
${Object.entries(context).map(([f, c]) => `### ${f}\n${c.slice(0, f.startsWith('file: ') || f === 'repo file list' ? 6000 : 3000)}`).join('\n\n')}

Issue:
#${issue}: ${title}

${body || '(no description)'}

${DRAFT_CHECKLIST}

Output ONLY the brief as a fenced markdown block. No explanation.`;

    const url = new URL(router.baseUrl);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const targetUrl = isLocalhost ? router.baseUrl.replace('localhost', '[::1]').replace('127.0.0.1', '[::1]') : router.baseUrl;

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(`${targetUrl}/messages`, {
                method: 'POST',
                signal: AbortSignal.timeout(60_000),
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': router.key || '',
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: 'MAX',
                    max_tokens: 8000,
                    stream: false,
                    system: sys,
                    messages: [{ role: 'user', content: 'Write the brief.' }],
                }),
            });

            if (!res.ok) throw new Error(`9router draft failed: ${res.status} ${await res.text()}`);
            const data = await res.json();
            // 9router models often lead with a thinking block: join the text blocks, not content[0].
            const text = (data.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
            // Greedy to the last fence, so an inner ``` block cannot truncate the brief; brieflint then rejects it.
            const m = text.match(/```(?:markdown|md)?\n([\s\S]*)\n```/);
            return (m ? m[1] : text).trim();
        } catch (e) {
            lastErr = e;
            if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw lastErr;
}

/** Lint a brief: validate required fields, scope, size. Returns { ok, errors, briefMeta }. */
export function lintBrief(briefText, maxLines) {
    const { meta, body } = parseBrief(briefText);
    const errors = [];

    if (!meta.test) errors.push('missing required field: test');
    if (!meta.allow) errors.push('missing required field: allow');
    if (!meta.maxLines) errors.push('missing required field: maxLines');
    else {
        const ml = Number(meta.maxLines);
        if (!Number.isFinite(ml) || ml < 1) errors.push('maxLines must be a positive number');
        else if (ml > maxLines) errors.push(`maxLines ${ml} exceeds groomer cap ${maxLines}`);
    }

    // Check if allow paths look reasonable (no .github/, no lockfiles)
    if (meta.allow) {
        const deny = [/^\.github\//, /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /bun\.lockb?$/];
        for (const a of String(meta.allow).split(',').map((s) => s.trim())) {
            if (deny.some((re) => re.test(a))) errors.push(`denied path in allow: ${a}`);
        }
    }

    // Quick gate dry-run: if body looks like a diff, check size
    // (We can't fully validate without a repo, but we can catch obvious issues)

    return { ok: errors.length === 0, errors, briefMeta: meta };
}

/** Check if an issue is already groomed (has draft or brief). */
export function alreadyGroomed(comments = []) {
    const hasDraft = comments.some((c) => (c.body || '').includes(DRAFT_MARK));
    const hasBrief = !!briefFromComments(comments);
    return hasDraft || hasBrief;
}

/**
 * Post a groomed comment and add the label atomically.
 * If label fails after comment succeeds, deletes the comment so the issue can be regroomed.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export async function postGroomed({ gh, owner, repo, number, commentBody, label }) {
    // Post comment and capture URL to extract comment ID
    let commentId;
    try {
        const commentOut = gh(['issue', 'comment', String(number), '-R', `${owner}/${repo}`, '--body', commentBody]);
        // gh prints URL like: https://github.com/owner/repo/issues/123#issuecomment-123456789
        const m = String(commentOut).match(/#issuecomment-(\d+)$/);
        if (m) commentId = m[1];
    } catch (e) {
        return { ok: false, error: `comment failed: ${e.message}` };
    }

    // Try to add label up to 2 times
    let labelErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            gh(['issue', 'edit', String(number), '-R', `${owner}/${repo}`, '--add-label', label]);
            return { ok: true };
        } catch (e) {
            labelErr = e;
            if (attempt === 0) await new Promise(r => setTimeout(r, 500));
        }
    }

    // Both label attempts failed - delete the comment
    if (commentId) {
        try {
            gh(['api', '-X', 'DELETE', `repos/${owner}/${repo}/issues/comments/${commentId}`]);
            return { ok: false, error: `label failed for ${owner}/${repo}#${number}; comment removed so the next run regrooms it` };
        } catch (e) {
            return { ok: false, error: `label failed for ${owner}/${repo}#${number}; comment removal failed too` };
        }
    }

    return { ok: false, error: `label failed for ${owner}/${repo}#${number}; could not parse comment ID for cleanup` };
}

/** Main groomer logic: find candidate issues, draft briefs, post as drafts. */
export async function runGroom({
    gh,
    ghJson,
    owner,
    repos,
    router,
    config = {},
    dailyCap = DEFAULTS.rsiDailyIssueCap,
    quietHours = DEFAULTS.quietHours,
    maxLines = DEFAULTS.maxLines,
    dryRun = false,
    singleRepo = null,
    searchPaceMs = 2100,
    poster = null,
    briefAuthors = ['nitsuah'],
} = {}) {
    const results = { candidates: 0, drafted: 0, skipped: 0, promoted: [], held: [], errors: [] };

    // Track daily count
    const filedPath = join(process.env.IMPS_HOME || join(homedir(), '.imps'), 'groom-filed.json');
    const day = new Date().toISOString().slice(0, 10);
    const filedState = (() => {
        try {
            const j = JSON.parse(readFileSync(filedPath, 'utf8'));
            return { day, count: j.day === day ? Number(j.count) || 0 : 0, keys: Array.isArray(j.keys) ? j.keys : [] };
        } catch {
            return { day, count: 0, keys: [] };
        }
    })();

    const remaining = Math.max(0, dailyCap - filedState.count);
    if (remaining <= 0) {
        results.errors.push(`daily cap reached (${dailyCap})`);
        return results;
    }

    // Set of repo#number already considered in this run (cross-repo dedupe)
    const seen = new Set();

    const repoKeys = singleRepo ? [singleRepo] : Object.keys(repos);
    for (const repo of repoKeys) {
        if (results.drafted >= remaining) break;
        if (!repos[repo]) continue;

        // Drafting and promoting never touch a repo; the dispatcher already keeps one imp
        // per repo and skips repos with an open imp PR. Quiet-only grooming is opt-in.
        const repoInfo = repos[repo];
        if (config.groomRequireQuiet === true && !isQuietRepo(repoInfo, quietHours)) continue;
        let example;

        // Search for untriaged issues in this repo
        let issues = [];
        try {
            // GitHub allows 30 search calls a minute; one search per repo across
            // ~70 repos tripped it (403), so pace them.
            if (searchPaceMs > 0) await new Promise((r) => setTimeout(r, searchPaceMs));
            const searchResults = ghJson([
                'search', 'issues', '--owner', owner, '--state', 'open',
                '--limit', '50', '--json', 'repository,number,title,labels,body,createdAt,author',
                '--', `repo:${owner}/${repo} -label:imp:*`
            ]);
            issues = searchResults
                .filter((i) => i.repository?.name === repo) // keep only results for this repo
                .map((i) => ({
                    repo: i.repository.name,
                    number: i.number,
                    title: i.title,
                    body: i.body || '',
                    labels: labelNames(i.labels),
                    createdAt: i.createdAt,
                    author: i.author?.login || '',
                }));
        } catch (e) {
            results.errors.push(`search failed for ${repo}: ${e.message}`);
            continue;
        }

        for (const issue of issues) {
            if (results.drafted >= remaining) break;

            // Cross-repo dedupe: skip if already seen this repo#number
            const key = `${issue.repo}#${issue.number}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.candidates++;

            // Skip if already has imp label or is groomed
            if (hasImpLabel(issue.labels)) { results.skipped++; continue; }
            // Owner-filed issues qualify without a bug/enhancement label; untrusted, security,
            // design and epic issues are skipped before drafting so they cannot burn the cap.
            const elig = groomEligible(issue, { owner, trustedAuthors: config.groomTrustedAuthors || [] });
            if (!elig.ok) { results.skipped++; continue; }

            const comments = ghJson(['issue', 'view', String(issue.number), '-R', `${owner}/${issue.repo}`, '--json', 'comments']).comments;
            if (alreadyGroomed(comments)) { results.skipped++; continue; }

            // Check for open PR
            if (await hasOpenPr(ghJson, owner, issue.repo, issue.number)) { results.skipped++; continue; }

            // Fetch context and draft
            try {
                // The files the issue names, so the brief can state real code facts.
                const tree = fetchRepoTree(gh, owner, issue.repo);
                const context = {
                    ...(tree ? { 'repo file list': treeContext(tree) } : {}),
                    ...(await fetchRepoContext(gh, owner, issue.repo)),
                    ...fetchNamedFiles(gh, owner, issue.repo, namedPaths(`${issue.title}\n${issue.body}`)),
                };
                const allowGuess = 'src/,lib/,app/,tests/,pkg/'; // generic default
                if (example === undefined) example = recentBrief(ghJson, owner, issue.repo, { exclude: issue.number });
                const briefText = await draftBrief({
                    router, owner, repo: issue.repo, issue: issue.number,
                    title: issue.title, body: issue.body, context,
                    maxLines, allow: allowGuess, example,
                });

                const lint = lintBrief(briefText, maxLines);
                if (!lint.ok) {
                    const preview = briefText.replace(/\n/g, ' ').slice(0, 160);
                    results.errors.push(`lint failed for ${issue.repo}#${issue.number}: ${lint.errors.join(', ')}; model output: ${preview}`);
                    results.skipped++;
                    continue;
                }

                const verdict = promotionVerdict({
                    issue, briefText, owner, maxLines,
                    trustedAuthors: config.groomTrustedAuthors || [],
                    enabled: config.groomAutoPromote !== false,
                    poster, briefAuthors,
                    ownerKeywordHold: config.groomOwnerKeywordHold === true,
                    // A truncated tree can't prove a path is absent, so only the hedge check runs then.
                    exists: tree && !tree.truncated ? treeExists(tree) : undefined,
                });
                const label = verdict.promote ? READY_LABEL : NEEDS_BRIEF_LABEL;
                if (!dryRun) {
                    if (!verdict.promote) {
                        gh(['label', 'create', NEEDS_BRIEF_LABEL, '-R', `${owner}/${issue.repo}`, '-c', 'fbca04', '-d', 'Groomed brief awaiting human promotion', '--force']);
                    }
                    const commentBody = groomedComment({ briefText, verdict, draftMark: DRAFT_MARK });
                    const pg = await postGroomed({ gh, owner, repo: issue.repo, number: issue.number, commentBody, label });
                    if (!pg.ok) {
                        results.errors.push(pg.error);
                        results.skipped++;
                        continue;
                    }

                    // Track
                    filedState.keys.push(`groom:${issue.repo}#${issue.number}`);
                    filedState.count++;
                }

                // Counted only once posted: a failed label rolls the post back.
                (verdict.promote ? results.promoted : results.held).push(
                    verdict.promote ? `${issue.repo}#${issue.number}` : { issue: `${issue.repo}#${issue.number}`, reasons: verdict.reasons },
                );
                results.drafted++;
            } catch (e) {
                results.errors.push(`draft failed for ${issue.repo}#${issue.number}: ${e.message}`);
                results.skipped++;
            }
        }
    }

    // Persist state
    if (!dryRun && results.drafted > 0) {
        writeFileSync(filedPath, JSON.stringify(filedState, null, 2) + '\n');
    }

    return results;
}