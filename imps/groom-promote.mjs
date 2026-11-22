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

export const PROMOTE_INTRO = 'Groomed brief, auto-promoted to `imp:ready` (trusted author, Docker-only commands, no security label; security terms only from the owner). Remove `imp:ready` to stop it.';

// Words that mean a person should read the brief before an imp runs it.
// Matched on the issue title, body and labels, and on the brief itself.
export const SENSITIVE = /\b(?:security|vuln\w*|cve|auth(?!or(?:s|ed|ing|ship)?\b)\w*|oauth|login|logout|passw\w*|secret\w*|tokens?|credential\w*|api[ _-]?keys?|webhooks?|signatures?|signing|stripe|payments?|billing|checkout|crypt\w*|encrypt\w*|decrypt\w*|sessions?|cookies?|csrf|cors|permissions?|rbac|acl|sandbox\w*|injection|sql|xss|ssrf|deserializ\w*|privacy|pii|gdpr)\b/i;

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
 * Only this exact shape passes: the worktree at /app (the mount may be double-quoted so a
 * worktree path with spaces stays one argument; the runner substitutes {wt} unquoted), optionally the repo's own
 * node_modules volume, an allowlisted image, then either `sh -c "<no expansions>"`
 * or plain argument tokens. No other mounts, flags, env, network or host commands.
 */
export function unsafeCommand(cmd, repo) {
    const c = String(cmd || '').trim();
    if (!c) return 'empty command';
    const vol = `imp-nm-${escapeRe(repo)}`;
    const re = new RegExp(
        String.raw`^docker run --rm -v (?:\{wt\}:/{1,2}app|"\{wt\}:/{1,2}app")(?: -v ${vol}:/{1,2}app/node_modules)? -w /{1,2}app ${IMAGE} (?:sh -c "${INNER}"|${TOKENS})$`,
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
export function promotionVerdict({ issue = {}, briefText = '', owner = '', trustedAuthors = [], maxLines = 180, enabled = true, poster, briefAuthors = ['nitsuah'], ownerKeywordHold = false, exists } = {}) {
    const reasons = [];
    if (!enabled) reasons.push('auto-promote is off (config groomAutoPromote: false)');
    // The dispatcher only reads briefs posted by IMPS_BRIEF_AUTHORS; a brief from any other
    // login would leave imp:ready on an issue with no brief it accepts.
    const dispatcherTrusts = new Set(briefAuthors.map((a) => String(a).trim().toLowerCase()));
    if (!poster || !dispatcherTrusts.has(String(poster).toLowerCase())) reasons.push(`posting login ${poster || '(unknown)'} is not in the dispatcher's IMPS_BRIEF_AUTHORS`);

    const trusted = new Set([owner, ...trustedAuthors].map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
    const author = String(issue.author || '').toLowerCase();
    if (!author || !trusted.has(author)) reasons.push(`issue author ${issue.author || '(unknown)'} is not trusted`);

    const labels = (issue.labels || []).map((l) => String(l).toLowerCase());
    const badLabel = labels.find((l) => SENSITIVE_LABELS.has(l));
    if (badLabel) reasons.push(`label ${badLabel}`);
    // The owner chose to file this issue (and to leave off a `security` label), so security words in it
    // or in its brief no longer hold it: 5 of 9 owner-filed QA issues sat held for "auth" or "privacy"
    // (2026-11-21). Labels, untrusted authors and every command check still hold. Config
    // groomOwnerKeywordHold: true brings the hold back for the owner too.
    const ownerWrote = !!owner && author === String(owner).trim().toLowerCase();
    if (!ownerWrote || ownerKeywordHold) {
        const issueTerm = sensitiveTerm(`${issue.title || ''}\n${issue.body || ''}\n${labels.join(' ')}`);
        if (issueTerm) reasons.push(`issue mentions "${issueTerm}"`);
        const briefTerm = sensitiveTerm(briefText);
        if (briefTerm) reasons.push(`brief mentions "${briefTerm}"`);
    }

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

    for (const r of guessedPathReasons(String(briefText), exists)) reasons.push(r);

    for (const key of ['test', 'lint', 'format']) {
        if (key !== 'test' && !meta[key]) continue;
        const why = unsafeCommand(meta[key], issue.repo || repo);
        if (why) reasons.push(`${key}: ${why}`);
    }
    return { promote: reasons.length === 0, reasons };
}

// A drafted target the model hedged on: "File: src/worker/index.ts (or similar Worker entry)".
const HEDGE = /\((?:or|maybe|possibly) (?:similar|wherever|whichever|equivalent|main|the main|another)\b|\(or `[^`]+` if\b/i;
// Allow entries that exist in nearly every repo and so prove nothing about the target.
const GENERIC = /^(?:package\.json|CHANGELOG\.md|docs\/CHANGELOG\.md|README\.md|docs\/?|tests?\/?|TASKS\.md|ROADMAP\.md)$/i;

/**
 * Reasons a brief's paths look guessed rather than read. `exists` (path => boolean on the default
 * branch) is optional; without it only the hedge check runs.
 */
export function guessedPathReasons(briefText, exists) {
    const reasons = [];
    const { meta, body } = parseBrief(String(briefText));
    const hedge = String(body || '').match(HEDGE);
    if (hedge) reasons.push(`brief hedges on its target file ("${hedge[0]}"), so the path is a guess`);
    if (typeof exists === 'function') {
        const allow = String(meta.allow || '').split(',').map((s) => s.trim()).filter(Boolean);
        // Docs and tests (and anything under them) prove nothing about where the fix goes.
        const specific = allow.filter((p) => !GENERIC.test(p) && !/^(?:docs|tests?)\//i.test(p));
        if (specific.length && !specific.some((p) => exists(p))) reasons.push(`no allow: path is on the default branch (${specific.join(', ')})`);
        for (const dir of npmDirsWithoutPackageJson(String(meta.test || ''), exists)) {
            if (dir === OUTSIDE_APP) reasons.push('test runs npm outside the /app worktree (a cd leaves it)');
            else reasons.push(dir ? `test runs npm in ${dir}/ but there is no ${dir}/package.json` : 'test runs npm at the repo root but there is no package.json there');
        }
    }
    return reasons;
}

/**
 * Directories (repo-relative, '' = root) where `cmd` runs an npm command with no package.json there.
 * Walks the steps in order, so `npm ci && cd frontend && npm test` still flags the root `npm ci`,
 * and a `cd` must land somewhere that has a package.json of its own. A `cd` inside `( … )` lasts
 * only to the closing paren, and `.`/`..` are resolved. Any step whose program is `npm` counts,
 * whatever flags come first (`npm --silent test`).
 */
export const OUTSIDE_APP = '<outside /app>';
export function npmDirsWithoutPackageJson(cmd, exists) {
    // Repo-relative directory, or OUTSIDE_APP once a cd leaves the mounted worktree.
    const canon = (p) => {
        const out = [];
        for (const seg of String(p).split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') {
                if (!out.length) return OUTSIDE_APP;
                out.pop();
            } else out.push(seg);
        }
        return out.join('/');
    };
    const fromApp = (p) => (/^\/{1,2}app(?=\/|$)/.test(String(p)) ? canon(String(p).replace(/^\/{1,2}app/, '')) : OUTSIDE_APP);
    const inner = cmd.match(/\bsh -c (["'])([\s\S]*)\1/);
    let dir = fromApp(cmd.match(/-w (\/{1,2}app\S*)/)?.[1] || '');
    const stack = [];
    const bad = new Set();
    // Without sh -c the container command is whatever follows the image, e.g. `... node:22 npm test`.
    const body = inner ? inner[2] : (cmd.match(/\s(npm\s[\s\S]*)$/)?.[1] ?? '');
    for (const raw of body.split(/&&|;|\|\|/)) {
        let step = raw.trim();
        while (step.startsWith('(')) {
            stack.push(dir);
            step = step.slice(1).trim();
        }
        let closes = 0;
        while (step.endsWith(')')) {
            closes++;
            step = step.slice(0, -1).trim();
        }
        // Leading VAR=value assignments don't change which program runs (`CI=true npm ci`).
        step = step.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
        const cd = step.match(/^cd\s+(\S+)$/);
        if (cd) {
            if (dir !== OUTSIDE_APP || cd[1].startsWith('/')) dir = cd[1].startsWith('/') ? fromApp(cd[1]) : canon(`${dir}/${cd[1]}`);
        } else if (/^npm(?:\s|$)/.test(step) && (dir === OUTSIDE_APP || !exists(dir ? `${dir}/package.json` : 'package.json'))) bad.add(dir);
        for (; closes > 0 && stack.length; closes--) dir = stack.pop();
    }
    return [...bad];
}

/** The issue comment for a groomed brief: a real brief when promoted, else a held draft with its reasons. */
export function groomedComment({ briefText, verdict, draftMark }) {
    const fenced = '```markdown\n' + String(briefText).trim() + '\n```';
    if (verdict.promote) return `${BRIEF_MARK}\n${PROMOTE_INTRO}\n${fenced}`;
    const why = verdict.reasons.map((r) => `- ${r}`).join('\n');
    return `${draftMark}\nGroomed draft, held for review (add a \`<!-- imp-brief -->\` copy and \`imp:ready\` to run it):\n${why}\n\n${fenced}`;
}
