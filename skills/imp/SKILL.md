---
name: imp
description: Drive the imps loop by hand. Queue or run a 9router imp on a GitHub issue, review or fix an imp PR with the 9router reviewer/fix round, merge a passing imp PR, or show the loop's status. Use when someone says "/imp", "imp this issue", "run an imp on <repo>#<n>", "have the bot fix/review PR <x>", "review bot", "imp status", "what are the imps doing", or "merge the imp PRs".
---

# /imp

The imps kit lives in `nitsuah/.github` under `imps/`. **Always run the merged copy:** `~/code/imps-runner` (a detached checkout of `origin/main`; run `git -C ~/code/imps-runner fetch -q && git -C ~/code/imps-runner checkout -q --detach origin/main` first). The contract is `~/code/imps-runner/imps/STANDARD.md`; read it before the first command in a session. State: `~/.imps/runs.jsonl` (the ledger), `~/.imps/dispatch.jsonl` (the hourly loop's log), and `~/.imps/briefs/`.

The hourly Windows task `imps-dispatch` already does everything below on its own: it sweeps imp PRs with fix rounds, then picks `imp:ready` issues (one per repo, never in a repo with an open imp PR) and runs imp → gate → draft PR → 9router review. Use `/imp` to go faster than the hour, to target something specific, or to check on it. All model work goes through 9router; none of it uses the Claude plan.

`K=~/code/imps-runner/imps` below.

## `/imp <repo>#<n>`: queue an issue (default)

1. Read the issue, then the code it points at in `~/code/<repo>` (from `origin/<default>`).
2. If it's narrow and verifiable, write a brief (format and checklist: STANDARD.md § A brief and § Brief checklist):
   - exact Docker `test:` with `{wt}` and a `imp-nm-<repo>` node_modules volume; filter tests by path prefix; add `tsc --noEmit` for TypeScript
   - `lint:`/`format:` when the repo has eslint
   - a tight `maxLines`
   - `allow:` including the repo's TASKS.md if it tracks the issue, plus its CHANGELOG
   - no inline `#` comments in the front matter
   - a body with "## The fix" naming the file, line and change, and "## Done when"
3. Post it on the issue as a comment starting with `<!-- imp-brief -->`, then one intro line, then the brief in a ```markdown fence. Add the label `imp:ready`. The hourly loop takes it.
4. If it isn't imp work (needs a visual check, a spec, a product call, or is a feature), post a short `<!-- imp-triage -->` comment saying why. Don't queue it.

**`--now`:** don't wait for the hour. Save the brief to `~/.imps/briefs/<repo>-<n>.md`, then run `node $K/imp.mjs run --brief <file>` → `node $K/imp.mjs gate <id>` → if it passes, `node $K/imp.mjs pr <id>` → `node $K/review.mjs <id>`. Only do this if the repo has no open `imp` PR, so they don't conflict.

## `/imp review <pr>`: 9router review

Find the run: the row in `~/.imps/runs.jsonl` whose `pr` matches. Then `node $K/review.mjs <id>` (add `--dry-run` to see it without posting). It posts one COMMENT review and records the verdict on the row. It only works for imp PRs (it needs the run's brief and worktree); for any other PR, say so and offer `/code-review` instead.

## `/imp fix <pr>`: 9router fix round

`node $K/fix.mjs <id> [--dry-run]`. It collects unresolved threads, new comments, the reviewer's blocker/major findings and red CI. It filters the noise, has the imp decide fix / pushback / skip per item, gates, pushes, replies and resolves. It stops after 2 rounds, or on a conflict, with `imp:needs-human`. It also clears a stale CodeRabbit block (`@coderabbitai approve`) when everything is green and resolved.

## `/imp merge <pr>`: land a passing imp PR

Don't wait on the user (they've delegated this). Merge when all of these hold: the gate passed, the imp review isn't `request_changes`, CI is green, no CodeRabbit block remains, and there's no `imp:needs-human` label.
1. `gh pr ready`.
2. In the run's worktree: fast-forward to the PR branch, merge `origin/main` in, and resolve CHANGELOG/TASKS conflicts by keeping both sides.
3. Tick or strike the issue in the repo's TASKS.md (`~~#n …~~ (fixed in #PR)` inside shared bullets), and commit as `Austin J. Hardy <88273576+nitsuah@users.noreply.github.com>`.
4. Push as separate commands: `git remote set-url --push origin "$(git remote get-url origin)"`, `git push origin HEAD`, `git remote set-url --push origin no_push`. **Confirm the push landed** (`git log origin/<branch> -1`) before merging; a failed push once merged two PRs without their TASKS strike.
5. Check `git diff origin/main...HEAD --stat` includes TASKS and CHANGELOG, then `gh pr merge --squash --delete-branch` (add `--auto` if checks are pending).

## `/imp status`

- `node $K/imp.mjs report`: per-run table (turns, errors, gate, review, outcome)
- the last ~10 lines of `~/.imps/dispatch.jsonl`: cycles, picks, PRs, fix-sweep results, skips
- `Get-ScheduledTask imps-dispatch | Get-ScheduledTaskInfo`: last and next run, and the result
- the queue: `gh search issues --owner nitsuah --state open --label imp:ready`, plus `imp:failed`
- open imp PRs (`--label imp`) and `imp:needs-human`

Summarize it as a short table, and flag anything red: no cycle in the last 2 h, gate failures, errors, needs-human.

## Rules

- Never edit the kit in `~/code/imps-runner` (it's reset to main every hour). Kit changes go through a branch and PR in a `nitsuah/.github` worktree.
- Every comment you post starts with an `<!-- imp-… -->` marker, so the fix round's noise filter skips it.
- Run npm/node/tests only through the briefs' Docker commands or `runtest.mjs`, never on the host.
