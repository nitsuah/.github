// Shared plumbing for imp.mjs and review.mjs: the ledger, git/process
// helpers, the clean environment and the headless `claude -p` launcher.
// Everything that talks to a model goes through runClaude, so both workers
// get the same guardrails (clean env, 9router only, no shell splitting).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { summarizeRun, parseBrief } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOME = process.env.IMPS_HOME || join(homedir(), '.imps');
export const LEDGER = join(HOME, 'runs.jsonl');
export const CODE = process.env.IMPS_CODE || join(homedir(), 'code');
mkdirSync(join(HOME, 'runs'), { recursive: true });

// ── ledger ────────────────────────────────────────────────────────────────
export const rows = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
// Atomic: a crash mid-write must not truncate the run history.
export const save = (all) => {
    const tmp = `${LEDGER}.${process.pid}.tmp`;
    writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(tmp, LEDGER);
};
export function update(id, patch) {
    const all = rows();
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error(`no run ${id} in ${LEDGER}`);
    Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
    save(all);
    return r;
}

// ── processes ─────────────────────────────────────────────────────────────
export const sh = (bin, args, opts = {}) => {
    const start = Date.now();
    const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, ...opts });
    const entry = {
        timestamp: new Date().toISOString(),
        command: `${bin} ${args.map(a=>a.replace(/\s+/g,'')).join(' ')}`,
        exit: r.status,
        durationMs: Date.now() - start,
    };
    // Append to tool error log
    const logPath = join(HOME, 'logs', 'tool-errors.log');
    try { writeFileSync(logPath, JSON.stringify(entry) + '\n', { flag: 'a' }); } catch (_) {}
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
export const git = (wt, ...args) => sh('git', ['-C', wt, ...args]);

export function cleanEnv() {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
    const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'DOCKER_HOST', 'IMPS_HOME'];
    const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    // Nothing from the dispatching session leaks in: no Claude/GitHub tokens.
    env.ANTHROPIC_BASE_URL = s.ANTHROPIC_BASE_URL || 'http://localhost:20128/v1';
    env.ANTHROPIC_API_KEY = s.NINEROUTER_KEY || s.ANTHROPIC_API_KEY;
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
// Edit/Write (vhs#77 ran 41 tool calls exploring and never edited); ends `killed-no-edit`.
// Context trim: the default CLI session sends ~60 slash commands, skills and every
// built-in tool each turn; workers only need `tools`. IMPS_NO_TRIM=1 turns the trim off.
export async function runClaude({ cwd, prompt, model, tools, deny = [], minutes, budget, maxTurns = 40, noEditByTurn = 0, transcript, permissionMode = 'acceptEdits' }) {
    const args = ['-p', prompt, '--model', model, '--permission-mode', permissionMode, '--strict-mcp-config',
        '--setting-sources', 'project', '--allowedTools', tools.join(' '),
        '--disallowedTools', [...ALWAYS_DENY, ...deny].join(' '), '--max-budget-usd', String(budget),
        '--output-format', 'stream-json', '--verbose'];
    if (!process.env.IMPS_NO_TRIM) {
        const builtin = [...new Set(tools.map((t) => t.replace(/\(.*$/, '')))];
        args.push('--disable-slash-commands', '--no-session-persistence', '--tools', builtin.join(','));
    }
    // Spawn the binary itself: a shell (the npm .cmd shim) splits multi-word args.
    const bin = process.platform === 'win32'
        ? join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
        : 'claude';
    const out = createWriteStream(transcript);
    const events = [];
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let toolTurns = 0;
    let capped = false;
    let edited = false;
    let noEdit = false;
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
            }
        }
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(minutes) * 60_000);
    // `close`, not `exit`: stdout can still hold the final result event at exit.
    const code = await new Promise((done) => {
        child.once('error', (e) => { console.error(`spawn failed: ${e.message}`); done(null); });
        child.once('close', done);
    });
    clearTimeout(timer);
    await new Promise((done) => out.end(done));
    const metrics = summarizeRun(events, { startedAt: t0, endedAt: Date.now() });
    if (capped) metrics.end = 'killed-max-turns';
    else if (noEdit) metrics.end = 'killed-no-edit';
    else if (metrics.end === 'no-result') metrics.end = code == null ? 'killed-timeout' : `exit-${code}`;
    metrics.toolTurns = toolTurns;
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
        `- The whole diff must stay under ${meta.maxLines || 80} changed lines.`,
        (meta.test || meta.lint) && `- Run the tests and lint with exactly \`${RUNTEST}\` (no arguments, one command on its own). It runs this brief's test and lint commands for you. Never run the brief's docker/npm/npx commands yourself; they're denied.`,
    ].filter(Boolean).join('\n');
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
// through; `fallback` is the paid floor. Quota is a shared counter next to the
// code, so concurrent runs decrement the same file.
export const MODEL_POOL = { prefer: ['openrouter/free'], fallback: ['MAX'] };
const QUOTA = join(HERE, 'model_quota.json');
const readQuota = () => { try { return JSON.parse(readFileSync(QUOTA, 'utf8')); } catch { return {}; } };

export function pickModel(pool = MODEL_POOL, strategy = 'fallback') {
    const order = strategy === 'prefer' ? [...pool.prefer, ...pool.fallback] : [...pool.fallback, ...pool.prefer];
    const quota = readQuota();
    return order.find((m) => (quota[m] ?? 1) > 0) || order[0];
}

export function decrementQuota(model) {
    const quota = readQuota();
    if (!(model in quota)) return;
    quota[model] = Math.max(0, quota[model] - 1);
    writeFileSync(QUOTA, JSON.stringify(quota, null, 2) + '\n');
}

// What an imp may do in its worktree: edit, read-only and commit git, and
// RUNTEST. Never a general docker/npm/node permission (they could mount
// ~/.ssh or the Docker socket), and nothing that pushes.
export const IMP_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)',
    'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git checkout -- :*)', `Bash(${RUNTEST})`];
