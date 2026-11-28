// Auto-update-branch for mergeable:dirty PRs
// Deterministic, no LLM. Runs on schedule or PR event.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const GH = 'gh';

function gh(args) {
  return execSync(`${GH} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getDirtyPRs(repo) {
  const out = gh(`pr list -R ${repo} --state open --json number,title,mergeable,mergeableState,headRefName --jq '.[] | select(.mergeableState=="DIRTY" or .mergeableState=="BEHIND") | "\(.number) \(.headRefName) \(.mergeableState)"'`);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [number, branch, state] = line.split(' ');
    return { number, branch, state };
  });
}

function updateBranch(repo, number) {
  try {
    gh(`pr update-branch ${number} -R ${repo}`);
    console.log(`Updated branch for ${repo}#${number}`);
    return true;
  } catch (e) {
    console.error(`Failed to update ${repo}#${number}:`, e.message);
    return false;
  }
}

function main() {
  const repos = process.argv.slice(2);
  if (!repos.length) {
    console.error('Usage: node auto-update-branch.mjs <repo1> [repo2...]');
    process.exit(1);
  }

  let updated = 0;
  for (const repo of repos) {
    const prs = getDirtyPRs(repo);
    for (const pr of prs) {
      if (updateBranch(repo, pr.number)) updated++;
    }
  }
  console.log(`Updated ${updated} PR(s) across ${repos.length} repo(s)`);
}

main();