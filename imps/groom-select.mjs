// Which issues the groomer drafts, and which repo files it shows the drafting
// model. Pure helpers; tested in groom-select.test.mjs.
//
// Throughput review 2026-11-20: the dispatcher idled in ~90% of cycles because
// nothing reached imp:ready. The groomer only took `bug`/`enhancement` issues and
// spent its whole daily cap drafting journeys-bot issues it could never promote,
// while 61 owner-filed issues had no label at all. And its briefs saw only the
// README/TASKS, never the code, so the facts that failed runs (positional CSS, an
// unresolvable import, which elements must stay visible) were missing.

const BLOCK_LABELS = new Set([
    'security', 'audit', 'investigate', 'needs-human', 'imp:needs-human',
    'epic', 'tracking', 'parent', 'meta', 'design', 'spec', 'rfc',
    'question', 'discussion', 'wontfix', 'duplicate', 'blocked',
    'safety-critical', 'imp', 'report',
]);

// Repos the groomer never touches: the security program runs its own gated
// pipeline, and 9router tracks upstream exactly.
export const SKIP_REPOS = new Set(['security-program', '9router']);

// Report and bookkeeping issues: findings lists, audits, roll-ups, triage queues,
// heartbeats. They hold many tasks, not one PR's worth of work.
const REPORT_TITLE = /^\s*(\[?(audit|report|qa|triage|heartbeat)\b|qa fast crawl|owned-repo|owned-repository|brand & link pass|imps heartbeat|chore\(triage\))|roll-?up|\bindex of\b|\bfindings\b/i;

const lower = (xs = []) => xs.map((x) => String(typeof x === 'string' ? x : x?.name || '').toLowerCase()).filter(Boolean);

/** True for an umbrella issue (epic, tracker, phased plan) rather than one PR's worth of work. */
export function isEpic({ title = '', body = '', labels = [] } = {}) {
    if (lower(labels).some((l) => ['epic', 'tracking', 'parent', 'meta'].includes(l))) return true;
    if (/^\s*\[?(epic|tracking|meta|rfc|umbrella)\b/i.test(title)) return true;
    const text = String(body);
    const openBoxes = (text.match(/^\s*[-*] \[ \]/gm) || []).length;
    const phases = (text.match(/^#{1,4}\s*phase\b/gim) || []).length + (text.match(/\*\*phase \d/gi) || []).length;
    return openBoxes >= 4 || phases >= 2;
}

/**
 * Whether the groomer should draft this issue. Returns { ok, reason }.
 * Only trusted authors' issues are drafted at all: a draft from an untrusted
 * issue can never be promoted, so drafting it only burns the daily cap.
 */
export function groomEligible(issue = {}, { owner = '', trustedAuthors = [] } = {}) {
    const labels = lower(issue.labels);
    if (SKIP_REPOS.has(String(issue.repo || '').toLowerCase())) return { ok: false, reason: `repo ${issue.repo} is never groomed` };
    if (labels.some((l) => l.startsWith('imp:'))) return { ok: false, reason: 'already has an imp:* label' };
    const trusted = new Set([owner, ...trustedAuthors].map((a) => String(a).toLowerCase()).filter(Boolean));
    if (!trusted.has(String(issue.author || '').toLowerCase())) return { ok: false, reason: `author ${issue.author || '(unknown)'} not trusted` };
    const blocked = labels.find((l) => BLOCK_LABELS.has(l));
    if (blocked) return { ok: false, reason: `label ${blocked}` };
    if (isEpic(issue)) return { ok: false, reason: 'epic or multi-phase issue' };
    if (REPORT_TITLE.test(String(issue.title || ''))) return { ok: false, reason: 'report or bookkeeping issue' };
    return { ok: true, reason: '' };
}

// Never sent to the drafting model, whoever names them.
const SECRET_PATH = /(^|\/)(secrets?|credentials?|private)(\/|[._-])|\.(pem|key|p12|pfx|crt|cer|keystore|jks|asc|gpg)$|(^|\/)id_(rsa|ed25519|ecdsa)|token|passw/i;

// Repo-relative paths named in issue text: `dir/file.ext` (not URLs).
const PATH_RE = /(?<![\w./:@-])(?:[\w@.-]+\/)+[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;

/** Up to `max` distinct repo-relative file paths named in `text`, in order of appearance. */
export function namedPaths(text = '', max = 4) {
    const out = [];
    for (const m of String(text).matchAll(PATH_RE)) {
        const p = m[0].replace(/^\.\//, '');
        const before = String(text).slice(Math.max(0, m.index - 8), m.index);
        if (/https?:\/\/\S*$/.test(before) || /^(www\.|[\w-]+\.(com|org|io|dev|app)\/)/i.test(p)) continue;
        if (p.startsWith('.github/') || /(^|\/)\.env/.test(p) || SECRET_PATH.test(p)) continue;
        if (!out.includes(p)) out.push(p);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * Fetch the named files from the repo's default branch for the drafting prompt.
 * `gh` is the sync gh wrapper; missing files are skipped. Each file is cut to
 * `maxChars` so one big file cannot crowd out the rest.
 */
export function fetchNamedFiles(gh, owner, repo, paths = [], { maxChars = 6000 } = {}) {
    const out = {};
    for (const p of paths) {
        try {
            const b64 = gh(['api', `repos/${owner}/${repo}/contents/${p}`, '--jq', '.content']);
            if (!b64) continue;
            const text = Buffer.from(b64, 'base64').toString('utf8');
            out[`file: ${p}`] = text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated, ${text.length} chars)` : text;
        } catch { /* not on the default branch: the brief may create it */ }
    }
    return out;
}

/**
 * The repo's file list on the default branch (one API call), or null when it cannot be read.
 * The drafting model sees it so `## The fix` and `allow:` name real files, and promotion uses it
 * to hold briefs whose paths are guesses (five of seven groomed briefs on 2026-11-21 named files
 * that did not exist, e.g. app/lib/state.mjs, src/worker/, an npm ci in a repo with no package.json).
 * GitHub cuts the recursive tree off past its size limit and sets `truncated`; the returned array
 * then carries `truncated: true`, and callers must not treat a missing path as proof it is absent.
 */
export const TRUNCATED_MARK = '#truncated';
export function fetchRepoTree(gh, owner, repo) {
    try {
        const out = gh(['api', `repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, '--jq', `(if .truncated then "${TRUNCATED_MARK}" else empty end), (.tree[] | select(.type == "blob") | .path)`]);
        const lines = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const paths = lines.filter((l) => l !== TRUNCATED_MARK);
        if (!paths.length) return null;
        paths.truncated = lines.includes(TRUNCATED_MARK);
        return paths;
    } catch {
        return null;
    }
}

/** (path) => boolean over a file list: true for a file in it or a directory prefix of one. */
export function treeExists(paths) {
    const files = new Set(paths);
    const dirs = new Set();
    for (const f of paths) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
    return (p) => {
        const q = String(p).trim().replace(/^\.\//, '').replace(/\/$/, '');
        return files.has(q) || dirs.has(q);
    };
}

/** The tree as prompt context: source-ish paths only, capped so it cannot crowd out the issue. */
export function treeContext(paths, { max = 400 } = {}) {
    const keep = paths.filter((p) => !/(^|\/)(node_modules|dist|build|coverage|vendor|__snapshots__|__screenshots__)\//.test(p) && !/\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|woff2?|ttf|lock)$/i.test(p));
    const shown = keep.slice(0, max);
    return shown.join('\n') + (keep.length > max ? `\n… (${keep.length - max} more)` : '');
}

/** Checklist the drafting model must follow; mirrors STANDARD.md § Brief checklist. */
export const DRAFT_CHECKLIST = `Before writing "## The fix", check the files shown above and say in the brief:
- If an element, id, class or block is removed or moved: whether CSS selects it by position (:first-child, :nth-child, :last-child) and which tests or journeys assert it; put those files in allow: and say how they change.
- Which imports the new code needs, and that every package it imports is already a dependency in package.json (never add a dependency).
- Which existing elements, exports or behaviours must stay unchanged, by name.
- The test command must pass on the unchanged base except for the behaviour the issue changes, and the lint command must exit 0 on the unchanged base and lint only files in allow:.
- New or edited files end with a newline.
- Every path in "## The fix" and allow: is copied from the repo file list above, or is a new file you say is new. Never write "(or similar …)" or "(or wherever …)": if you cannot find the file, say so in the brief instead of guessing.
- The test command runs from the directory that holds package.json (or pyproject.toml); if that is a subdirectory, cd into it inside the sh -c string.`;
