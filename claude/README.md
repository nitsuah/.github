# Claude Code kit

The shared Claude Code setup for every machine and every person who uses this kit.
It is installed with the imps kit and updated with it, so a merge to `main` reaches every machine.

## What goes where

| Tier | Where | What | How it moves |
|---|---|---|---|
| **Kit** | this repo (public) | `skills/`, `claude/hooks/`, `claude/CLAUDE.md`, `claude/settings.base.json`, `claude/mcp.base.json` | PR upstream, then `imps/update.ps1` pulls it to each machine |
| **Private** | OneDrive `claude-sync` (`CLAUDE_PRIVATE_SYNC`) | memory, `private/` context, scheduled-task prompts, local-only skills or assets (licensed music, third-party hooks such as peon-ping) | present on every machine you sign in to; distilled into the stash vault, not committed |
| **Machine** | `~/.claude/machine.json` | API keys, router URLs, per-machine overrides | never synced, never committed, owner-only ACL |

Rules:
- Templates hold no keys and no personal paths. Use `{{HOME}}`, `{{CLAUDE}}`, `{{CODE}}`, `{{KIT}}`, and `{{secret:NAME}}` for values that live in `machine.json` under `secrets`.
- To change a setting for everyone, edit `settings.base.json` in a PR. To change it for one machine, put it under `settings` in `machine.json`. Edits made straight to `~/.claude/settings.json` are overwritten on the next install.
- A skill in the kit wins over a private skill with the same name. Delete the private copy once the kit has it.

## New machine

```powershell
pwsh -File imps/setup.ps1            # clones the kit to the runner path
pwsh -File claude/install.ps1        # dry run: shows every change
pwsh -File claude/install.ps1 -Apply
```

On a machine with no live config, `install.ps1` creates an empty `machine.json` and warns about each missing secret. Fill those in, then run it again.

## `machine.json`

```json
{
  "secrets":  { "OBSIDIAN_AUTH": "Bearer ..." },
  "settings": { "env": { "ANTHROPIC_BASE_URL": "...", "NINEROUTER_KEY": "..." } },
  "mcp":      {}
}
```

`settings` and `mcp` are deep-merged over the templates. This is the interim home for keys. The planned replacement is SOPS + age (security-program secrets plan).
