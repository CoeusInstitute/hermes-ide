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
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN_ID = "hermes-ide"

IDE_OPEN_SCHEMA: dict[str, Any] = {
    "name": "ide_open",
    "description": (
        "Open a file in the Hermes IDE editor inside the Hermes Desktop app, optionally at a line, so the "
        "user can see or edit it there. Use when the user asks to open, show or jump to a file or a line in "
        "the IDE. Pass an absolute path or one relative to the session's working directory. A url (such as "
        "the dev server you just started) is offered in the IDE's project UI view; to show a page in the "
        "app's Browser pane directly, use desktop_preview (action open) instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (absolute, or relative to the working directory)."},
            "line": {"type": "integer", "description": "1-based line to reveal.", "minimum": 1},
            "url": {"type": "string", "description": "http(s) URL to offer in the IDE, e.g. http://localhost:5173/."},
        },
        "additionalProperties": False,
    },
}


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


def handle_ide_open(args: dict[str, Any], **kw: Any) -> str:
    raw = args.get("path")
    url = args.get("url")
    payload: dict[str, Any] = {}
    if isinstance(url, str) and url.strip():
        url = url.strip()
        if not url.lower().startswith(("http://", "https://")) or len(url) > 2048:
            return json.dumps({"success": False, "error": "url must be an http(s) URL"})
        payload["url"] = url
    elif not isinstance(raw, str) or not raw.strip():
        return json.dumps({"success": False, "error": "pass a path or a url"})
    elif raw.strip().startswith(("\\\\", "//")):
        # A network path would make the gateway open an SMB connection (and offer the user's
        # credentials) to a host a prompt may have named.
        return json.dumps({"success": False, "error": "network paths are not opened; use a local path"})
    else:
        path = _resolve(raw)
        if not os.path.isfile(path):
            return json.dumps({"success": False, "error": f"not a file: {path}"})
        payload["path"] = path
        line = args.get("line")
        if isinstance(line, int) and line > 0:
            payload["line"] = line
    if kw.get("session_id"):
        payload["session_id"] = str(kw["session_id"])
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, "open", payload)
    except Exception as e:
        return json.dumps({"success": False, "error": f"could not reach Hermes Desktop: {e}"})
    return json.dumps({"success": True, **payload,
                       "note": "Opened in the Hermes IDE when a Desktop window with the IDE enabled is connected."})


# ── IDE context for the model ─────────────────────────────────────────────────────────────────

IDE_NOTE = (
    "[Hermes IDE] This message was sent from the Hermes IDE window for this chat. Hermes IDE is a plugin in "
    "the user's own Hermes setup: beside this chat they see a file Explorer, a code editor and their "
    "project's running web UI. A [[ Element picked in ... ]] block describes an element they picked in that "
    "page (selector, markup, styles, the UI component and its source when known): treat it as the thing they "
    "mean. @file: references are files or selections they added from the editor. To show them a file at a "
    "line, call ide_open with a path; to put a page in front of them, ide_open with a url (or desktop_preview, action "
    "open, for the app's Browser). Their edits save to disk "
    "and your file edits appear in their editor with a review diff. For more, load the skill hermes-ide:guide."
)
IDE_LEASE_SECONDS = 180
_cache: dict[str, Any] = {"mtime": None, "data": {}}


def _ide_sessions_path() -> Path:
    # Same place the backend writes (dashboard/plugin_api.py, /ide/session).
    try:
        from plugins.plugin_storage import plugin_data_dir

        return Path(plugin_data_dir(PLUGIN_ID)) / "ide-sessions.json"
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "plugin-data" / PLUGIN_ID / "ide-sessions.json"


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
