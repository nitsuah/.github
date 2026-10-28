---
name: content-gen
description: Generate AI short videos from a topic using MoneyPrinterTurbo running locally in Docker. Handles Docker lifecycle (auto-start + auto-stop), submits generation jobs via REST API, polls until render completes, and returns download URLs. Use when user asks to make/generate/create a video or content.
user_invocable: true
---

# /content-gen — AI Video Generator

Generates HD short videos from a topic using the local MoneyPrinterTurbo Docker stack.

## Requires
`agent-board` repo at `~/code\agent-board` on `main` (or the feature branch merged to main).
The Docker compose file and tool source both live there.

## Backend
The `content-gen` MCP server runs at **http://localhost:3200** as a Docker container
in the `agent-board` tools stack. Source: `~/code\agent-board\tools\content-gen\`

**Start:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" --profile tools up tool-content-gen -d
```

**Stop:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" --profile tools stop tool-content-gen
```

**Logs:**
```powershell
docker compose -f "~/code\agent-board\config\docker-compose.yml" logs -f tool-content-gen
```

## Usage

```
/content-gen <topic> [options]
```

**Options** (parse from user's message):
| Arg | Values | Default |
|---|---|---|
| `--aspect` / `-a` | `portrait` (9:16), `landscape` (16:9) | `portrait` |
| `--count` / `-n` | 1–5 | `1` |
| `--lang` | BCP-47 language code | `en` |
| `--no-subs` | flag | subtitles ON |
| `--keep` | flag | auto-stop OFF |
| `--script` | quoted string | (LLM generates) |

Examples:
- `/content-gen "5 morning habits for productivity"` → portrait, 1 video, English
- `/content-gen "cooking pasta" --aspect landscape --count 3`
- `/content-gen "sleep tips" --script "Tip 1: no screens. Tip 2: ..."`

## Step-by-step execution

### 1. Parse arguments
Extract the topic and options from the user's message.

### 2. Check if MCP server is available
Try `GET http://localhost:3200/health`. If it fails, fall back to running the
PowerShell script directly (legacy path).

### 3a. Via MCP server (preferred)
Call the `generate_video` tool on the content-gen MCP server at `http://localhost:3200/mcp`.

Tool parameters:
```json
{
  "topic":     "<TOPIC>",
  "aspect":    "portrait",
  "count":     1,
  "language":  "en",
  "subtitles": true
}
```

### 3b. Via PowerShell script (fallback / legacy)
```powershell
$params = @{
    Topic      = "<TOPIC>"
    Aspect     = "portrait"
    Language   = "en"
    Count      = 1
    Subtitles  = "on"
    KeepRunning = $false
}
& "~/code\agent-board\tools\content-gen\scripts\generate-video.ps1" @params
```
Set `timeout` to **600000** (10 minutes).

### 4. Report results
- Lines starting with `✓ http://` are download URLs — relay them clearly.
- Mention the web UI at **http://localhost:8501** for visual management.

## Container management commands

```powershell
# Start
docker compose -f "~/code\agent-board\tools\content-gen\MoneyPrinterTurbo\docker-compose.yml" up -d

# Stop
docker compose -f "~/code\agent-board\tools\content-gen\MoneyPrinterTurbo\docker-compose.yml" stop

# Logs
docker compose -f "~/code\agent-board\tools\content-gen\MoneyPrinterTurbo\docker-compose.yml" logs --tail 50 -f
```

## First-run check
If MCP server fails with "No such file" or container won't start:
```powershell
# Start the tool via Docker (builds image on first run):
docker compose -f "~/code\agent-board\config\docker-compose.yml" --profile tools up tool-content-gen -d
# One-time setup (API keys):
docker compose -f "~/code\agent-board\config\docker-compose.yml" exec tool-content-gen pwsh -File scripts/setup.ps1
```

## Troubleshooting
| Symptom | Fix |
|---|---|
| MCP server not responding | Run the Docker compose start command above |
| "No pexels_api_keys" error | Edit `agent-board/tools/content-gen/MoneyPrinterTurbo/config.toml` — all keys must be inside `[app]` section |
| LLM auth error | Check API key in config.toml |
| Container won't start | `docker info` to confirm Docker Desktop is running |

## Continuous improvement

After a run, if a step here was wrong, out of date, or caused avoidable manual work, fix this file directly rather than repeating the workaround next time.
