// node --test imps/*.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'imps-runner-stream-'));
const previousHome = process.env.IMPS_HOME;
process.env.IMPS_HOME = tempHome;
const { runClaude } = await import('./runner.mjs');

after(() => {
    if (previousHome === undefined) delete process.env.IMPS_HOME;
    else process.env.IMPS_HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
});

function fakeCli() {
    const script = join(tempHome, 'fake-claude-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
    const source = [
        '#!/usr/bin/env node',
        "import { createInterface } from 'node:readline';",
        'const args = process.argv.slice(2);',
        "const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');",
        "const finish = (result) => {",
        "  const event = { type: 'result', subtype: 'success', result, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } };",
        "  process.stdout.write(JSON.stringify(event) + '\\n', () => process.exit(0));",
        '};',
        "if (!args.includes('--input-format')) {",
        "  const promptIndex = args.indexOf('-p') + 1;",
        "  finish(JSON.stringify({ args, prompt: args[promptIndex] }));",
        '} else {',
        '  const received = [];',
        '  const rl = createInterface({ input: process.stdin });',
        "  rl.on('line', (line) => {",
        '    let message;',
        '    try { message = JSON.parse(line); } catch { return; }',
        '    received.push(message);',
        '    if (received.length === 1) {',
        "      for (let i = 0; i < 3; i++) emit({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'No such file or directory' }] } });",
        '    } else {',
        '      finish(JSON.stringify(received));',
        '    }',
        '  });',
        "  setTimeout(() => { if (received.length === 0) finish('NO_INITIAL_PROMPT'); }, 1000);",
        '}',
    ].join('\n');
    writeFileSync(script, source);
    chmodSync(script, 0o755);
    return script;
}

async function runWithFake({ guard, prompt, name }) {
    const previousGuard = process.env.IMPS_REPEAT_FAILURE_GUARD;
    const previousBin = process.env.IMPS_CLAUDE_BIN;
    process.env.IMPS_REPEAT_FAILURE_GUARD = guard ? '1' : '0';
    process.env.IMPS_CLAUDE_BIN = fakeCli();
    try {
        return await runClaude({
            cwd: tempHome,
            prompt,
            model: 'MAX',
            tools: [],
            deny: [],
            minutes: 0.2,
            budget: 0.1,
            maxTurns: 4,
            noEditByTurn: 0,
            transcript: join(tempHome, name + '.jsonl'),
        });
    } finally {
        if (previousGuard === undefined) delete process.env.IMPS_REPEAT_FAILURE_GUARD;
        else process.env.IMPS_REPEAT_FAILURE_GUARD = previousGuard;
        if (previousBin === undefined) delete process.env.IMPS_CLAUDE_BIN;
        else process.env.IMPS_CLAUDE_BIN = previousBin;
    }
}

test('default-off launch preserves -p then prompt argv order', { skip: process.platform === 'win32' }, async () => {
    const prompt = 'DEFAULT_ARGV_PROMPT';
    const metrics = await runWithFake({ guard: false, prompt, name: 'default-argv' });
    const launch = JSON.parse(metrics.finalText);
    assert.equal(metrics.end, 'success');
    assert.equal(launch.args[0], '-p');
    assert.equal(launch.args[1], prompt);
    assert.equal(launch.prompt, prompt);
});

test('opt-in stream-json delivers initial prompt and the third-repeat nudge to the live child', { skip: process.platform === 'win32' }, async () => {
    const prompt = 'STREAM_JSON_INITIAL_PROMPT';
    const metrics = await runWithFake({ guard: true, prompt, name: 'stream-json' });
    const received = JSON.parse(metrics.finalText);
    assert.equal(metrics.end, 'success');
    assert.equal(metrics.toolErrors, 3);
    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'user');
    assert.equal(received[0].message.content, prompt);
    assert.equal(received[1].type, 'user');
    assert.match(received[1].message.content, /^Repeated missing-path:/);
});
