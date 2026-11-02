# Architecture

## Shape

```
Main Hermes Desktop window                IDE window: the app's single-session pop-out, claimed by the plugin
┌──────────────────────────────────┐      ┌────────────────────────────────────────────────────────────────────────────┐
│ Sessions (core)   │ Session chat │      │ tabs:  Explorer ×   Editor ×          Browser ×        <chat tab>   [E][Ed][B][T] │
│ ─ PINNED          │ (core)       │      ├──────────┬──────────────────────┬──────────────────┬────────────────┤
│   chat [IDE]◄badge│              │ Ctrl+│ Explorer │ tabs, crumbs, review │ address bar, run │ Session chat   │
│ ─ SESSIONS        │              │ Alt+I│ Search   │ ┌──────────────────┐ │ status, picker   │ (core, the     │
│   IDE ◄ group     │              │ ───► │ Source   │ │ srcdoc iframe:   │ │ ┌──────────────┐ │  same session  │
│     chat  chat    │              │ IDE  │ Control  │ │ CodeMirror 6     │ │ │ <webview>:   │ │  as the main   │
│   Today …         │ status: [IDE]│ group│          │ └──────▲───────────┘ │ │ the project's│ │  window)       │
└──────────────────────────────────┘ row  │ (app tile)│ (app tile)│postMessage│ UI (app tile)│ │  composer ◄────┼ Ctrl+L, Ctrl+K,
   window.hermesDesktop.openSessionWindow └──────────┴──────────────────────┴──────────────────┴────────────────┘ picked element
   + localStorage open request                      │ ctx.rest                                     ▲ plugin.hermes-ide.open
                                                    ▼                                              │ (path or url, session_id)
              Hermes gateway (agent machine): /api/plugins/hermes-ide/*  ·  agent half: ide_open tool
              fs, rg search, git, project UI detection, dev servers (npm/pnpm/yarn/bun or a static server) with a lease
```

Every column is its own app tile, so its tab is a real drag handle: the arrangement above is only the default.

The plugin is one package with three halves:

| Half | Files | Loaded by |
|---|---|---|
| Desktop | `desktop/plugin.js` (built from `src/`) | The Desktop disk-plugin loader, after the package installer copies it to `$HERMES_HOME/desktop-plugins/hermes-ide/` |
| Backend | `dashboard/manifest.json`, `dashboard/plugin_api.py` | The gateway web server, mounted at `/api/plugins/hermes-ide/` when the plugin is in `plugins.enabled` |
| Agent | `plugin.yaml`, `__init__.py` | The Hermes plugin loader; registers the `ide_open` tool in toolset `hermes-ide` |

## What is reused, mirrored and added

**Reused, never duplicated.** The session chat and its composer, the single-session pop-out window, the app's pane tree and its tab dragging (FancyZones) for arranging the columns, the terminal, the Review pane, the command palette, the theme system, the folder picker, file reference chips (`@file:`), session-row decoration slots, and the agent's own file tools.

**Mirrored.** The IDE subscribes to Desktop state and follows it:

| Desktop state | SDK door | IDE behavior |
|---|---|---|
| The window's chat | `#/<storedId>` route of the pop-out, `host.state.focusedStoredSessionId` | Load that chat's tab set (`tabs:<storedId>` in plugin storage); an IDE window never switches chats |
| Chat folder | `host.state.cwd`, `session.cwd.set` | Explorer root follows it; Open Folder moves the chat |
| Agent tool calls | `ctx.onEvent('tool.complete')` | Re-stat open files; reload changed ones with an inline review diff |
| Turn end | `ctx.onEvent('message.complete')` | Apply a folder chosen while the chat was a draft |
| Theme, mode, accent, fonts | computed `--ui-*`, `--font-*` tokens, `$accentOverride`, `@font-face` rules | Re-sent to the editor frame after each repaint settles |
| Agent requests | `ctx.onEvent('plugin.hermes-ide.open')` | Open the file at the line, or the URL in the Browser column |
| Session list | `host.listPersistedSessions`, the Pinned section's own rows | The sidebar IDE group: titles, models, message counts, ages; pinned IDE chats stay in Pinned |

**Added.** The IDE window role (claiming a pop-out, maximizing it, hiding its session list, rebuilding and sizing its columns, remembering the arrangement), the layout toggles, Explorer, Search and Source Control views, the editor, the Browser column with its dev-server controls and element picker, Quick Open, the Open Folder dialog, the review and conflict banners, the sidebar IDE group and row badge, the status item, commands, keybinds, the settings page, the transcript card, the backend routes (files, search, git, project detection, dev servers) and the `ide_open` tool.

## The IDE window

Opening: the main window writes `hermes-ide:open-window = {sid, at, path?, line?}` to localStorage and calls `window.hermesDesktop.openSessionWindow(sid, {profile, connectionId})`, the same door the app's "Open in new window" uses. The app opens (or re-fronts) one pop-out per chat, at `index.html?win=secondary…#/<sid>`.

Claiming: the plugin copy in that pop-out reads the request at load. If the request names its chat and is under a minute old, it removes the request and sets `hermes-ide:window` in sessionStorage, so a reload of that window stays an IDE window. A plain pop-out that already exists gets the request through a `storage` event and reloads itself as the IDE. A plain pop-out asking for itself (its own IDE button) converts directly, because a window never receives its own storage events.

Columns: Explorer, Editor and Browser are three `host.openWorkspace` tiles (`plugin-workspace:hermes-ide-<id>`). Each tile gets its own zone, so the app draws a tab for it at the top of the window, and that tab is the app's own drag handle: dragging it onto any edge of another zone, or onto its middle to stack, moves the column with the app's FancyZones engine. The plugin never moves zones itself. The titlebar's right cluster (`TITLEBAR_AREAS.right`, the cluster the app's own controls use, so it takes clicks) holds the toggles that open and close each column and the terminal; the IDE window's dialogs mount there too, because titlebar slots are permanent mount points.

Layout memory: `readColumns()` reads the window's top-row zones left to right and finds which column holds each IDE tile and the chat, by geometry (a pane body can be hosted outside its zone element). The arrangement is saved as `layout = {columns: [[ids…], …], widths: {id: fraction}}` every few seconds and after every pointer release, and when the window unloads. On open, `dockPlan()` in `util.ts` turns the saved columns into an ordered list of `openWorkspace` docks chained outward from the chat (`workspace`): left of the chat, each column docks left of its right neighbour; right of it, right of its left neighbour; stacked tabs dock `center` on their column's first tile. A tile hidden behind another tab is not on screen, so it keeps the column it had. When the column order changes (the user moved one), the app re-splits the window evenly; the save keeps each column's own width (keyed by column, not position) and refits before recording widths again. **IDE: Reset Column Layout** clears the saved layout and reloads the window through the same restore path (closing and reopening tiles in place raced the app's pane adoption and left an empty zone).

Sizing: the window maximizes once (`windowControls.toggleMaximize`) and waits until it is actually near screen width (the maximize can land seconds after the first resize on large displays; hiding the session list while the window is still narrow toggles the narrow overlay instead and leaves the list visible), hides the app's session list with `view.toggleSidebar`, re-checking until it is gone (pop-out layout state is memory-only, so the main window's sidebar is untouched), then `fitColumns()` sizes the columns: saved widths where the user set them, otherwise `columnPlan(width)` (Explorer 14%, chat 30%, Browser 32%, clamped); the editor (or the chat, with the editor closed) takes the rest, and zones the IDE does not own keep their size. The SDK has no door to size a split, so `dragSeam` drags the app's own sash with synthetic pointer events; `tree-split.tsx` accepts them, clamps every zone to its floor and commits once on release. Two details matter: the seam moves by the pointer's travel from where it pressed, so the pointer aims half a sash past the target (otherwise every fitted column lands 4 px short and drifts smaller each time the window opens); and each target is measured from where the neighbouring seam really ended up, because the app clamps a column at its floor (the chat's floor, 845 px at 3840, is wider than its plan) and planned sums would misplace the next seam. A `MutationObserver` refits only when the number of zones changes, so a streaming chat costs one `querySelectorAll` per mutation batch.

Look: the IDE window departs from the main window on purpose, because an IDE needs its columns readable at a glance. Column tones use opaque theme surfaces in Cursor's order (Explorer `--ui-bg-sidebar`, chat `--ui-bg-chrome`, Editor and Browser `--ui-bg-elevated`); the `*-surface-background` role tokens are not used because glass skins make them transparent. Inputs use a 5% tint of `--ui-text-primary`, not `--ui-bg-input`, which resolves to near-white even in dark mode. Every column's first bar is `--hi-bar` (35 px) and its second row `--hi-sub` (28 px), so the rows line up across the window. Dividers are the theme's `--ui-base` at 18%, a neutral line that stays visible on every tone (the accent-tinted theme strokes measured near-invisible on dark surfaces). The app's own zone seams are restyled only in this window by an injected stylesheet: full opacity, the same divider colour, and `translate: none`, because the stock half-pixel shift smears the 1px line across two pixels at half strength.

## The Browser column and dev servers

The Browser column is an Electron `<webview>` (pop-outs are created with `webviewTag: true`) on its own `persist:hermes-ide` partition, so the app's preview preload and its guest rules do not apply. Navigations go through `loadURL`; the `src` attribute is set once, because re-setting it to the URL the page already navigated to would reload it.

When the IDE's folder changes, `/project/detect` reports the web UIs in it (see the backend table). A trusted project (`trustedProjects` in plugin storage, keyed by the project folder) with installed dependencies starts at once when the setting allows; any other project shows the trust banner first. `/devserver/start` takes only a detected candidate id: the backend derives the command from the project's own files, spawns it in a new process group with `BROWSER=none`, reads its output for the URL (a line labelled `Local:` wins over an earlier proxy or API URL; the framework's usual port is the fallback after 25 s), and reports `ready` once that port accepts a TCP connection (IPv4 and IPv6, since Node 18+ binds `localhost` to `::1` first). The column polls `/devserver/status` every 1.5 s, which doubles as a lease: a server nobody has asked about for 120 s is stopped (process-tree kill: `taskkill /T` on Windows, the process group elsewhere), so closing the IDE window stops its dev server while a reload keeps it. Gateway shutdown stops them all.

The element picker sends a self-contained script into the page with `executeJavaScript`; it highlights the element under the pointer, swallows the click, and resolves with the element's selector, size, text, markup and key computed styles. The plugin then searches the project (id, then visible text, then the most specific class name) for up to three source lines and inserts the whole description into the chat composer as a block, with the lines as `@file:` references.

## IDE chats in the main window

A chat becomes an IDE chat when it opens in an IDE window (`ideChats` in plugin storage, keyed by any of its ids and normalized to the durable lineage-root id once the session list is loaded, so it survives compaction). Two parts show them:

- **Row badge.** A `SESSION_ROW_AREAS.leading` contribution renders an `IDE` badge on every IDE chat's row, wherever the app draws it (Pinned, the date groups, project lists, search). It also adds a capture-phase click listener on the row body (the nearest ancestor holding the row's title button), so a plain click opens the IDE window instead of a tab; modifier clicks pass through.
- **The IDE group.** The SDK has no door to add a group to the session list, so the group is a plain-DOM block (plugins get no `react-dom` for a portal) inserted right under the SESSIONS header, found by the list's own `data-sessions-mode="flat"` container and its `data-session-pin-drop` / `data-session-unpin-drop` drop-target markers. While the group is shown, the IDE chats' rows in the date groups are hidden (their `[data-index]` wrapper in a virtualized list, or the row itself in a short one); the virtualizer re-measures a hidden wrapper to zero height, so no gap is left. Pinned state comes from the Pinned section's own rows, because the backend's pinned flag lags a pin or unpin until the next refresh. A `MutationObserver` re-runs the placement once per animation frame; a `disposed` flag stops a frame queued before a hot reload from putting the old instance's group back. If the anchors disappear in a Desktop update, the group is not shown and nothing is hidden: the badges and clicks keep working.

## Source map

| File | Responsibility |
|---|---|
| `src/plugin.tsx` | `register(ctx)`: decides the window role (main or IDE window), then registers that role's contributions, commands, keybinds and event subscriptions |
| `src/core.ts` | State (nanostores atoms) and actions: the IDE window (open request, claim, maximize, tiles, layout capture and restore, column fitting by seam drag), the IDE chat registry, backend calls, tab model, save and conflict logic, agent-edit review, per-session state, chat wiring, the frame bridge |
| `src/browser.ts` | The Browser column's logic: project detection, trust, dev-server start, stop and polling, the element picker and its source lookup |
| `src/sidebar.ts` | Main window: the sidebar IDE group (plain DOM), hiding the IDE chats' date-group rows, the new-IDE-chat flow |
| `src/ui.tsx` | Views: the Explorer, Editor and Browser tiles, Sidebar (Explorer, Search, Source Control), EditorPane, the layout toggles, the row badge, dialogs, status item (the IDE button in the main window), settings page, transcript card |
| `src/util.ts` | Pure helpers: paths, `@file` reference formatting, fuzzy ranking, tool-argument path extraction, the column plan, the layout model (`normalizeLayout`, `dockPlan`, `columnWidths`), all unit tested |
| `src/frame/editor.ts` | The editor document: CodeMirror setup, languages, theme from tokens, inline edit panel, context menu, the frame side of the protocol |
| `dev/build.mjs` | Bundles the frame to an IIFE, inlines it as the iframe `srcdoc`, bundles the plugin to one ESM file, and fails the build if any import other than the three allowed specifiers remains |
| `dashboard/plugin_api.py` | Backend routes |
| `__init__.py` | `ide_open` tool |

## Editor frame protocol

The frame is `<iframe sandbox="allow-scripts" srcdoc=…>`: an opaque origin with no access to the app, its storage or the preload bridge. Both sides check `event.source` before acting.

Plugin → frame:

| Message | Fields | Effect |
|---|---|---|
| `look` | `vars`, `dark`, `fontSize`, `wrap` | Apply theme tokens, color scheme, size, wrap |
| `font` | `family`, `weight`, `style`, `buffer` | Register the app's font bytes |
| `open` | `path`, `text`, `saved?`, `eol`, `line?`, `col?`, `original?`, `show?` | Create the file's state (once) and show it |
| `show` | `path`, `line?`, `col?` | Switch to a file, reveal a line |
| `close`, `rename` | `path` / `from`, `to` | Drop or rename a file's state |
| `replace` | `path`, `text`, `original?`, `markSaved?` | Load new disk text as an undoable change; optional review diff |
| `setDiff` | `path`, `original` or `null` | Turn the unified review diff on or off |
| `saved`, `saveRequest` | `path` | Mark clean / ask the frame to send its text for saving |
| `inlineEdit`, `find`, `focus` | | Open the Ctrl+K panel, open find, focus |

Frame → plugin: `ready`, `dirty {path, dirty}`, `draft {path, text}`, `save {path, text}`, `cursor {path, line, col, sel, lang, eol}`, `addToChat {path, from, to, empty}`, `inlineEdit {path, from, to, instruction}`, `diffResolved {path}`, `command {id}`.

The frame keeps one `EditorState` per open file, so undo history survives tab switches. The plugin keeps the authoritative tab list, saved text, mtimes and drafts, so a remounted frame is rebuilt from plugin state on `ready`.

## Backend API

All routes are `POST` with a JSON body under `/api/plugins/hermes-ide/`. Paths travel in the body, never the URL. All routes are plain `def`, so FastAPI runs them in its threadpool and a slow `git` or `rg` call never stalls the gateway event loop.

| Route | Body | Returns |
|---|---|---|
| `/health` | | version, `rg` and `git` availability, platform |
| `/fs/list` | `path`, `show_hidden` | entries (folders first), `truncated` past 5,000 |
| `/fs/read` | `path` | `text`, `mtime` (ns), `size`, `bom`, or `binary` / `too_large` (over 5 MB) |
| `/fs/stat` | `path` | `exists`, `dir`, `mtime`, canonical `path` |
| `/fs/write` | `path`, `text`, `expected_mtime?`, `bom?` | new `mtime`; `409` when the file changed since `expected_mtime` |
| `/fs/create` | `path`, `dir?` | `409` when it exists |
| `/fs/rename` | `from`, `to` | `409` when the target exists |
| `/fs/trash` | `path` | moves to the OS trash; `501` rather than a permanent delete |
| `/fs/files` | `root` | workspace file list for Quick Open (ripgrep, gitignore-aware; up to 50,000) |
| `/search` | `root`, `query`, `regex`, `case`, `glob` | matches with line and column (up to 2,000) |
| `/git/status` | `root` | repo root, branch, per-file status |
| `/git/head` | `path` | the file's text at `HEAD` |
| `/project/detect` | `root` | web UIs in the folder (id, framework, dir, command, package manager, whether dependencies are installed) and the servers already running there |
| `/devserver/start` | `root`, `id`, `install?` | starts the detected candidate `id` (installing dependencies first when asked or missing); returns its state; an already running server is returned as is |
| `/devserver/status` | `root` | the servers in the folder: state (`installing`, `starting`, `ready`, `exited`), URL, exit code, last 80 log lines. Each call renews their lease |
| `/devserver/stop` | `key` | stops the server and its child processes |

Writes are atomic (temp file in the same folder, then replace) and keep the file mode. Every path is resolved and checked against the Hermes credential files before use.

## Security model

- **Trust boundary.** The gateway's authentication. Desktop's main process attaches the native grant to `ctx.rest` calls; the plugin never sees credentials.
- **Reach.** The same files the agent can reach, minus Hermes credential files, which every route refuses.
- **No data loss by design.** No permanent deletes, no overwrite on create or rename, mtime-checked saves, drafts mirrored for crash recovery, conflicts surfaced instead of resolved silently.
- **Isolation.** The editor runs at an opaque origin with `allow-scripts` only. The plugin itself runs with full app authority, like every desktop plugin; the code is open for review.
- **Dev servers.** The command is never taken from the client: the backend derives it from the detected project's own files, and the Desktop asks the user once per project before the first run. Static sites bind `127.0.0.1`.
- **Agent half.** One tool, `ide_open`, which only emits an event naming an existing file or an http(s) URL.

## SDK gaps and the workarounds used

| Gap | Workaround | Upstream ask |
|---|---|---|
| No door opens or drives a Browser tab from a plugin; `preview.open` reaches a window only during that session's turn | The IDE's own Browser column: a `<webview>` it controls (navigation, DevTools, element picker) | `host.openPreview(target)` with navigation events |
| No door sizes a split | Drag the app's own sash with synthetic pointer events | `host.setPaneShare(paneId, fraction)` |
| No door adds a group to the session list | A plain-DOM group placed by the list's drop-target markers; badges through `SESSION_ROW_AREAS` | A `sidebar.sessionGroups` contribution area |
| A draft chat's folder is renderer state plugins cannot write | Apply the folder with `session.cwd.set` after the first reply | `host.setDraftWorkspace(cwd)` or a `newChat({ cwd })` option |
| Global `mod+…` chords fire inside every text input | Editor in a sandboxed frame | A keybind scope for focused plugin surfaces |

Each workaround is explained where it lives in the code, with the upgrade path.
