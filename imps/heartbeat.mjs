#!/usr/bin/env node
// Report this machine's liveness, kit commit, and last cycle to GitHub, so
// "which machines are alive and current" is one `gh issue list` (#61).
//
//   node imps/heartbeat.mjs [--dry-run]
//
// Called at the end of a dispatch cycle. Opt-in: does nothing unless
// IMPS_HEARTBEAT=1 or config.json has "heartbeat": true — a second machine that
// should not advertise itself just leaves it off.
//
// There is one issue per machine, titled `imps heartbeat: <machine>`, living in
// the kit repo. Runs.jsonl and dispatch.jsonl are per machine; this is the only
// piece of state the fleet shares, and it is deliberately tiny.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, LEDGER, rows, kitSha, machineName } from './runner.mjs';
import { DEFAULTS } from './defaults.mjs';

const dry = process.argv.includes('--dry-run');
const config = (() => {
    try {
        return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
    } catch {
        return {};
    }
})();

const enabled = config.heartbeat === true || ['1', 'true'].includes(String(process.env.IMPS_HEARTBEAT || '').toLowerCase());
if (!enabled) process.exit(0);

// Resolve machine name once, shared across all four record types:
// heartbeat issues, claim comments, ledger rows, dispatch events.
// Falls back to hostname if IMPS_MACHINE and config.machine are both unset.
function resolveMachine(config, env) {
    return env.IMPS_MACHINE || config.machine || machineName();
}
const machine = resolveMachine(config, process.env);
const title = `imps heartbeat: ${machine}`;
const repo = config.kitRepo || DEFAULTS.kitRepo;

// Last cycle this machine ran, from its own log.
const cycle = (() => {
    try {
        const lines = readFileSync(join(HOME, 'dispatch.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
        return JSON.parse(lines[lines.length - 1]);
    } catch {
        return null;
    }
})();

const today = new Date().toISOString().slice(0, 10);
const runsToday = rows().filter((r) => (r.startedAt || '').startsWith(today)).length;

const body = [
    '<!-- imp-heartbeat -->',
    `| field | value |`,
    `| --- | --- |`,
    `| machine | \`${machine}\` |`,
    `| kit sha | \`${kitSha() || 'unknown'}\` |`,
    `| last cycle | ${cycle ? `${cycle.at} (${cycle.event || 'cycle'})` : 'never'} |`,
    `| runs today | ${runsToday} |`,
    `| reported at | ${new Date().toISOString()} |`,
    '',
    '_Written by `imps/heartbeat.mjs`. A machine whose row has not moved is not running._',
].join('\n');

const gh = (args) => spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });

if (dry) {
    console.log(body);
    process.exit(0);
}

// Reuse this machine's issue if it exists; one per machine keeps the list short.
const found = gh(['issue', 'list', '-R', repo, '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '20']);
const match = (() => {
    try {
        return JSON.parse(found.stdout || '[]').find((i) => i.title === title);
    } catch {
        return null;
    }
})();

// Edit the existing issue body instead of appending a comment so issue-list
// queries for heartbeat bodies always show current status.
const write = match
    ? gh(['issue', 'edit', String(match.number), '-R', repo, '--body', body])
    : gh(['issue', 'create', '-R', repo, '--title', title, '--body', body, '--label', 'imp']);

if (write.status !== 0) {
    // A heartbeat must never fail a cycle: the queue work is what matters.
    console.error(`heartbeat failed: ${(write.stderr || '').trim()}`);
    process.exit(0);
}
console.log(`heartbeat → ${repo} (${machine})`);
