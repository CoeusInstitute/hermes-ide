# Hermes IDE

A Cursor-style IDE for [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), shipped as one installable Hermes plugin.

Press **Ctrl+Alt+I** in any chat and that chat opens in its own IDE window: Explorer and a tabbed code editor on the left, the chat on the right, and the Desktop Browser beside it when you render a page. The window holds exactly that one session. It is the app's own single-chat pop-out, so the chat in it is the real session chat, not a copy, and your main window is never rearranged.

The IDE wires its parts to that chat: send a selection with Ctrl+L, ask Hermes to edit lines in place with Ctrl+K, review what the agent changed with Keep and Undo, and pick elements in the rendered page to hand to the chat. The open folder and the editor tabs belong to the session, so reopening the IDE for a chat brings back its folder and files. You can still drive everything from the chat alone; the agent opens files in the IDE with its `ide_open` tool, which opens that chat's IDE window when it is not open yet.

![Hermes IDE layout](docs/images/ide-layout.png)

## Install

You need Hermes Desktop 0.22 or newer (the release that ships `host.openWorkspace`, `host.composer` and the plugin package installer).

**From the Desktop app (recommended).** Open **Capabilities → Plugins → Install from Git**, enter `CoeusInstitute/hermes-ide`, keep both the Agent plugin and Desktop UI targets checked, and click **Install**. The dialog installs both halves and turns them on at once; the **EXPLORER** tab appears in the sidebar without a restart or a Rescan.

**From a link.** `hermes://plugin/install?repo=CoeusInstitute/hermes-ide&enable=1` opens the same Desktop install dialog. Nothing installs until you confirm.

**From a terminal.**

```bash
hermes plugins install CoeusInstitute/hermes-ide --enable
```

The terminal installs and enables the agent half only. If Hermes Desktop is already open, it does not pick up the new desktop half; restart the app. Then search `Hermes IDE` under **Capabilities → Plugins** and switch **Desktop: Hermes IDE** on (a terminal install leaves the desktop half off, like every package's desktop half). Prefer the Desktop install above, which needs neither step.

The backend routes mount without a gateway restart on current Hermes; on an older build run `hermes gateway restart` once.

The repository is private today. Installing it needs a GitHub login with access (`gh auth login`, or `GITHUB_TOKEN` in your `.env`). Make the repository public to let anyone install it.

## Use

In a chat, press **Ctrl+Alt+I**, click **IDE** in the status bar, or run **IDE: Open in IDE Window** from the command palette (Ctrl+K). The chat needs at least one message first; a draft has no session yet.

The IDE window maximizes on the screen it opens on and sizes its columns to that screen: Explorer about 14% (220 to 340 px), chat about 30% (380 to 760 px, never below the app's own minimum chat width), editor the rest. A rendered page opens as a preview column of about a third of the window, taking its space from the editor; closing it gives the space back. Drag any seam to change a size; double-click the Explorer seam to reset it. If the chat already has a plain pop-out window, that window turns into the IDE instead of a second window opening.

Columns are told apart the way Cursor does it, with colours from your theme only: the Explorer sits on the theme's sidebar surface (darkest), the chat on its chrome surface, and the editor on its elevated surface (lightest), with a full-height 1px divider in the theme's base colour at 18% at every column edge. The active editor tab takes the editor's tone, so it reads as part of the editor; inactive tabs sit on the darker strip. This styling applies only in the IDE window; the main window keeps the app's look.

The Explorer opens the chat's working directory; **Open Folder…** opens another one and, by default, moves the chat there too.

| Keys (in the editor) | Action |
|---|---|
| Ctrl+L | Add the selection (or the file) to the chat as an `@file:path:from-to` reference |
| Ctrl+K | Edit the selected lines with Hermes; the request goes to the session chat |
| Ctrl+P | Go to file, with `:line` to jump |
| Ctrl+Shift+F | Search in files |
| Ctrl+S / Ctrl+Shift+S | Save / Save all |
| Ctrl+F, Ctrl+G, Ctrl+D, Ctrl+/ | Find, go to line, select next match, toggle comment |
| Ctrl+Shift+P or F1 | The Desktop command palette |
| Ctrl+B | Toggle the Explorer |
| Ctrl+J or Ctrl+` | Show the terminal |
| Ctrl+Alt+Left/Right | Previous / next tab |

Outside the editor the same commands have palette entries (`IDE: …`) and rebindable defaults (Ctrl+Alt+P, Ctrl+Alt+F, Ctrl+Alt+E, Ctrl+Alt+I). In the main window the only IDE command is **IDE: Open in IDE Window**; everything else lives in the IDE window.

**Agent edits.** When Hermes edits an open file, the tab reloads with an inline diff against what you had. Accept or Reject single hunks, or use **Keep** and **Undo** for the whole edit. If you had unsaved changes, you get **Compare**, **Use Disk Version** and **Overwrite with Mine** instead, and nothing is lost.

**Browser and element picking.** **Open in Browser** (the globe on HTML, SVG and Markdown files, or the Explorer menu) renders the file in the Desktop preview beside the chat in the IDE window. Turn on its **Annotate** tool, click an element, write a note, and **Add comment** sends the element's selector, HTML, styles and a screenshot to the chat.

![Agent edit review](docs/images/agent-edit-review.png)

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Desktop half | `desktop/plugin.js` (built from `src/`) | Main window: the **IDE** status button, the open command and keybind. IDE window (a claimed single-session pop-out): the IDE tile (Explorer, Search, Source Control, Editor), column sizing, Quick Open, commands, keybinds. Both: settings page, the `::hermes-ide-open` transcript card |
| Editor | sandboxed `srcdoc` iframe inside the IDE tile | CodeMirror 6 with the app's theme tokens and fonts; owns its keyboard |
| Backend | `dashboard/plugin_api.py` → `/api/plugins/hermes-ide/` | File system, ripgrep search, Quick Open file list, git status, git HEAD text, on the machine the agent runs on |
| Agent half | `__init__.py`, `plugin.yaml` | The `ide_open` tool, which opens a file in the IDE through a plugin event |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The feature map, gates and what comes next: [docs/FEATURES.md](docs/FEATURES.md). How the design was derived from Cursor and from Hermes Desktop: [docs/RESEARCH.md](docs/RESEARCH.md).

## Security

The backend runs inside the Hermes gateway with your user's rights, behind the gateway's own authentication, so the IDE can reach the files the agent's own file tools can reach. It refuses Hermes credential files (`.env`, `auth.json`, `mcp-tokens/`, `secrets/` under the Hermes home), never deletes permanently (it uses the system trash or refuses), never overwrites on create or rename, and refuses a save when the file changed on disk since it was loaded. The editor runs in an opaque-origin sandboxed frame and talks to the plugin only through `postMessage`.

## Known limits

- Ripgrep makes search and Quick Open fast and gitignore-aware; without it the backend falls back to a slower Python walk.
- The editor has no language server yet: highlighting, folding, brackets and word completion, but no go-to-definition or diagnostics. See Gate 2 in [docs/FEATURES.md](docs/FEATURES.md).
- A chat that has not started yet cannot be moved to a folder by a plugin. The IDE applies the folder when the chat's first reply finishes; to start a chat directly in a folder, use the composer's folder button.
- Open in Browser shows the Desktop's own preview card, so it takes one click to open. Plugins have no direct door to the Browser yet.
- Column sizing drags the app's own split seams with synthetic pointer events, because the plugin SDK has no door to size a split. If a Desktop update changes those seams, the IDE window still opens, with the app's even split instead.
- The preview column docks to the right of the chat, where the app puts previews. A plugin cannot move it between the editor and the chat.

## Develop

```bash
cd dev && npm ci && npm run build   # writes desktop/plugin.js
npm test                            # helper tests
cd .. && uv run --with pytest --with fastapi --with httpx python -m pytest tests -q
```

See [docs/DEVELOPING.md](docs/DEVELOPING.md) for the live loop and the sandboxed Desktop used to verify releases.

## License

MIT. Copyright (c) 2026 Coeus Institute.
