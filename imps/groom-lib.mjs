// Pure groomer helpers: turn untriaged issues into brief drafts.
// File I/O is limited to config. Tested in groom-lib.test.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from './defaults.mjs';
import { BRIEF_MARK, parseBrief, briefFromComments, closesIssue } from './lib.mjs';

export const DRAFT_MARK = '<!-- imp-brief-draft -->';
export const NEEDS_BRIEF_LABEL = 'imp:needs-brief';

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

export function groomEnabled(config = {}, env = {}) {
    if (env.IMPS_GROOM === '0' || env.IMPS_GROOM === 'false') return false;
    return env.IMPS_GROOM === '1' || config.groom === true;
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
    } catch (error) {
        // Unknown PR state is not proof that no PR exists: fail closed.
        throw new Error(`open-PR lookup failed for ${owner}/${repo}#${issueNumber}: ${error.message}`);
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

/** Draft a brief via 9router chat completion. */
export async function draftBrief({ router, owner, repo, issue, title, body, context, maxLines, allow }) {
    const sys = `You are an imps groomer. Write a brief in the STANDARD.md format for an imp to implement.

The brief MUST be valid front-matter + body:
- Front matter keys: repo, issue, test, maxLines, allow (lint optional)
- repo: ${owner}/${repo}
- issue: ${issue}
- test: the exact command to run (e.g., "npm test", "cargo test", "go test ./...")
- maxLines: ${maxLines} (do not exceed)
- allow: comma-separated paths the imp may touch (e.g., "src/,tests/")
- The imp must NOT touch .github/, lockfiles, or secrets

Context from the repo:
${Object.entries(context).map(([f, c]) => `### ${f}\n${c.slice(0, 3000)}`).join('\n\n')}

Issue:
#${issue}: ${title}

${body || '(no description)'}

Output ONLY the brief as a fenced markdown block. No explanation.`;

    const res = await fetch(`${router.baseUrl}/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: {
            'content-type': 'application/json',
            'x-api-key': router.key || '',
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'MAX',
            max_tokens: 4000,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: 'Write the brief.' },
            ],
        }),
    });

    if (!res.ok) throw new Error(`9router draft failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/```(?:markdown|md)?\n([\s\S]*?)\n```/);
    return (m ? m[1] : text).trim();
}

/** Lint a brief: validate required fields, scope, size. Returns { ok, errors, briefMeta }. */
export function lintBrief(briefText, maxLines, expected = {}) {
    const { meta, body } = parseBrief(briefText);
    const errors = [];

    if (!meta.test) errors.push('missing required field: test');
    if (!meta.repo) errors.push('missing required field: repo');
    if (!meta.issue) errors.push('missing required field: issue');
    if (expected.repo && meta.repo !== expected.repo) errors.push('repo does not match candidate');
    if (expected.issue != null && String(meta.issue) !== String(expected.issue)) errors.push('issue does not match candidate');
    if (!meta.allow) errors.push('missing required field: allow');
    if (!meta.maxLines) errors.push('missing required field: maxLines');
    else {
        const ml = Number(meta.maxLines);
        if (!Number.isFinite(ml) || ml < 1) errors.push('maxLines must be a positive number');
        else if (ml > maxLines) errors.push(`maxLines ${ml} exceeds groomer cap ${maxLines}`);
    }

    // Check if allow paths look reasonable (no .github/, no lockfiles)
    if (meta.allow) {
        const deny = [
            /^\.github(?:\/|$)/i,
            /(^|\/)\.env(?:\.|$)/i,
            /(^|\/)(?:secrets?|credentials?)(?:\/|$)/i,
            /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
            /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i,
        ];
        for (const a of String(meta.allow).split(',').map((s) => s.trim().replace(/\\/g, '/').replace(/\/$/, ''))) {
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
} = {}) {
    const results = { candidates: 0, drafted: 0, skipped: 0, errors: [] };

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

    for (const repo of Object.keys(repos)) {
        if (results.drafted >= remaining) break;

        const repoInfo = repos[repo];
        if (!isQuietRepo(repoInfo, quietHours)) continue;

        // Search for untriaged issues in this repo
        let issues = [];
        try {
            issues = ghJson([
                'search', 'issues', '--owner', owner, '--state', 'open',
                '--limit', '50', '--json', 'repository,number,title,labels,body,createdAt',
                '--', `repo:${owner}/${repo} -label:imp:*`
            ]).map((i) => ({
                repo: i.repository.name,
                number: i.number,
                title: i.title,
                body: i.body || '',
                labels: labelNames(i.labels),
                createdAt: i.createdAt,
            }));
        } catch (e) {
            results.errors.push(`search failed for ${repo}: ${e.message}`);
            continue;
        }

        for (const issue of issues) {
            if (results.drafted >= remaining) break;
            results.candidates++;

            // Skip if already has imp label or is groomed
            if (hasImpLabel(issue.labels)) { results.skipped++; continue; }
            if (!isPrShaped(issue.labels)) { results.skipped++; continue; }

            let comments;
            try {
                comments = ghJson(['issue', 'view', String(issue.number), '-R', `${owner}/${issue.repo}`, '--json', 'comments']).comments;
                if (!Array.isArray(comments)) throw new Error('issue comments response is not an array');
            } catch (error) {
                results.errors.push(`issue eligibility lookup failed for ${issue.repo}#${issue.number}: ${error.message}`);
                results.skipped++;
                continue;
            }
            if (alreadyGroomed(comments)) { results.skipped++; continue; }

            // Check for open PR. A failed lookup must never be treated as "no PR".
            try {
                if (await hasOpenPr(ghJson, owner, issue.repo, issue.number)) { results.skipped++; continue; }
            } catch (error) {
                results.errors.push(error.message);
                results.skipped++;
                continue;
            }

            const dedupeKey = `groom:${issue.repo}#${issue.number}`;
            if (filedState.keys.includes(dedupeKey)) { results.skipped++; continue; }

            // Fetch context and draft
            try {
                const context = await fetchRepoContext(gh, owner, issue.repo);
                const allowGuess = 'src/,lib/,app/,tests/,pkg/'; // generic default
                const briefText = await draftBrief({
                    router, owner, repo: issue.repo, issue: issue.number,
                    title: issue.title, body: issue.body, context,
                    maxLines, allow: allowGuess,
                });

                const lint = lintBrief(briefText, maxLines, {
                    repo: `${owner}/${issue.repo}`,
                    issue: issue.number,
                });
                if (!lint.ok) {
                    results.errors.push(`lint failed for ${issue.repo}#${issue.number}: ${lint.errors.join(', ')}`);
                    results.skipped++;
                    continue;
                }

                // Post as draft
                if (!dryRun) {
                    // Ensure label exists
                    gh(['label', 'create', NEEDS_BRIEF_LABEL, '-R', `${owner}/${issue.repo}`, '-c', 'fbca04', '-d', 'Groomed brief awaiting human promotion', '--force']);
                    const commentBody = DRAFT_MARK + '\n```markdown\n' + briefText + '\n```';
                    gh(['issue', 'comment', String(issue.number), '-R', `${owner}/${issue.repo}`, '--body', commentBody]);
                    // Add label
                    gh(['issue', 'edit', String(issue.number), '-R', `${owner}/${issue.repo}`, '--add-label', NEEDS_BRIEF_LABEL]);

                    // Track
                    filedState.keys.push(`groom:${issue.repo}#${issue.number}`);
                    filedState.count++;
                }

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