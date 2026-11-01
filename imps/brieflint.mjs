#!/usr/bin/env node
// Lint a brief before it is posted as an issue comment, the way the dispatcher will read it.
//   node brieflint.mjs <brief.md ...> [--code-dir ~/code]
// Exits 1 on any problem. Warnings (new files, size advice) do not fail the run.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRIEF_MARK, briefFromComments, parseBrief } from './lib.mjs';

// A brief that spells out N lines of code leads to a diff of about 2.5x that once the tests and
// wiring are written (vigil#359: 56 inline lines, 136-line diff; fire#335: 107 lines, 160-line diff).
export const SIZE_FACTOR = 2.5;

export function codeLines(body) {
    let inside = false;
    let n = 0;
    for (const line of body.split(/\r?\n/)) {
        if (/^~~~/.test(line)) inside = !inside;
        else if (inside) n++;
    }
    return n;
}

/** @param exists (path) => boolean, whether the path is on origin/main (omit to skip path checks) */
export function lintBrief(text, { exists } = {}) {
    const problems = [];
    const warnings = [];
    const { meta, body } = parseBrief(text);
    for (const k of ['repo', 'issue', 'test', 'maxLines', 'allow']) if (!meta[k]) problems.push(`missing front matter: ${k}`);
    for (const k of ['allow', 'maxLines', 'repo', 'issue']) if (/\s#\s/.test(meta[k] || '')) problems.push(`trailing # comment in ${k}`);
    const max = Number(meta.maxLines);
    if (meta.maxLines && !(max >= 20)) problems.push(`maxLines ${meta.maxLines} is not a number >= 20`);
    if (/^```/m.test(body)) problems.push('nested ``` fence in the body (use ~~~)');
    const posted = briefFromComments([{ author: { login: 'nitsuah' }, body: `${BRIEF_MARK}\n\`\`\`markdown\n${text.trim()}\n\`\`\`` }]);
    if (!posted || parseBrief(posted).body.trim() !== body.trim()) problems.push('briefFromComments does not return the whole brief');
    if (!meta.depends && /depends on|has not merged|not merged yet|must be merged|after #\d+ (?:is )?merged|child \d of \d/i.test(body)) {
        warnings.push('the body mentions a dependency but the front matter has no `depends:` line (e.g. `depends: #318`); without it the dispatcher can run this issue before its dependency has merged');
    }
    const code = codeLines(body);
    if (max >= 20 && code * SIZE_FACTOR > max) warnings.push(`${code} inline code lines but maxLines ${max}; expect a diff near ${Math.round(code * SIZE_FACTOR)}. Suggest maxLines: ${Math.ceil((code * SIZE_FACTOR) / 10) * 10}, or split the issue`);
    if (exists) {
        for (const p of (meta.allow || '').split(',').map((s) => s.trim()).filter(Boolean)) if (!exists(p)) warnings.push(`allow path not on origin/main (new file?): ${p}`);
        for (const m of (meta.test || '').matchAll(/--config\s+(\S+)/g)) if (!exists(m[1])) problems.push(`test config not on origin/main: ${m[1]}`);
    }
    return { meta, problems, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const i = args.indexOf('--code-dir');
    const codeDir = i >= 0 ? args.splice(i, 2)[1] : join(homedir(), 'code');
    let bad = 0;
    for (const file of args) {
        const text = readFileSync(file, 'utf8');
        const repo = parseBrief(text).meta.repo;
        const exists = repo ? (p) => spawnSync('git', ['-C', join(codeDir, repo), 'cat-file', '-e', `origin/main:${p.replace(/\/$/, '')}`]).status === 0 : undefined;
        const r = lintBrief(text, { exists });
        console.log(`${r.problems.length ? 'FAIL' : 'ok  '} ${file}`);
        for (const p of r.problems) console.log(`  - ${p}`);
        for (const w of r.warnings) console.log(`  ! ${w}`);
        bad += r.problems.length;
    }
    process.exit(bad ? 1 : 0);
}
