/** Format an agent attribution trailer. Missing machine identity must block merging. */
export function formatMergedByAgentTrailer(machine) {
    const name = String(machine ?? '').trim();
    return name ? `Merged-by-agent: imp-${name}` : null;
}

/** Preserve the PR commit list and distinct co-author trailers in the squash body. */
export function mergedByAgentCommitBody(commits, machine) {
    const trailer = formatMergedByAgentTrailer(machine);
    if (!trailer) return null;
    const rows = Array.isArray(commits) ? commits : [];
    const headlines = rows.map((c) => String(c?.commit?.messageHeadline || '').trim()).filter(Boolean);
    const coAuthors = [...new Set(rows.flatMap((c) => String(c?.commit?.messageBody || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^Co-Authored-By:/i.test(line))))];
    return [
        headlines.map((headline) => `* ${headline}`).join('\n'),
        coAuthors.join('\n'),
        trailer,
    ].filter(Boolean).join('\n\n');
}
