"""Line-count hotspots for one repo (deterministic replacement for the eng-loc Phase 0/1 report).

Usage: python loc.py <repo-dir> [--max-lines 500] [--top 15]
Prints markdown. Always exits 0: hotspots are advice, not a gate.
"""
import argparse
import os

EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".cs", ".java", ".rb", ".php",
    ".swift", ".kt", ".scala", ".cpp", ".cc", ".c", ".h", ".hpp", ".vue", ".svelte", ".ps1", ".sh",
}
EXCLUDE_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".pnpm-store", "vendor",
    "target", "bin", "obj", ".gradle", "out", ".claude", ".venv", "venv", ".obsidian", "env",
    "__pycache__", ".repo-health-kit",
}


def count_lines(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def scan(root):
    """Return [(relative path, lines)] for source files, largest first."""
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext not in EXTENSIONS or name.endswith(".min.js"):
                continue
            full = os.path.join(dirpath, name)
            out.append((os.path.relpath(full, root).replace(os.sep, "/"), count_lines(full)))
    return sorted(out, key=lambda t: (-t[1], t[0]))


def render(files, max_lines, top):
    total = sum(n for _, n in files)
    over = [(p, n) for p, n in files if n > max_lines]
    lines = ["## LOC hotspots", "",
             f"{len(files)} source files, {total} lines. {len(over)} over {max_lines} lines.", ""]
    if over:
        lines += ["| File | Lines |", "|---|---|"]
        lines += [f"| `{p}` | {n} |" for p, n in over[:top]]
        if len(over) > top:
            lines.append(f"\n...and {len(over) - top} more.")
    else:
        lines.append("No file is over the limit.")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--max-lines", type=int, default=500)
    ap.add_argument("--top", type=int, default=15)
    args = ap.parse_args()
    print(render(scan(args.repo), args.max_lines, args.top), end="")


if __name__ == "__main__":
    main()
