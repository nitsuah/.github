"""Root-file hygiene for one repo (deterministic replacement for the eng-mini root audit).

Classifies every root entry as KEEP (a directory, or a known root-required file or tool config,
LICENSE included) or unclassified (a human or the monthly PMO pass decides). Nothing is ever moved.

Usage: python root_hygiene.py <repo-dir>
Prints markdown. Exits 0.
"""
import fnmatch
import os
import sys

KEEP_PATTERNS = [
    "README*", "LICENSE*", "COPYING*", "NOTICE*", "CHANGELOG*", "CONTRIBUTING*", "CODE_OF_CONDUCT*",
    "SECURITY*", "SUPPORT*", "TASKS*", "ROADMAP*", "FEATURES*", "METRICS*", "ARCHITECTURE*", "API*",
    "CLAUDE.md", "AGENTS.md", ".git", ".github", ".gitignore", ".gitattributes", ".gitmodules",
    ".dockerignore", "Dockerfile*", "docker-compose*.y*ml", "compose*.y*ml", ".env*", ".nvmrc",
    ".node-version", ".python-version", ".tool-versions", ".editorconfig", ".prettier*",
    "prettier.config.*", ".eslint*", "eslint.config.*", ".stylelint*", ".npmrc", ".yarnrc*",
    ".husky", ".pre-commit-config.y*ml", ".coderabbit.y*ml", ".claude", ".vscode", ".devcontainer",
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "bun.lock*", "tsconfig*.json", "jsconfig.json", "vite.config.*", "vitest.config.*",
    "jest.config.*", "jest.setup.*", "next.config.*", "next-env.d.ts", "tailwind.config.*",
    "postcss.config.*", "babel.config.*", ".babelrc*", "webpack.config.*", "rollup.config.*",
    "playwright*.config.*", "netlify.toml", "vercel.json", "wrangler.toml", "fly.toml",
    "Procfile", "Makefile", "justfile", "pyproject.toml", "setup.py", "setup.cfg", "requirements*.txt",
    "poetry.lock", "uv.lock", "Pipfile*", "tox.ini", "pytest.ini", "ruff.toml", ".ruff.toml",
    "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile*", "composer.*", "pom.xml",
    "build.gradle*", "settings.gradle*", "gradlew*", "*.sln", "*.csproj", "global.json",
    "manifest.json", "index.html", "_headers", "_redirects", "renovate.json", ".releaserc*",
    "knip.json", "components.json", "drizzle.config.*", "CODEOWNERS", "PULL_REQUEST_TEMPLATE*",
    ".pytest_cache", ".ruff_cache", ".mypy_cache",
]


def classify(names, dirs=()):
    """Directories are never flagged (src/, docs/ and friends are normal); loose files are."""
    keep, unknown = [], []
    for name in sorted(names):
        if name in dirs or any(fnmatch.fnmatchcase(name, pat) for pat in KEEP_PATTERNS):
            keep.append(name)
        else:
            unknown.append(name)
    return keep, unknown


def render(names, dirs=()):
    keep, unknown = classify(names, dirs)
    lines = ["## Root hygiene", "",
             f"{len(names)} root entries: {len(keep)} known root files, {len(unknown)} unclassified.", ""]
    if unknown:
        lines += ["Unclassified (move to a folder if safe, or add to the allowlist):", ""]
        lines += [f"- `{n}`" for n in unknown]
    else:
        lines.append("Nothing to review.")
    return "\n".join(lines) + "\n"


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    names = [n for n in os.listdir(root) if n != ".repo-health-kit"]
    dirs = {n for n in names if os.path.isdir(os.path.join(root, n))}
    print(render(names, dirs), end="")


if __name__ == "__main__":
    main()
