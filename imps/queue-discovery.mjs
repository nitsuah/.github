/** CLI argument detection must preserve both parseArgs-supported --owner forms. */
export function hasExplicitOwnerArg(args = []) {
    return args.some((arg) => arg === '--owner' || String(arg).startsWith('--owner='));
}

/** Convert multi-owner GitHub search rows into a stable, deduplicated dispatch queue. */
export function discoverQueueCandidates(queueRows = [], excludedRepos = [], only = '') {
    const excluded = new Set(excludedRepos.map((slug) => String(slug).trim().toLowerCase()));
    const selected = only ? new Set(String(only).split(',').map((item) => item.trim()).filter(Boolean)) : null;
    const unique = new Map();
    for (const row of queueRows) {
        const repo = row.repository?.name;
        const owner = row.repository?.owner?.login || row.repository?.nameWithOwner?.split('/')[0] || row.searchedOwner;
        const number = row.number;
        if (!owner || !repo || !Number.isInteger(number)) continue;
        const labels = (row.labels || []).map((label) => typeof label === 'string' ? label : label.name);
        const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
        if (excluded.has(`${owner}/${repo}`.toLowerCase())) continue;
        if (labels.some((label) => ['imp:working', 'imp:pr'].includes(label))) continue;
        if (selected && !selected.has(`${repo}#${number}`)) continue;
        if (!unique.has(key)) unique.set(key, { owner, repo, number, title: row.title, createdAt: row.createdAt, labels });
    }
    return [...unique.values()];
}
