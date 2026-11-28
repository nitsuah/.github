#!/usr/bin/env node
// Live view of the imps. Read-only: it never writes, never spawns, never touches the network.
//   node watch.mjs --statusline   rows for Claude Code's statusLine command (finishes in a few ms)
//   node watch.mjs                full-screen view, redraws at 1 Hz, `q` quits
// Flags: --once (one frame, no TTY), --home <dir> (default IMPS_HOME or ~/.imps), --no-color.
// Only the TAIL of each file is read, so cost does not grow with history. Everything read from a
// file is sanitized and truncated; Bash bodies and tool inputs are cut down to a few chars
// because transcripts can hold secrets. Contract and settings snippet: README.md "Watching a run".
import { closeSync, fstatSync, openSync, readSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const KB = 1024;
const STALL_MS = 2 * 60 * 1000;
const STALE_RUN_MS = 6 * 3600 * 1000;
const SHOWN = new Set(['pr', 'gate-fail', 'run-error', 'infra-fail', 'pr-error', 'fix-sweep', 'issue-cap', 'no-brief', 'error', 'commit-recovery-failed', 'retry-feedback', 'invalid-brief']);
// Events that mean a run ended without a PR (counted as 24 h failures).
const FAILED = new Set(['gate-fail', 'run-error', 'infra-fail', 'commit-recovery-failed', 'retry-feedback']);

const clean = (s, n) => {
    const t = String(s ?? '').replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b[\\])?)/g, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// Last `bytes` of a file as complete lines. A cut first line and a half-written last line are
// dropped by the JSON parse, never thrown on.
export function tailLines(file, bytes) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        const lines = buf.toString('utf8').split('\n');
        if (start > 0) lines.shift();
        return lines;
    } catch {
        return [];
    } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ }
    }
}

const tailJson = (file, bytes) => {
    const out = [];
    for (const l of tailLines(file, bytes)) {
        if (!l.trim()) continue;
        try { out.push(JSON.parse(l)); } catch { /* half-written or cut line */ }
    }
    return out;
};

const readJson = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

const alive = (pid) => {
    if (!Number.isInteger(pid)) return true; // no pid recorded: trust the age check
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// What the imp is doing right now: its last tool_use, reduced to a safe label.
export function lastTool(transcript) {
    const evs = tailJson(transcript, 32 * KB);
    const ts = evs.reduce((m, e) => (Number.isFinite(e?._ts) && e._ts > m ? e._ts : m), 0);
    for (let i = evs.length - 1; i >= 0; i--) {
        const blocks = evs[i]?.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j];
            if (b?.type !== 'tool_use') continue;
            const inp = b.input || {};
            let arg = '';
            if (b.name === 'Bash') arg = String(inp.command || '').trim().split(/\s+/)[0];
            else if (inp.file_path || inp.path) arg = basename(String(inp.file_path || inp.path).replace(/\\/g, '/'));
            else if (inp.pattern) arg = String(inp.pattern);
            return { label: clean(`${b.name} ${clean(arg, 40)}`, 52), ts };
        }
    }
    return { label: '', ts };
}

// Throughput over the last 24 h (as far back as the tail reaches): outcomes and the commonest gate reason.
export function dayStats(events, now) {
    const s = { pr: 0, fail: 0, reasons: {} };
    for (const e of events) {
        const t = Date.parse(e.at);
        if (!Number.isFinite(t) || now - t > 24 * 3600 * 1000) continue;
        if (e.event === 'pr') s.pr++;
        else if (FAILED.has(e.event)) {
            s.fail++;
            for (const r of Array.isArray(e.reasons) && e.reasons.length ? e.reasons : [e.event]) s.reasons[clean(r, 30)] = (s.reasons[clean(r, 30)] || 0) + 1;
        }
    }
    s.top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])[0] || null;
    return s;
}

const CLOSED = new Set(['merged', 'closed', 'abandoned']);
const HOUR = 3600 * 1000;

/**
 * Loop health from the dispatch log alone (no spawning, no network): `ok`
 * while a cycle holds the lock or the last cycle is under 75 min old, `stale`
 * up to 3 h, `down` after that. The newest skip reason after the last cycle
 * (e.g. "9router not up after 10 min") is the likely cause.
 */
export function loopHealth(events, lock, now) {
    let lastCycle = null;
    let skip = null;
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.event === 'cycle') { lastCycle = Date.parse(e.at); break; }
        if (!skip && e.event === 'skip' && !/previous cycle still running/.test(String(e.reason || ''))) skip = clean(e.reason, 40);
    }
    if (lock) return { state: 'ok', lastCycle, skip };
    if (!Number.isFinite(lastCycle)) return { state: events.length ? 'stale' : 'unknown', lastCycle: null, skip };
    const age = now - lastCycle;
    return { state: age < 1.25 * HOUR ? 'ok' : age < 3 * HOUR ? 'stale' : 'down', lastCycle, skip };
}

export function collect(home, now = Date.now()) {
    const d = { now, lock: null, cycle: null, quota: [], running: [], events: [], prs: [] };
    const lock = readJson(join(home, 'dispatch.lock'));
    if (lock) {
        const startedAt = Date.parse(lock.startedAt);
        if (Number.isFinite(startedAt)) d.lock = { startedAt, pid: lock.pid };
    }
    const events = tailJson(join(home, 'dispatch.jsonl'), 128 * KB);
    for (let i = events.length - 1; i >= 0 && !d.cycle; i--) if (events[i].event === 'cycle') d.cycle = events[i];
    d.day = dayStats(events, now);
    d.health = loopHealth(events, d.lock, now);
    d.events = events.filter((e) => SHOWN.has(e.event)).slice(-12).reverse();
    // The newest fix-sweep result per PR: "needs-human" means the PR is waiting on you.
    const sweep = new Map();
    for (const e of events) if (e.event === 'fix-sweep' && e.pr) sweep.set(prNumber(e.pr) + '@' + clean(e.pr, 200), String(e.result || ''));
    const quota = readJson(join(home, 'model_quota.json')) || {};
    d.quota = Object.entries(quota).filter(([, v]) => v && v.used > 0).map(([m, v]) => [clean(m, 14), Number(v.used)]);
    const seen = new Set();
    for (const r of tailJson(join(home, 'runs.jsonl'), 256 * KB).reverse()) {
        if (!r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        if (r.pr && !CLOSED.has(r.outcome)) {
            const swept = sweep.get(prNumber(r.pr) + '@' + clean(r.pr, 200)) || '';
            const needsYou = r.review?.verdict === 'request_changes' || /needs-human/.test(swept) || r.outcome === 'needs-human';
            d.prs.push({ repo: r.repo, issue: r.issue, pr: prNumber(r.pr), needsYou, review: r.review?.verdict || null });
        }
        const t0 = Date.parse(r.startedAt);
        if (r.endedAt || !Number.isFinite(t0) || now - t0 > STALE_RUN_MS || !alive(r.pid)) continue;
        d.running.push({
            repo: r.repo, issue: r.issue, t0,
            turns: r.metrics?.turns, toolErrors: r.metrics?.toolErrors,
            ...(({ label, ts }) => ({ tool: label, lastActive: ts }))(lastTool(r.transcript || join(home, 'runs', `${r.id}.jsonl`))),
        });
    }
    d.running.sort((a, b) => a.t0 - b.t0);
    return d;
}

const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 48 * 3600) return `${Math.floor(s / 86400)}d${String(Math.floor(s / 3600) % 24).padStart(2, '0')}h`;
    return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const paint = (color) => {
    const on = (c) => (s) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
    return { dim: on(2), bold: on(1), green: on(32), red: on(31), cyan: on(36), yellow: on(33) };
};

const prNumber = (url) => (String(url || '').match(/\/pull\/(\d+)/) || [])[1];

function eventRow(e, c, now) {
    const ago = Number.isFinite(Date.parse(e.at)) ? c.dim(`${dur(now - Date.parse(e.at))} ago`) : '';
    const ref = e.repo ? `${clean(e.repo, 16)}#${clean(e.number, 6)}` : '';
    switch (e.event) {
        case 'pr': return `${c.green(`✓ PR #${clean(prNumber(e.url) ?? '?', 6)}`)} ${ref} ${ago}`;
        case 'gate-fail': return `${c.red('✗ gate-fail')} ${ref} ${c.dim(clean((e.reasons || []).join(', '), 40))} ${ago}`;
        case 'fix-sweep': return `${c.cyan(`↻ fix-sweep #${clean(prNumber(e.pr) ?? '?', 6)}`)} ${c.dim(clean(e.result, 24))} ${ago}`;
        case 'issue-cap': case 'no-brief': return `${c.yellow(`· ${e.event}`)} ${ref} ${ago}`;
        case 'retry-feedback': return `${c.yellow('↺ retry')} ${ref} ${c.dim(clean((e.reasons || []).join(', '), 30))} ${ago}`;
        case 'commit-recovery-failed': return `${c.red('✗ uncommitted')} ${ref} ${c.dim(clean(e.reason, 24))} ${ago}`;
        case 'invalid-brief': return `${c.red('✗ bad brief')} ${ref} ${c.dim(clean(e.reason, 30))} ${ago}`;
        default: return `${c.red(`✗ ${clean(e.event, 14)}`)} ${ref} ${ago}`;
    }
}

/**
 * One square per thing in flight, in the same colours as the vuln view:
 * blue ■ an imp running, red ■ an imp PR that needs you, yellow ■ an imp PR
 * waiting on CI/review, dim □ a queued issue not yet picked, then the last
 * 24 h as small marks: green ▪ a PR opened, red ▪ a failed run.
 */
export function tiles(d, { color = true } = {}) {
    const c = paint(color);
    const out = [];
    for (let i = 0; i < d.running.length; i++) out.push(c.cyan('■'));
    const prs = d.prs || [];
    for (const p of prs) if (p.needsYou) out.push(c.red('■'));
    for (const p of prs) if (!p.needsYou) out.push(c.yellow('■'));
    const picked = Array.isArray(d.cycle?.picked) ? d.cycle.picked.length : 0;
    const waiting = Math.max(0, Math.min(12, (Number(d.cycle?.queued) || 0) - picked));
    for (let i = 0; i < waiting; i++) out.push(c.dim('□'));
    const day = [];
    for (let i = 0; i < Math.min(d.day?.pr || 0, 12); i++) day.push(c.green('▪'));
    for (let i = 0; i < Math.min(d.day?.fail || 0, 12); i++) day.push(c.red('▪'));
    return [out.join(' '), day.join('')].filter(Boolean).join('  ');
}

/** The compact headline for the combined status line: state, squares, 24 h, queue, quota. */
export function headline(d, { color = true } = {}) {
    const c = paint(color);
    const h = d.health || { state: 'unknown' };
    const parts = [];
    if (d.lock) parts.push(c.green(`● imps ${dur(d.now - d.lock.startedAt)}`));
    else if (h.state === 'down') parts.push(c.red(`✗ imps down ${h.lastCycle ? dur(d.now - h.lastCycle) : ''}`.trim()));
    else if (h.state === 'stale') parts.push(c.yellow(`◐ imps stale ${h.lastCycle ? dur(d.now - h.lastCycle) : ''}`.trim()));
    else parts.push(c.dim(`○ imps idle${h.lastCycle ? ` · last cycle ${dur(d.now - h.lastCycle)} ago` : ''}`));
    const sq = tiles(d, { color });
    if (sq) parts.push(sq);
    const need = (d.prs || []).filter((p) => p.needsYou).length;
    if (need) parts.push(c.red(`⚠ ${need} need${need > 1 ? '' : 's'} you`));
    if (d.day && d.day.pr + d.day.fail > 0) parts.push(`24h ${c.green(`${d.day.pr} pr`)} ${d.day.fail ? c.red(`${d.day.fail} fail`) : c.dim('0 fail')}`);
    if (d.cycle) {
        const picked = Array.isArray(d.cycle.picked) ? d.cycle.picked.length : 0;
        const waiting = Math.max(0, (Number(d.cycle.queued) || 0) - picked);
        if (waiting || picked) parts.push(c.dim(`queue ${waiting}`));
        const cool = Object.keys(d.cycle.cooldown || {}).map((k) => clean(k, 14));
        if (cool.length) parts.push(c.yellow(`cooldown ${cool.slice(0, 2).join(',')}`));
    }
    if (h.state !== 'ok' && h.skip) parts.push(c.red(clean(h.skip, 40)));
    if (d.quota.length) parts.push(c.dim(d.quota.map(([m, u]) => `${m} ${u}`).join(' ')));
    return parts.join(c.dim(' · '));
}

/** Rows for the combined status line: headline, one row per running imp, PRs that need you, latest events. */
export function compact(d, { color = true, lanes = 3 } = {}) {
    const c = paint(color);
    const rows = [headline(d, { color })];
    for (const r of d.running.slice(0, lanes)) {
        const errs = r.toolErrors > 0 ? c.red(`e${r.toolErrors}`) : c.dim(`e${r.toolErrors ?? 0}`);
        const stalled = r.lastActive && d.now - r.lastActive > STALL_MS ? ` ${c.yellow(`stalled ${dur(d.now - r.lastActive)}`)}` : '';
        rows.push(`  ${c.cyan('■')} ${c.bold(pad(`${clean(r.repo, 16)}#${clean(r.issue, 6)}`, 20))} ${pad(dur(d.now - r.t0), 7)} t${pad(String(r.turns ?? 0), 3)} ${errs} ${c.dim(r.tool)}${stalled}`);
    }
    if (d.running.length > lanes) rows.push(c.dim(`  +${d.running.length - lanes} more running`));
    const need = (d.prs || []).filter((p) => p.needsYou).slice(0, 3);
    if (need.length) rows.push(`  ${c.red('■')} ${need.map((p) => `${clean(p.repo, 16)} PR #${clean(p.pr, 6)}${p.review === 'request_changes' ? ' changes requested' : ' needs-human'}`).join(c.dim(' │ '))}`);
    const evs = d.events.slice(0, 2);
    if (evs.length) rows.push(`  ${evs.map((e) => eventRow(e, c, d.now)).join(c.dim(' │ '))}`);
    return rows.join('\n');
}

// Rows for the status line (full=false: 3-5 rows) or the full-screen view (full=true).
export function render(d, { color = true, full = false } = {}) {
    const c = paint(color);
    const rows = [];
    const head = [];
    head.push(d.lock ? c.green(`● imps running ${dur(d.now - d.lock.startedAt)}`) : c.dim('○ imps idle'));
    if (d.cycle) {
        const picked = Array.isArray(d.cycle.picked) ? d.cycle.picked.length : 0;
        head.push(`queue ${clean(d.cycle.queued ?? '?', 5)}${Number(d.cycle.queued) > picked ? ` (${d.cycle.queued - picked} waiting)` : ''}`, `picked ${picked}`);
        const cool = Object.keys(d.cycle.cooldown || {}).map((k) => clean(k, 14));
        if (Number.isFinite(d.cycle.runsLast24h)) head.push(`runs ${d.cycle.runsLast24h}/24h`);
        if (cool.length) head.push(c.yellow(`cooldown ${cool.slice(0, 3).join(',')}`));
        if (!d.lock && Number.isFinite(Date.parse(d.cycle.at))) head.push(c.dim(`last cycle ${dur(d.now - Date.parse(d.cycle.at))} ago`));
    }
    if (d.quota.length) head.push(`quota ${d.quota.map(([m, u]) => `${m} ${u}`).join(' ')}`);
    rows.push(head.join(c.dim(' │ ')));
    if (full) {
        const h = d.health || {};
        if (h.state === 'down' || h.state === 'stale') rows.push((h.state === 'down' ? c.red : c.yellow)(`  loop ${h.state}: last cycle ${h.lastCycle ? `${dur(d.now - h.lastCycle)} ago` : 'never'}${h.skip ? ` · ${h.skip}` : ''}`));
        const sq = tiles(d, { color });
        if (sq) rows.push(`  ${sq}`);
        for (const p of (d.prs || []).slice(0, 6)) rows.push(`  ${p.needsYou ? c.red('■') : c.yellow('■')} ${clean(p.repo, 16)}#${clean(p.issue, 6)} PR #${clean(p.pr, 6)} ${c.dim(p.review || 'no review yet')}${p.needsYou ? ` ${c.red('needs you')}` : ''}`);
    }
    if (d.day && d.day.pr + d.day.fail > 0) {
        const top = d.day.top ? ` · top: ${d.day.top[0]} ×${d.day.top[1]}` : '';
        rows.push(`  24h: ${c.green(`${d.day.pr} pr`)} ${c.red(`${d.day.fail} fail`)}${c.dim(top)}`);
    }
    const lanes = d.running.slice(0, full ? 8 : 3);
    for (const r of lanes) {
        const errs = r.toolErrors > 0 ? c.red(`e${r.toolErrors}`) : c.dim(`e${r.toolErrors ?? 0}`);
        rows.push(`  ${c.bold(pad(`${clean(r.repo, 16)}#${clean(r.issue, 6)}`, 22))} ${pad(dur(d.now - r.t0), 7)} t${pad(String(r.turns ?? 0), 3)} ${errs} ${c.dim(r.tool)}${r.lastActive && d.now - r.lastActive > STALL_MS ? ` ${c.yellow(`stalled ${dur(d.now - r.lastActive)}`)}` : ''}`);
    }
    if (d.running.length > lanes.length) rows.push(c.dim(`  +${d.running.length - lanes.length} more`));
    const evs = d.events.slice(0, full ? 12 : 3);
    if (evs.length) rows.push(evs.map((e) => eventRow(e, c, d.now)).join(full ? '\n' : c.dim(' │ ')));
    else rows.push(c.dim('no dispatch events yet'));
    return rows.join('\n');
}

const o = (() => {
    try {
        return parseArgs({
            options: { statusline: { type: 'boolean' }, once: { type: 'boolean' }, home: { type: 'string' }, 'no-color': { type: 'boolean' } },
            strict: false,
        }).values;
    } catch { return {}; }
})();

const resolveHome = () => o.home || process.env.IMPS_HOME || join(homedir(), '.imps');

function statusline() {
    // Claude Code pipes session JSON to stdin; this never reads it, so there is nothing to block on.
    let text;
    try {
        text = render(collect(resolveHome()), { color: !o['no-color'] && !process.env.NO_COLOR });
    } catch {
        text = o['no-color'] ? 'imps: status unavailable' : '\x1b[2mimps: status unavailable\x1b[0m';
    }
    try { writeSync(1, `${text}\n`); } catch { /* closed pipe: Claude Code cancelled this run */ }
    process.exit(0);
}

function fullscreen() {
    const color = !o['no-color'] && !process.env.NO_COLOR;
    const frame = () => {
        try { return render(collect(resolveHome()), { color, full: true }); } catch { return 'imps: status unavailable'; }
    };
    if (o.once || !process.stdout.isTTY) {
        process.stdout.write(`${frame()}\n`);
        return;
    }
    const out = process.stdout;
    const quit = () => {
        clearInterval(timer);
        out.write('\x1b[?25h\x1b[?1049l');
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
    };
    const draw = () => out.write(`\x1b[H\x1b[2J${frame()}\n${paint(color).dim('q to quit')}\n`);
    out.write('\x1b[?1049h\x1b[?25l');
    draw();
    const timer = setInterval(draw, 1000);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (k) => { if (k[0] === 0x71 || k[0] === 0x03) quit(); });
    }
    process.on('SIGINT', quit);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (o.statusline) statusline();
    else fullscreen();
}
