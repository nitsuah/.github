"""Summarize `osv-scanner --format json` output (deterministic replacement for the week-vuln advisory lookup).

Usage: python osv_summary.py <osv.json> <repo-name> [--min-severity 7.0]
Prints markdown plus a '## For TIRE' section (one line per HIGH/CRITICAL finding with a known fix).
Exit code: 1 when any finding is at or above --min-severity, 2 when scanner output is invalid.
"""
import argparse
import json
import sys


def severity_label(score):
    if score >= 9.0:
        return "CRITICAL"
    if score >= 7.0:
        return "HIGH"
    if score >= 4.0:
        return "MEDIUM"
    return "LOW"


def fixed_versions(vuln, package):
    fixed = set()
    for aff in vuln.get("affected", []):
        if aff.get("package", {}).get("name") != package:
            continue
        for rng in aff.get("ranges", []):
            for ev in rng.get("events", []):
                if "fixed" in ev:
                    fixed.add(ev["fixed"])
    return sorted(fixed)


def findings(data):
    """Return findings with scanner provenance for accurate remediation."""
    out = []
    for res in data.get("results", []):
        source = res.get("source", {}) or {}
        source_path = source.get("path") or source.get("name") or "unknown"
        source_type = source.get("type") or "unknown"
        for pkg in res.get("packages", []):
            info = pkg.get("package", {})
            vulns = {v["id"]: v for v in pkg.get("vulnerabilities", [])}
            for group in pkg.get("groups", []):
                try:
                    score = float(group.get("max_severity") or 0)
                except ValueError:
                    score = 0.0
                ids = group.get("ids", [])
                vuln = vulns.get(ids[0], {}) if ids else {}
                out.append({
                    "package": info.get("name", "?"), "version": info.get("version", "?"),
                    "ecosystem": info.get("ecosystem", "?"), "id": ids[0] if ids else "?",
                    "score": score, "fixed": fixed_versions(vuln, info.get("name", "")),
                    "source": source_path, "source_type": source_type,
                })
    return sorted(out, key=lambda f: (-f["score"], f["package"]))


def render(items, repo, min_severity):
    lines = ["## Dependency advisories (osv-scanner)", ""]
    if not items:
        return "\n".join(lines + ["No known vulnerabilities."]) + "\n"
    lines += ["| Package | Current | Fixed in | Advisory | Severity | Scanner source |",
              "|---|---|---|---|---|---|"]
    for f in items:
        fixed = ", ".join(f["fixed"]) or "no fix"
        lines.append(f"| {f['package']} | {f['version']} | {fixed} | {f['id']} | "
                     f"{severity_label(f['score'])} | {f['source']} ({f['source_type']}) |")
    tire = [f for f in items if f["score"] >= min_severity and f["fixed"]]
    lines += ["", "## For TIRE", ""]
    lines += [f"quick | {repo} | bump {f['package']} {f['version']}->{f['fixed'][0]} ({f['id']}) | peer-dep risk: unknown"
              for f in tire] or ["None."]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_path")
    ap.add_argument("repo")
    ap.add_argument("--min-severity", type=float, default=7.0)
    args = ap.parse_args()
    try:
        with open(args.json_path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            raise ValueError("OSV output is missing a valid results array")
    except (OSError, ValueError) as exc:
        print(f"ERROR: unable to parse OSV scanner output: {exc}", file=sys.stderr)
        return 2
    items = findings(data)
    sys.stdout.write(render(items, args.repo, args.min_severity))
    return 1 if any(f["score"] >= args.min_severity for f in items) else 0


if __name__ == "__main__":
    sys.exit(main())
