// Dispatch imp:needs-human issues to available imps
// Deterministic, no LLM. Reads issues labeled imp:needs-human and dispatches.

import { execSync } from 'node:child_process';

const GH = 'gh';
const REPO = 'nitsuah/.github'; // imps kit repo

function gh(args) {
  return execSync(`${GH} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getNeedsHumanIssues() {
  const out = gh(`api --paginate --slurp "repos/${REPO}/issues?state=open&labels=imp%3Aneeds-human&per_page=100"`);
  const issues = JSON.parse(out).flat().filter(i => !i.pull_request);
  return issues.map(i => ({ number: i.number, title: i.title }));
}

function dispatchIssue(number, title) {
  try {
    // Add comment to trigger imp dispatch
    gh(`issue comment ${number} -R ${REPO} --body "/imp dispatch ${number}"`);
    console.log(`Dispatched imp for issue #${number}: ${title}`);
    return true;
  } catch (e) {
    console.error(`Failed to dispatch #${number}:`, e.message);
    return false;
  }
}

function main() {
  const issues = getNeedsHumanIssues();
  if (!issues.length) {
    console.log('No imp:needs-human issues found');
    return;
  }
  console.log(`Found ${issues.length} imp:needs-human issues`);
  let dispatched = 0;
  for (const issue of issues) {
    if (dispatchIssue(issue.number, issue.title)) dispatched++;
  }
  console.log(`Dispatched ${dispatched}/${issues.length} issues`);
  if (dispatched !== issues.length) process.exitCode = 1;
}

main();