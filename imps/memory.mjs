// Per-repo memory for imps. Three deterministic sources, no model calls:
//   1. notes computed from this machine's ledger (what went wrong in this repo lately),
//   2. an optional curated `imps/memory/<repo>.md` in the kit (lessons a human or RSI wrote down),
//   3. a short digest of the target repo's own agent docs (AGENTS.md, CLAUDE.md, ...).
// loadBrief (runner.mjs) puts the result after the gate limits in every imp prompt.
// Each source is capped so the prompt stays cheap: it is resent on every turn.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateSignature } from './rsi-lib.mjs';

export const MAX_NOTES = 8;
export const CURATED_CAP = 1200;
export const DOCS_CAP = 1000;
export const AGENT_DOCS = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];

const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; };
const sum = (m, re) => Object.entries(m).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);

/** Recent outcome counts for one repo from ledger rows (newest `last` runs). */
export function repoStats(rows = [], repo, { last = 12 } = {}) {
    const runs = rows
        .filter((r) => r && r.repo === repo && r.startedAt)
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
        .slice(-last);
    const reasons = {};
    const ends = {};
    const errs = {};
    const reverted = {};
    let strays = 0;
    for (const r of runs) {
        for (const x of r.gate?.reasons || []) inc(reasons, gateSignature(x));
        const end = r.metrics?.end;
        if (end && end !== 'success') inc(ends, end);
        for (const [k, v] of Object.entries(r.metrics?.errorKinds || {})) inc(errs, k, Number(v) || 0);
        for (const p of r.outOfScopeReverted || []) inc(reverted, p);
        for (const x of r.gate?.reasons || []) {
            const m = String(x).match(/^outside scope (.+)$/);
            if (m) inc(reverted, m[1]);
        }
        if ((r.strayRemoved || []).length) strays++;
    }
    const gated = runs.filter((r) => r.gate);
    const turns = runs.map((r) => r.metrics?.turns).filter(Number.isFinite).sort((a, b) => a - b);
    return {
        repo,
        runs: runs.length,
        merged: runs.filter((r) => r.outcome === 'merged').length,
        gated: gated.length,
        passed: gated.filter((r) => r.gate.pass).length,
        recoveryFailed: runs.filter((r) => r.outcome === 'commit-recovery-failed').length,
        reasons, ends, errs, reverted, strays,
        turnsP50: turns.length ? turns[turns.length >> 1] : null,
    };
}

/**
 * Concrete instructions derived from a repo's recent failures. Each line names
 * the evidence (a count) and the behaviour that avoids it. Empty when the repo
 * has no history or nothing recurring.
 */
export function repoNotes(rows = [], repo, opts = {}) {
    const s = repoStats(rows, repo, opts);
    if (!s.runs) return [];
    const out = [`Last ${s.runs} runs here: ${s.merged} merged, ${s.passed}/${s.gated} passed the gate${s.turnsP50 ? `, median ${s.turnsP50} turns` : ''}.`];
    const noCommit = sum(s.reasons, /^(no commits|edits left uncommitted)$/) + s.recoveryFailed;
    if (noCommit >= 2) out.push(`${noCommit} runs here ended with work not committed. Commit (rule 5) as soon as RUNTEST passes; uncommitted work is lost.`);
    const testFail = sum(s.reasons, /^tests exit/);
    if (testFail >= 2) out.push(`${testFail} runs here failed their tests at the gate. Run RUNTEST before committing and read its output to the end.`);
    const lintFail = sum(s.reasons, /^lint (exit|not run)/);
    if (lintFail >= 1) out.push(`Lint failed at the gate ${lintFail} time(s) here. RUNTEST runs lint too; clear every lint error before committing.`);
    const size = sum(s.reasons, /^diff N lines/);
    if (size >= 2) out.push(`${size} runs here went over the size cap. Change only what "The fix" names and write only the test scenarios it lists.`);
    const paths = Object.entries(s.reverted).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => `\`${p}\``);
    if (paths.length) out.push(`Earlier runs edited files outside the brief (${paths.join(', ')}); the runner throws those edits away. Leave them alone.`);
    const stalled = (s.ends['killed-max-turns'] || 0) + (s.ends['killed-no-edit'] || 0) + (s.ends['no-edit-timeout'] || 0);
    if (stalled >= 2) out.push(`${stalled} runs here hit the turn cap or went 20 tool calls without an edit. Open the file "The fix" names first and make the edit within your first few turns.`);
    if ((s.errs.denied || 0) >= 5) out.push(`Commands were denied ${s.errs.denied} times in recent runs here. One allowed command per Bash call; tests only through RUNTEST.`);
    if ((s.errs['missing-path'] || 0) >= 3) out.push(`${s.errs['missing-path']} tool calls here hit missing paths. Use repo-relative forward-slash paths and Glob before Read when unsure.`);
    if ((s.errs['edit-miss'] || 0) >= 3) out.push(`Edit missed its old_string ${s.errs['edit-miss']} times here. Re-Read the file and copy old_string exactly.`);
    if (s.strays) out.push(`${s.strays} run(s) here left scratch files (test logs). Don't write files outside the brief's allow list.`);
    return out.slice(0, MAX_NOTES);
}

/** ISO week label (e.g. 2026-W47), so a struggling repo is proposed at most once a week. */
export function isoWeek(now = Date.now()) {
    const d = new Date(now);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const y = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const w = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${y}-W${String(w).padStart(2, '0')}`;
}

/**
 * Repos whose recent imp runs mostly fail: at least `minRuns` runs and a merge
 * rate under `maxRate`. Sorted worst first, each with the ledger notes RSI turns
 * into curated memory.
 */
export function strugglingRepos(rows = [], { minRuns = 4, maxRate = 0.35, last = 12, now = Date.now() } = {}) {
    const repos = [...new Set(rows.map((r) => r && r.repo).filter((r) => typeof r === 'string' && /^[A-Za-z0-9._-]+$/.test(r)))];
    return repos
        .map((repo) => {
            const s = repoStats(rows, repo, { last });
            const samples = rows.filter((r) => r.repo === repo && r.outcome !== 'merged' && r.issue).slice(-4).map((r) => `${repo}#${r.issue}`);
            return { ...s, notes: repoNotes(rows, repo, { last }).slice(1), samples: [...new Set(samples)], week: isoWeek(now) };
        })
        .filter((s) => s.runs >= minRuns && s.merged / s.runs < maxRate)
        .sort((a, b) => a.merged / a.runs - b.merged / b.runs);
}

/**
 * Remove HTML comments until none are left, then any unterminated opener, so a
 * nested or split `<!--` can't survive one pass (CodeQL js/incomplete-multi-character-sanitization).
 */
export function stripComments(text) {
    let out = String(text);
    for (let prev = null; prev !== out;) {
        prev = out;
        out = out.replace(/<!--[\s\S]*?-->/g, '');
    }
    return out.split('<!--').join('').split('-->').join('');
}

/** The kit's curated lessons for a repo (`imps/memory/<repo>.md`), capped. */
export function curatedMemory(kitDir, repo, read = readFileSync, exists = existsSync) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(repo || '')) || repo === '.' || repo === '..') return '';
    const p = join(kitDir, 'memory', `${repo}.md`);
    if (!exists(p)) return '';
    const text = stripComments(String(read(p, 'utf8'))).trim();
    return text.length > CURATED_CAP ? `${text.slice(0, CURATED_CAP - 1)}…` : text;
}

const USEFUL = /convention|style|test|lint|format|rule|gotcha|don't|do not|never|always|structure|layout|commit/i;

/**
 * A digest of the target repo's agent docs: which exist, plus the bullet lines
 * under headings that look like rules (conventions, tests, lint, never/always),
 * capped at DOCS_CAP characters.
 */
export function docsDigest(wt, read = readFileSync, exists = existsSync) {
    const found = AGENT_DOCS.filter((f) => exists(join(wt, f)));
    if (!found.length) return '';
    const picked = [];
    let size = 0;
    for (const f of found.slice(0, 2)) {
        let keep = false;
        for (const line of String(read(join(wt, f), 'utf8')).split(/\r?\n/)) {
            const h = line.match(/^#{1,4}\s+(.*)/);
            if (h) { keep = USEFUL.test(h[1]); continue; }
            const b = line.match(/^\s*[-*]\s+(.*\S)/);
            if (!keep || !b) continue;
            const item = `- ${b[1].length > 200 ? `${b[1].slice(0, 199)}…` : b[1]}`;
            if (size + item.length > DOCS_CAP) break;
            picked.push(item);
            size += item.length + 1;
        }
    }
    const head = `This repo documents its conventions in ${found.map((f) => `\`${f}\``).join(', ')}. Read one only if "The fix" leaves a convention unclear.`;
    return picked.length ? `${head}\n${picked.join('\n')}` : head;
}

/** The prompt section, or '' when there is nothing to say. */
export function memorySection({ rows = [], repo, kitDir, wt, read, exists } = {}) {
    const notes = repo ? repoNotes(rows, repo) : [];
    const curated = repo && kitDir ? curatedMemory(kitDir, repo, read, exists) : '';
    const docs = wt ? docsDigest(wt, read, exists) : '';
    const parts = [
        notes.length && `### From earlier imp runs in ${repo}\n${notes.map((n) => `- ${n}`).join('\n')}`,
        curated && `### Lessons kept for ${repo}\n${curated}`,
        docs && `### The repo's own docs\n${docs}`,
    ].filter(Boolean);
    return parts.length ? `## What we know about this repo\n\n${parts.join('\n\n')}` : '';
}
