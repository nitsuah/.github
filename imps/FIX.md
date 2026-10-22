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

## Answer

End with exactly one fenced `json` block:

```json
{ "decisions": [ { "id": "<item id>", "action": "fix | pushback | skip", "reply": "What you changed, or why not, with the evidence." } ] }
```
