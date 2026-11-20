// Auto-promotion for groomed briefs: decide whether a brief the groomer drafted
// may go straight to `imp:ready`, or must wait as a draft for the owner.
//
// The dispatcher runs a brief's `test:`, `lint:` and `format:` lines literally
// on this machine, and the groomer's brief is model-written from an issue body.
// So promotion is fail-closed: every check below must pass, and anything that
// looks security-sensitive is held for a person no matter how clean it is.
// Tested in groom-promote.test.mjs.
import { BRIEF_MARK, parseBrief } from './lib.mjs';
import { lintBrief as kitLint } from './brieflint.mjs';

export const PROMOTE_INTRO = 'Groomed brief, auto-promoted to `imp:ready` (trusted author, Docker-only commands, no security terms). Remove `imp:ready` to stop it.';

// Words that mean a person should read the brief before an imp runs it.
// Matched on the issue title, body and labels, and on the brief itself.
export const SENSITIVE = /\b(?:security|vuln\w*|cve|auth(?!or)\w*|oauth|login|logout|passw\w*|secret\w*|tokens?|credential\w*|api[ _-]?keys?|webhooks?|signatures?|signing|stripe|payments?|billing|checkout|crypt\w*|encrypt\w*|decrypt\w*|sessions?|cookies?|csrf|cors|permissions?|rbac|acl|sandbox\w*|injection|sql|xss|ssrf|deserializ\w*|privacy|pii|gdpr)\b/i;

const SENSITIVE_LABELS = new Set(['security', 'audit', 'investigate', 'needs-human', 'imp:needs-human']);

// Images an auto-promoted command may run. Everything else waits for a person.
const IMAGE = String.raw`(?:node:\d{2}(?:-(?:slim|alpine|bookworm|bookworm-slim))?|python:3(?:\.\d{1,2})?(?:-slim)?|golang:1\.\d{1,2}|rust:1(?:\.\d{1,3})?(?:-slim)?)`;
// Inside double quotes the host shell still expands $, backticks and (cmd.exe) %VAR% / !VAR!,
// and a backslash or quote could end the string early, so none of them may appear.
const INNER = String.raw`[^"$\x60\\%!\r\n]+`;
const TOKENS = String.raw`[\w./:@=,+-]+(?: [\w./:@=,+-]+)*`;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Null when `cmd` is a sandboxed Docker command the groomer may promote, else why not.
 * Only this exact shape passes: the worktree at /app, optionally the repo's own
 * node_modules volume, an allowlisted image, then either `sh -c "<no expansions>"`
 * or plain argument tokens. No other mounts, flags, env, network or host commands.
 */
export function unsafeCommand(cmd, repo) {
    const c = String(cmd || '').trim();
    if (!c) return 'empty command';
    const vol = `imp-nm-${escapeRe(repo)}`;
    const re = new RegExp(
        String.raw`^docker run --rm -v \{wt\}:/{1,2}app(?: -v ${vol}:/{1,2}app/node_modules)? -w /{1,2}app ${IMAGE} (?:sh -c "${INNER}"|${TOKENS})$`,
    );
    if (!re.test(c)) return 'not the sandboxed docker shape (worktree at /app, repo node_modules volume, allowlisted image, no host expansions)';
    if (/\bdocker\b/.test(c.slice('docker run'.length))) return 'nested docker call';
    return null;
}

/** First sensitive term in `text`, or null. */
export function sensitiveTerm(text) {
    const m = String(text || '').match(SENSITIVE);
    return m ? m[0] : null;
}

/**
 * Decide whether a groomed brief may be promoted to imp:ready.
 * Returns { promote, reasons } where reasons lists every failed check (empty when promoted).
 */
export function promotionVerdict({ issue = {}, briefText = '', owner = '', trustedAuthors = [], maxLines = 180, enabled = true } = {}) {
    const reasons = [];
    if (!enabled) reasons.push('auto-promote is off (config groomAutoPromote: false)');

    const trusted = new Set([owner, ...trustedAuthors].map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
    const author = String(issue.author || '').toLowerCase();
    if (!author || !trusted.has(author)) reasons.push(`issue author ${issue.author || '(unknown)'} is not trusted`);

    const labels = (issue.labels || []).map((l) => String(l).toLowerCase());
    const badLabel = labels.find((l) => SENSITIVE_LABELS.has(l));
    if (badLabel) reasons.push(`label ${badLabel}`);
    const issueTerm = sensitiveTerm(`${issue.title || ''}\n${issue.body || ''}\n${labels.join(' ')}`);
    if (issueTerm) reasons.push(`issue mentions "${issueTerm}"`);
    const briefTerm = sensitiveTerm(briefText);
    if (briefTerm) reasons.push(`brief mentions "${briefTerm}"`);

    const posted = `${BRIEF_MARK}\n\`\`\`markdown\n${String(briefText).trim()}\n\`\`\``;
    const lint = kitLint(posted);
    for (const p of lint.problems) reasons.push(`brieflint: ${p}`);

    const { meta } = parseBrief(String(briefText));
    const repo = String(meta.repo || '').split('/').pop();
    if (repo && issue.repo && repo !== issue.repo) reasons.push(`brief repo ${meta.repo} is not ${issue.repo}`);
    if (meta.issue && issue.number && String(meta.issue) !== String(issue.number)) reasons.push(`brief issue ${meta.issue} is not #${issue.number}`);
    const ml = Number(meta.maxLines);
    if (Number.isFinite(ml) && ml > maxLines) reasons.push(`maxLines ${ml} over the groomer cap ${maxLines}`);
    if (meta.depends && !/^(none|n\/a|-)\s*(;|$)/i.test(String(meta.depends).trim())) reasons.push('has depends: (a person checks the order)');

    for (const key of ['test', 'lint', 'format']) {
        if (key !== 'test' && !meta[key]) continue;
        const why = unsafeCommand(meta[key], issue.repo || repo);
        if (why) reasons.push(`${key}: ${why}`);
    }
    return { promote: reasons.length === 0, reasons };
}

/** The issue comment for a groomed brief: a real brief when promoted, else a held draft with its reasons. */
export function groomedComment({ briefText, verdict, draftMark }) {
    const fenced = '```markdown\n' + String(briefText).trim() + '\n```';
    if (verdict.promote) return `${BRIEF_MARK}\n${PROMOTE_INTRO}\n${fenced}`;
    const why = verdict.reasons.map((r) => `- ${r}`).join('\n');
    return `${draftMark}\nGroomed draft, held for review (add a \`<!-- imp-brief -->\` copy and \`imp:ready\` to run it):\n${why}\n\n${fenced}`;
}
