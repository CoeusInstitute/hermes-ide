"""Hermes IDE backend: workspace file system, search, git and preview routes.

Mounted by the Hermes web server at ``/api/plugins/hermes-ide/`` once ``hermes-ide`` is in
``plugins.enabled``. The desktop half reaches it through ``ctx.rest``. Every route is POST with a
JSON body so file paths never travel in a URL (``ctx.rest`` refuses ``..`` in paths, and a file
literally named ``a..b`` must still open).

The routes run on the machine the agent runs on, so the IDE edits the same files the agent edits,
including against a remote backend. Trust boundary: the gateway's own authentication. Inside it the
IDE can reach what the agent's file tools can reach, minus Hermes' credential files (in every
Hermes home and profile, under any spelling of their path), which every route refuses and no
listing or search returns.
"""

from __future__ import annotations

import atexit
import ctypes
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

# Routes are plain `def`: FastAPI runs them in its threadpool, so a long search or git call never
# blocks the gateway event loop that every Desktop request shares.
router = APIRouter()

VERSION = "0.6.0"
MAX_READ_BYTES = 5 * 1024 * 1024
MAX_LIST_ENTRIES = 5000
MAX_FILES = 50_000
MAX_MATCHES = 2000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build", ".cache"}
# Credential files in a Hermes home (the active one, the default root and every profile under it):
# .env and its backups, auth.json, OAuth and API tokens, client secrets, app passwords, Honcho's key,
# key files, and the token folders. Matched at a home's top level and a profile's top level only, so
# a source tree kept in the home (the hermes-agent checkout's oauth.py) still opens.
SECRET_RE = re.compile(r"^\.env|^auth\.|token|secret|oauth|credential|password|^honcho\.json|-auth$|\.(pem|key|p12|pfx)$", re.I)
SECRET_DIRS = {"mcp-tokens", "secrets", "credentials"}
_CASELESS = sys.platform in ("win32", "darwin")  # file systems that ignore case by default


def _canon(path: Any) -> str:
    """One spelling per file: no extended-length or device prefix, symlinks resolved, forward slashes,
    and lower case where the file system ignores case. Compare these, never raw strings."""
    s = os.fspath(path)
    if s[:4] in ("\\\\?\\", "//?/", "\\\\.\\", "//./"):
        s = s[4:]
        if s[:4].upper() in ("UNC\\", "UNC/"):
            s = "//" + s[4:]
    s = os.path.realpath(s).replace("\\", "/").rstrip("/")
    return s.lower() if _CASELESS else s


def _hermes_roots() -> list[str]:
    roots: list[Any] = []
    try:
        import hermes_constants as hc

        roots += [hc.get_hermes_home(), hc.get_default_hermes_root()]
    except Exception:
        pass
    if os.environ.get("HERMES_HOME"):
        roots.append(os.environ["HERMES_HOME"])
    roots.append(Path.home() / ".hermes")  # the defaults, so an import failure never fails open
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "hermes")
    return list(dict.fromkeys(_canon(r) for r in roots))


def _is_secret(path: Any, roots: list[str] | None = None) -> bool:
    c = _canon(path)
    for root in roots if roots is not None else _hermes_roots():
        if not c.startswith(root + "/"):
            continue
        rel = c[len(root) + 1:].split("/")
        if rel[0] == "profiles" and len(rel) > 2:
            rel = rel[2:]  # profiles/<name>/... is a home of its own
        if rel[0] in SECRET_DIRS or (len(rel) == 1 and SECRET_RE.search(rel[0])):
            return True
    return False


def _may_be_secret(rel: str) -> bool:
    """Cheap name test before the full check, for listings of thousands of files."""
    parts = rel.replace("\\", "/").split("/")
    return bool(SECRET_RE.search(parts[-1])) or any(x.lower() in SECRET_DIRS for x in parts)


def resolve_path(raw: Any, *, must_exist: bool = True) -> Path:
    """Absolute, symlink-resolved path or a 400/403/404. Relative paths are refused: the client
    always knows the workspace root and sends absolute paths."""
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        raise HTTPException(400, "path required")
    p = Path(os.path.expanduser(raw.strip()))
    if not p.is_absolute():
        raise HTTPException(400, "absolute path required")
    p = p.resolve(strict=False)
    if _is_secret(p):
        raise HTTPException(403, "refused: Hermes credential file")
    if must_exist and not p.exists():
        raise HTTPException(404, "not found")
    return p


def resolve_link(raw: Any) -> Path:
    """Like resolve_path, but a symlink stays the link (rename and trash act on the entry the user
    clicked, not on what it points to). Both the link and its target must pass the credential check."""
    target = resolve_path(raw, must_exist=False)
    p = Path(os.path.expanduser(str(raw).strip()))
    link = p.parent.resolve(strict=False) / p.name
    if _is_secret(link):
        raise HTTPException(403, "refused: Hermes credential file")
    if not link.exists() and not link.is_symlink():
        raise HTTPException(404, "not found")
    return link if link.is_symlink() else target


def _stat(p: Path) -> dict[str, Any]:
    st = p.stat()
    return {"size": st.st_size, "mtime": str(st.st_mtime_ns)}


def _body(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON object body required")
    return body


def _posix(p: Path) -> str:
    return p.as_posix()


# ── file system ────────────────────────────────────────────────────────────────────────────


def list_dir(path: Path, show_hidden: bool = True) -> dict[str, Any]:
    if not path.is_dir():
        raise HTTPException(400, "not a directory")
    entries = []
    with os.scandir(path) as it:
        for e in it:
            if not show_hidden and e.name.startswith("."):
                continue
            try:
                is_dir = e.is_dir()
            except OSError:
                is_dir = False
            entries.append({"name": e.name, "path": _posix(Path(e.path)), "dir": is_dir})
    # Sort first, then cap: folders must not vanish because scandir listed them late.
    entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {"path": _posix(path), "entries": entries[:MAX_LIST_ENTRIES], "truncated": len(entries) > MAX_LIST_ENTRIES}


def read_file(path: Path) -> dict[str, Any]:
    if path.is_dir():
        raise HTTPException(400, "is a directory")
    if not path.is_file():
        raise HTTPException(400, "not a regular file")  # a pipe or device would read forever
    meta = _stat(path)
    base = {"path": _posix(path), **meta, "text": None, "binary": False, "too_large": False}
    if meta["size"] > MAX_READ_BYTES:
        return {**base, "too_large": True}
    data = path.read_bytes()
    if b"\x00" in data[:8192]:
        return {**base, "binary": True}
    try:
        text = data.decode("utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8")
    except UnicodeDecodeError:
        return {**base, "binary": True}
    return {**base, "text": text, "bom": data.startswith(b"\xef\xbb\xbf")}


def write_file(path: Path, text: str, expected_mtime: str | None, bom: bool = False) -> dict[str, Any]:
    """Atomic replace. ``expected_mtime`` is the mtime the editor loaded; a different one on disk
    means someone (usually the agent) wrote since, and the save is refused with 409."""
    if path.exists():
        if path.is_dir():
            raise HTTPException(400, "is a directory")
        if expected_mtime is not None and _stat(path)["mtime"] != str(expected_mtime):
            raise HTTPException(409, json.dumps({"error": "conflict", **_stat(path)}))
    elif expected_mtime is not None:
        # The editor loaded this file and it is gone now (deleted or renamed, often by the agent):
        # saving would silently bring it back.
        raise HTTPException(409, json.dumps({"error": "deleted"}))
    elif not path.parent.is_dir():
        raise HTTPException(400, "parent folder does not exist")
    data = (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".hermes-ide-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if path.exists():
            shutil.copymode(path, tmp)
        elif os.name != "nt":
            os.chmod(tmp, 0o644)  # mkstemp makes 0600; a new source file should read like any other
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return {"path": _posix(path), **_stat(path)}


def _trash_windows(path: Path) -> bool:
    # SHFileOperationW with FOF_ALLOWUNDO sends to the Recycle Bin.
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", ctypes.c_void_p), ("wFunc", ctypes.c_uint), ("pFrom", ctypes.c_wchar_p),
                    ("pTo", ctypes.c_wchar_p), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", ctypes.c_int),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", ctypes.c_wchar_p)]

    # FOF_WANTNUKEWARNING: where the item cannot be recycled (a network drive, a full or disabled
    # Recycle Bin) Windows asks before deleting it for good instead of silently doing so.
    fo_delete, allow_undo, no_ui, nuke_warning = 3, 0x40, 0x0010 | 0x0400 | 0x0004, 0x4000
    op = SHFILEOPSTRUCTW(None, fo_delete, str(path) + "\0", None, allow_undo | no_ui | nuke_warning, 0, None, None)
    ok = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0
    return ok and not op.fAnyOperationsAborted and not path.exists()


def trash(path: Path) -> None:
    """Recoverable delete only. When no OS trash is reachable, refuse rather than unlink."""
    try:
        from send2trash import send2trash  # type: ignore

        send2trash(str(path))
        return
    except ImportError:
        pass
    if sys.platform == "win32":
        if _trash_windows(path):
            return
    elif sys.platform == "darwin":
        script = f'tell application "Finder" to delete POSIX file {json.dumps(str(path), ensure_ascii=False)}'
        if subprocess.run(["osascript", "-e", script], capture_output=True, timeout=60).returncode == 0:
            return
    elif shutil.which("gio") and subprocess.run(["gio", "trash", str(path)], capture_output=True, timeout=60).returncode == 0:
        return
    raise HTTPException(501, "no recoverable trash available on this machine; delete it yourself")


def list_files(root: Path, limit: int = MAX_FILES) -> dict[str, Any]:
    """Workspace file list for Quick Open, gitignore-aware when ripgrep is installed."""
    if not root.is_dir():
        raise HTTPException(400, "not a directory")
    files: list[str] = []
    rg = shutil.which("rg")
    if rg:
        proc = subprocess.run([rg, "--files", "--hidden", "-g", "!.git"], cwd=root, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=30)
        files = [line.replace("\\", "/") for line in proc.stdout.splitlines() if line]
    else:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            rel = Path(dirpath).relative_to(root)
            files.extend((rel / f).as_posix() for f in filenames)
            if len(files) > limit:
                break
    roots = _hermes_roots()
    files = sorted(f for f in files if not (_may_be_secret(f) and _is_secret(root / f, roots)))
    return {"root": _posix(root), "files": files[:limit], "truncated": len(files) > limit}


def search(root: Path, query: str, *, regex: bool = False, case: bool = False, glob: str = "",
           limit: int = MAX_MATCHES) -> dict[str, Any]:
    if not root.is_dir():
        raise HTTPException(400, "not a directory")
    if not query:
        return {"matches": [], "truncated": False}
    matches: list[dict[str, Any]] = []
    roots = _hermes_roots()
    rg = shutil.which("rg")
    if rg:
        args = [rg, "--json", "--hidden", "-g", "!.git", "--max-columns", "300", "--max-count", "200"]
        args += [] if regex else ["-F"]
        args += [] if case else ["-i"]
        if glob:
            args += ["-g", glob]
        args += ["--", query, "."]
        proc = subprocess.run(args, cwd=root, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
        for line in proc.stdout.splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") != "match":
                continue
            d = ev["data"]
            rel = d["path"].get("text", "").replace("\\", "/").removeprefix("./")
            if _may_be_secret(rel) and _is_secret(root / rel, roots):
                continue  # a search over a Hermes home must not print its keys
            text = d["lines"].get("text", "").rstrip("\r\n")
            start = d["submatches"][0]["start"] if d.get("submatches") else 0
            col = len(text.encode("utf-8")[:start].decode("utf-8", "ignore"))  # rg counts bytes; the editor counts characters
            matches.append({"path": _posix(root / rel), "rel": rel, "line": d["line_number"], "col": col,
                            "text": text[:300]})
            if len(matches) >= limit:
                break
        if proc.returncode == 2 and not matches:  # ripgrep's error exit: a bad regex or glob
            raise HTTPException(400, (proc.stderr or "search failed").strip().splitlines()[-1][:300])
        return {"matches": matches, "truncated": len(matches) >= limit}
    pat = re.compile(query if regex else re.escape(query), 0 if case else re.IGNORECASE)
    for rel in list_files(root)["files"]:
        p = root / rel
        try:
            if p.stat().st_size > MAX_READ_BYTES:
                continue
            lines = p.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for i, text in enumerate(lines, 1):
            m = pat.search(text)
            if m:
                matches.append({"path": _posix(p), "rel": rel, "line": i, "col": m.start(), "text": text[:300]})
                if len(matches) >= limit:
                    return {"matches": matches, "truncated": True}
    return {"matches": matches, "truncated": False}


# ── git ─────────────────────────────────────────────────────────────────────────────────────


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    # No optional locks: a background status must never hold index.lock while the agent commits.
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    return subprocess.run(["git", "-c", "core.fsmonitor=false", *args], cwd=cwd, capture_output=True, timeout=30, env=env)


def git_status(root: Path) -> dict[str, Any]:
    if not shutil.which("git"):
        return {"repo": False}
    top = _git(root, "rev-parse", "--show-toplevel")
    if top.returncode != 0:
        return {"repo": False}
    toplevel = Path(top.stdout.decode().strip()).resolve()
    proc = _git(toplevel, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all")
    branch = ""
    files: dict[str, str] = {}
    records = proc.stdout.decode("utf-8", "replace").split("\0")
    i = 0
    while i < len(records):
        rec = records[i]
        i += 1
        if not rec:
            continue
        if rec.startswith("## "):
            branch = rec[3:].split("...")[0]
            continue
        xy, rel = rec[:2], rec[3:]
        if xy[0] in "RC":  # rename/copy: next record is the source path
            i += 1
        code = "?" if xy == "??" else ("U" if "U" in xy else (xy[1] if xy[1] != " " else xy[0]))
        files[_posix(toplevel / rel)] = code
    return {"repo": True, "root": _posix(toplevel), "branch": branch, "files": files}


def git_head_text(path: Path) -> dict[str, Any]:
    top = _git(path.parent, "rev-parse", "--show-toplevel")
    if top.returncode != 0:
        return {"text": None}
    toplevel = Path(top.stdout.decode().strip()).resolve()
    try:
        rel = path.relative_to(toplevel).as_posix()
    except ValueError:
        return {"text": None}
    show = _git(toplevel, "show", f"HEAD:{rel}")
    if show.returncode != 0:
        return {"text": None}
    try:
        return {"text": show.stdout.decode("utf-8")}
    except UnicodeDecodeError:
        return {"text": None}


# ── project UI detection and dev servers ───────────────────────────────────────────────────
#
# The IDE finds a web UI inside the open folder and runs it so the Browser column can show it.
# The command is always derived here from the project's own files (package.json scripts, or a
# static index.html); the client only names a candidate id, never a command.

UI_DEPS = {  # dependency → (framework label, port it usually prints)
    "next": ("Next.js", 3000), "nuxt": ("Nuxt", 3000), "@remix-run/dev": ("Remix", 5173),
    "@sveltejs/kit": ("SvelteKit", 5173), "astro": ("Astro", 4321), "@angular/cli": ("Angular", 4200),
    "react-scripts": ("Create React App", 3000), "gatsby": ("Gatsby", 8000), "@vue/cli-service": ("Vue CLI", 8080),
    "vite": ("Vite", 5173), "parcel": ("Parcel", 1234), "webpack-dev-server": ("webpack", 8080),
    "@storybook/react": ("Storybook", 6006), "live-server": ("live-server", 8080), "http-server": ("http-server", 8080),
    "serve": ("serve", 3000),
}
UI_SCRIPTS = ("dev", "start", "serve", "develop", "preview", "storybook")
# The command each framework's script runs: a dependency alone is no UI (vite used only by vitest).
UI_BINS = {
    "next": ("next",), "nuxt": ("nuxt", "nuxi"), "@remix-run/dev": ("remix", "vite"), "@sveltejs/kit": ("vite", "svelte-kit"),
    "astro": ("astro",), "@angular/cli": ("ng",), "react-scripts": ("react-scripts",), "gatsby": ("gatsby",),
    "@vue/cli-service": ("vue-cli-service",), "vite": ("vite",), "parcel": ("parcel",), "webpack-dev-server": ("webpack", "webpack-dev-server"),
    "@storybook/react": ("storybook", "start-storybook"), "live-server": ("live-server",), "http-server": ("http-server",), "serve": ("serve",),
}
STATIC_DIRS = ("", "public", "src", "docs", "site", "www", "web", "frontend", "client")
SCAN_SKIP = SKIP_DIRS | {"out", "coverage", "target", ".turbo", ".svelte-kit", ".output"}
URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local)(?::\d+)?(?:/[^\s'\"\x1b]*)?")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
LEASE_SECONDS = 120  # a server nobody has asked about for this long is stopped (the IDE window closed)


def _read_json(p: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _manager(pkg_dir: Path, root: Path) -> str:
    """Package manager from the nearest lockfile between the package and the workspace root."""
    d = pkg_dir
    while True:
        for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun"),
                         ("package-lock.json", "npm")):
            if (d / lock).exists():
                return pm
        if d == root or d.parent == d:
            return "npm"
        d = d.parent


def _installed(pkg_dir: Path, root: Path) -> bool:
    d = pkg_dir
    while True:
        if (d / "node_modules").is_dir():
            return True
        if d == root or d.parent == d:
            return False
        d = d.parent


def _node_candidate(pkg_dir: Path, root: Path) -> dict[str, Any] | None:
    pkg = _read_json(pkg_dir / "package.json")
    if not pkg:
        return None
    scripts = pkg.get("scripts") if isinstance(pkg.get("scripts"), dict) else {}
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    if "electron" in deps and not any(d in deps for d in ("vite", "next", "react-scripts")):
        return None  # a desktop app, not a page a browser can show
    def runs(cmd: str, dep: str) -> bool:
        # A meta-framework that runs another tool's command (Remix and SvelteKit run vite) counts
        # only when it is a dependency; a tool named after its own command may come from elsewhere.
        bins = [b for b in UI_BINS[dep] if dep in deps or b == dep]
        return any(re.search(rf"(^|[\s/&;|\"'(]){re.escape(b)}([\s\"');&|]|$)", cmd) for b in bins)

    for script in UI_SCRIPTS:
        cmd = scripts.get(script)
        if not isinstance(cmd, str) or re.search(r"\belectron\b", cmd):
            continue
        # One hop through `npm run web` / `pnpm web` / `yarn web` to the script that does the work.
        via = re.search(r"\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)", cmd)
        text = cmd + " " + (scripts.get(via.group(1)) if via and isinstance(scripts.get(via.group(1)), str) else "")
        hit = next(((dep, *UI_DEPS[dep]) for dep in UI_DEPS if runs(text, dep)), None)
        if not hit:
            continue
        rel = pkg_dir.relative_to(root).as_posix() if pkg_dir != root else ""
        pm = _manager(pkg_dir, root)
        return {"id": f"node:{rel}", "kind": "node", "dir": _posix(pkg_dir), "rel": rel, "name": pkg.get("name") or (rel or root.name),
                "framework": hit[1], "port": hit[2], "script": script, "manager": pm, "run": cmd,
                "command": f"{pm} run {script}" if pm != "yarn" else f"yarn {script}", "installed": _installed(pkg_dir, root)}
    return None


def detect_projects(root: Path) -> list[dict[str, Any]]:
    """Web UIs inside ``root``: package.json projects at the root, one level down, and under
    apps/* and packages/* (monorepos), then a static index.html when no Node UI exists."""
    if not root.is_dir():
        raise HTTPException(400, "not a directory")
    dirs = [root]
    # Look one level down only inside a project (a home folder's subfolders are unrelated repos).
    is_project = any((root / m).exists() for m in (".git", "package.json", "pnpm-workspace.yaml", "turbo.json", "nx.json"))
    for base in ((root, root / "apps", root / "packages") if is_project else ()):
        try:
            dirs += [d for d in sorted(base.iterdir()) if d.is_dir() and d.name not in SCAN_SKIP and not d.name.startswith(".")]
        except OSError:
            continue
    out, seen = [], set()
    for d in dirs:
        c = _node_candidate(d, root)
        if c and c["id"] not in seen:
            seen.add(c["id"])
            out.append(c)
    if not out:
        for sub in STATIC_DIRS:
            d = root / sub if sub else root
            if (d / "index.html").is_file():
                out.append({"id": f"static:{sub}", "kind": "static", "dir": _posix(d), "rel": sub, "name": sub or root.name,
                            "framework": "Static site", "port": 0, "command": "static server (127.0.0.1)", "run": "", "installed": True})
                break
    # Prefer the root project, then names that look like the app (web, frontend, client, ui, site).
    rank = lambda c: (c["rel"] != "", not re.search(r"(^|/)(web|frontend|client|ui|site|app|dashboard)$", c["rel"]), c["rel"])
    return sorted(out, key=rank)


class DevServer:
    def __init__(self, key: str, cand: dict[str, Any]):
        self.key, self.cand = key, cand
        self.proc: subprocess.Popen | None = None
        self.log: deque[str] = deque(maxlen=400)
        self.url: str | None = None
        self.state = "starting"  # installing → starting → ready | exited
        self.exit_code: int | None = None
        self.seen = time.time()
        self.stopped = False
        self.labelled = False  # the URL came from a "Local:" line (beats an earlier proxy or API URL)

    def info(self) -> dict[str, Any]:
        return {"key": self.key, "id": self.cand["id"], "framework": self.cand["framework"], "command": self.cand["command"],
                "state": self.state, "url": self.url, "exit_code": self.exit_code, "log": list(self.log)[-80:]}


SERVERS: dict[str, DevServer] = {}
SERVERS_LOCK = threading.Lock()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_open(url: str) -> bool:
    m = re.match(r"https?://([^/:]+|\[[^\]]+\])(?::(\d+))?", url)
    if not m:
        return False
    host = m.group(1).strip("[]")
    port = int(m.group(2) or (443 if url.startswith("https") else 80))
    # Node 18+ resolves localhost to ::1 first, so a dev server may listen on IPv6 only.
    hosts = ["127.0.0.1", "::1"] if host in ("localhost", "0.0.0.0", "::", "") else [host]
    for h in hosts:
        try:
            with socket.create_connection((h, port), timeout=0.5):
                return True
        except OSError:
            continue
    return False


# The gateway's environment holds every provider key Hermes loaded. A project's dev script and every
# dependency's install script run unreviewed code, so they get the environment minus anything that
# looks like a credential (the project's own keys belong in its own .env). Registry tokens stay:
# private-package installs need them and Hermes never sets them.
_SECRET_ENV = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|^HERMES|^HONCHO|^OPENROUTER", re.I)
_KEEP_ENV = {"NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN"}


def _child_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() in _KEEP_ENV or not _SECRET_ENV.search(k)}
    return {**env, "BROWSER": "none", "FORCE_COLOR": "0", "NO_COLOR": "1"}  # BROWSER=none: no system browser tab


def _spawn(args: list[str], cwd: str) -> subprocess.Popen:
    env = _child_env()
    kw: dict[str, Any] = {"cwd": cwd, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL, "env": env}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        kw["start_new_session"] = True
    return subprocess.Popen(args, **kw)


def _kill_tree(proc: subprocess.Popen | None) -> None:
    if not proc or proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=15)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        proc.kill()


def _command(cand: dict[str, Any], install: bool) -> list[str]:
    if cand["kind"] == "static":
        # Not `python -m http.server`: that also serves dotfiles (.env, .git) and directory listings
        # to any Host, which a web page could read through DNS rebinding.
        return [sys.executable, str(Path(__file__).with_name("static_server.py")), str(cand["port"]), cand["dir"]]
    exe = shutil.which(cand["manager"]) or shutil.which("npm")
    if not exe:
        raise HTTPException(424, f"{cand['manager']} is not installed on the agent's machine")
    if install:
        return [exe, "install"]
    return [exe, cand["script"]] if cand["manager"] == "yarn" else [exe, "run", cand["script"]]


def _pump(srv: DevServer, proc: subprocess.Popen) -> None:
    assert proc.stdout is not None
    for raw in iter(proc.stdout.readline, b""):
        line = ANSI_RE.sub("", raw.decode("utf-8", "replace")).rstrip()
        if not line:
            continue
        srv.log.append(line)
        if srv.state == "installing" or srv.labelled:
            continue
        m = URL_RE.search(line)
        if m and (srv.url is None or re.search(r"\blocal\b\s*:", line, re.I)):
            srv.url = m.group(0).rstrip(".,;)").replace("0.0.0.0", "localhost").replace("[::]", "localhost")
            srv.labelled = bool(re.search(r"\blocal\b\s*:", line, re.I))


def _run(srv: DevServer, install: bool) -> None:
    """Install (when asked), then run the dev command; watch its log for the URL and probe it."""
    try:
        if install:
            srv.state = "installing"
            srv.proc = _spawn(_command(srv.cand, True), srv.cand["dir"])
            if srv.stopped:
                _kill_tree(srv.proc)
                return
            _pump(srv, srv.proc)
            if srv.proc.wait() != 0 or srv.stopped:
                srv.state, srv.exit_code = "exited", srv.proc.returncode
                return
        srv.state = "starting"
        if srv.cand["kind"] == "static":
            srv.url = f"http://localhost:{srv.cand['port']}/"
        srv.proc = proc = _spawn(_command(srv.cand, False), srv.cand["dir"])
        if srv.stopped:  # Stop landed while it was starting: nothing else holds this process
            _kill_tree(proc)
            return
        threading.Thread(target=_pump, args=(srv, proc), daemon=True).start()
        guess_at = time.time() + 25  # no URL printed by then: try the framework's usual port
        while proc.poll() is None and not srv.stopped:
            if srv.url is None and time.time() > guess_at and srv.cand.get("port"):
                srv.url = f"http://localhost:{srv.cand['port']}/"
            if srv.url and srv.state != "ready" and _port_open(srv.url):
                srv.state = "ready"
            time.sleep(0.3)
        srv.state, srv.exit_code = "exited", proc.returncode
    except HTTPException as e:
        srv.log.append(str(e.detail))
        srv.state = "exited"
    except OSError as e:
        srv.log.append(f"could not start: {e}")
        srv.state = "exited"


def start_server(root: Path, cand_id: str, install: bool = False) -> dict[str, Any]:
    cand = next((c for c in detect_projects(root) if c["id"] == cand_id), None)
    if not cand:
        raise HTTPException(404, "no such project UI in this folder")
    key = cand["dir"]
    with SERVERS_LOCK:
        srv = SERVERS.get(key)
        if srv and srv.state != "exited":
            srv.seen = time.time()
            return srv.info()
        if cand["kind"] == "static":
            cand = {**cand, "port": _free_port()}
        srv = DevServer(key, cand)
        SERVERS[key] = srv
    threading.Thread(target=_run, args=(srv, install), daemon=True).start()
    return srv.info()


def stop_server(key: str) -> dict[str, Any]:
    with SERVERS_LOCK:
        srv = SERVERS.pop(key, None)
    if srv:
        srv.stopped = True
        _kill_tree(srv.proc)
        srv.state = "exited"
    return {"ok": True}


def server_status(root: Path) -> dict[str, Any]:
    """Servers inside ``root``. Asking counts as a lease renewal."""
    prefix = _posix(root).rstrip("/")
    now = time.time()
    out = []
    with SERVERS_LOCK:
        for srv in SERVERS.values():
            if srv.key == prefix or srv.key.startswith(prefix + "/"):
                srv.seen = now
                out.append(srv.info())
    return {"servers": out}


def stale_servers(now: float) -> list[str]:
    """Servers to stop: unasked-for past the lease (their IDE window closed), or long exited."""
    return [k for k, s in list(SERVERS.items())
            if now - s.seen > LEASE_SECONDS or (s.state == "exited" and now - s.seen > 600)]


def _reap() -> None:
    last = time.time()
    while True:
        time.sleep(15)
        now = time.time()
        if now - last > 60:
            # The machine slept: nobody could renew a lease meanwhile, so restart every lease
            # instead of stopping servers whose IDE window is still open.
            with SERVERS_LOCK:
                for srv in SERVERS.values():
                    srv.seen = now
        last = now
        for k in stale_servers(now):
            stop_server(k)


threading.Thread(target=_reap, daemon=True, name="hermes-ide-reaper").start()
atexit.register(lambda: [stop_server(k) for k in list(SERVERS)])


# ── IDE windows (read by the agent half's pre_llm_call hook) ─────────────────────────────────
#
# An open IDE window renews its chat's ids here every minute, so the agent half can tell the model a
# message comes from the IDE. A lease: an id not renewed for a few minutes is not an IDE chat now.

IDE_SESSIONS_FILE = "ide-sessions.json"


def _data_dir() -> Path:
    # The agent half reads here too (__init__.py): per profile, kept across updates.
    try:
        from plugins.plugin_storage import plugin_data_dir

        return Path(plugin_data_dir("hermes-ide"))
    except Exception:
        d = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "plugin-data" / "hermes-ide"
        d.mkdir(parents=True, exist_ok=True)
        return d


def _ide_sessions_path() -> Path:
    return _data_dir() / IDE_SESSIONS_FILE


def note_ack(request_id: Any, status: Any, detail: Any = "", url: Any = "") -> dict[str, Any]:
    """An IDE window's answer to the agent's ide_open request; the tool is polling for this file."""
    if not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise HTTPException(400, "bad request_id")
    d = _data_dir() / "acks"
    d.mkdir(exist_ok=True)
    now = time.time()
    for old in d.glob("*.json"):  # answers nobody collected (the tool timed out)
        try:
            if now - old.stat().st_mtime > 3600:
                old.unlink()
        except OSError:
            pass
    f = d / f"{request_id}.json"
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps({"status": str(status)[:40], "detail": str(detail)[:4000], "url": str(url)[:2048]}), encoding="utf-8")
    os.replace(tmp, f)
    return {"ok": True}


def note_ide_sessions(ids: list[Any]) -> dict[str, Any]:
    f = _ide_sessions_path()
    now = time.time()
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        data = data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        data = {}
    data = {k: v for k, v in data.items() if isinstance(v, (int, float)) and now - v < 86400}
    for i in ids[:8]:
        if isinstance(i, str) and 0 < len(i) <= 200:
            data[i] = now
    tmp = f.with_name(f.name + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, f)
    return {"ok": True}


# ── routes ──────────────────────────────────────────────────────────────────────────────────


@contextmanager
def _os_errors():
    """The OS's own refusal as a readable 4xx (a locked file, no permission, a slow git) instead of
    an opaque 500."""
    try:
        yield
    except HTTPException:
        raise
    except subprocess.TimeoutExpired as e:
        raise HTTPException(504, f"{Path(str(e.cmd[0])).name if isinstance(e.cmd, list) else 'command'} took too long ({e.timeout:.0f}s)")
    except PermissionError as e:
        raise HTTPException(403, f"permission denied: {e.strerror or e}")
    except FileNotFoundError as e:
        raise HTTPException(404, f"not found: {e.filename or e}")
    except OSError as e:
        raise HTTPException(409, f"{e.strerror or e}")


@router.post("/project/detect")
def route_project_detect(body: dict) -> dict:
    root = resolve_path(_body(body).get("root"))
    candidates = detect_projects(root)
    # Only servers of projects found here: a parent folder (a home folder) must not adopt a dev
    # server that belongs to some project deep inside it.
    dirs = {c["dir"] for c in candidates}
    return {"candidates": candidates, "servers": [s for s in server_status(root)["servers"] if s["key"] in dirs]}


@router.post("/devserver/start")
def route_devserver_start(body: dict) -> dict:
    b = _body(body)
    cand_id = b.get("id")
    if not isinstance(cand_id, str) or not cand_id:
        raise HTTPException(400, "id required")
    return start_server(resolve_path(b.get("root")), cand_id, bool(b.get("install")))


@router.post("/devserver/status")
def route_devserver_status(body: dict) -> dict:
    return server_status(resolve_path(_body(body).get("root")))


@router.post("/devserver/stop")
def route_devserver_stop(body: dict) -> dict:
    key = _body(body).get("key")
    if not isinstance(key, str) or key not in SERVERS:
        return {"ok": True}
    return stop_server(key)


@router.post("/ide/ack")
def route_ide_ack(body: dict) -> dict:
    b = _body(body)
    with _os_errors():
        return note_ack(b.get("request_id"), b.get("status"), b.get("detail", ""), b.get("url", ""))


@router.post("/ide/session")
def route_ide_session(body: dict) -> dict:
    ids = _body(body).get("ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "ids required")
    with _os_errors():
        return note_ide_sessions(ids)


@router.post("/health")
def health(body: dict | None = None) -> dict:
    return {"ok": True, "version": VERSION, "rg": bool(shutil.which("rg")), "git": bool(shutil.which("git")),
            "home": os.path.expanduser("~").replace("\\", "/"), "platform": sys.platform}


@router.post("/fs/list")
def fs_list(body: dict) -> dict:
    b = _body(body)
    with _os_errors():
        return list_dir(resolve_path(b.get("path")), bool(b.get("show_hidden", True)))


@router.post("/fs/read")
def fs_read(body: dict) -> dict:
    with _os_errors():
        return read_file(resolve_path(_body(body).get("path")))


@router.post("/fs/stat")
def fs_stat(body: dict) -> dict:
    p = resolve_path(_body(body).get("path"), must_exist=False)
    if not p.exists():
        return {"path": _posix(p), "exists": False}
    return {"path": _posix(p), "exists": True, "dir": p.is_dir(), **_stat(p)}


@router.post("/fs/write")
def fs_write(body: dict) -> dict:
    b = _body(body)
    text = b.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "text required")
    expected = b.get("expected_mtime")
    with _os_errors():
        return write_file(resolve_path(b.get("path"), must_exist=False), text,
                          None if expected in (None, "") else str(expected), bool(b.get("bom")))


@router.post("/fs/create")
def fs_create(body: dict) -> dict:
    b = _body(body)
    p = resolve_path(b.get("path"), must_exist=False)
    if p.exists():
        raise HTTPException(409, "already exists")
    if not p.parent.is_dir():
        raise HTTPException(400, "parent folder does not exist")
    with _os_errors():
        if b.get("dir"):
            p.mkdir()
        else:
            with open(p, "x", encoding="utf-8"):
                pass
    return {"path": _posix(p)}


@router.post("/fs/rename")
def fs_rename(body: dict) -> dict:
    b = _body(body)
    src = resolve_link(b.get("from"))
    raw_to = b.get("to")
    dst = resolve_path(raw_to, must_exist=False)
    dst = dst.parent / Path(str(raw_to)).name  # keep the new name's spelling (a case-only rename)
    case_only = dst.exists() and src.exists() and os.path.samefile(src, dst) and src.name != dst.name
    if dst.exists() and not case_only:
        raise HTTPException(409, "target exists")
    if not dst.parent.is_dir():
        raise HTTPException(400, "target folder does not exist")
    with _os_errors():
        src.rename(dst)
    return {"path": _posix(dst)}


@router.post("/fs/trash")
def fs_trash(body: dict) -> dict:
    p = resolve_link(_body(body).get("path"))
    with _os_errors():
        trash(p)
    return {"ok": True}


@router.post("/fs/files")
def fs_files(body: dict) -> dict:
    with _os_errors():
        return list_files(resolve_path(_body(body).get("root")))


@router.post("/search")
def fs_search(body: dict) -> dict:
    b = _body(body)
    q = b.get("query")
    if not isinstance(q, str):
        raise HTTPException(400, "query required")
    try:
        return search(resolve_path(b.get("root")), q, regex=bool(b.get("regex")), case=bool(b.get("case")),
                      glob=str(b.get("glob") or ""))
    except Exception as e:  # a bad regex is the user's typo, not a server fault
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(400, f"search failed: {e}")


@router.post("/git/status")
def route_git_status(body: dict) -> dict:
    with _os_errors():
        return git_status(resolve_path(_body(body).get("root")))


@router.post("/git/head")
def route_git_head(body: dict) -> dict:
    with _os_errors():
        return git_head_text(resolve_path(_body(body).get("path")))
