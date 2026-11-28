# Tooling preferences

## Prefer Docker Desktop for npm/node/container/WSL workloads

When a task involves running npm, node, or other JS/TS toolchain commands (install,
build, test, dev servers, linting, etc.), or anything that would otherwise need a
container or WSL environment, prefer running it inside a Docker container via Docker
Desktop rather than invoking npm/node directly on the Windows host.

In practice this means:
- Check whether the project already has a Dockerfile / docker-compose.yml / devcontainer
  setup. If so, use it (`docker compose run`, `docker compose up`, `docker exec`, etc.).
- If no container setup exists but the task is substantial (installing deps, running a
  dev server, running the test suite, building), prefer spinning up or using an existing
  Docker container with the right Node version rather than relying on a local/global
  Node install.
- Only fall back to running npm/node directly on the host when:
  - A genuinely global tool/CLI is required (e.g. something that must integrate with the
    host OS, editor, or shell directly), or
  - Docker Desktop is not available/running and the user confirms it's fine to run
    locally, or
  - The operation is trivial (e.g. a one-off `npm --version` check) where containerizing
    would add pure overhead with no benefit.
- Before assuming Docker is available, verify Docker Desktop is running (e.g.
  `docker info`) — if it isn't, say so and ask whether to start it or proceed locally
  rather than silently falling back to the host toolchain.
- Read-only registry/version lookups (e.g. `npm view <pkg> version`, `npm --version`)
  don't touch project state and gain nothing from a container — run those locally
  rather than spinning up Docker for them.

# PRs close their own tracked work

Before the last push of any PR that completes a TASKS.md / ROADMAP.md item, update
those docs (plus CHANGELOG, and README/FEATURES if affected) in the same branch, and
before merging confirm `git diff origin/main...HEAD --stat` includes them. Never merge
first and fix the docs in a follow-up PR; week-sotu reads TASKS.md from main.

# Maintaining this file

- Keep this file lean: every line should be something that, if removed, would cause a
  mistake. If a rule keeps getting missed, the file is too long — prune before adding.
- When you make a mistake here that I correct, offer to add a short note to this file so
  it isn't repeated. Don't add notes for one-off slip-ups; only for patterns likely to
  recur.
