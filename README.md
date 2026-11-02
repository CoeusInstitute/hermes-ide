# Hermes IDE

A Cursor-style IDE for [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), shipped as one installable Hermes plugin.

Press **Ctrl+Alt+I** in any chat and that chat opens in its own IDE window: an Explorer, a tabbed code editor, a Browser that runs and shows your project's UI, and the chat itself. The window holds exactly that one session. It is the app's own single-chat pop-out, so the chat in it is the real session chat, not a copy, and your main window is never rearranged.

The IDE wires its parts to that chat: send a selection with Ctrl+L, ask Hermes to edit lines in place with Ctrl+K, review what the agent changed with Keep and Undo, and pick an element in the running page to hand it to the chat with the source lines that likely render it. The open folder and the editor tabs belong to the session, so reopening the IDE for a chat brings back its folder and files. IDE chats get their own group in the main window's sidebar and open straight into their IDE window. You can still drive everything from the chat alone; the agent opens files and pages in the IDE with its `ide_open` tool.

![Hermes IDE layout](docs/images/ide-layout.png)

## Install

You need Hermes Desktop 0.22 or newer (the release that ships `host.openWorkspace`, `host.composer`, session-row slots and the plugin package installer).

**From the Desktop app (recommended).** Open **Capabilities → Plugins → Install from Git**, enter `CoeusInstitute/hermes-ide`, keep both the Agent plugin and Desktop UI targets checked, and click **Install**. The dialog installs both halves and turns them on at once; the **IDE** button appears in the status bar without a restart or a Rescan.

**From a link.** `hermes://plugin/install?repo=CoeusInstitute/hermes-ide&enable=1` opens the same Desktop install dialog. Nothing installs until you confirm.

**From a terminal.**

```bash
hermes plugins install CoeusInstitute/hermes-ide --enable
```

The terminal installs and enables the agent half only. If Hermes Desktop is already open, it does not pick up the new desktop half; restart the app. Then search `Hermes IDE` under **Capabilities → Plugins** and switch **Desktop: Hermes IDE** on (a terminal install leaves the desktop half off, like every package's desktop half). Prefer the Desktop install above, which needs neither step.

The backend routes mount without a gateway restart on current Hermes; on an older build run `hermes gateway restart` once.

The repository is private today. Installing it needs a GitHub login with access (`gh auth login`, or `GITHUB_TOKEN` in your `.env`). Make the repository public to let anyone install it.

**Update.** **Capabilities → Plugins** offers updates, or run `hermes plugins update hermes-ide`. After a terminal update, run **Reload desktop plugins** from the command palette (or restart the app) so the open windows load the new desktop half. When an update changes the backend (as v0.3 does: project detection and dev servers), a gateway that was already running keeps the previous backend until `hermes gateway restart` (or an app restart); the Browser column says so when it finds the gateway behind. A first install needs no restart.

**Uninstall.** Run `hermes plugins remove hermes-ide`. That removes the package, its `plugins.enabled` entry and its install record. The running Desktop keeps the IDE's Desktop half until that copy goes, so also delete `desktop-plugins/hermes-ide` in your Hermes home (`%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere); the app unloads it at once, and the IDE button and the sidebar group disappear. Small settings the IDE kept in the app's own storage (tab lists, column layout, trusted projects, the IDE chat list) stay behind and are reused if you reinstall.

## Use

In a chat, press **Ctrl+Alt+I**, click **IDE** in the status bar, or run **IDE: Open in IDE Window** from the command palette (Ctrl+K). The IDE opens the chat on screen: from a page such as Capabilities it asks you to open a chat first. The chat needs at least one message; a draft has no session yet. If the chat already has a plain pop-out window, that window turns into the IDE instead of a second window opening.

### Columns

The IDE window maximizes on the screen it opens on. Explorer, Editor and Browser are separate columns beside the chat, each with its own tab at the top of the window:

- **Rearrange by dragging a column's tab** to any edge of another column, or onto its middle to stack the two as tabs. This is the app's own pane dragging, so it works the way the rest of Hermes Desktop does.
- **Show or hide a column** with the toggles at the top right of the IDE window (Explorer, Editor, Browser, Terminal), or the commands **IDE: Toggle Explorer / Editor / Browser Column**.
- **Resize** by dragging any seam.

The IDE remembers the arrangement, the widths and which columns are open, and rebuilds them the next time an IDE window opens. **IDE: Reset Column Layout** goes back to the default: Explorer (about 14% of the window, 220 to 340 px), Editor (the rest), Browser (about a third, 520 to 1280 px) and the chat (about 30%, never below the app's own minimum chat width).

Columns are told apart the way Cursor does it, with colours from your theme only: the Explorer sits on the theme's sidebar surface (darkest), the chat on its chrome surface, and the Editor and Browser on its elevated surface (lightest), with a full-height 1px divider in the theme's base colour at 18% at every column edge. Every column's first bar is the same height, so the bars line up across the window. This styling applies only in the IDE window; the main window keeps the app's look.

### Project UI and the Browser

When the IDE opens a folder, it looks for a web UI in it: a `package.json` with a dev script for Vite, Next.js, Nuxt, Remix, SvelteKit, Astro, Angular, Create React App, Gatsby, Vue CLI, Parcel, webpack, Storybook and similar (at the root, one level down, or under `apps/*` and `packages/*` in a monorepo), or else a static `index.html`. The package manager comes from the lockfile (pnpm, yarn, bun or npm).

- The first time, the Browser column asks before running anything: **Always run for this project**, **Run once**, or **Not now**. Running a dev server runs that project's own code, so the IDE never does it unasked.
- A trusted project starts on its own every time its IDE window opens (turn that off in **Settings → Hermes IDE**), and the page opens in the Browser column as soon as the dev server is up. The URL comes from the dev server's own output, so a different port is picked up correctly.
- Without `node_modules`, the button reads **Install & run** and installs the dependencies first.
- The status row shows the server's state; click it for the live log. **Restart** and **Stop** are beside it. With several UIs in a monorepo, a picker chooses which one runs.
- The dev server belongs to the IDE window: when no IDE window has asked about it for two minutes (you closed the window), the backend stops it. Reloading or reopening the window within that time keeps it running.

The Browser column is a full browser for anything else too: type an address, use back, forward and reload, open **DevTools** for the page, or open it in your system browser. **Open in Browser** on an HTML, SVG, Markdown, image or PDF file shows it there (served by the dev server when the project is a running static site).

**Pick an element** (the inspect button, or **IDE: Pick Element in Browser**): hover the page, click an element, and the IDE adds it to the chat composer with its selector, size, text, markup, key styles and up to three likely source lines (`@file:` references found by searching the project for its id, its text or its most specific class). Press Esc to cancel.

### IDE chats in the sidebar

The main window's sidebar lists IDE chats in their own **IDE** group under **SESSIONS**, newest first, the way the date groups work, and takes them out of the date groups. Clicking one opens its IDE window (or brings it to the front) instead of a tab. A pinned IDE chat stays in **Pinned** and carries an **IDE** badge, and so does an IDE chat in project lists and search results; clicking it opens the IDE as well. Modifier clicks keep the app's meaning (Shift-click pins).

- **+** on the group starts a new chat that opens in the IDE as soon as you send its first message.
- **×** on a row removes the chat from the group; it goes back to the normal list.

A chat becomes an IDE chat the first time it opens in an IDE window.

### Keys

| Keys (in the editor) | Action |
|---|---|
| Ctrl+L | Add the selection (or the file) to the chat as an `@file:path:from-to` reference |
| Ctrl+K | Edit the selected lines with Hermes; the request goes to the session chat |
| Ctrl+P | Go to file, with `:line` to jump |
| Ctrl+Shift+F | Search in files |
| Ctrl+S / Ctrl+Shift+S | Save / Save all |
| Ctrl+F, Ctrl+G, Ctrl+D, Ctrl+/ | Find, go to line, select next match, toggle comment |
| Ctrl+Shift+P or F1 | The Desktop command palette |
| Ctrl+B | Toggle the Explorer column |
| Ctrl+J or Ctrl+` | Show the terminal |
| Ctrl+Alt+Left/Right | Previous / next tab |

Outside the editor the same commands have palette entries (`IDE: …`) and rebindable defaults: Ctrl+Alt+P (go to file), Ctrl+Alt+F (search), Ctrl+Alt+E (Explorer), Ctrl+Alt+B (Browser column), Ctrl+Alt+R (run the project's UI), Ctrl+Alt+I (open or show the IDE). An empty editor shows the main ones as a clickable list.

**Agent edits.** When Hermes edits an open file, the tab reloads with an inline diff against what you had. Accept or Reject single hunks, or use **Keep** and **Undo** for the whole edit. If you had unsaved changes, you get **Compare**, **Use Disk Version** and **Overwrite with Mine** instead, and nothing is lost.

**The agent drives the IDE.** `ide_open` with a `path` (and optional `line`) opens a file; with a `url` it shows a page in the Browser column, for example the dev server it just started. Either opens that chat's IDE window when it is not open yet.

![Agent edit review](docs/images/agent-edit-review.png)

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Desktop half | `desktop/plugin.js` (built from `src/`) | Main window: the **IDE** status button, the open command, the sidebar IDE group and the IDE row badge. IDE window (a claimed single-session pop-out): the Explorer, Editor and Browser columns as app tiles, the layout toggles, layout memory and column sizing, the dev-server controls and element picker, Quick Open, commands, keybinds. Both: settings page, the `::hermes-ide-open` transcript card |
| Editor | sandboxed `srcdoc` iframe inside the Editor column | CodeMirror 6 with the app's theme tokens and fonts; owns its keyboard |
| Browser | an Electron `<webview>` inside the Browser column | Shows the project's UI or any page; the picker runs inside the page |
| Backend | `dashboard/plugin_api.py` → `/api/plugins/hermes-ide/` | File system, ripgrep search, Quick Open file list, git status, git HEAD text, project UI detection and the dev-server manager, on the machine the agent runs on |
| Agent half | `__init__.py`, `plugin.yaml` | The `ide_open` tool, which opens a file or page in the IDE through a plugin event |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The feature map, gates and what comes next: [docs/FEATURES.md](docs/FEATURES.md). How the design was derived from Cursor and from Hermes Desktop: [docs/RESEARCH.md](docs/RESEARCH.md).

## Security

The backend runs inside the Hermes gateway with your user's rights, behind the gateway's own authentication, so the IDE can reach the files the agent's own file tools can reach. It refuses Hermes credential files (`.env`, `auth.json`, `mcp-tokens/`, `secrets/` under the Hermes home), never deletes permanently (it uses the system trash or refuses), never overwrites on create or rename, and refuses a save when the file changed on disk since it was loaded. The editor runs in an opaque-origin sandboxed frame and talks to the plugin only through `postMessage`.

Dev servers: the command always comes from the project's own files (its `package.json` script, or Python's built-in static server for a plain site); the Desktop only names which detected project to run, never a command. Each project asks once before its code runs. Dev servers get `BROWSER=none`, so none opens a system browser tab, and a static site is served on `127.0.0.1` only.

## Known limits

- Ripgrep makes search, Quick Open and the picker's source lookup fast and gitignore-aware; without it the backend falls back to a slower Python walk.
- The editor has no language server yet: highlighting, folding, brackets and word completion, but no go-to-definition or diagnostics. See Gate 2 in [docs/FEATURES.md](docs/FEATURES.md).
- A chat that has not started yet cannot be moved to a folder by a plugin. The IDE applies the folder when the chat's first reply finishes; to start a chat directly in a folder, use the composer's folder button.
- Against a remote Hermes backend, the dev server runs on the remote machine, so its `localhost` page is not reachable from the Browser column, and **Open in Browser** on a file uses a `file://` address on this machine.
- Python web UIs (Streamlit, Flask, Django) are not detected yet; type their address in the Browser column.
- The layout remembers columns side by side and stacked as tabs; a column split top and bottom comes back side by side.
- Column sizing drags the app's own split seams with synthetic pointer events, and the sidebar group is placed using the session list's own drop-target markers, because the plugin SDK has no door to size a split or add a session group. If a Desktop update changes either, the IDE still works: the window opens with the app's even split, and IDE chats show their badge in the normal list instead of their own group.

## Develop

```bash
cd dev && npm ci && npm run build   # writes desktop/plugin.js
npm test                            # helper and layout tests
cd .. && uv run --with pytest --with fastapi --with httpx python -m pytest tests -q
```

See [docs/DEVELOPING.md](docs/DEVELOPING.md) for the live loop and the sandboxed Desktop used to verify releases.

## License

MIT. Copyright (c) 2026 Coeus Institute.
