"""Hermes IDE: agent half.

The IDE itself is the desktop half (``desktop/plugin.js``) plus the backend routes in
``dashboard/plugin_api.py``. This half gives the agent:

- one tool, ``ide_open``, so a chat can drive the IDE ("open the router in the IDE at the 404
  handler"): it pushes an event to every connected Hermes Desktop window, and the IDE opens the file;
- a short note in each turn of a chat whose IDE window is open (a ``pre_llm_call`` hook), so the
  model knows the message comes from the IDE and what the IDE can do;
- a bundled skill, ``hermes-ide:guide``, with the details the note points to.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN_ID = "hermes-ide"

IDE_OPEN_SCHEMA: dict[str, Any] = {
    "name": "ide_open",
    "description": (
        "Drive the user's Hermes IDE window for this chat (the Hermes IDE plugin in Hermes Desktop), opening "
        "the window when needed, and report what the IDE actually did. "
        "ui: true runs the project's web UI: the IDE detects it in its folder (a package.json dev script that "
        "runs Vite, Next.js, Nuxt, Remix, SvelteKit, Astro, Angular, CRA and similar, or an index.html), starts "
        "the dev server with its own manager once the user has trusted the project, and shows the page in its "
        "Browser. Use it whenever the user asks to open, run, start, show or preview the project's UI, app, site "
        "or dev server in the IDE. Never start the dev server yourself (npm run dev in a terminal) for the IDE: it "
        "duplicates the IDE's server and keeps the chat marked as working. "
        "path (with line) shows a file in the IDE's editor. url shows a page that is already running. "
        "Statuses: opened, running (with url), needs_trust (the IDE asks the user to allow the project; tell "
        "them to click Always run or Run once in the IDE), starting, no_ui, no_folder, error. A relative path "
        "is resolved against the session's working directory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ui": {"type": "boolean", "description": "Run the project's web UI in the IDE and show it in the IDE's Browser."},
            "path": {"type": "string", "description": "File path (absolute, or relative to the working directory)."},
            "line": {"type": "integer", "description": "1-based line to reveal.", "minimum": 1},
            "url": {"type": "string", "description": "http(s) URL of a page that is already running, e.g. http://localhost:5173/."},
        },
        "additionalProperties": False,
    },
}

# How long the tool waits for the IDE window's answer. A UI start includes the user answering the
# trust prompt and a dependency install, so it waits longer; it then reports the latest status.
OPEN_WAIT = 15.0
UI_WAIT = 55.0
FINAL = {"opened", "running", "no_ui", "no_folder", "error"}


def _data_dir() -> Path:
    # The backend writes here too (dashboard/plugin_api.py): per profile, kept across updates.
    try:
        from plugins.plugin_storage import plugin_data_dir

        return Path(plugin_data_dir(PLUGIN_ID))
    except Exception:
        d = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "plugin-data" / PLUGIN_ID
        d.mkdir(parents=True, exist_ok=True)
        return d


def _resolve(path: str) -> str:
    """Resolve against the session's working directory (the documented plugin route, not the gateway
    process's own cwd), so 'src/app.ts' means the file the agent just wrote."""
    p = os.path.expanduser(path.strip())
    if not os.path.isabs(p):
        try:
            from agent.runtime_cwd import resolve_agent_cwd

            base = str(resolve_agent_cwd())
        except Exception:
            base = os.getcwd()
        p = os.path.join(base, p)
    return os.path.realpath(p).replace("\\", "/")


def _wait_for_answer(request_id: str, timeout: float) -> dict[str, Any] | None:
    """The IDE window's answer (/ide/ack): the first final status, else the latest one at the deadline."""
    f = _data_dir() / "acks" / f"{request_id}.json"
    last = None
    for _ in range(max(1, int(timeout / 0.4))):
        try:
            last = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if last and last.get("status") in FINAL:
            break
        time.sleep(0.4)
    try:
        f.unlink()
    except OSError:
        pass
    return last


def handle_ide_open(args: dict[str, Any], **kw: Any) -> str:
    raw = args.get("path")
    url = args.get("url")
    ui = args.get("ui") is True
    payload: dict[str, Any] = {"ui": True} if ui else {}
    if isinstance(url, str) and url.strip():
        url = url.strip()
        if not url.lower().startswith(("http://", "https://")) or len(url) > 2048:
            return json.dumps({"success": False, "error": "url must be an http(s) URL"})
        payload["url"] = url
    elif isinstance(raw, str) and raw.strip():
        if raw.strip().startswith(("\\\\", "//")):
            # A network path would make the gateway open an SMB connection (and offer the user's
            # credentials) to a host a prompt may have named.
            return json.dumps({"success": False, "error": "network paths are not opened; use a local path"})
        path = _resolve(raw)
        if not os.path.isfile(path):
            return json.dumps({"success": False, "error": f"not a file: {path}"})
        payload["path"] = path
        line = args.get("line")
        if isinstance(line, int) and line > 0:
            payload["line"] = line
    elif not ui:
        return json.dumps({"success": False, "error": "pass ui: true, a path, or a url"})
    if kw.get("session_id"):
        payload["session_id"] = str(kw["session_id"])
    payload["request_id"] = uuid.uuid4().hex
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, "open", payload)
    except Exception as e:
        return json.dumps({"success": False, "error": f"could not reach Hermes Desktop: {e}"})
    wait = UI_WAIT if ui else OPEN_WAIT
    answer = _wait_for_answer(payload["request_id"], wait)
    if not answer:
        return json.dumps({"success": False, "status": "no_window", "error": (
            f"No Hermes IDE window answered within {int(wait)} s. Hermes Desktop must be open with the Hermes IDE "
            "plugin turned on (Capabilities > Plugins > Desktop: Hermes IDE); after an update the gateway also needs a "
            "restart. Tell the user; do not work around it with your own dev server or screen automation.")})
    status = str(answer.get("status") or "")
    result = {"success": status in ("opened", "running", "needs_trust", "starting"), "status": status,
              "detail": str(answer.get("detail") or "")}
    if answer.get("url"):
        result["url"] = answer["url"]
    return json.dumps(result)


# ── IDE context for the model ─────────────────────────────────────────────────────────────────

IDE_NOTE = (
    "[Hermes IDE] This message was sent from the Hermes IDE window for this chat. Hermes IDE is a plugin in "
    "the user's own Hermes setup: beside this chat they see a file Explorer, a code editor and their "
    "project's running web UI. To open, run or show the project's UI, call ide_open with ui: true (never "
    "start a dev server yourself); to show a file at a line, ide_open with a path. ide_open reports what the "
    "IDE did; if it says needs_trust, ask the user to click Always run or Run once in the IDE. A "
    "[[ Element picked in ... ]] block describes an element they picked in that page (selector, markup, styles, "
    "the UI component and its source when known): treat it as the thing they mean. @file: references are files "
    "or selections from the editor. Your file edits appear in their editor with a review diff. For more, load "
    "the skill hermes-ide:guide."
)
IDE_LEASE_SECONDS = 180
_cache: dict[str, Any] = {"mtime": None, "data": {}}


def _ide_sessions_path() -> Path:
    # Same place the backend writes (dashboard/plugin_api.py, /ide/session).
    return _data_dir() / "ide-sessions.json"


def _open_ide_sessions(now: float | None = None) -> set[str]:
    """Chat ids whose IDE window renewed its lease in the last few minutes."""
    f = _ide_sessions_path()
    try:
        mtime = f.stat().st_mtime
    except OSError:
        return set()
    if _cache["mtime"] != mtime:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            _cache["data"] = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _cache["data"] = {}
        _cache["mtime"] = mtime
    now = time.time() if now is None else now
    return {k for k, v in _cache["data"].items() if isinstance(v, (int, float)) and now - v < IDE_LEASE_SECONDS}


def on_pre_llm_call(session_id: str = "", user_message: Any = "", **_: Any) -> dict[str, str] | None:
    """A turn in a chat whose IDE window is open (or that carries a picked element) gets the IDE note,
    appended to this turn's user message only: nothing is stored, and the system prompt is untouched."""
    try:
        text = user_message if isinstance(user_message, str) else ""
        if (session_id and session_id in _open_ide_sessions()) or "[[ Element picked in " in text:
            return {"context": IDE_NOTE}
    except Exception:
        logger.debug("hermes-ide: pre_llm_call skipped", exc_info=True)
    return None


def _skill_description(path: Path) -> str:
    m = re.search(r"^description:\s*(.+)$", path.read_text(encoding="utf-8"), re.M)
    return m.group(1).strip() if m else ""


def register(ctx) -> None:
    ctx.register_tool(name="ide_open", toolset="hermes-ide", schema=IDE_OPEN_SCHEMA, handler=handle_ide_open,
                      description=IDE_OPEN_SCHEMA["description"], emoji="🧭")
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    guide = Path(__file__).parent / "skills" / "guide" / "SKILL.md"
    if guide.is_file() and hasattr(ctx, "register_skill"):
        # The skills index shows the description passed here (the registry does not read the
        # frontmatter), and it is what tells the agent when to load the skill.
        ctx.register_skill("guide", guide, description=_skill_description(guide))
