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
        "user can see or edit it. Use when the user asks to open, show or jump to a file or line in the "
        "IDE/editor. Pass an absolute path, or a path relative to the session's working directory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path (absolute, or relative to the working directory)."},
            "line": {"type": "integer", "description": "1-based line to reveal.", "minimum": 1},
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}


def _resolve(path: str, task_id: str) -> str:
    """Resolve the way the agent's own file tools do, so 'src/app.ts' means the file it just wrote."""
    p = path.strip()
    try:
        from tools.file_tools_paths import _resolve_path_for_task

        return os.path.realpath(str(_resolve_path_for_task(p, task_id))).replace("\\", "/")
    except Exception:
        p = os.path.expanduser(p)
        return os.path.realpath(p if os.path.isabs(p) else os.path.join(os.getcwd(), p)).replace("\\", "/")


def handle_ide_open(args: dict[str, Any], **kw: Any) -> str:
    raw = args.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return json.dumps({"success": False, "error": "path is required"})
    path = _resolve(raw, str(kw.get("task_id") or "default"))
    if not os.path.isfile(path):
        return json.dumps({"success": False, "error": f"not a file: {path}"})
    line = args.get("line")
    payload: dict[str, Any] = {"path": path}
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
