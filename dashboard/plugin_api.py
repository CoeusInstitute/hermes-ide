"""Hermes IDE backend: workspace file system, search, git and preview routes.

Mounted by the Hermes web server at ``/api/plugins/hermes-ide/`` once ``hermes-ide`` is in
``plugins.enabled``. The desktop half reaches it through ``ctx.rest``. Every route is POST with a
JSON body so file paths never travel in a URL (``ctx.rest`` refuses ``..`` in paths, and a file
literally named ``a..b`` must still open).

The routes run on the machine the agent runs on, so the IDE edits the same files the agent edits,
including against a remote backend. Trust boundary: the gateway's own authentication. Inside it the
IDE can reach what the agent's file tools can reach, minus Hermes' credential files, which are
refused here on every route.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

# Routes are plain `def`: FastAPI runs them in its threadpool, so a long search or git call never
# blocks the gateway event loop that every Desktop request shares.
router = APIRouter()

VERSION = "0.1.0"
MAX_READ_BYTES = 5 * 1024 * 1024
MAX_LIST_ENTRIES = 5000
MAX_FILES = 50_000
MAX_MATCHES = 2000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build", ".cache"}
# Credential files under the Hermes home. The agent never needs the IDE to open these.
SECRET_NAMES = {".env", "auth.json"}
SECRET_DIRS = {"mcp-tokens", "secrets"}


def _hermes_home() -> Path | None:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()).resolve()
    except Exception:
        env = os.environ.get("HERMES_HOME")
        return Path(env).resolve() if env else None


def _is_secret(path: Path) -> bool:
    home = _hermes_home()
    if home is None:
        return False
    try:
        rel = path.relative_to(home)
    except ValueError:
        return False
    parts = rel.parts
    return bool(parts) and (parts[-1] in SECRET_NAMES or any(p in SECRET_DIRS for p in parts))


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
    truncated = False
    with os.scandir(path) as it:
        for e in it:
            if not show_hidden and e.name.startswith("."):
                continue
            if len(entries) >= MAX_LIST_ENTRIES:
                truncated = True
                break
            try:
                is_dir = e.is_dir()
            except OSError:
                is_dir = False
            entries.append({"name": e.name, "path": _posix(Path(e.path)), "dir": is_dir})
    entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {"path": _posix(path), "entries": entries, "truncated": truncated}


def read_file(path: Path) -> dict[str, Any]:
    if path.is_dir():
        raise HTTPException(400, "is a directory")
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
    elif not path.parent.is_dir():
        raise HTTPException(400, "parent folder does not exist")
    data = (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".hermes-ide-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if path.exists():
            shutil.copymode(path, tmp)
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

    fo_delete, allow_undo, no_ui = 3, 0x40, 0x0010 | 0x0400 | 0x0004  # NOCONFIRMATION|NOERRORUI|SILENT
    op = SHFILEOPSTRUCTW(None, fo_delete, str(path) + "\0", None, allow_undo | no_ui, 0, None, None)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not path.exists()


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
        script = f'tell application "Finder" to delete POSIX file {json.dumps(str(path))}'
        if subprocess.run(["osascript", "-e", script], capture_output=True).returncode == 0:
            return
    elif shutil.which("gio") and subprocess.run(["gio", "trash", str(path)], capture_output=True).returncode == 0:
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
    files.sort()
    return {"root": _posix(root), "files": files[:limit], "truncated": len(files) > limit}


def search(root: Path, query: str, *, regex: bool = False, case: bool = False, glob: str = "",
           limit: int = MAX_MATCHES) -> dict[str, Any]:
    if not root.is_dir():
        raise HTTPException(400, "not a directory")
    if not query:
        return {"matches": [], "truncated": False}
    matches: list[dict[str, Any]] = []
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
            text = d["lines"].get("text", "").rstrip("\r\n")
            col = d["submatches"][0]["start"] if d.get("submatches") else 0
            matches.append({"path": _posix(root / rel), "rel": rel, "line": d["line_number"], "col": col,
                            "text": text[:300]})
            if len(matches) >= limit:
                break
        return {"matches": matches, "truncated": len(matches) >= limit}
    import re

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
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, timeout=30)


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
    rel = path.relative_to(toplevel).as_posix()
    show = _git(toplevel, "show", f"HEAD:{rel}")
    if show.returncode != 0:
        return {"text": None}
    try:
        return {"text": show.stdout.decode("utf-8")}
    except UnicodeDecodeError:
        return {"text": None}


# ── routes ──────────────────────────────────────────────────────────────────────────────────


@router.post("/health")
def health(body: dict | None = None) -> dict:
    return {"ok": True, "version": VERSION, "rg": bool(shutil.which("rg")), "git": bool(shutil.which("git")),
            "home": os.path.expanduser("~").replace("\\", "/"), "platform": sys.platform}


@router.post("/fs/list")
def fs_list(body: dict) -> dict:
    b = _body(body)
    return list_dir(resolve_path(b.get("path")), bool(b.get("show_hidden", True)))


@router.post("/fs/read")
def fs_read(body: dict) -> dict:
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
    if b.get("dir"):
        p.mkdir()
    else:
        with open(p, "x", encoding="utf-8"):
            pass
    return {"path": _posix(p)}


@router.post("/fs/rename")
def fs_rename(body: dict) -> dict:
    b = _body(body)
    src = resolve_path(b.get("from"))
    dst = resolve_path(b.get("to"), must_exist=False)
    if dst.exists():
        raise HTTPException(409, "target exists")
    if not dst.parent.is_dir():
        raise HTTPException(400, "target folder does not exist")
    src.rename(dst)
    return {"path": _posix(dst)}


@router.post("/fs/trash")
def fs_trash(body: dict) -> dict:
    p = resolve_path(_body(body).get("path"))
    trash(p)
    return {"ok": True}


@router.post("/fs/files")
def fs_files(body: dict) -> dict:
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
    return git_status(resolve_path(_body(body).get("root")))


@router.post("/git/head")
def route_git_head(body: dict) -> dict:
    return git_head_text(resolve_path(_body(body).get("path")))
