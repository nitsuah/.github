// Pure helpers for imps: brief parsing, run metrics, the pre-push gate and
// the RSI report. No I/O, no deps. Tested in lib.test.mjs (node --test).

// A brief is markdown with an optional `---` front matter of `key: value`
// lines (repo, issue, test, maxLines, allow). Returns { meta, body }.
export function parseBrief(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
    }
    return { meta, body: text.slice(m[0].length) };
}

// One pass over a `claude -p --output-format stream-json` transcript.
// Everything the RSI loop wants per run: turns and their timing, tool use and
// tool errors by kind, permission denials, tokens, served models (and how
// often the router switched model mid-run), and how the run ended.
export function summarizeRun(events, { startedAt, endedAt } = {}) {
    const s = {
        turns: 0, tools: {}, toolErrors: 0, errorKinds: {}, denials: 0,
        served: [], modelSwitches: 0, turnMs: { max: 0, median: 0 },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costEstimateUsd: null, end: 'no-result', isError: true, durationMs: null, finalText: '',
    };
    const stamps = [];
    let last = null;
    for (const e of events) {
        if (e.type === 'assistant') {
            const model = e.message?.model;
            if (model) {
                if (!s.served.includes(model)) s.served.push(model);
                if (last && model !== last) s.modelSwitches++;
                last = model;
            }
            if (e._ts) stamps.push(e._ts);
            for (const c of e.message?.content || [])
                if (c.type === 'tool_use') s.tools[c.name] = (s.tools[c.name] || 0) + 1;
        } else if (e.type === 'user') {
            for (const c of e.message?.content || []) {
                if (c.type !== 'tool_result' || !c.is_error) continue;
                s.toolErrors++;
                const k = errorKind(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
                s.errorKinds[k] = (s.errorKinds[k] || 0) + 1;
            }
        } else if (e.type === 'system' && e.subtype === 'permission_denied') {
            s.denials++;
        } else if (e.type === 'result') {
            s.turns = e.num_turns ?? s.turns;
            s.end = e.subtype || 'result';
            s.isError = !!e.is_error;
            s.durationMs = e.duration_ms ?? null;
            s.costEstimateUsd = e.total_cost_usd ?? null;
            s.finalText = String(e.result ?? '').slice(0, 2000);
            const u = e.usage || {};
            s.tokens = {
                input: u.input_tokens || 0,
                output: u.output_tokens || 0,
                cacheRead: u.cache_read_input_tokens || 0,
                cacheWrite: u.cache_creation_input_tokens || 0,
            };
        }
    }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    if (gaps.length) s.turnMs = { max: gaps[gaps.length - 1], median: gaps[Math.floor(gaps.length / 2)] };
    if (s.durationMs == null && startedAt && endedAt) s.durationMs = endedAt - startedAt;
    return s;
}

// Coarse buckets so errors aggregate across runs.
export function errorKind(text = '') {
    if (/String to replace not found/i.test(text)) return 'edit-miss';
    if (/File has not been read yet|must read/i.test(text)) return 'edit-unread';
    if (/InputValidationError|No changes to make/i.test(text)) return 'bad-tool-call';
    if (/permission|not allowed|denied|requires approval/i.test(text)) return 'denied';
    if (/No such file|ENOENT|does not exist/i.test(text)) return 'missing-path';
    if (/exit code [1-9]|Exit code [1-9]/.test(text)) return 'command-failed';
    if (/timed? ?out/i.test(text)) return 'timeout';
    return 'other';
}

const DENY = [/^\.github\//, /(^|\/)\.env/, /(^|\/)secrets?\//i, /package-lock\.json$/];

// The pre-push gate. Deterministic: numstat lines from
// `git diff --numstat <base>..HEAD`, commit messages, and the test exit code.
export function gate({ numstat, commits, testExit, maxLines = 80, allow = [] }) {
    const files = numstat
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [a, d, path] = l.split('\t');
            return { path, lines: (Number(a) || 0) + (Number(d) || 0) };
        });
    const lines = files.reduce((n, f) => n + f.lines, 0);
    const reasons = [];
    if (!commits.length) reasons.push('no commits');
    for (const f of files) {
        if (DENY.some((re) => re.test(f.path))) reasons.push(`denied path ${f.path}`);
        if (allow.length && !allow.some((p) => f.path.startsWith(p))) reasons.push(`outside scope ${f.path}`);
    }
    if (lines > maxLines) reasons.push(`diff ${lines} lines > ${maxLines}`);
    if (commits.length && !commits.every((c) => /Co-Authored-By: .*imp/i.test(c))) reasons.push('commit missing imp trailer');
    if (testExit !== 0) reasons.push(testExit == null ? 'tests not run' : `tests exit ${testExit}`);
    return { pass: reasons.length === 0, reasons, lines, files: files.map((f) => f.path) };
}

// RSI report over ledger rows: one line per model mix, plus the error kinds and
// gate reasons that keep coming back (those are what the next preamble fixes).
export function report(rows) {
    const out = [];
    const n = rows.length;
    const passed = rows.filter((r) => r.gate?.pass).length;
    const merged = rows.filter((r) => r.outcome === 'merged').length;
    out.push(`runs ${n} · gate pass ${passed} · merged ${merged}`);
    const sum = (k) => rows.reduce((a, r) => a + (r.metrics?.tokens?.[k] || 0), 0);
    out.push(`tokens in ${sum('input')} (cache read ${sum('cacheRead')}) · out ${sum('output')}`);
    const tally = (pick) => {
        const t = {};
        for (const r of rows) for (const [k, v] of Object.entries(pick(r) || {})) t[k] = (t[k] || 0) + v;
        return Object.entries(t).sort((a, b) => b[1] - a[1]);
    };
    out.push('', '| run | issue | brief | model | turns | min | tool err | switches | gate | outcome |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
        const m = r.metrics || {};
        out.push(`| ${r.id} | ${r.repo}#${r.issue ?? '?'} | ${r.briefHash?.slice(0, 7) ?? ''} | ${r.model}${m.served?.length > 1 ? ` (${m.served.length} served)` : ''} | ${m.turns ?? ''} | ${m.durationMs ? (m.durationMs / 60000).toFixed(1) : ''} | ${m.toolErrors ?? ''} | ${m.modelSwitches ?? ''} | ${r.gate ? (r.gate.pass ? 'pass' : 'fail') : '…'} | ${r.outcome ?? ''} |`);
    }
    const errs = tally((r) => r.metrics?.errorKinds);
    if (errs.length) out.push('', 'tool errors: ' + errs.map(([k, v]) => `${k} ${v}`).join(' · '));
    const reasons = {};
    for (const r of rows) for (const x of r.gate?.reasons || []) {
        const k = x.replace(/\d+/g, 'N').replace(/ \S+\/\S+$/, ' <path>');
        reasons[k] = (reasons[k] || 0) + 1;
    }
    const rs = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    if (rs.length) out.push('gate failures: ' + rs.map(([k, v]) => `${k} ×${v}`).join(' · '));
    return out.join('\n');
}
