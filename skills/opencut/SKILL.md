---
name: opencut
description: Video editing with OpenCut (open-source CapCut alternative) via MCP. Handles full lifecycle — fresh-machine setup, starting the local editor, and AI-driven editing using 161 MCP tools (timeline, effects, text, audio, export). Use when user asks to edit video, add captions, apply effects, export clips, or set up OpenCut on a new machine.
user_invocable: true
---

# /opencut — AI Video Editor (OpenCut + MCP)

AI-powered video editing via the local OpenCut editor. Claude controls the editor directly using Playwright-based MCP tools.

## Stack

| Component | Location |
|---|---|
| OpenCut editor (classic) | `C:\Users\ajhar\code\opencut` |
| MCP controller | `C:\Users\ajhar\code\opencut-controller` |
| Editor URL | `http://localhost:3000` |
| Bun binary | `C:\Users\ajhar\.bun\bin\bun.exe` |

---

## Usage

```
/opencut <task>
```

Examples:
- `/opencut setup` — fresh-machine install (see Setup section)
- `/opencut start` — start the local editor
- `/opencut "add captions to client-video.mp4"`
- `/opencut "trim the first 5 seconds and add a fade-in"`
- `/opencut "export as 1080p MP4 for Instagram"`

---

## Setup — Fresh Machine

Run this section when OpenCut isn't yet installed on the machine.

### Step 1 — Install Bun
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# Then restart the terminal or add to PATH:
$env:PATH = "$env:PATH;$env:USERPROFILE\.bun\bin"
```

Verify: `bun --version` should print `1.3+`

### Step 2 — Clone repos
```powershell
git clone https://github.com/nitsuah/opencut-classic.git C:\Users\ajhar\code\opencut
git clone https://github.com/JXUE0/opencut-controller.git C:\Users\ajhar\code\opencut-controller
```

### Step 3 — Install controller deps (downloads Playwright + Chromium ~290 MB)
```powershell
Set-Location C:\Users\ajhar\code\opencut-controller
bun install
```

### Step 4 — Create .env (gitignored, must be done manually)
```powershell
Set-Content C:\Users\ajhar\code\opencut\apps\web\.env @'

NODE_ENV=development
NEXT_PUBLIC_SITE_URL=http://localhost:3000
DATABASE_URL="postgresql://opencut:opencut@localhost:5432/opencut"
BETTER_AUTH_SECRET=dummy_secret
'@
```
The patch code changes are already in the fork — you only need to create this file.

### Step 5 — Install editor deps
```powershell
Set-Location C:\Users\ajhar\code\opencut
bun install
```

### Step 6 — Add MCP to Claude config
Add to `~/.claude/mcp.json`:
```json
{
  "opencut": {
    "type": "stdio",
    "command": "C:\\Users\\<USERNAME>\\.bun\\bin\\bun.exe",
    "args": ["run", "C:\\Users\\<USERNAME>\\code\\opencut-controller\\src\\index.ts"]
  }
}
```
Replace `<USERNAME>` with the actual Windows username.

---

## Starting the Editor

**Terminal 1 — Start OpenCut:**
```powershell
$env:PATH = "$env:PATH;$env:USERPROFILE\.bun\bin"
Set-Location C:\Users\ajhar\code\opencut
bun dev:web
```
Wait for: `✓ Ready — started server on 0.0.0.0:3000`

The MCP controller connects automatically when Claude uses any `mcp__opencut__*` tool.

---

## Editing Workflow

### 1 — Check editor is running
Before using MCP tools, verify OpenCut is accessible at `http://localhost:3000`. If not running, start it (see above).

### 2 — Create or open project
```
mcp__opencut__create_project  → create new project
mcp__opencut__open_project    → open existing project by name
mcp__opencut__list_projects   → list all projects
```

### 3 — Import media
```
mcp__opencut__import_media    → import video/audio/image file by path
```

### 4 — Edit
Key tools by task:

| Task | MCP Tool |
|---|---|
| Add clip to timeline | `mcp__opencut__add_clip_to_timeline` |
| Trim clip | `mcp__opencut__trim_clip` |
| Split clip at playhead | `mcp__opencut__split_clip` |
| Add text overlay | `mcp__opencut__add_text_overlay` |
| Auto-transcribe + captions | `mcp__opencut__transcribe_audio` |
| Apply visual effect | `mcp__opencut__apply_effect` |
| Add background music | `mcp__opencut__search_music` → `mcp__opencut__add_audio_track` |
| Adjust volume | `mcp__opencut__set_clip_volume` |
| Add fade in/out | `mcp__opencut__add_audio_fade` |
| Add transition | `mcp__opencut__add_transition` |
| Move clip | `mcp__opencut__move_clip` |
| Duplicate clip | `mcp__opencut__duplicate_clip` |

### 5 — Export
```
mcp__opencut__export_project  → render and export video
```
Common export presets: `1080p`, `720p`, `instagram-reels` (9:16), `youtube` (16:9)

### 6 — Save
```
mcp__opencut__save_project    → save current project state
```

---

## Common Client Tasks

### Add subtitles/captions to a video
1. Import the video file
2. Call `mcp__opencut__transcribe_audio` — auto-generates timed captions
3. Review/adjust caption timing with `mcp__opencut__edit_text`
4. Export

### Create social media clip (portrait 9:16)
1. Create project, set canvas to portrait
2. Import source footage
3. Trim to desired length (max 60s for Reels/TikTok)
4. Add captions if needed
5. Add music from OpenCut's sound library
6. Export with `instagram-reels` preset

### Add intro/outro
Use the built-in MCP prompt: tell the MCP `create_intro_video` — automates a 10-second intro with text overlays.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `window.__opencut is undefined` | You're connected to production opencut.app. Run locally: `bun dev:web` |
| MCP tools not found | Check `~/.claude/mcp.json` has the opencut entry; restart Claude Code |
| `bun: command not found` | Add to PATH: `$env:PATH = "$env:PATH;$env:USERPROFILE\.bun\bin"` |
| Editor won't start | Run `bun install` in `C:\Users\ajhar\code\opencut` first |
| Playwright browser missing | Run `bun run playwright install chromium` in the controller folder |
| React version error | Re-run the patch script: `bun run scripts/patch-editor.ts C:\Users\ajhar\code\opencut` |
| Connection timeout | Wait for `✓ Ready` in the editor terminal before using MCP tools |

---

## MCP Tools — Full Category List

161 tools across 17 categories:
- **Project** (6): create, open, save, export, list, delete
- **Scenes** (8): create, rename, delete, duplicate, reorder
- **Playback** (5): play, pause, stop, seek, set speed
- **Timeline Tracks** (7): add, remove, lock, mute, reorder
- **Timeline Elements** (12): trim, split, move, duplicate, delete, select
- **Effects** (9): apply, remove, adjust parameters, presets
- **Keyframes** (8): add, delete, move, set easing
- **Selection/Clipboard** (10): copy, cut, paste, select all, deselect
- **History** (5): undo, redo, jump to state
- **Media** (10): import, search, trim, optimize
- **Text** (7): add overlay, edit, animate, style
- **Audio** (11): search music/SFX, volume, fades, pitch
- **Stickers/Canvas** (11): add sticker, canvas zoom, resolution, pan
- **Transcribe/Export** (10): transcribe, generate captions, render
- **Bookmarks/Panels** (10): UI navigation, layout management
- **Auth & Storage** (13): project backup, sync, session
- **API** (8): direct backend endpoint access

Use `mcp__opencut__<tool_name>` to call any tool.

---

## Continuous improvement

After a session, if a step here was wrong, out of date, or caused avoidable manual work (a renamed tool, a patch that needs reapplying, a version bump that broke something), fix this file directly rather than repeating the workaround next time.
