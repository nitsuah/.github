# The warlock, the imp-runner, and the imps

> Contract for how many of each thing runs on a machine. Checked by
> [`warlock.mjs`](./warlock.mjs): `node imps/warlock.mjs`.
> Sibling contracts: [`STANDARD.md`](./STANDARD.md) (one run), [`README.md`](./README.md) (install).

**One warlock per machine. Many imps per machine. Many machines.**

That is the whole rule. Everything below is what it means in practice and
what breaks when it is violated.

## The three words

| Word | What it is | How many | Lives where |
| --- | --- | --- | --- |
| **warlock** | the single `dispatch.mjs` cycle on a machine. No LLM of its own — it reads the GitHub queue, runs fix-sweeps, picks work, and spawns imps. | **exactly 1 per machine** | one Scheduled Task (`imps-dispatch`) → `~/.imps/hourly.cmd` → `<kit>/imps/dispatch.mjs` |
| **imp-runner** | the kit checkout the warlock executes. A detached clone pinned to `origin/main`, reset before every run. Holds no state of its own. | 1 per machine (shared by every imp) | the path in `~/.imps/kit-path.txt` / `$env:IMPS_KIT_PATH` (default `%LOCALAPPDATA%\imps-runner`) |
| **imp** | a headless `claude -p` worker through 9router. Takes one brief → one worktree → one small PR. Can't push; the runner pushes. | **many, unbounded by design** — capped by `--concurrency`, `--per-repo`, `--wip`, `--daily-cap` | disposable worktrees under `~/code/<repo>-<run-id>`; nothing survives the run |

The warlock is a lock-holder, not a worker. It never edits a repo. If you find
yourself wanting "another warlock" for throughput, raise `--concurrency`
(imps) instead — that is the knob that scales.

## Why exactly one warlock

The warlock's job is to be the only thing deciding *what runs next*. Two of
them on one machine see the same GitHub labels and pick the same issues, which
means two imps cut worktrees for the same brief and race on the same
`imp-nm-<repo>` node_modules volume. The symptom is not a clean error: it is
`npm ci` corruption and gate failures that look like bad briefs.

Two protections exist, and a second warlock must get past both:

1. `dispatch.lock` — written on entry, removed on exit, and a cycle **skips
   entirely** if the lock is under 3 hours old. This stops overlap, not
   duplication: two warlocks started 4 hours apart both run.
2. One Scheduled Task per machine. `setup.ps1` registers `imps-dispatch`;
   registering a second under a different name is the mistake to avoid.

So "one warlock" is a *configuration invariant*, not something the code can
enforce for you. That is why `warlock.mjs` checks it.

## Why the imp-runner must be a git checkout

The runner is reset to `origin/main` before each run, which only works if it
is a clone. A directory that merely *contains* `imps/dispatch.mjs` — a hand
copy, an old extract, a stub — passes an "is the file there" check and then
never improves. `setup.ps1` refuses to install over one
(`"exists and is not a git checkout"`), and `hourly.cmd` on a stale copy will
either run old code forever or exit early with a message nobody reads.

This actually happened on this machine on 2026-10-26: `~/code/imps-runner`
held a 78-byte `dispatch.mjs` stub with no `.git`, so `hourly.cmd` logged
`IMP dispatch stub executed` on schedule while the real cycles came from
hand-run `/imp`. Every check in `warlock.mjs` exists because something in this
section went wrong in the wild.

## Many machines

Machines are independent. Each has its own warlock, its own runner, its own
`~/.imps` state. They are coordinated **only through GitHub**:

- **The queue is the lock.** `imp:ready` → `imp:working` is a label flip the
  warlock does before spawning. A warlock on another machine sees the label
  and does not pick it. This is coarse (there is a window between reading the
  search results and the flip) and that is accepted: a duplicate imp produces
  a duplicate PR, which a human closes, not a corrupted repo.
- **The ledger is per-machine.** `~/.imps/runs.jsonl` is local. A warlock
  cannot fix-sweep a PR opened from another machine's ledger — it logs the PR
  as unknown and skips. Fix rounds therefore happen on the machine that
  opened the PR.
- **Nothing else is shared.** No shared lock, no shared volume, no leader
  election. Adding either is a design change, not a config change.

Practical consequence: to make a second machine useful, give it the kit
(`setup.ps1`) and let it see the same `imp:ready` labels. Do not point two
machines at one `IMPS_HOME`.

## What `warlock.mjs` checks

Run it after any setup change or when the queue looks stuck. It reads only
local state and prints one line per check:

| Check | Fails when |
| --- | --- |
| runner is a git checkout | the runner path has no `.git` |
| runner tracks origin/main | checkout is dirty, detached elsewhere, or behind |
| hourly.cmd points at the runner | `hourly.cmd` runs a different path than `kit-path.txt` |
| exactly one dispatch task | zero, or more than one, task whose action runs a dispatcher |
| lock not stale | `dispatch.lock` is older than 3 h (a cycle died and never unlocked) |
| 9router reachable | the `MAX` probe fails (the warlock skips every cycle) |
| ledger is writable | `~/.imps/runs.jsonl` is missing or unparseable |

Exit code is `0` when every check passes, `1` otherwise, so it can gate a
script. It never mutates anything — the fix for every failure is a sentence in
the output.

## Changing this contract

`WARLOCK.md` is prose; `warlock.mjs` is the thing that fails. If you add a
check, add its row above in the same PR. `README.md` links here from the
"Fresh machine" section so a new machine learns the rule before it runs two
warlocks.
