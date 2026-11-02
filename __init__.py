"""Hermes IDE: agent half.

The IDE itself is the desktop half (``desktop/plugin.js``) plus the backend routes in
``dashboard/plugin_api.py``. This half gives the agent one tool, ``ide_open``, so a chat can drive
the IDE ("open the router in the IDE at the 404 handler"): it pushes an event to every connected
Hermes Desktop window, and the IDE opens the file at that line.
"""

from __future__ import annotations

import json
import logging
import os
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
        "app's Browser pane directly, use the open_preview tool instead."
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


def register(ctx) -> None:
    ctx.register_tool(name="ide_open", toolset="hermes-ide", schema=IDE_OPEN_SCHEMA, handler=handle_ide_open,
                      description=IDE_OPEN_SCHEMA["description"], emoji="🧭")
