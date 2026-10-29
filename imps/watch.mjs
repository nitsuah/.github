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
const SHOWN = new Set(['pr', 'gate-fail', 'run-error', 'infra-fail', 'pr-error', 'fix-sweep', 'issue-cap', 'no-brief', 'error']);

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
        else if (e.event === 'gate-fail' || e.event === 'run-error' || e.event === 'infra-fail') {
            s.fail++;
            for (const r of Array.isArray(e.reasons) && e.reasons.length ? e.reasons : [e.event]) s.reasons[clean(r, 30)] = (s.reasons[clean(r, 30)] || 0) + 1;
        }
    }
    s.top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])[0] || null;
    return s;
}

export function collect(home, now = Date.now()) {
    const d = { now, lock: null, cycle: null, quota: [], running: [], events: [] };
    const lock = readJson(join(home, 'dispatch.lock'));
    if (lock) {
        const startedAt = Date.parse(lock.startedAt);
        if (Number.isFinite(startedAt)) d.lock = { startedAt, pid: lock.pid };
    }
    const events = tailJson(join(home, 'dispatch.jsonl'), 128 * KB);
    for (let i = events.length - 1; i >= 0 && !d.cycle; i--) if (events[i].event === 'cycle') d.cycle = events[i];
    d.day = dayStats(events, now);
    d.events = events.filter((e) => SHOWN.has(e.event)).slice(-12).reverse();
    const quota = readJson(join(home, 'model_quota.json')) || {};
    d.quota = Object.entries(quota).filter(([, v]) => v && v.used > 0).map(([m, v]) => [clean(m, 14), Number(v.used)]);
    const seen = new Set();
    for (const r of tailJson(join(home, 'runs.jsonl'), 64 * KB).reverse()) {
        if (!r.id || seen.has(r.id)) continue;
        seen.add(r.id);
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
        default: return `${c.red(`✗ ${clean(e.event, 14)}`)} ${ref} ${ago}`;
    }
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
