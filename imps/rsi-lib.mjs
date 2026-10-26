// Pure RSI helpers: turn ledger/dispatch/journey signals into issue proposals.
// File I/O is limited to loadRsiConfigFile. Tested in rsi-lib.test.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { DEFAULTS } from './defaults.mjs';
import { BRIEF_MARK } from './lib.mjs';

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

/** Normalize a gate reason into a recurrence key. */
export function gateSignature(reason = '') {
    return String(reason)
        .replace(/\d+/g, 'N')
        .replace(/\s+\S+\/\S+/g, ' <path>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

/**
 * Propose up to `dailyCap` issues.
 * Sources:
 *  1. Recurring gate-failure signatures across the ledger
 *  2. High needs-human / fix-round exhaustion (from dispatchLog + ledger fixes)
 *  3. Open bot:journey / bot:review issues without an imp brief yet
 *
 * Kit improvements (PREAMBLE/REVIEW/FIX/lib gate) target `kitRepo` (.github).
 * Product bugs target their own repo. Never proposes touching workflows/secrets.
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
            '- Diff stays inside maxLines; tests in the kit (`node --test imps/*.test.mjs`) still pass.',
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
        // Visual baseline churn is usually runner/human work, not an imp.
        if (/baseline|screenshot|snapshot/i.test(j.title || '') && /stale|update/i.test(j.title || '')) continue;
        const key = `journey:${j.repo}#${j.number}`;
        const title = `imp: ${j.title}`.slice(0, 80);
        const allowGuess = j.repo === 'stash' ? 'packages/, docs/' : 'app/, src/, lib/, tests/';
        const brief = [
            '---',
            `repo: ${j.repo}`,
            `issue: ${j.number}`,
            `maxLines: ${Math.max(DEFAULTS.maxLines, 40)}`,
            `allow: ${allowGuess}`,
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
            body: `Fed from journeys/review: ${j.repo}#${j.number}.\n\n${BRIEF_MARK} will be attached so the dispatcher can take it.`,
            brief,
            kind: 'journey',
        });
    }

    return out.slice(0, dailyCap);
}
