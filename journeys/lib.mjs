// Pure helpers for the journey reporter: no I/O, no network, no deps.
// Everything here is unit-tested in lib.test.mjs (node --test).
import { createHash } from 'node:crypto';

export const FP_MARK = 'journey-fp';
export const META_MARK = 'journey-meta';

const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s = '') => String(s).replace(ANSI, '');

// Coarse, stable error class: the same bug on a different night (or with a
// different number/selector/timeout in the message) must map to the same
// class, so it dedups onto the same issue.
export function errorClass(message = '', status = 'failed') {
    if (status === 'timedOut') return 'test-timeout';
    if (status === 'interrupted') return 'interrupted';
    const msg = stripAnsi(message);
    if (/snapshot doesn't exist/i.test(msg)) return 'missing-baseline';
    if (/toHaveScreenshot|Screenshot comparison failed|screenshots? (?:are )?different/i.test(msg))
        return 'visual-diff';
    const first = msg.split('\n').find((l) => l.trim()) || '';
    const matcher = first.match(/expect\((\w+)\)\.(not\.)?(\w+)/);
    if (matcher) return `expect:${matcher[2] || ''}${matcher[3]}`;
    const action = msg.match(/\b(locator|page|frame|elementHandle)\.(\w+)\b/);
    if (/Timeout \d+ms exceeded|TimeoutError/i.test(msg))
        return action ? `timeout:${action[1]}.${action[2]}` : 'timeout';
    const named = first.match(/^\s*(?:Error: )?(\w*(?:Error|Exception))\b/);
    if (named && named[1] !== 'Error') return named[1];
    if (action) return `error:${action[1]}.${action[2]}`;
    return (
        'error:' +
        first
            .replace(/^\s*Error:\s*/, '')
            .replace(/\S*[\\/]\S*/g, 'PATH')
            .replace(/0x[0-9a-f]+/gi, 'X')
            .replace(/\d+(\.\d+)?/g, 'N')
            .replace(/(["'`]).*?\1/g, '…')
            .trim()
            .slice(0, 60)
    );
}

export function fingerprint({ repo, file, journey, step, errClass }) {
    return createHash('sha1')
        .update([repo, file, journey, step, errClass].join('|'))
        .digest('hex')
        .slice(0, 12);
}

// Deepest test.step that carries an error, as "Outer › Inner".
export function failingStep(steps = []) {
    for (const s of steps) {
        if (!s.error) continue;
        const inner = failingStep(s.steps || []);
        return inner ? `${s.title} › ${inner}` : s.title;
    }
    return null;
}

const normTag = (t) => String(t).replace(/^@/, '');
export const tagValues = (tags, key) =>
    tags.map(normTag).filter((t) => t.startsWith(key + ':')).map((t) => t.slice(key.length + 1));

// Flatten a Playwright JSON report into one record per test (per project).
export function flattenReport(report) {
    const out = [];
    // Top-level suites are files (their title is the file name, so it is not
    // part of the journey name); nested suites are describe() blocks.
    const walk = (suite, here) => {
        for (const spec of suite.specs || []) {
            for (const t of spec.tests || []) {
                const results = t.results || [];
                const last = results[results.length - 1] || {};
                const tags = [...(spec.tags || []), ...(t.tags || [])].map(normTag);
                out.push({
                    file: spec.file || suite.file,
                    journey: [...here, spec.title].join(' › '),
                    project: t.projectName || '',
                    status: t.status, // expected | unexpected | flaky | skipped
                    resultStatus: last.status, // passed | failed | timedOut | interrupted | skipped
                    error: last.error || (last.errors || [])[0] || null,
                    steps: last.steps || [],
                    attachments: last.attachments || [],
                    tags,
                    features: tagValues(tags, 'feature'),
                    area: tagValues(tags, 'area')[0] || 'app',
                });
            }
        }
        for (const child of suite.suites || []) walk(child, [...here, child.title]);
    };
    for (const s of report.suites || []) walk(s, []);
    return out;
}

export const journeyId = (r) => `${r.file} › ${r.journey}${r.project ? ` [${r.project}]` : ''}`;

export function failureOf(repo, r) {
    const step = failingStep(r.steps) || '(outside any step)';
    const message = stripAnsi(r.error?.message || r.error?.value || '');
    const errClass = errorClass(message, r.resultStatus);
    return {
        fp: fingerprint({ repo, file: r.file, journey: r.journey, step, errClass }),
        journeyId: journeyId(r),
        file: r.file,
        journey: r.journey,
        step,
        errClass,
        message,
        features: r.features,
        area: r.area,
        attachments: r.attachments,
    };
}

export function readMarker(body = '', mark) {
    const m = body.match(new RegExp(`<!-- ${mark}[: ](.*?) -->`));
    if (!m) return null;
    if (mark === FP_MARK) return m[1].trim();
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

// Screenshots worth embedding, in display order.
export function pickImages(attachments = []) {
    const imgs = attachments.filter((a) => a.path && /^image\//.test(a.contentType || ''));
    const rank = (a) => (/-diff\./.test(a.path) ? 1 : /-actual\./.test(a.path) ? 0 : /-expected\./.test(a.path) ? 2 : 3);
    return imgs.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

const fence = (s) => '```\n' + s.replace(/```/g, '` ` `') + '\n```';

export function issueTitle(f) {
    const j = f.journey.length > 70 ? f.journey.slice(0, 69) + '…' : f.journey;
    return `[journey] ${j} › ${f.step.split(' › ').pop()}: ${f.errClass}`;
}

export function issueBody(f, meta, ctx) {
    const lines = [
        `**Journey:** \`${f.file}\` › ${f.journey}`,
        `**Failing step:** ${f.step}`,
        `**Error class:** \`${f.errClass}\``,
        f.features.length ? `**Features:** ${f.features.map((x) => '`' + x + '`').join(', ')}` : null,
        `**First seen:** ${meta.firstSeen} · **Last seen:** [${meta.lastSeen}](${ctx.runUrl}) · ` +
            `**Occurrences:** ${meta.occurrences} · **Reopened:** ${meta.reopens}`,
        '',
        '### Error',
        fence(f.message.split('\n').slice(0, 20).join('\n') || '(no message)'),
    ];
    if (ctx.images?.length) {
        lines.push('', '### Screenshots (latest failure)', '');
        for (const im of ctx.images) lines.push(`<img src="${im.url}" alt="${im.name}" width="420">`);
    }
    lines.push(
        '',
        '### Reproduce',
        ctx.repro ? fence(ctx.repro) : '_Run the journeys command from the repo’s caller workflow._',
        `Trace: download the \`journeys-report\` artifact from [the run](${ctx.runUrl}), then \`npx playwright show-trace <trace.zip>\` (or drop it on trace.playwright.dev).`,
        '',
        '---',
        `Filed by the nightly journey run, with no AI involved. Fix it in a PR that says \`Refs #<this>\` (not \`Fixes\`, which would close it on merge). Later nightlies verify the fix: this issue closes after ${ctx.greenRuns} consecutive green runs of this journey, and it reopens if the same fingerprint comes back.`,
        `<!-- ${FP_MARK}: ${f.fp} -->`,
        `<!-- ${META_MARK} ${JSON.stringify(meta)} -->`,
    );
    return lines.filter((l) => l !== null).join('\n');
}

// Decide what to do with every known issue given this run's results.
// Returns a plan; the caller performs it. Pure so it can be tested.
export function plan({ failures, records, issues, greenRuns, maxNew, today }) {
    const byFp = new Map(issues.map((i) => [i.fp, i]));
    const passed = new Set(records.filter((r) => r.status === 'expected').map(journeyId));
    // A run that produced journeys at all is a green run for the harness issue.
    if (records.length && !failures.some((f) => f.journeyId === '(harness)')) passed.add('(harness)');
    const actions = [];
    const seen = new Set();
    let created = 0;
    const deferred = [];
    for (const f of failures) {
        if (seen.has(f.fp)) continue;
        seen.add(f.fp);
        const existing = byFp.get(f.fp);
        if (!existing) {
            if (created >= maxNew) {
                deferred.push(f);
                continue;
            }
            created++;
            actions.push({
                kind: 'create',
                f,
                meta: { journey: f.journeyId, firstSeen: today, lastSeen: today, occurrences: 1, reopens: 0, greens: 0 },
            });
            continue;
        }
        const m = existing.meta || {};
        const meta = {
            journey: f.journeyId,
            firstSeen: m.firstSeen || today,
            lastSeen: today,
            occurrences: (m.occurrences || 0) + 1,
            reopens: (m.reopens || 0) + (existing.state === 'closed' ? 1 : 0),
            greens: 0,
        };
        actions.push({ kind: existing.state === 'closed' ? 'reopen' : 'update', f, issue: existing, meta });
    }
    // A journey that failed this run (with any fingerprint) breaks every
    // open issue's green streak: the close rule is *consecutive* green runs.
    const failingIds = new Set(failures.map((f) => f.journeyId));
    for (const i of issues) {
        if (i.state !== 'open' || seen.has(i.fp) || !i.meta?.journey) continue;
        if (failingIds.has(i.meta.journey)) {
            if (i.meta.greens) actions.push({ kind: 'green', issue: i, meta: { ...i.meta, greens: 0 } });
            continue;
        }
        if (!passed.has(i.meta.journey)) continue; // didn't run, or failed differently
        const greens = (i.meta.greens || 0) + 1;
        const meta = { ...i.meta, greens };
        actions.push({ kind: greens >= greenRuns ? 'close' : 'green', issue: i, meta });
    }
    return { actions, deferred };
}

const AREA_ORDER = ['app', 'site', 'promo', 'docs', 'mcp', 'api'];
export function bugsMarkdown({ repo, issues, generatedAt, runUrl }) {
    const open = issues.filter((i) => i.state === 'open');
    const groups = new Map();
    for (const i of open) {
        const area = (i.labels.find((l) => l.startsWith('area:')) || 'area:app').slice(5);
        if (!groups.has(area)) groups.set(area, []);
        groups.get(area).push(i);
    }
    const areas = [...groups.keys()].sort(
        (a, b) => (AREA_ORDER.indexOf(a) + 1 || 99) - (AREA_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
    const out = [
        '# Bugs',
        '',
        `> Generated from open \`bot:journey\` / \`bot:review\` issues in [${repo}](https://github.com/${repo}/issues). Don’t edit this file by hand: fix or close the issue. Updated ${generatedAt} by [the nightly journey run](${runUrl}).`,
        '',
    ];
    if (!open.length) out.push('No open bot issues. 🎉', '');
    for (const a of areas) {
        out.push(`## ${a}`, '');
        for (const i of groups.get(a).sort((x, y) => x.number - y.number)) {
            const src = i.labels.includes('bot:journey') ? 'journey' : 'review';
            const seen = i.meta?.lastSeen ? ` · last seen ${i.meta.lastSeen}` : '';
            out.push(`- [#${i.number}](https://github.com/${repo}/issues/${i.number}) ${i.title.replace(/^\[journey\] /, '')} _(${src}${seen})_`);
        }
        out.push('');
    }
    return out.join('\n');
}

export function coverage(records, features) {
    if (!features) return null;
    const visible = features.filter((f) => f.visual !== 'none').map((f) => f.id);
    const known = new Set(features.map((f) => f.id));
    const tagged = new Set(records.flatMap((r) => r.features));
    return {
        total: visible.length,
        covered: visible.filter((id) => tagged.has(id)).length,
        uncovered: visible.filter((id) => !tagged.has(id)),
        unknownTags: [...tagged].filter((t) => !known.has(t)),
    };
}
