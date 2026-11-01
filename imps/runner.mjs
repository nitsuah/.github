// Shared plumbing for imp.mjs and review.mjs: the ledger, git/process
// helpers, the clean environment and the headless `claude -p` launcher.
// Everything that talks to a model goes through runClaude, so both workers
// get the same guardrails (clean env, 9router only, no shell splitting).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, renameSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { summarizeRun, effectiveMaxLines, parseBrief, closesIssue, resolveRouter, errorKind, repeatFailureGuard, REPEAT_GUARD_KINDS, writeStreamJsonMessage } from './lib.mjs';
import { DEFAULTS } from './defaults.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
export const LEDGER = join(HOME, 'runs.jsonl');
export const CODE = process.env.IMPS_CODE || join(homedir(), 'code');
mkdirSync(join(HOME, 'runs'), { recursive: true });

/**
 * Resolve the optional vault playbook path (stash agent/prompts/IMPS.md).
 * Honor order: IMPS_VAULT_PROMPT env → config.vaultPrompt / vault_prompt
 * (absolute, or relative to HOME/CODE). Returns null if unset/missing.
 * Stash wrappers set IMPS_VAULT_PROMPT from imps-config.yml `vault_prompt`.
 */
export function resolveVaultPrompt(config = {}, env = process.env) {
    const candidates = [];
    if (env.IMPS_VAULT_PROMPT) candidates.push(env.IMPS_VAULT_PROMPT);
    const fromCfg = config.vaultPrompt || config.vault_prompt;
    if (fromCfg) {
        candidates.push(fromCfg);
        if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(fromCfg)) {
            candidates.push(join(CODE, fromCfg));
            candidates.push(join(HOME, fromCfg));
        }
    }
    for (const p of candidates) {
        if (p && existsSync(p)) return p;
    }
    return null;
}

// ── ledger ────────────────────────────────────────────────────────────────
export const rows = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

// ── provenance ────────────────────────────────────────────────────────────
// Which kit commit and which machine produced a run. Every ledger row and
// dispatch cycle carries these, so "this behaved differently" can be answered
// without guessing which machine was running what (#61).
export const kitSha = () => {
    try {
        return spawnSync('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim() || null;
    } catch {
        return null;
    }
};
// Resolve machine name once, shared across all four record types:
// heartbeat issues, claim comments, ledger rows, dispatch events.
// Falls back to hostname if IMPS_MACHINE and config.machine are both unset.
export function resolveMachine(config = {}, env = process.env) {
    return env.IMPS_MACHINE || config.machine || hostname();
}
export const machineName = () => resolveMachine({}, process.env);
// How many edit-less tool calls a run may make: env, then ~/.imps/config.json, then defaults.
export function resolveNoEditTurns(config = {}, env = process.env) {
    // An empty string is "unset", not 0 (Number('') is 0); only an explicit 0 disables.
    const set = (v) => (v == null || String(v).trim() === '' ? undefined : v);
    const n = Number(set(env.IMPS_NO_EDIT_TURNS) ?? set(config.noEditTurns) ?? DEFAULTS.noEditTurns);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULTS.noEditTurns;
}
// Check if the kit repo has uncommitted changes (used for provenance in ledger rows).
export function isGitDirty(path) {
    try {
        const r = spawnSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
        return r.status === 0 && r.stdout.trim().length > 0;
    } catch {
        return false;
    }
}
// A cross-process lock around every ledger write. update() reads the whole file, patches one row and renames a
// temp file over it, while imp.mjs appends a row when a run starts: an append that landed between the read and
// the rename used to be lost. An exclusive lock file (O_EXCL) serialises them. A lock is broken ONLY by age:
// nobody holds it for more than milliseconds, and checking the owner pid first is a check-then-delete race (the
// owner can finish and a new holder take the lock between the check and the unlink, which then deletes a live
// lock and lets two writers in). A crashed holder therefore costs at most LOCK_STALE_MS. IMPS_LEDGER_LOCK=0
// turns the lock off.
const LOCK = `${LEDGER}.lock`;
export const LOCK_STALE_MS = 10_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let lockDepth = 0;
export function withLedgerLock(fn, { timeoutMs = 15_000 } = {}) {
    if (process.env.IMPS_LEDGER_LOCK === '0' || lockDepth > 0) return fn(); // reentrant: update() -> save()
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const fd = openSync(LOCK, 'wx');
            writeFileSync(fd, String(process.pid));
            closeSync(fd);
            break;
        } catch (e) {
            // Windows reports EPERM/EACCES (not EEXIST) while another process's delete of the lock is still pending.
            if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
            let age = 0;
            try {
                age = Date.now() - statSync(LOCK).mtimeMs;
            } catch (er) {
                // Vanished between our failed create and this stat: retry the create at once. Never unlink here: a new
                // holder may already have made a fresh lock at the same path, and deleting it lets two writers in.
                if (er.code === 'ENOENT') continue;
            }
            if (age > LOCK_STALE_MS) { try { unlinkSync(LOCK); } catch { /* someone else broke it first */ } continue; }
            if (Date.now() > deadline) throw new Error(`ledger lock busy for ${timeoutMs} ms (${LOCK})`);
            sleepSync(15 + Math.floor(Math.random() * 25));
        }
    }
    lockDepth++;
    try {
        return fn();
    } finally {
        lockDepth--;
        try { unlinkSync(LOCK); } catch { /* already gone */ }
    }
}
// Atomic: a crash mid-write must not truncate the run history.
export const save = (all) => withLedgerLock(() => {
    const tmp = `${LEDGER}.${process.pid}.tmp`;
    writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // Windows can refuse the rename for a moment while another process (a viewer, an indexer) has the file open.
    for (let attempt = 0; ; attempt++) {
        try {
            renameSync(tmp, LEDGER);
            return;
        } catch (e) {
            if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            sleepSync(25 * (attempt + 1));
        }
    }
});
export function update(id, patch) {
    return withLedgerLock(() => {
        const all = rows();
        const r = all.find((x) => x.id === id);
        if (!r) throw new Error(`no run ${id} in ${LEDGER}`);
        Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
        save(all);
        return r;
    });
}
/** Append one run row under the same lock update() takes. */
export const appendRow = (row) => withLedgerLock(() => appendFileSync(LEDGER, JSON.stringify(row) + '\n'));

// ── processes ─────────────────────────────────────────────────────────────
const LOG_FILE = join(HOME, 'logs', 'tool-errors.log');
mkdirSync(dirname(LOG_FILE), { recursive: true });
export const sh = (bin, args, opts = {}) => {
    const start = Date.now();
    const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, ...opts });
    const entry = {
        timestamp: new Date().toISOString(),
        command: `${bin} ${JSON.stringify(args)}`,
        exit: r.status,
        durationMs: Date.now() - start,
    };
    try { appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (_) {}
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
export const git = (wt, ...args) => sh('git', ['-C', wt, ...args]);

// Everything prGuard needs about one issue: its state, every imp/<n>-* PR, and
// merged PRs whose body closes it. Throws when a lookup fails (fail closed).
export function lookupIssueGuard(slug, issue) {
    const view = sh('gh', ['issue', 'view', String(issue), '-R', slug, '--json', 'state']);
    const list = sh('gh', ['pr', 'list', '-R', slug, '--state', 'all', '--search', `head:imp/${issue}-`, '--json', 'number,state,headRefName,mergedAt']);
    const body = sh('gh', ['pr', 'list', '-R', slug, '--state', 'merged', '--search', `#${issue} in:body`, '--json', 'number,body']);
    if (view.code !== 0 || list.code !== 0 || body.code !== 0) throw new Error(`cannot look up #${issue}: ${view.err || list.err || body.err}`);
    return {
        issueState: JSON.parse(view.out || '{}').state,
        prs: JSON.parse(list.out || '[]'),
        mergedPrs: JSON.parse(body.out || '[]').filter((p) => closesIssue(p.body, issue, slug)),
    };
}

export function cleanEnv(src = process.env, settings) {
    const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'DOCKER_HOST', 'IMPS_HOME'];
    const env = Object.fromEntries(keep.filter((k) => src[k]).map((k) => [k, src[k]]));
    // Nothing from the dispatching session leaks in: no Claude/GitHub tokens.
    // Only the resolved router URL/key are passed (env first, settings.json fallback).
    const { baseUrl, key } = resolveRouter({ env: src, settings });
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (key) env.ANTHROPIC_API_KEY = key;
    return env;
}

// One headless `claude -p` run. Streams the transcript to `transcript`,
// prints tool calls, enforces the wall-clock limit, and returns the summary.
// Never useful to a worker, and each is a way out of the worktree.
const ALWAYS_DENY = ['PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Skill', 'NotebookEdit', 'Monitor', 'CronCreate', 'ScheduleWakeup', 'SendMessage', 'PushNotification'];

// maxTurns is enforced here: this CLI build accepts --max-turns but ignores it
// (2026-10-22: a 2-turn cap ran 4 turns). A turn is an assistant message that
// calls a tool; past the cap the process is stopped and the run ends
// `killed-max-turns`.
// noEditByTurn: stop a worker that has made this many tool calls without a single
// Edit/Write (vhs#77 ran 41 tool calls exploring and never edited); ends `no-edit-timeout`
// and records the limit as metrics.noEditTurns.
// Context trim: the default CLI session sends ~60 slash commands, skills and every
// built-in tool each turn; workers only need `tools`. IMPS_NO_TRIM=1 turns the trim off.
//
// Where the CLI lives. IMPS_CLAUDE_BIN wins; on Windows the npm global .exe (not the
// .cmd shim); elsewhere `claude` on PATH. A fresh machine with no install used to
// spawn a missing path and end `killed-timeout` in 4 ms, which read as a gate failure
// of the issue; now it is `spawn-failed`, an infrastructure error.
export function claudeBinCandidates(env = process.env, platform = process.platform) {
    if (env.IMPS_CLAUDE_BIN) return [env.IMPS_CLAUDE_BIN];
    if (platform !== 'win32') return ['claude'];
    const pkg = 'node_modules/@anthropic-ai/claude-code/bin/claude.exe';
    return [env.APPDATA && join(env.APPDATA, 'npm', pkg), env.npm_config_prefix && join(env.npm_config_prefix, pkg)].filter(Boolean);
}
export function resolveClaudeBin(env = process.env, platform = process.platform, exists = existsSync) {
    if (platform !== 'win32' && !env.IMPS_CLAUDE_BIN) return 'claude';
    return claudeBinCandidates(env, platform).find((p) => exists(p)) || null;
}
// The shell for a brief's `test:` / `lint:` commands. Briefs are written POSIX-style
// (`sh -c '...&&...'`); node's `shell: true` is cmd.exe on Windows, which does not group
// single quotes, so the command split and the container's sh died with exit 2 before
// the imp's code was ever tested. Use Git Bash (IMPS_SHELL overrides). The WSL
// bash.exe in System32 is not it. `true` (the platform default) elsewhere.
export function gateShell(env = process.env, platform = process.platform, exists = existsSync) {
    if (env.IMPS_SHELL) return env.IMPS_SHELL;
    if (platform !== 'win32') return true;
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    return roots.map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => exists(p)) || true;
}
function spawnFailed(t0) {
    const metrics = summarizeRun([], { startedAt: t0, endedAt: Date.now() });
    metrics.end = 'spawn-failed';
    metrics.toolTurns = 0;
    return metrics;
}
export async function runClaude({ cwd, prompt, model, tools, deny = [], minutes, budget, maxTurns = 40, noEditByTurn = 0, transcript, permissionMode = 'acceptEdits' }) {
    const guardEnabled = process.env.IMPS_REPEAT_FAILURE_GUARD === '1';
    const args = ['-p', '--model', model, '--permission-mode', permissionMode, '--strict-mcp-config',
        '--setting-sources', 'project', '--allowedTools', tools.join(' '),
        '--disallowedTools', [...ALWAYS_DENY, ...deny].join(' '), '--max-budget-usd', String(budget),
        '--output-format', 'stream-json', '--verbose'];
    if (!guardEnabled) {
        // Preserve the original CLI argument order: -p, prompt, then options.
        args.splice(1, 0, prompt);
    } else {
        // Streaming mode: prompt via stdin with --input-format stream-json
        args.push('--input-format', 'stream-json');
    }
    if (!process.env.IMPS_NO_TRIM) {
        const builtin = [...new Set(tools.map((t) => t.replace(/\(.*$/, '')))];
        args.push('--disable-slash-commands', '--no-session-persistence', '--tools', builtin.join(','));
    }
    const t0 = Date.now();
    // Spawn the binary itself: a shell (the npm .cmd shim) splits multi-word args.
    const bin = resolveClaudeBin();
    if (!bin) {
        console.error(`claude binary not found (looked at: ${claudeBinCandidates().join(', ')}). Install Claude Code or set IMPS_CLAUDE_BIN.`);
        return spawnFailed(t0);
    }
    const out = createWriteStream(transcript);
    const events = [];
    const stdio = guardEnabled ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const child = spawn(bin, args, { cwd, env: cleanEnv(), stdio, windowsHide: true });
    let buf = '';
    let toolTurns = 0;
    let capped = false;
    let edited = false;
    let noEdit = false;
    // Guard state (local to this run). A failed/backpressured stdin write disables
    // only future guard messages; it never terminates or gates the worker.
    const guardState = { counts: new Map(), nudged: new Set() };
    const stdinState = { disabled: false, closed: false };
    let promptSent = false;

    const writeStdin = (msg) => writeStreamJsonMessage(child.stdin, msg, stdinState);

    const closeStdin = () => {
        if (stdinState.closed || !child.stdin?.writable) return;
        stdinState.closed = true;
        try { child.stdin.end(); } catch { /* ignore */ }
    };
    child.stdin?.on('error', () => { stdinState.disabled = true; });

    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            ev._ts = Date.now();
            events.push(ev);
            out.write(JSON.stringify(ev) + '\n');
            if (ev.type === 'assistant') {
                const uses = (ev.message?.content || []).filter((c) => c.type === 'tool_use');
                for (const c of uses) {
                    console.log(`  ${c.name} ${JSON.stringify(c.input).slice(0, 110)}`);
                    if (c.name === 'Edit' || c.name === 'Write') edited = true;
                }
                if (uses.length && noEditByTurn && !edited && toolTurns + 1 > noEditByTurn && !capped && !noEdit) {
                    noEdit = true;
                    console.log(`  ${noEditByTurn} tool calls with no edit; stopping`);
                    child.kill('SIGTERM');
                }
                if (uses.length && ++toolTurns > maxTurns && !capped) {
                    capped = true;
                    console.log(`  turn cap ${maxTurns} reached; stopping`);
                    child.kill('SIGTERM');
                }
            } else if (guardEnabled && ev.type === 'user') {
                for (const c of ev.message?.content || []) {
                    if (c.type !== 'tool_result' || !c.is_error) continue;
                    const kind = errorKind(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
                    const nudge = repeatFailureGuard(kind, guardState);
                    if (nudge) {
                        // Advisory nudge: send as a user message with only the normalized kind
                        writeStdin({ type: 'user', message: { role: 'user', content: nudge } });
                    }
                }
            } else if (ev.type === 'result') {
                // Final result event: close stdin in streaming mode
                if (guardEnabled) closeStdin();
            }
        }
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(minutes) * 60_000);
    // `close`, not `exit`: stdout can still hold the final result event at exit.
    // spawn-failed means the process never started. An `error` after `spawn` (e.g. a failed
    // kill) must not discard the collected events: `close` still follows and ends the run.
    let spawnError = false;
    let started = false;
    child.once('spawn', () => {
        started = true;
        if (guardEnabled && !promptSent) {
            writeStdin({ type: 'user', message: { role: 'user', content: prompt } });
            promptSent = true;
        }
    });
    const code = await new Promise((done) => {
        child.once('error', (e) => {
            console.error(`${started ? 'child error' : 'spawn failed'}: ${e.message}`);
            if (!started) { spawnError = true; done(null); }
        });
        child.once('close', done);
    });
    clearTimeout(timer);
    await new Promise((done) => out.end(done));
    if (spawnError) return spawnFailed(t0);
    const metrics = summarizeRun(events, { startedAt: t0, endedAt: Date.now() });
    if (capped) metrics.end = 'killed-max-turns';
    else if (noEdit) metrics.end = 'no-edit-timeout';
    else if (metrics.end === 'no-result') metrics.end = code == null ? 'killed-timeout' : `exit-${code}`;
    metrics.toolTurns = toolTurns;
    if (noEdit) metrics.noEditTurns = noEditByTurn;
    if (!metrics.turns) metrics.turns = toolTurns;
    return metrics;
}

// One plain chat completion through 9router (OpenAI format): no agent loop, no tools, no
// 30k-token session resent every turn. For read-only work whose whole input fits in one prompt
// (reviews). Returns the same shape the review path reads from runClaude.
export async function chat({ prompt, model = 'MAX', maxTokens = 6000, minutes = 6 }) {
    const env = cleanEnv();
    const t0 = Date.now();
    try {
        const res = await fetch(`${env.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ANTHROPIC_API_KEY}` },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }),
            signal: AbortSignal.timeout(Number(minutes) * 60_000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { end: `http-${res.status}`, finalText: '', served: [], turns: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: Date.now() - t0, toolErrors: 0 };
        const u = body.usage || {};
        return {
            end: body.choices?.[0]?.finish_reason === 'length' ? 'length' : 'success',
            finalText: body.choices?.[0]?.message?.content || '',
            served: body.model ? [body.model] : [], turns: 1, toolErrors: 0, durationMs: Date.now() - t0,
            tokens: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: u.prompt_tokens_details?.cached_tokens || 0, cacheWrite: 0 },
        };
    } catch (e) {
        return { end: 'chat-error', error: e.message, finalText: '', served: [], turns: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: Date.now() - t0, toolErrors: 0 };
    }
}

// ── brief ─────────────────────────────────────────────────────────────────
// Every brief gets PREAMBLE.md (the shared, RSI-maintained rules) in front.
// The hash of the combined prompt ties each outcome to a prompt version.
export function loadBrief(path, wt) {
    const { meta, body } = parseBrief(readFileSync(path, 'utf8'));
    const preamble = readFileSync(join(HERE, 'PREAMBLE.md'), 'utf8');
    const fill = (s) => s.replaceAll('{wt}', wt.replaceAll('\\', '/')).replaceAll('{issue}', meta.issue || '');
    // The gate's scope and size limits go in the prompt too, so the imp knows them.
    const limits = [
        meta.allow && `- You may only change files under: ${meta.allow}. Anything else fails the gate.`,
        `- The whole diff must stay under ${effectiveMaxLines(meta.maxLines)} changed lines.`,
        (meta.test || meta.lint) && `- Run the tests and lint with exactly \`${RUNTEST}\` (no arguments, one command on its own). It runs this brief's test and lint commands for you. Never run the brief's docker/npm/npx commands yourself; they're denied.`,
    ].filter(Boolean).join('\n');
    // Vault playbook (IMPS_VAULT_PROMPT) is for humans / RSI logging — never
    // injected into the worker prompt (token cost). See resolveVaultPrompt().
    const prompt = fill(`${preamble}\n\n## Gate limits for this run\n${limits}\n\n---\n\n${body}`);
    const hash = createHash('sha1').update(prompt.replaceAll(wt.replaceAll('\\', '/'), '{wt}')).digest('hex');
    return { meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, fill(v)])), prompt, hash };
}


// The one test command imps may run (no arguments; runtest.mjs runs the
// brief's test and lint). Forward slashes so the permission rule and the
// command the model types are the same string.
export const RUNTEST = `node ${join(HERE, 'runtest.mjs').split('\\').join('/')}`;

// ── model pool ────────────────────────────────────────────────────────────
// Which models a run may use. `prefer` orders the free combos 9router rotates
// through; `fallback` is the paid floor.
//
// Quota is machine state, not code: it lives in IMPS_HOME, because the runner
// checkout is hard-reset to origin/main before every cycle. Keeping it in the
// checkout meant a reset (a) wiped the counter back to its committed value and
// (b) dirty-tree'd the checkout so update.ps1/setup.ps1 refused to run at all
// (#59). One counter per machine also matches what it measures — this
// machine's spend — and a per-machine home is what a second machine gets.
export const MODEL_POOL = { prefer: [], fallback: ['MAX'] };
const QUOTA = join(HOME, 'model_quota.json');

// Counters refill on a rolling window. Without one, a counter that can finally
// persist would run to 0 and stop the fleet permanently with no way back.
const QUOTA_WINDOW_MS = DEFAULTS.quotaWindowMs;
const QUOTA_DEFAULT = DEFAULTS.quotaPerWindow;
const windowStart = (now) => Math.floor(now / QUOTA_WINDOW_MS) * QUOTA_WINDOW_MS;

const readQuota = () => {
    try {
        const content = readFileSync(QUOTA, 'utf8');
        const parsed = JSON.parse(content);
        // Reject non-plain-object roots (null, array, primitive) — damaged quota
        // state must not silently reset the spend limit.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('model_quota.json root is not a plain object');
        }
        return parsed;
    } catch (e) {
        // Missing file is normal on a fresh machine — return empty quota.
        if (e.code === 'ENOENT') return {};
        // Propagate other errors so the caller fails closed instead of treating
        // invalid state as unused quota.
        throw new Error(`invalid model_quota.json: ${e.message}`);
    }
};

// { model: { used, window } } — a stale window counts as unused.
// Legacy: model_quota.json once stored plain numbers (remaining quota).
// Convert them so existing files don't reset the counter.
const counter = (raw, model, now) => {
    const c = raw[model];
    if (typeof c === 'number') {
        // Legacy numeric value = remaining quota in that window.
        // Convert to consumed: used = DEFAULT - remaining.
        return { used: Math.max(0, QUOTA_DEFAULT - c), window: windowStart(now) };
    }
    if (!c || c.window !== windowStart(now)) return { used: 0, window: windowStart(now) };
    return { used: c.used || 0, window: c.window };
};

// Returns null when every model in the order is out of quota: the caller must
// stop rather than silently spend past the limit. Throws on invalid quota state
// so a damaged quota file cannot reset the spend limit.
export function pickModel(pool = MODEL_POOL, strategy = 'fallback', now = Date.now()) {
    const order = strategy === 'prefer' ? [...pool.prefer, ...pool.fallback] : [...pool.fallback, ...pool.prefer];
    const raw = readQuota();
    return order.find((m) => counter(raw, m, now).used < QUOTA_DEFAULT) || null;
}

// Reserve quota atomically: pick + decrement as one operation so concurrent
// runs cannot both see the same available slot and both execute (#64).
// Uses a retry loop with verification to handle concurrent callers.
export function reserveQuota(pool = MODEL_POOL, strategy = 'fallback', now = Date.now()) {
    const order = strategy === 'prefer' ? [...pool.prefer, ...pool.fallback] : [...pool.fallback, ...pool.prefer];

    for (let attempt = 0; attempt < 5; attempt++) {
        const raw = readQuota();
        const model = order.find((m) => counter(raw, m, now).used < QUOTA_DEFAULT);
        if (!model) return null;
        const c = counter(raw, model, now);
        const expectedUsed = c.used;
        raw[model] = { used: Math.min(QUOTA_DEFAULT, c.used + 1), window: c.window };
        mkdirSync(HOME, { recursive: true });
        const tmp = `${QUOTA}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
        renameSync(tmp, QUOTA);

        // Verify the write wasn't stomped by another process
        const verify = readQuota();
        if (verify[model]?.used === expectedUsed + 1 && verify[model]?.window === c.window) {
            return model;
        }
        // Another process modified the file; retry
    }
    // Too many retries — treat as quota exhausted to avoid live lock
    return null;
}

export function decrementQuota(model, now = Date.now()) {
    const raw = readQuota();
    const c = counter(raw, model, now);
    raw[model] = { used: Math.min(QUOTA_DEFAULT, c.used + 1), window: c.window };
    mkdirSync(HOME, { recursive: true });
    const tmp = `${QUOTA}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    renameSync(tmp, QUOTA);
}

// What an imp may do in its worktree: edit, read-only and commit git, and
// RUNTEST. Never a general docker/npm/node permission (they could mount
// ~/.ssh or the Docker socket), and nothing that pushes.
export const IMP_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)',
    'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git checkout -- :*)', `Bash(${RUNTEST})`];
