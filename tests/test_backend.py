"""Backend contract tests. Run with the Hermes venv python (it has fastapi + pytest):

    env -u PYTHONPATH <hermes>/venv/Scripts/python.exe -m pytest tests -q
"""

from __future__ import annotations

import importlib.util
import json
import os
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
    monkeypatch.setattr(api, "_hermes_roots", lambda: [api._canon(tmp_path / "home")])
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


def test_credential_refusal_holds_for_every_spelling_profile_and_listing(client, tmp_path):
    home = tmp_path / "home"
    (home / "profiles" / "work").mkdir(parents=True)
    (home / "mcp-tokens").mkdir()
    (home / "hermes-agent" / "agent").mkdir(parents=True)
    secrets = [home / ".env", home / ".env.bak-20261024", home / "google_token.json", home / "google_client_secret.json",
               home / "honcho.json", home / ".gmail-app-password", home / "mcp-tokens" / "a.json", home / "profiles" / "work" / ".env"]
    for f in secrets:
        f.write_text("OPENROUTER_API_KEY=sk-secret-123\n")
    spellings = [str(home / ".env").upper() if sys.platform in ("win32", "darwin") else str(home / ".env")]
    if sys.platform == "win32":
        spellings += ["\\\\?\\" + str(home / ".env"), "//?/" + str(home / ".env").replace("\\", "/")]
    for f in [*map(str, secrets), *spellings]:
        assert post(client, "/fs/read", path=f).status_code == 403, f
        assert post(client, "/fs/write", path=f, text="x").status_code == 403, f
    # A source tree kept in the home still opens (the hermes-agent checkout's oauth.py).
    src = home / "hermes-agent" / "agent" / "oauth.py"
    src.write_text("token = None\n")
    assert post(client, "/fs/read", path=str(src)).status_code == 200
    # Search and Quick Open never surface a credential, even from a folder above the home.
    for root in (home, tmp_path):
        hits = post(client, "/search", root=str(root), query="sk-secret").json()["matches"]
        assert hits == [], hits
        files = post(client, "/fs/files", root=str(root)).json()["files"]
        assert not [f for f in files if "secret" in f or ".env" in f or "token" in f.split("/")[-1] and "oauth" not in f], files


def test_dev_servers_get_no_credentials(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-x")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp-x")
    monkeypatch.setenv("HERMES_HOME", "/h")
    monkeypatch.setenv("NPM_TOKEN", "npm-x")
    env = api._child_env()
    assert "OPENROUTER_API_KEY" not in env and "GITHUB_TOKEN" not in env and "HERMES_HOME" not in env
    assert env["NPM_TOKEN"] == "npm-x" and env.get("PATH") == os.environ.get("PATH") and env["BROWSER"] == "none"


def test_static_server_refuses_dotfiles_and_foreign_hosts():
    ss = _load("hermes_ide_static_server", ROOT / "dashboard" / "static_server.py")
    assert ss.allowed("localhost:5173", "/index.html") == 0
    assert ss.allowed("127.0.0.1:80", "/a/b.css?x=1") == 0
    assert ss.allowed("[::1]:8000", "/") == 0
    assert ss.allowed("localhost:5173", "/.env") == 404
    assert ss.allowed("localhost:5173", "/.git/config") == 404
    assert ss.allowed("localhost:5173", "/%2egit/config") == 404
    assert ss.allowed("evil.example:5173", "/index.html") == 403
    assert ss.allowed("localhost.evil.example", "/") == 403


def test_save_of_a_file_deleted_on_disk_is_refused(client, tmp_path):
    f = tmp_path / "gone.ts"
    f.write_text("x")
    mtime = post(client, "/fs/read", path=str(f)).json()["mtime"]
    f.unlink()
    r = post(client, "/fs/write", path=str(f), text="y", expected_mtime=mtime)
    assert r.status_code == 409 and "deleted" in r.json()["detail"] and not f.exists()


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
    if sys.platform in ("win32", "darwin"):  # a case-only rename is a rename, not a clash
        assert post(client, "/fs/rename", **{"from": str(b), "to": str(tmp_path / "Other.ts")}).status_code == 200
        assert [p.name for p in tmp_path.iterdir() if p.name.lower() == "other.ts"] == ["Other.ts"]


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


def _agent_with_ide(monkeypatch, tmp_path, answer):
    """The agent half with a fake Desktop: every broadcast is answered by `answer(payload)` through
    the backend's real /ide/ack writer, in the data folder both halves share."""
    import types
    plugin = _load("hermes_ide_agent_half", ROOT / "__init__.py")
    data = tmp_path / "plugin-data"
    data.mkdir(exist_ok=True)
    monkeypatch.setattr(plugin, "_data_dir", lambda: data)
    monkeypatch.setattr(api, "_data_dir", lambda: data)
    monkeypatch.setattr(plugin, "OPEN_WAIT", 1.2)
    monkeypatch.setattr(plugin, "UI_WAIT", 2.0)
    sent = []

    def broadcast(pid, ev, payload):
        sent.append((pid, ev, payload))
        for status, detail, url in answer(payload):
            api.note_ack(payload["request_id"], status, detail, url)

    fake = types.ModuleType("hermes_cli.plugin_events")
    fake.broadcast_plugin_event = broadcast
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", fake)
    return plugin, sent


def test_ide_open_reports_what_the_ide_window_did(monkeypatch, tmp_path):
    plugin, sent = _agent_with_ide(monkeypatch, tmp_path, lambda p: [("opened", f"Showing {p.get('path') or p.get('url')}", p.get("url", ""))])
    f = tmp_path / "x.py"
    f.write_text("print(1)\n")
    out = json.loads(plugin.handle_ide_open({"path": str(f), "line": 3}, session_id="s-123"))
    assert out["success"] and out["status"] == "opened" and str(f.name) in out["detail"]
    assert sent[0][:2] == ("hermes-ide", "open") and sent[0][2]["line"] == 3 and sent[0][2]["session_id"] == "s-123"
    assert len(sent[0][2]["request_id"]) == 32
    out = json.loads(plugin.handle_ide_open({"url": "http://localhost:5173/"}, session_id="s-9"))
    assert out["success"] and out["url"] == "http://localhost:5173/"
    # Refused before anything is sent.
    n = len(sent)
    assert json.loads(plugin.handle_ide_open({"path": str(tmp_path / "missing.py")}))["success"] is False
    assert json.loads(plugin.handle_ide_open({"url": "file:///etc/passwd"}))["success"] is False
    assert json.loads(plugin.handle_ide_open({}))["success"] is False
    assert len(sent) == n


def test_ide_open_without_an_answering_window_says_so(monkeypatch, tmp_path):
    plugin, _ = _agent_with_ide(monkeypatch, tmp_path, lambda p: [])
    out = json.loads(plugin.handle_ide_open({"ui": True}, session_id="s-1"))
    assert out["success"] is False and out["status"] == "no_window" and "Hermes Desktop" in out["error"]


def test_ide_open_ui_waits_through_trust_to_the_running_page(monkeypatch, tmp_path):
    # The IDE asks the user first, then reports the page once the server is ready.
    steps = [("needs_trust", "Found a Vite app", ""), ("running", "The Vite app is running", "http://localhost:5173/")]
    plugin, sent = _agent_with_ide(monkeypatch, tmp_path, lambda p: steps)
    out = json.loads(plugin.handle_ide_open({"ui": True}, session_id="s-2"))
    assert sent[0][2]["ui"] is True and "path" not in sent[0][2]
    assert out == {"success": True, "status": "running", "detail": "The Vite app is running", "url": "http://localhost:5173/"}
    # Still waiting for the user at the deadline: the latest status, so the agent can tell them.
    plugin2, _ = _agent_with_ide(monkeypatch, tmp_path, lambda p: steps[:1])
    out = json.loads(plugin2.handle_ide_open({"ui": True}, session_id="s-3"))
    assert out["success"] and out["status"] == "needs_trust"
    # No UI in the folder is a final answer, not a success.
    plugin3, _ = _agent_with_ide(monkeypatch, tmp_path, lambda p: [("no_ui", "No web UI was found", "")])
    assert json.loads(plugin3.handle_ide_open({"ui": True}, session_id="s-4"))["success"] is False


def test_ide_ack_route_validates_and_stores(client, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "_data_dir", lambda: tmp_path)
    rid = "a" * 32
    assert post(client, "/ide/ack", request_id=rid, status="running", detail="ok", url="http://localhost:5173/").status_code == 200
    assert json.loads((tmp_path / "acks" / f"{rid}.json").read_text())["status"] == "running"
    assert post(client, "/ide/ack", request_id="../../evil", status="x").status_code == 400


# ── project UI detection and dev servers ───────────────────────────────────────────────────


def _pkg(d: Path, scripts: dict, dev: dict | None = None, deps: dict | None = None, **extra) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(json.dumps({"name": d.name, "scripts": scripts, "devDependencies": dev or {},
                                                "dependencies": deps or {}, **extra}))
    return d


def test_detects_node_uis_static_sites_and_managers(client, tmp_path):
    root = _pkg(tmp_path / "app", {"dev": "vite", "build": "vite build"}, {"vite": "^5"})
    c = post(client, "/project/detect", root=str(root)).json()["candidates"]
    assert [(x["framework"], x["command"], x["installed"], x["rel"]) for x in c] == [("Vite", "npm run dev", False, "")]
    (root / "node_modules").mkdir()
    (root / "pnpm-lock.yaml").write_text("")
    c = post(client, "/project/detect", root=str(root)).json()["candidates"]
    assert c[0]["installed"] is True and c[0]["command"] == "pnpm run dev"

    # Monorepo: apps/web is the UI; a server-only package and an Electron shell are not.
    mono = tmp_path / "mono"
    _pkg(mono, {"build": "turbo build"}, {"turbo": "*"})
    (mono / ".git").mkdir()
    _pkg(mono / "apps" / "web", {"dev": "next dev"}, deps={"next": "15"})
    _pkg(mono / "apps" / "api", {"dev": "node server.js"}, deps={"express": "4"})
    _pkg(mono / "apps" / "desktop", {"start": "electron ."}, {"electron": "30"})
    c = post(client, "/project/detect", root=str(mono)).json()["candidates"]
    assert [(x["rel"], x["framework"], x["port"]) for x in c] == [("apps/web", "Next.js", 3000)]

    # A UI dependency alone is no UI: vite only for vitest, a nodemon dev script.
    tool = _pkg(tmp_path / "tool", {"dev": "nodemon server.js", "test": "vitest"}, {"vite": "5", "vitest": "1"})
    assert post(client, "/project/detect", root=str(tool)).json()["candidates"] == []
    # One hop through another script still finds it, and the candidate carries the script text.
    hop = _pkg(tmp_path / "hop", {"dev": "npm run web", "web": "vite --port 4000"}, {"vite": "5"})
    c = post(client, "/project/detect", root=str(hop)).json()["candidates"]
    assert c[0]["framework"] == "Vite" and c[0]["run"] == "npm run web"

    # No Node UI: a static index.html is served instead.
    site = tmp_path / "site"
    (site / "public").mkdir(parents=True)
    (site / "public" / "index.html").write_text("<h1>hi</h1>")
    c = post(client, "/project/detect", root=str(site)).json()["candidates"]
    assert c[0]["kind"] == "static" and c[0]["rel"] == "public"

    # A folder that is not a project (a home folder) is not searched one level down.
    home = tmp_path / "home2"
    _pkg(home / "someone-elses-repo", {"dev": "vite"}, {"vite": "5"})
    assert post(client, "/project/detect", root=str(home)).json()["candidates"] == []


def test_dev_log_url_prefers_the_local_line():
    import io

    class P:
        stdout = io.BytesIO(b"proxy -> http://localhost:8000/api\n\x1b[32m  \xe2\x9e\x9c  Local:   \x1b[1mhttp://localhost:5173/\x1b[22m\n"
                            b"  Network: http://192.168.1.4:5173/\n")

    srv = api.DevServer("k", {"id": "node:", "framework": "Vite", "command": "npm run dev"})
    api._pump(srv, P())
    assert srv.url == "http://localhost:5173/"
    assert any("Local:" in line and "\x1b" not in line for line in srv.log)


def _wait(client, root, state, timeout=40):
    import time

    end = time.time() + timeout
    while time.time() < end:
        servers = post(client, "/devserver/status", root=str(root)).json()["servers"]
        if servers and servers[0]["state"] in (state, "exited"):
            return servers[0]
        time.sleep(0.3)
    raise AssertionError(f"server never reached {state}: {servers}")


def _get(url: str) -> str:
    import urllib.request

    with urllib.request.urlopen(url, timeout=5) as r:
        return r.read().decode()


def test_static_site_serves_and_stops(client, tmp_path):
    site = tmp_path / "mysite"  # not a folder name the parent would serve as its own UI
    site.mkdir()
    (site / "index.html").write_text("<h1>static-ui</h1>")
    started = post(client, "/devserver/start", root=str(site), id="static:").json()
    srv = _wait(client, site, "ready")
    assert srv["state"] == "ready", srv
    assert "static-ui" in _get(srv["url"])
    # Starting again returns the running server instead of a second one.
    assert post(client, "/devserver/start", root=str(site), id="static:").json()["url"] == srv["url"]
    # A parent folder that does not detect this project (not a static folder name it serves, not
    # a project itself) does not adopt its server.
    assert post(client, "/project/detect", root=str(tmp_path)).json()["servers"] == []
    assert post(client, "/project/detect", root=str(site)).json()["servers"][0]["url"] == srv["url"]
    post(client, "/devserver/stop", key=started["key"])
    assert post(client, "/devserver/status", root=str(site)).json()["servers"] == []
    import urllib.error

    with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
        _get(srv["url"])


@pytest.mark.skipif(not shutil.which("npm"), reason="npm not installed")
def test_node_dev_server_url_from_its_log_and_tree_kill(client, tmp_path):
    # The script must name the framework's command to count as a UI; server.js ignores the argument.
    app = _pkg(tmp_path / "web", {"dev": "node server.js --as vite"}, {"vite": "5"})
    (app / "node_modules").mkdir()
    (app / "server.js").write_text(
        "const s=require('http').createServer((q,r)=>r.end('node-ui')).listen(0,'127.0.0.1',"
        "()=>console.log('  Local:   http://localhost:'+s.address().port+'/'))\n")
    started = post(client, "/devserver/start", root=str(app), id="node:").json()
    srv = _wait(client, app, "ready")
    assert srv["state"] == "ready", srv
    assert _get(srv["url"]) == "node-ui"
    post(client, "/devserver/stop", key=started["key"])
    import time
    import urllib.error

    time.sleep(1)
    with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
        _get(srv["url"])  # npm's child node process died with it, not only the npm wrapper


def test_start_refuses_unknown_candidates_and_reaps_unwatched_servers(client, tmp_path):
    (tmp_path / "x").mkdir()
    assert post(client, "/devserver/start", root=str(tmp_path / "x"), id="node:").status_code == 404
    srv = api.DevServer("k1", {"id": "static:", "framework": "Static site", "command": "x"})
    api.SERVERS["k1"] = srv
    try:
        now = srv.seen
        assert "k1" not in api.stale_servers(now + 10)
        assert "k1" in api.stale_servers(now + api.LEASE_SECONDS + 1)
    finally:
        api.SERVERS.pop("k1", None)



def test_ide_session_lease_drives_the_agent_note(client, tmp_path, monkeypatch):
    sessions = tmp_path / "plugin-data" / "ide-sessions.json"
    sessions.parent.mkdir(parents=True)
    monkeypatch.setattr(api, "_ide_sessions_path", lambda: sessions)
    assert post(client, "/ide/session", ids=["local-abc", "", 5, "x" * 300]).status_code == 200
    assert post(client, "/ide/session", ids="nope").status_code == 400
    data = json.loads(sessions.read_text())
    assert list(data) == ["local-abc"]

    agent = _load("hermes_ide_agent_half_note", ROOT / "__init__.py")
    monkeypatch.setattr(agent, "_ide_sessions_path", lambda: sessions)
    assert agent.on_pre_llm_call(session_id="local-abc", user_message="why is this red?") == {"context": agent.IDE_NOTE}
    assert agent.on_pre_llm_call(session_id="other", user_message="hello") is None
    # A picked element marks an IDE message even without a lease (the window just closed).
    picked = "[[ Element picked in the IDE browser (http://localhost:5173/):\n- selector: `#x`\n]]"
    assert agent.on_pre_llm_call(session_id="other", user_message=picked) == {"context": agent.IDE_NOTE}
    # The lease runs out a few minutes after the window stops renewing it.
    assert "local-abc" not in agent._open_ide_sessions(now=data["local-abc"] + agent.IDE_LEASE_SECONDS + 1)


def test_agent_half_registers_the_tool_the_hook_and_the_skill():
    agent = _load("hermes_ide_agent_half_reg", ROOT / "__init__.py")
    calls = []

    class Ctx:
        def register_tool(self, **kw):
            calls.append(("tool", kw["name"]))

        def register_hook(self, name, fn):
            calls.append(("hook", name))

        def register_skill(self, name, path, description=""):
            calls.append(("skill", name, path.read_text(encoding="utf-8").startswith("---\nname: guide"), description.startswith("Use when")))

    agent.register(Ctx())
    assert calls == [("tool", "ide_open"), ("hook", "pre_llm_call"), ("skill", "guide", True, True)]
