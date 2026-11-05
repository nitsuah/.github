import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


loc, rh, osv = load("loc"), load("root_hygiene"), load("osv_summary")


def test_loc_flags_big_files_and_skips_excluded(tmp_path):
    (tmp_path / "big.py").write_text("x\n" * 600)
    (tmp_path / "small.py").write_text("x\n" * 5)
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "huge.js").write_text("x\n" * 9000)
    files = loc.scan(str(tmp_path))
    assert [p for p, _ in files] == ["big.py", "small.py"]
    out = loc.render(files, 500, 15)
    assert "| `big.py` | 600 |" in out and "small.py" not in out


def test_root_hygiene_keeps_license_and_flags_strays():
    keep, unknown = rh.classify(["LICENSE", "package.json", "notes-todo.txt", ".env.example", "scratch.py"])
    assert "LICENSE" in keep and ".env.example" in keep
    assert unknown == ["notes-todo.txt", "scratch.py"]


def test_osv_summary_for_tire_line():
    data = {"results": [{"packages": [{
        "package": {"name": "lodash", "version": "4.17.20", "ecosystem": "npm"},
        "vulnerabilities": [{"id": "GHSA-x", "affected": [{"package": {"name": "lodash"},
                             "ranges": [{"events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}]}],
        "groups": [{"ids": ["GHSA-x"], "max_severity": "7.5"},
                   {"ids": ["GHSA-y"], "max_severity": "3.1"}],
    }]}]}
    out = osv.render(osv.findings(data), "fire", 7.0)
    assert "quick | fire | bump lodash 4.17.20->4.17.21 (GHSA-x) | peer-dep risk: unknown" in out
    assert out.count("quick |") == 1
    assert "HIGH" in out and "LOW" in out


def test_osv_summary_includes_source_path():
    data = {"results": [{"source": {"type": "lockfile", "path": "backend/package-lock.json"},
                         "packages": [{"package": {"name": "lodash", "version": "4.17.20", "ecosystem": "npm"},
                                       "vulnerabilities": [{"id": "GHSA-x", "affected": [{"package": {"name": "lodash"},
                                           "ranges": [{"events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}]}],
                                       "groups": [{"ids": ["GHSA-x"], "max_severity": "7.5"}]}]}]}
    out = osv.render(osv.findings(data), "sample", 7.0)
    assert "backend/package-lock.json" in out
    assert "lockfile" in out


def test_osv_summary_empty():
    assert "No known vulnerabilities" in osv.render(osv.findings({}), "fire", 7.0)


def test_root_hygiene_never_flags_directories():
    keep, unknown = rh.classify(["src", "stray.txt"], dirs={"src"})
    assert keep == ["src"] and unknown == ["stray.txt"]


def test_osv_summary_empty_results_is_clean(tmp_path, monkeypatch, capsys):
    import sys

    result = tmp_path / "osv.json"
    result.write_text('{"results": []}', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["osv_summary.py", str(result), "fire"])
    assert osv.main() == 0
    assert "No known vulnerabilities" in capsys.readouterr().out


def test_osv_summary_invalid_output_is_operational_error(tmp_path, monkeypatch, capsys):
    import sys

    result = tmp_path / "osv.json"
    result.write_text("", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["osv_summary.py", str(result), "fire"])
    assert osv.main() == 2
    assert "ERROR: unable to parse OSV scanner output" in capsys.readouterr().err


def test_osv_workflow_excludes_shared_kit_checkout():
    workflow_path = os.path.join(
        HERE, "..", ".github", "workflows", "repo-health.yml"
    )
    with open(workflow_path, encoding="utf-8") as f:
        workflow = f.read()
    assert (
        "scan source -r --x-exclude=.repo-health-kit "
        "--format json --allow-no-lockfiles /src"
    ) in workflow
