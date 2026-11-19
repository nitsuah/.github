#!/usr/bin/env node
// One Claude Code statusLine for everything that runs unattended on this machine
// (Claude Code allows a single statusLine command):
//   imps  the dispatch loop: health, squares for running imps / PRs / queue, lanes, latest events
//   vuln  the security-program pipeline, when this machine has it: full rows while it has open
//         PRs, workers or something that needs you; one dim line when it is idle
// Read-only: no network, no writes, no child processes. A missing or broken vuln
// checkout never breaks or delays the imps rows.
//
//   node imps/statusline.mjs [--no-color] [--home <imps home>] [--vuln <security-program/vuln dir>]
//
// settings.json: { "statusLine": { "type": "command",
//   "command": "node C:/Users/<you>/AppData/Local/imps-runner/imps/statusline.mjs", "refreshInterval": 5 } }
// IMPS_VULN_DIR overrides the vuln location; IMPS_VULN=0 hides the vuln section.
import { existsSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { collect, compact } from './watch.mjs';

const COLOR = { green: 32, yellow: 33, red: 31, cyan: 36, grey: 90, dim: 2, bold: 1 };
const paint = (color) => (name, t) => (color ? `\u001b[${COLOR[name]}m${t}\u001b[0m` : t);

/** Where the vuln pipeline lives: --vuln, IMPS_VULN_DIR, else <IMPS_CODE or ~/code>/security-program/vuln. */
export function vulnDir(o = {}, env = process.env) {
    if (env.IMPS_VULN === '0') return null;
    const dir = o.vuln || env.IMPS_VULN_DIR || join(env.IMPS_CODE || join(homedir(), 'code'), 'security-program', 'vuln');
    return existsSync(join(dir, 'watch.mjs')) && existsSync(join(dir, 'lib.mjs')) ? dir : null;
}

/** Whether the vuln section deserves full rows: something open, running or waiting on you. */
export const vulnActive = (s) => !!s && ((s.open || 0) > 0 || (s.running || 0) > 0 || (s.attention || []).length > 0);

/** One dim line for an idle pipeline. */
export function vulnIdleLine(s, { color = true } = {}) {
    const c = paint(color);
    const tick = s?.lastTick?.t ? ` · train ${ago(Date.now() - Date.parse(s.lastTick.t))} ago` : '';
    return c('dim', `○ vuln idle · ${s?.merged ?? 0} merged${tick}`);
}

const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
};

/**
 * Full vuln rows in the imps layout: a headline with the pipeline's own squares,
 * then what needs you (or what is next). `tiles` is the vuln statusline's tile
 * renderer when it exports one.
 */
export function vulnRows(s, { color = true, tiles = null } = {}) {
    const c = paint(color);
    const head = [c('green', '● vuln')];
    const sq = typeof tiles === 'function' ? tiles(s, { color }) : '';
    if (sq) head.push(sq);
    head.push(`${s.open} open`);
    if (s.running) head.push(c('cyan', `${s.running} worker${s.running > 1 ? 's' : ''}`));
    if (s.attention?.length) head.push(c('red', `⚠ ${s.attention.length} need${s.attention.length > 1 ? '' : 's'} you`));
    if (s.unproven) head.push(c('yellow', `${s.unproven} unproven`));
    if (s.failures) head.push(c('red', `${s.failures} failed/h`));
    const tick = s.lastTick?.t ? Date.now() - Date.parse(s.lastTick.t) : null;
    if (tick != null) head.push(tick > 45 * 60_000 && s.open ? c('yellow', `train ${ago(tick)} ago`) : c('dim', `train ${ago(tick)} ago`));
    const rows = [head.join(c('dim', ' · '))];
    const name = (r) => String(r?.repo || '').split('/').pop();
    if (s.attention?.length) {
        rows.push(`  ${c('red', '■')} ${s.attention.slice(0, 3).map(({ r, a }) => `${name(r)}#${r.number} ${a.action}`).join(c('dim', ' │ '))}`);
    } else if (s.latest) {
        const next = [...s.latest.values()].filter((a) => a.action !== 'done').slice(0, 3).map((a) => `${name(a)}#${a.number} ${a.action}`);
        if (next.length) rows.push(`  ${c('yellow', '■')} ${next.join(c('dim', ' │ '))}`);
    }
    return rows;
}

async function vulnSection(dir, { color }) {
    try {
        const url = (f) => pathToFileURL(join(dir, f)).href;
        const watch = await import(url('watch.mjs'));
        const lib = await import(url('lib.mjs'));
        let tiles = null;
        try { tiles = (await import(url('statusline.mjs'))).tiles || null; } catch { tiles = null; }
        const s = watch.summarize({ registry: lib.loadRegistry(), events: lib.recentEvents(400), workers: watch.workerStates() });
        return vulnActive(s) ? vulnRows(s, { color, tiles }) : [vulnIdleLine(s, { color })];
    } catch {
        return [];
    }
}

export async function statusRows({ home, vuln, color = true } = {}) {
    let imps;
    try {
        imps = compact(collect(home), { color });
    } catch {
        imps = paint(color)('dim', 'imps: status unavailable');
    }
    const v = vuln ? await vulnSection(vuln, { color }) : [];
    return [imps, ...v].join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const o = (() => {
        try {
            return parseArgs({ options: { home: { type: 'string' }, vuln: { type: 'string' }, 'no-color': { type: 'boolean' } }, strict: false }).values;
        } catch { return {}; }
    })();
    const color = !o['no-color'] && !process.env.NO_COLOR;
    const home = o.home || process.env.IMPS_HOME || join(homedir(), '.imps');
    // Claude Code pipes session JSON on stdin; nothing here reads it, so nothing blocks.
    const text = await statusRows({ home, vuln: vulnDir(o), color });
    try { writeSync(1, `${text}\n`); } catch { /* closed pipe */ }
    process.exit(0);
}
