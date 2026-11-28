## This is a fix round

You already opened a PR for this issue (your earlier commits are in this worktree). Reviewers and CI responded. Below are the **feedback items** for this round, each with an `id`. For **every** item, make exactly one decision:

- **fix**: the item is right, and fixing it belongs in this PR. Make the smallest change that resolves it.
- **pushback**: the item is wrong. Say why, with evidence: the file and line you read, the test that covers it, or the brief's instruction it contradicts. Change nothing for it.
- **skip**: the item is right but out of scope for this issue (a pre-existing problem, a refactor, a different feature). Say it should be its own issue. Change nothing for it.

## How to judge (this is how a senior reviewer treats bot feedback)

- **Verify against the code before deciding.** Read the file at the line the item points at. Some findings are already fixed, outdated, or about code this PR didn't touch.
- **Bots are often right on specifics and wrong on scope.** A correct, small, in-scope finding is a `fix`. "Also refactor X" or "consider handling Y everywhere" on code this PR didn't change is a `skip`.
- **Don't fix to make a bot happy.** If a suggestion would add a dependency, widen the diff past the brief's scope, or change behaviour the issue didn't ask for, push back or skip, and say so.
- **Rate-limit notices, summaries and "review skipped" messages are never items.** The runner filtered them out. If something like that slipped through, `skip` it with "not feedback".
- **A failing CI check is always worth a look:** read the log excerpt and fix the cause if it's in your diff. If the failure is unrelated to your change (flaky, infrastructure, a pre-existing failure on main), `pushback` with the evidence.
- **A human's comment outranks a bot's.** Don't push back on the repo owner unless they asked a question; then answer it in the reply.

## Rules (in addition to the preamble)

- The same gate runs again after you: tests, lint, scope, and size (with a little slack for this round). Stay inside the brief's `allow:` paths.
- Commit your fixes as **one** commit (`fix: address review on #<PR>`, body listing the item ids you fixed, ending with the imp trailer). If every decision is pushback or skip, don't commit at all.
- Replies are posted on GitHub as-is: one to three sentences, specific, no apologies, no "great catch".

## Recurring misjudgements (fix-round model gets these wrong → gate fails)

- **CodeRabbit "Review limit reached" / rate-limit banners** — noise, never feedback. `feedbackItems` drops them via `botLogin()`. If one slips through, `pushback` with "not feedback: bot summary".
- **Netlify deploy preview comments** ("Deploy Preview ready", "Pages changed - x", "Header rules - x", "Redirect rules - x") — noise. `feedbackItems` drops via name filter on checks and `botLogin()` on comments. If one slips through, `pushback`.
- **Threads where imp replied last** (`IMP_MARK` in last comment) — already handled, waiting on reviewer. `feedbackItems` skips these. If model sees one, `skip` with "already answered in previous round".
- **Stale/outdated threads** (`isResolved` or `isOutdated`) — `feedbackItems` skips. If model sees one, `skip`.
- **CI failures from deploy checks** (Netlify, Pages changed, Header rules, Redirect rules) — not code feedback. `feedbackItems` filters by name. If one slips through, `pushback` with "deploy check, not code".
- **Imp reviewer nits** (severity `nit`) — `feedbackItems` only surfaces `blocker`/`major`. If a nit appears, `skip` with "nit, out of scope for fix round".
- **Comments older than `since`** — `feedbackItems` filters by `createdAt`. If model sees one, `skip` with "before cutoff".
- **`@coderabbitai approve` / commands** — `feedbackItems` drops comments starting with `@coderabbitai`. If one slips, `pushback` with "bot command, not feedback".
- **Empty/whitespace comments** — `feedbackItems` drops. If one slips, `pushback`.
- **Treating out-of-scope "fix" as in-scope** — Item is real but belongs in a different issue/PR. Action: `skip` with "out of scope: #<issue> tracks it". Do not `fix` and bloat diff.
- **Treating wrong finding as "fix"** — Finding is outdated, already fixed, or about code this PR didn't touch. Action: `pushback` with evidence (file:line, test, or brief instruction it contradicts).
- **Duplicate item IDs in model output** — `parseFixDecisions` nulls duplicates. Never emit same `id` twice.
- **Non-string or missing `id` in decisions** — `parseFixDecisions` rejects. Always use exact `id` from item list.
- **Invalid `action`** — Only `fix`, `pushback`, `skip` accepted. Others become `null` (unanswered → thread stays open → needs-human).

## Answer

End with exactly one fenced `json` block:

```json
{ "decisions": [ { "id": "<item id>", "action": "fix | pushback | skip", "reply": "What you changed, or why not, with the evidence." } ] }
```
