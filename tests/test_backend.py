"""Backend contract tests. Run with the Hermes venv python (it has fastapi + pytest):

    env -u PYTHONPATH <hermes>/venv/Scripts/python.exe -m pytest tests -q
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


api = _load("hermes_ide_plugin_api", ROOT / "dashboard" / "plugin_api.py")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(api, "_hermes_home", lambda: (tmp_path / "home").resolve())
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/hermes-ide")
    return TestClient(app)


def post(client, route, **body):
    return client.post(f"/api/plugins/hermes-ide{route}", json=body)


def test_list_read_write_roundtrip_keeps_crlf_and_bom(client, tmp_path):
    f = tmp_path / "ws" / "a.txt"
    f.parent.mkdir()
    f.write_bytes(b"\xef\xbb\xbfone\r\ntwo\r\n")
    listing = post(client, "/fs/list", path=str(tmp_path / "ws")).json()
    assert [e["name"] for e in listing["entries"]] == ["a.txt"]
    got = post(client, "/fs/read", path=str(f)).json()
    assert got["text"] == "one\r\ntwo\r\n" and got["bom"] is True
    saved = post(client, "/fs/write", path=str(f), text="one\r\nTWO\r\n", expected_mtime=got["mtime"], bom=True)
    assert saved.status_code == 200
    assert f.read_bytes() == b"\xef\xbb\xbfone\r\nTWO\r\n"


def test_stale_save_is_refused_with_409(client, tmp_path):
    f = tmp_path / "b.py"
    f.write_text("x = 1\n")
    mtime = post(client, "/fs/read", path=str(f)).json()["mtime"]
    f.write_text("x = 2  # the agent edited it\n")
    import os
    os.utime(f, ns=(int(mtime) + 5_000_000_000, int(mtime) + 5_000_000_000))
    r = post(client, "/fs/write", path=str(f), text="x = 3\n", expected_mtime=mtime)
    assert r.status_code == 409
    assert "agent edited" in f.read_text()


def test_refuses_relative_paths_and_hermes_credentials(client, tmp_path):
    assert post(client, "/fs/read", path="relative.txt").status_code == 400
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text("OPENROUTER_API_KEY=secret\n")
    assert post(client, "/fs/read", path=str(home / ".env")).status_code == 403
    assert post(client, "/fs/write", path=str(home / "auth.json"), text="{}").status_code == 403
    (home / "config.yaml").write_text("model: x\n")
    assert post(client, "/fs/read", path=str(home / "config.yaml")).status_code == 200


def test_binary_and_large_files_are_not_returned_as_text(client, tmp_path, monkeypatch):
    b = tmp_path / "img.bin"
    b.write_bytes(b"\x89PNG\x00\x01")
    assert post(client, "/fs/read", path=str(b)).json()["binary"] is True
    monkeypatch.setattr(api, "MAX_READ_BYTES", 4)
    t = tmp_path / "big.txt"
    t.write_text("0123456789")
    r = post(client, "/fs/read", path=str(t)).json()
    assert r["too_large"] is True and r["text"] is None


def test_create_and_rename_never_overwrite(client, tmp_path):
    a, b = tmp_path / "new.ts", tmp_path / "other.ts"
    assert post(client, "/fs/create", path=str(a)).status_code == 200
    assert post(client, "/fs/create", path=str(a)).status_code == 409
    b.write_text("keep me")
    assert post(client, "/fs/rename", **{"from": str(a), "to": str(b)}).status_code == 409
    assert b.read_text() == "keep me"
    assert post(client, "/fs/create", path=str(tmp_path / "pkg"), dir=True).status_code == 200
    assert (tmp_path / "pkg").is_dir()


def test_trash_refuses_instead_of_unlinking(client, tmp_path, monkeypatch):
    f = tmp_path / "doomed.txt"
    f.write_text("x")
    monkeypatch.setattr(api, "_trash_windows", lambda p: False)
    monkeypatch.setattr(api.shutil, "which", lambda name: None)
    monkeypatch.setattr(api.sys, "platform", "win32")
    r = post(client, "/fs/trash", path=str(f))
    assert r.status_code == 501
    assert f.exists()


@pytest.mark.parametrize("use_rg", [True, False])
def test_search_and_files(client, tmp_path, monkeypatch, use_rg):
    if use_rg and not shutil.which("rg"):
        pytest.skip("ripgrep not installed")
    if not use_rg:
        real = shutil.which
        monkeypatch.setattr(api.shutil, "which", lambda n: None if n == "rg" else real(n))
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.ts").write_text("const a = 1\nexport function Hello() {}\n")
    (tmp_path / "README.md").write_text("hello world\n")
    files = post(client, "/fs/files", root=str(tmp_path)).json()["files"]
    assert "src/app.ts" in files and "README.md" in files
    hits = post(client, "/search", root=str(tmp_path), query="hello").json()["matches"]
    assert {(h["rel"], h["line"]) for h in hits} == {("src/app.ts", 2), ("README.md", 1)}
    cased = post(client, "/search", root=str(tmp_path), query="hello", case=True).json()["matches"]
    assert [h["rel"] for h in cased] == ["README.md"]
    assert post(client, "/search", root=str(tmp_path), query="([", regex=True).status_code in (200, 400)


@pytest.mark.skipif(not shutil.which("git"), reason="git not installed")
def test_git_status_and_head(client, tmp_path):
    def git(*a):
        subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    (tmp_path / "tracked.txt").write_text("v1\n")
    git("add", ".")
    git("commit", "-qm", "init")
    (tmp_path / "tracked.txt").write_text("v2\n")
    (tmp_path / "new.txt").write_text("n\n")
    st = post(client, "/git/status", root=str(tmp_path)).json()
    assert st["repo"] and st["branch"] == "main"
    codes = {Path(p).name: c for p, c in st["files"].items()}
    assert codes == {"tracked.txt": "M", "new.txt": "?"}
    head = post(client, "/git/head", path=str(tmp_path / "tracked.txt")).json()
    assert head["text"].replace("\r\n", "\n") == "v1\n"


def test_ide_open_tool_broadcasts(monkeypatch, tmp_path):
    plugin = _load("hermes_ide_agent_half", ROOT / "__init__.py")
    sent = []
    import types
    fake = types.ModuleType("hermes_cli.plugin_events")
    fake.broadcast_plugin_event = lambda pid, ev, payload: sent.append((pid, ev, payload))
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", fake)
    f = tmp_path / "x.py"
    f.write_text("print(1)\n")
    out = json.loads(plugin.handle_ide_open({"path": str(f), "line": 3}))
    assert out["success"] and sent[0][:2] == ("hermes-ide", "open") and sent[0][2]["line"] == 3
    assert json.loads(plugin.handle_ide_open({"path": str(tmp_path / "missing.py")}))["success"] is False
