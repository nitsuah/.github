// Pure RSI helpers: turn ledger/dispatch/journey signals into issue proposals.
// File I/O is limited to loadRsiConfig. Tested in rsi-lib.test.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { DEFAULTS } from './defaults.mjs';
import { BRIEF_MARK } from './lib.mjs';

export const KIT_TEST = 'node --test imps/*.test.mjs';

/** Parse ~/.imps/config.json text. Missing/invalid → {}. */
export function parseRsiConfig(text = '') {
    try {
        const j = JSON.parse(text || '{}');
        return j && typeof j === 'object' ? j : {};
    } catch {
        return {};
    }
}

export function loadRsiConfig(path) {
    if (!path || !existsSync(path)) return parseRsiConfig('{}');
    return parseRsiConfig(readFileSync(path, 'utf8'));
}

export function rsiEnabled(config = {}, env = {}) {
    if (env.IMPS_RSI === '0' || env.IMPS_RSI === 'false') return false;
    if (config.rsi === false) return false;
    return true;
}

/**
 * Whether the dispatcher should run the RSI pass at the end of this cycle:
 * always with --rsi or IMPS_RSI=1, never with IMPS_RSI=0, and otherwise once a
 * UTC day when config.json says `"rsi": true` (no `rsi` event yet today in the
 * dispatch log lines given).
 */
export function rsiDue({ flag = false, env = {}, config = {}, dispatchLines = [], now = Date.now() } = {}) {
    if (env.IMPS_RSI === '0' || env.IMPS_RSI === 'false') return false;
    if (flag || env.IMPS_RSI === '1') return true;
    if (config.rsi !== true) return false;
    const today = new Date(now).toISOString().slice(0, 10);
    for (const line of dispatchLines) {
        if (!line.includes('"event":"rsi"')) continue;
        try {
            const e = JSON.parse(line);
            if (e.event === 'rsi' && String(e.at || '').startsWith(today)) return false;
        } catch { /* a cut line */ }
    }
    return true;
}

/** Normalize a gate reason into a recurrence key. */
export function gateSignature(reason = '') {
    return String(reason)
        .replace(/\d+/g, 'N')
        .replace(/\s+\S+\/\S+/g, ' <path>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

/** Internal model state for the fallback policy. */
const modelState = new Map();
let passSequence = 0;

/**
 * Record a gate result for a model.
 * @param {string} model - Model identifier (e.g., "nemotron", "recursive/flint")
 * @param {boolean} passed - Whether the gate passed
 */
export function recordModelGateResult(model, passed) {
    if (!model) return;
    const state = modelState.get(model) || { streak: 0, benched: false, lastPassedAt: null, passSeq: 0 };
    if (passed) {
        state.streak = 0;
        state.benched = false;
        state.lastPassedAt = Date.now();
        passSequence += 1;
        state.passSeq = passSequence;
    } else {
        state.streak += 1;
        if (state.streak >= 3) {
            state.benched = true;
        }
    }
    modelState.set(model, state);
}

/**
 * Select a model from the given list, skipping benched models and
 * falling back to the most recent last-known-good model.
 * The served model may be retried with 0-2 failures without a recorded pass.
 * Fallback candidates must have a recorded gate pass.
 * Among models with passes, the most recent pass (highest passSeq) wins.
 * @param {string[]} models - Ordered list of candidate models (preferred first)
 * @param {string} [servedModel] - Currently served model (allowed 0-2 failures without pass)
 * @returns {string|null} Selected model or null if none available
 */
export function selectModel(models = [], servedModel = null) {
    // First pass: served model - used unless benched (a fresh model with no record is allowed)
    if (servedModel && models.includes(servedModel)) {
        const state = modelState.get(servedModel);
        if (!state || !state.benched) {
            return servedModel;
        }
    }
    // Second pass: among preferred models with passes, pick the most recent pass
    let bestPreferred = null;
    let bestTime = -1;
    let bestSeq = -1;
    for (const model of models) {
        if (model === servedModel) continue;
        const state = modelState.get(model);
        if (state && !state.benched && state.lastPassedAt) {
            if (state.lastPassedAt > bestTime ||
                (state.lastPassedAt === bestTime && state.passSeq > bestSeq)) {
                bestPreferred = model;
                bestTime = state.lastPassedAt;
                bestSeq = state.passSeq;
            }
        }
    }
    if (bestPreferred) return bestPreferred;
    // Third pass: fallback to last-known-good across all models, using passSeq for tiebreaking
    let lastGood = null;
    let lastGoodTime = -1;
    let lastGoodSeq = -1;
    for (const [model, state] of modelState) {
        if (!state.benched && state.lastPassedAt) {
            if (state.lastPassedAt > lastGoodTime ||
                (state.lastPassedAt === lastGoodTime && state.passSeq > lastGoodSeq)) {
                lastGood = model;
                lastGoodTime = state.lastPassedAt;
                lastGoodSeq = state.passSeq;
            }
        }
    }
    return lastGood;
}

/**
 * Reset all model state (for testing).
 */
export function resetModelState() {
    modelState.clear();
}

/** Extract a brief `test:` line from an issue body, or null. */
export function testFromIssueBody(body = '') {
    const m = String(body).match(/(?:^|\n)\s*test:\s*(.+?)\s*(?:\n|$)/i);
    return m ? m[1].trim() : null;
}

/**
 * Propose up to `dailyCap` issues.
 * Sources:
 *  1. Recurring gate-failure signatures across the ledger
 *  2. High needs-human / fix-round exhaustion (from dispatchLog + ledger fixes)
 *  3. Open bot:journey / bot:review issues that already name a `test:` command
 *
 * Kit improvements target `kitRepo` (.github). Never proposes touching workflows/secrets.
 * Journey proposals without a known `test:` are skipped (gate would fail with "tests not run").
 *
 * `testsByRepo` (optional): { [repo]: testCommand } from config.json for journey briefs.
 */
export function proposeRsiIssues({
    rows = [],
    dispatchLog = [],
    journeyIssues = [],
    openRsi = [],
    filedKeys = [],
    kitRepo = '.github',
    minRecurrence = DEFAULTS.rsiMinRecurrence,
    dailyCap = DEFAULTS.rsiDailyIssueCap,
    testsByRepo = {},
    struggling = [],
} = {}) {
    const openTitles = new Set(openRsi.map((i) => i.title));
    const used = new Set(filedKeys);
    const out = [];
    const targetKit = kitRepo === '.github' ? '.github' : kitRepo;

    const take = (p) => {
        if (out.length >= dailyCap) return false;
        if (used.has(p.key) || openTitles.has(p.title)) return false;
        used.add(p.key);
        out.push(p);
        return true;
    };

    // ── 1. Recurring gate failures → kit PREAMBLE / gate lesson ───────────
    const reasons = {};
    for (const r of rows) {
        for (const x of r.gate?.reasons || []) {
            const k = gateSignature(x);
            (reasons[k] ||= { count: 0, samples: [] }).count++;
            if (reasons[k].samples.length < 5) reasons[k].samples.push(`${r.repo}#${r.issue || r.id}`);
        }
    }
    const ranked = Object.entries(reasons)
        .filter(([, v]) => v.count >= minRecurrence)
        .sort((a, b) => b[1].count - a[1].count);

    for (const [sig, v] of ranked) {
        const title = `imps RSI: reduce gate failure "${sig}"`;
        const key = `gate:${sig}`;
        const isSize = /^diff N lines/.test(sig);
        const allow = isSize ? 'imps/PREAMBLE.md, imps/STANDARD.md' : 'imps/PREAMBLE.md, imps/lib.mjs, imps/FIX.md, imps/REVIEW.md';
        const brief = [
            '---',
            `repo: ${targetKit}`,
            'issue: (set after create)',
            `maxLines: ${DEFAULTS.maxLines}`,
            `allow: ${allow}`,
            `test: ${KIT_TEST}`,
            '---',
            `## Recurring gate failure: \`${sig}\` (×${v.count})`,
            '',
            `Samples: ${v.samples.join(', ')}.`,
            '',
            '### The fix',
            isSize
                ? 'Add one PREAMBLE lesson: briefs must set a realistic `maxLines` and split oversized work. Do not raise the global default without evidence.'
                : 'Add one PREAMBLE (or FIX/REVIEW) lesson citing the sample runs, or tighten the gate in `lib.mjs` if the failure is a missing deterministic check. One lesson line. Do not touch `.github/workflows/` or secrets.',
            '',
            '### Done when',
            '- One lesson or gate rule lands under `allow:`.',
            `- Diff stays inside maxLines; \`${KIT_TEST}\` still passes.`,
        ].join('\n');
        take({
            key,
            title,
            repo: targetKit,
            body: `Recurring gate failure \`${sig}\` appeared **${v.count}** times.\n\nSamples: ${v.samples.join(', ')}.`,
            brief,
            kind: 'gate',
        });
    }

    // ── 1b. Repos where imps keep failing → curated per-repo memory ────────
    // `struggling` comes from memory.mjs strugglingRepos(): repo, stats and the
    // ledger notes. The brief asks an imp to turn them into imps/memory/<repo>.md,
    // which every later imp prompt for that repo includes (runner.loadBrief).
    for (const st of struggling) {
        const key = `struggle:${st.repo}:${st.week}`;
        // Stable title: the open-issue dedupe matches on it, so counts stay in the body.
        const title = `imps RSI: imps keep failing in ${st.repo}`;
        const brief = [
            '---',
            `repo: ${targetKit}`,
            'issue: (set after create)',
            'maxLines: 60',
            `allow: imps/memory/${st.repo}.md`,
            `test: ${KIT_TEST}`,
            '---',
            `## Imps keep failing in ${st.repo}`,
            '',
            `Last ${st.runs} runs: ${st.merged} merged, ${st.passed}/${st.gated} passed the gate. Samples: ${st.samples.join(', ')}.`,
            '',
            'What the ledger says:',
            ...st.notes.map((n) => `- ${n}`),
            '',
            '### The fix',
            `Create or update \`imps/memory/${st.repo}.md\`: 3 to 6 bullet lines, each naming one trap specific to this repo (a file layout, a test quirk, a command that fails, a convention imps keep breaking) and the rule that avoids it. Use the notes above and the sample issues' gate reasons; do not restate the general PREAMBLE rules.`,
            '',
            '### Done when',
            `- \`imps/memory/${st.repo}.md\` exists with 3 to 6 repo-specific lessons.`,
            `- \`${KIT_TEST}\` still passes.`,
        ].join('\n');
        take({
            key,
            title,
            repo: targetKit,
            body: `Imps merged ${st.merged} of the last ${st.runs} runs in ${st.repo}.\n\n${st.notes.map((n) => `- ${n}`).join('\n')}`,
            brief,
            kind: 'struggle',
        });
    }

    // ── 2. Needs-human / fix exhaustion ───────────────────────────────────
    const needsHuman = dispatchLog.filter((e) => e.event === 'fix-sweep' && /needs-human|max-rounds/i.test(String(e.result || '')));
    const fixFails = rows.filter((r) => (r.fixes || []).length >= DEFAULTS.fixMaxRounds && r.fixes.some((f) => f.gate && !f.gate.pass));
    if (needsHuman.length + fixFails.length >= minRecurrence) {
        const key = 'fix:needs-human';
        const title = 'imps RSI: cut fix-round needs-human rate';
        const brief = [
            '---',
            `repo: ${targetKit}`,
            'issue: (set after create)',
            `maxLines: ${DEFAULTS.maxLines}`,
            'allow: imps/FIX.md, imps/fix.mjs, imps/PREAMBLE.md',
            `test: ${KIT_TEST}`,
            '---',
            '## Fix rounds escalate to needs-human too often',
            '',
            `Dispatch fix-sweep signals: ${needsHuman.length}. Ledger exhausted fix rounds: ${fixFails.length}.`,
            '',
            '### The fix',
            'Add FIX.md lessons for the recurring misjudgements, or a deterministic skip in feedbackItems. Never widen path allowlists to `.github/`.',
        ].join('\n');
        take({
            key,
            title,
            repo: targetKit,
            body: `Fix rounds are hitting needs-human. Dispatch signals ${needsHuman.length}, exhausted ledger rounds ${fixFails.length}.`,
            brief,
            kind: 'fix',
        });
    }

    // ── 3. Journey / review findings → product-repo briefs ────────────────
    for (const j of journeyIssues) {
        if (j.labels?.some((l) => String(l).startsWith('imp:'))) continue;
        if (/<!--\s*imp-brief\s*-->/i.test(j.body || '')) continue;
        if (/baseline|screenshot|snapshot/i.test(j.title || '') && /stale|update/i.test(j.title || '')) continue;
        const testCmd = testFromIssueBody(j.body) || testsByRepo[j.repo] || null;
        if (!testCmd) continue; // without test: the gate fails with "tests not run"
        const key = `journey:${j.repo}#${j.number}`;
        const title = `imp: ${j.title}`.slice(0, 80);
        const allowGuess = j.repo === 'stash' ? 'packages/, docs/' : 'app/, src/, lib/, tests/';
        const brief = [
            '---',
            `repo: ${j.repo}`,
            `issue: ${j.number}`,
            `maxLines: ${Math.max(DEFAULTS.maxLines, 40)}`,
            `allow: ${allowGuess}`,
            `test: ${testCmd}`,
            '---',
            `## ${j.title}`,
            '',
            `Source: ${j.labels?.includes('bot:journey') ? 'bot:journey' : 'bot:review'} issue #${j.number}.`,
            '',
            '### Context from the issue',
            (j.body || '').replace(/```/g, '~~~').slice(0, 2500),
            '',
            '### The fix',
            'Apply the smallest change that makes the journey (or review finding) green. Update tests under allow. Do not touch `.github/`, lockfiles, or secrets. If a screenshot baseline must move, stop and leave it for a human (baselines are not imp work).',
            '',
            '### Done when',
            '- The described failure is fixed inside allow + maxLines.',
            '- Gate tests/lint for this brief pass.',
        ].join('\n');
        take({
            key,
            title,
            repo: j.repo,
            body: `Fed from journeys/review: ${j.repo}#${j.number}.\n\n${BRIEF_MARK} will be attached as a comment so the dispatcher can take it.`,
            brief,
            kind: 'journey',
        });
    }

    return out.slice(0, dailyCap);
}
