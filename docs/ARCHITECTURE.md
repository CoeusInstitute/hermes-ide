# Architecture

## Shape

```
Main Hermes Desktop window                 IDE window: the app's single-session pop-out, claimed by the plugin
┌──────────────────────────────────┐       ┌─────────────────────────────────────────────────────────────────────┐
│ Sessions (core)   │ Session chat │       │ tabs:  Editor ×             <chat tab>            Browser (app)      │
│ ─ PINNED          │ (core)       │ Ctrl+ ├──────────┬─────────────────────┬──────────────────┬────────────────┤
│   chat [IDE]◄badge│              │ Alt+I │ Explorer │ tabs, crumbs, review│ Session chat     │ the app's own  │
│ ─ SESSIONS        │              │ ────► │ Search   │ ┌─────────────────┐ │ (core, the same  │ Browser pane:  │
│   chat [IDE]      │              │       │ Source   │ │ iframe document │ │  session as the  │ the project's  │
│   Today …         │ status: IDE ▴│       │ Run ▶    │ │ CodeMirror 6    │ │  main window)    │ page, reached  │
└──────────────────────────────────┘       │ (panel)  │ └─────────────────┘ │  composer ◄──────┤ by ctx.preview │
   host.openSession(id, {intent:'window'}) └──────────┴─────────────────────┴──────────────────┴────────────────┘
   + localStorage open request                  │ ctx.rest                       ▲ plugin.hermes-ide.open
                                                ▼                                │ (path or url, session_id)
          Hermes gateway (agent machine): /api/plugins/hermes-ide/*  ·  agent half: ide_open tool
          fs, rg search, git, project UI detection, dev servers (npm/pnpm/yarn/bun, or the plugin's static server)
```

That is the catalog build. The full build gives the Explorer and the project UI columns of their own (the project UI as a Browser column with its own `<webview>`), and adds an IDE group to the main window's session list. Every column is an app tile, so its tab is a real drag handle: the arrangement above is only the default.

The plugin is one package with three halves:

| Half | Files | Loaded by |
|---|---|---|
| Desktop | `desktop/plugin.js` (built from `src/`) | The Desktop disk-plugin loader, after the package installer copies it to `$HERMES_HOME/desktop-plugins/hermes-ide/` |
| Backend | `dashboard/manifest.json`, `dashboard/plugin_api.py`, `dashboard/static_server.py` | The gateway web server, mounted at `/api/plugins/hermes-ide/` when the plugin is in `plugins.enabled` |
| Agent | `plugin.yaml`, `__init__.py` | The Hermes plugin loader; registers the `ide_open` tool in toolset `hermes-ide` |

## Two builds of one source

`dev/build.mjs --target=catalog|full` defines the constant `__CATALOG__`. Every feature that reads the app's own markup lives in `src/full/` and is reached only from `if (!__CATALOG__)` branches, so esbuild removes those branches, then tree-shakes the `src/full/` modules out of the catalog bundle. The catalog bundle is what `hermes plugins validate` checks; `grep` it for `data-tree`, `MutationObserver`, `hermesDesktop` or `webview` and only the single bridge call below remains.

| Need | Catalog build (SDK only) | Full build (`src/full/`) | SDK hook that would merge them |
|---|---|---|---|
| Explorer width | a panel inside the Editor tile, with the plugin's own splitter (`Workbench`) | its own tile, sized by `fitColumns` | a size hint for `host.openWorkspace` |
| Column sizing and memory | the app's split (it keeps your resizes for the window's life); open columns are remembered | `fitColumns` drags the app's sash; `readColumns` reads zones by geometry; arrangement and widths saved per chat | `host.setPaneShare(paneId, fraction)` plus a layout snapshot |
| Project UI page | the app's Browser pane: a `MessageTextContent` link the user clicks (the app's own link handling), scripts through `ctx.preview.executeJavaScript` with per-site consent | the plugin's own `<webview>` column | `ctx.preview.open(url)` |
| IDE chats in the session list | `SESSION_ROW_AREAS.leading` badge (a click on it opens the IDE) and the status-bar IDE chats menu | a plain-DOM group under SESSIONS, date-group rows hidden, row-body click | a `sidebar.sessionGroups` contribution area |
| Window size | one call to `window.hermesDesktop.windowControls.toggleMaximize` (the validator's only review warning) | the same | a window verb on `host` |
| Seam visibility | the app's seams | a stylesheet restyling `[data-sash-overlap]` in the IDE window | none needed |

## What is reused, mirrored and added

**Reused, never duplicated.** The session chat and its composer, the single-session pop-out window (`host.openSession` with `intent: 'window'`), the app's pane tree and its tab dragging for arranging columns, the app's Browser pane and its consent-gated script door (catalog), the terminal, the Review pane, the command palette, the theme system, the folder picker, file reference chips (`@file:`), session-row decoration slots, the app's link handling, and the agent's own file tools.

**Mirrored.** The IDE subscribes to Desktop state and follows it:

| Desktop state | SDK door | IDE behavior |
|---|---|---|
| The window's chat | `#/<storedId>` route of the pop-out, `host.state.focusedStoredSessionId` | Load that chat's tab set (`tabs:<storedId>`) and drafts (`drafts:<storedId>`) |
| Chat folder | `host.state.cwd`, `session.cwd.set` | Explorer root follows it; Open Folder moves the chat |
| Agent tool calls | `ctx.onEvent('tool.complete')` | Re-stat open files (read-only tools excepted); reload changed ones with an inline review diff |
| Turn end | `ctx.onEvent('message.complete')` | Apply a folder chosen while the chat was a draft |
| Theme, mode, accent, fonts | computed `--ui-*`, `--font-*` tokens, `$accentOverride`, `@font-face` rules | Re-sent to the editor after each repaint settles |
| Agent requests | `ctx.onEvent('plugin.hermes-ide.open')` | Open the file at the line (matched to the chat by any of its ids, compaction included) |
| Session list | `host.listPersistedSessions` | The IDE chats menu (and the full build's group): titles, ages, pins |
| Session list visibility | `host.paneVisibility('sessions')` | The IDE window hides the list with `view.toggleSidebar`, waiting for each toggle to land |

**Added.** The IDE window role (claiming a pop-out, maximizing it, hiding its session list, rebuilding its columns), the layout toggles, Explorer, Search, Source Control and (catalog) Run views, the editor, the project UI with its dev-server controls and element picker, Quick Open, the Open Folder dialog, the review and conflict banners, the row badge and IDE chats menu, the status item, commands, keybinds, the settings page with trusted projects, the transcript card, the backend routes and the `ide_open` tool.

## The IDE window

**Opening.** The main window writes `hermes-ide:open-window:<sid> = {sid, at, path?, line?, url?}` to localStorage (one key per chat, so two quick requests never overwrite each other) and calls `host.openSession(sid, {intent: 'window'})`, which resolves the chat's owner profile and opens (or re-fronts) the app's one pop-out per chat at `index.html?win=secondary…#/<sid>`. "Chat on screen" is `host.composer.getDraft(null) !== null`: the app answers only while a composer is showing.

**Claiming.** The plugin copy in that pop-out reads its chat's request at load. A request under a minute old is removed and `hermes-ide:window` is set in sessionStorage, so a reload stays an IDE window. A plain pop-out that already exists gets the request through a `storage` event and reloads itself as the IDE; a pop-out asking for itself converts directly, because a window never receives its own storage events.

**Boot.** Maximize once (the app opens pop-outs at 420 px), rebuild the columns, load the active tab, open a pending file or page at once, wait for the maximize to land and the size to settle, then hide the session list (a toggle in a still-narrow window toggles the overlay instead). The full build then fits its columns. The tile list is written only once boot is done, so a window closed mid-restore never saves a partial list.

**Columns.** Each column is a `host.openWorkspace` tile (`plugin-workspace:hermes-ide-<id>`), docked by `dockPlan()` in `util.ts`: the saved (or default) columns become docks chained outward from the chat, left of the chat each column docking left of its right neighbour, right of it right of its left neighbour, stacked tabs `center`. In the catalog build the Explorer and the project UI are not tiles (see the table above): `openTile('explorer')` shows the Explorer panel inside the Editor tile, and `openTile('browser')` shows the panel's Run view.

**Full-build sizing and memory.** `readColumns()` reads the window's top-row zones left to right and finds which column holds each IDE tile and the chat, by geometry. The arrangement is saved as `layout = {columns, widths}` every few seconds, on pointer release and on unload. `fitColumns()` sizes columns to saved fractions or `columnPlan(width)` (Explorer 14%, chat 30%, Browser 32%, clamped); a zone the IDE does not own (the app's Browser pane) shares the Browser plan; the editor takes the rest. The SDK has no door to size a split, so `dragSeam` drags the app's own sash with synthetic pointer events, aiming half a sash past the target (the seam moves by the pointer's travel from where it pressed) and measuring each seam from where its neighbour really ended up (the app clamps zones at their floors).

**Look.** Column tones use opaque theme surfaces in Cursor's order (Explorer `--ui-bg-sidebar`, chat `--ui-bg-chrome`, Editor `--ui-bg-elevated`); inputs use a 5% tint of `--ui-text-primary` because `--ui-bg-input` resolves near-white in dark mode. Every column's first bar is `--hi-bar` (35 px) and its second row `--hi-sub` (28 px).

## The editor

`src/frame/editor.ts` exports `mountEditor(win, send)`. The Editor tile renders an `<iframe>` whose `srcdoc` is plain markup from the build (styles, `#empty`, `#editor`, `#menu`; no script), and on every `load` (the app reloads an iframe when it re-parents a tile) the plugin mounts CodeMirror into that document from its own bundle (`new EditorView({ parent, root: doc })`). Keydown inside a child document never reaches the app's window-capture keybind dispatcher, which otherwise claims Ctrl+D/F/G/K/P and Ctrl+/ from any in-DOM editor. CodeMirror is realm-safe: it identifies nodes by `nodeType`, takes its window from the node's owner document, and style-mod mounts its rules into that document.

The two sides keep the message shapes of a postMessage bridge, but the transport is two functions: `send(msg)` (frame → plugin) and the returned `receive(msg)` (plugin → frame), each delivered on a microtask so a reply never re-enters the sender mid-loop.

Plugin → frame:

| Message | Fields | Effect |
|---|---|---|
| `look` | `vars`, `dark`, `fontSize`, `wrap` | Apply theme tokens, color scheme, size, wrap |
| `font` | `family`, `weight`, `style`, `buffer` | Register the app's font bytes (in the frame's own `FontFace`) |
| `open` | `path`, `text`, `saved?`, `eol`, `line?`, `col?`, `original?`, `show?` | Create the file's state (once; line endings normalized to the file's dominant one) and show it |
| `show` | `path`, `line?`, `col?` | Switch to a file, reveal a line |
| `close`, `rename` | `path` / `from`, `to` | Drop or rename a file's state (a rename keeps undo history and unsaved text) |
| `replace` | `path`, `text`, `original?`, `markSaved?` | Load new disk text as one undoable change covering only what differs, so the cursor and scroll stay put |
| `setDiff` | `path`, `original` or `null` | Turn the unified review diff on or off |
| `saved`, `saveRequest` | `path` | Mark clean / ask the frame to send its text for saving |
| `inlineEdit`, `find`, `focus` | | Open the Ctrl+K panel, open find, focus |

Frame → plugin: `ready`, `dirty {path, dirty}`, `draft {path, text}`, `save {path, text}`, `cursor {path, line, col, sel, lang, eol}`, `addToChat {path, from, to, empty}`, `inlineEdit {path, from, to, instruction}`, `diffResolved {path}`, `command {id}`.

The frame keeps one `EditorState` per open file, so undo history survives tab switches. The plugin keeps the authoritative tab list, saved text, mtimes and drafts (each draft with the mtime it was typed against), so a remounted frame is rebuilt from plugin state on `ready`, and a draft whose file changed on disk opens with a conflict banner instead of a save that would overwrite the agent's work.

## The project UI and dev servers

When the IDE's folder changes, `/project/detect` reports the web UIs in it. A candidate is a `package.json` script (`dev`, `start`, `serve`, `develop`, `preview`, `storybook`) that runs a known framework's own command, directly or through one `npm run` / `pnpm` / `yarn` / `bun run` hop; a dependency alone is not a UI, a meta-framework that runs another tool's command (Remix and SvelteKit run `vite`) counts only when it is a dependency, and Electron scripts are skipped. Each candidate carries the script text, which is part of its trust key.

A trusted project (`trustedProjects` in plugin storage: folder, command and script text) with installed dependencies starts at once when the setting allows; otherwise the trust prompt shows (catalog: a dot on the Run tab and a toast with **Show**, without taking the Explorer panel from the user's files). `/devserver/start` takes only a detected candidate id: the backend derives the command from the project's own files, spawns it in a new process group with a credential-free environment and `BROWSER=none`, reads its output for the URL (a line labelled `Local:` wins; the framework's usual port is the fallback after 25 s), and reports `ready` once that port accepts a TCP connection (IPv4 and IPv6). The IDE polls `/devserver/status` every 1.5 s, which doubles as a lease: a server nobody has asked about for 120 s is stopped with its process tree (`taskkill /T`, or the process group), so closing the IDE window stops its dev server while a reload keeps it. A stop that lands mid-start kills the just-spawned process; the lease clock restarts after the machine sleeps; gateway exit stops every server.

A static site runs on `dashboard/static_server.py`: `127.0.0.1`, no dotfiles or dot folders (percent-encoded ones included), no folder listings, and only a `localhost` / `127.0.0.1` / `::1` Host header (no DNS rebinding).

The element picker is one self-contained script: it highlights the element under the pointer, swallows the click and resolves with the element's selector, size, text, markup and key computed styles. The catalog build runs it with `ctx.preview.executeJavaScript` in the app's Browser pane (the app asks the user once per origin and guards the origin in the page); the full build runs it in its own `<webview>`. Esc, the button again, or two minutes end a pick. The plugin then searches the project (id, then visible text, then the most specific class) for up to three source lines and inserts the description into the chat composer, with the lines as `@file:` references.

## Backend API

All routes are `POST` with a JSON body under `/api/plugins/hermes-ide/`. Paths travel in the body, never the URL. All routes are plain `def`, so FastAPI runs them in its threadpool and a slow `git` or `rg` call never stalls the gateway event loop. OS refusals and timeouts come back as readable `4xx`/`504` errors.

| Route | Body | Returns |
|---|---|---|
| `/health` | | version, `rg` and `git` availability, platform |
| `/fs/list` | `path`, `show_hidden` | entries (folders first, sorted before the 5,000 cap), `truncated` |
| `/fs/read` | `path` | `text`, `mtime` (ns), `size`, `bom`, or `binary` / `too_large` (over 5 MB); regular files only |
| `/fs/stat` | `path` | `exists`, `dir`, `mtime`, canonical `path` |
| `/fs/write` | `path`, `text`, `expected_mtime?`, `bom?` | new `mtime`; `409 conflict` when the file changed since `expected_mtime`, `409 deleted` when it is gone |
| `/fs/create` | `path`, `dir?` | `409` when it exists |
| `/fs/rename` | `from`, `to` | `409` when the target exists (a case-only rename is allowed); acts on a symlink itself |
| `/fs/trash` | `path` | moves to the OS trash; `501` rather than a permanent delete; acts on a symlink itself |
| `/fs/files` | `root` | workspace file list for Quick Open (ripgrep, gitignore-aware; up to 50,000) |
| `/search` | `root`, `query`, `regex`, `case`, `glob` | matches with line and character column (up to 2,000); `400` for a bad regex |
| `/git/status` | `root` | repo root, branch, per-file status |
| `/git/head` | `path` | the file's text at `HEAD` |
| `/project/detect` | `root` | web UIs in the folder (id, framework, dir, command, script text, package manager, installed) and the servers already running there |
| `/devserver/start` | `root`, `id`, `install?` | starts the detected candidate; an already running server is returned as is |
| `/devserver/status` | `root` | servers in the folder: state, URL, exit code, last 80 log lines; renews their lease |
| `/devserver/stop` | `key` | stops the server and its child processes |

Writes are atomic (a temp file in the same folder, then replace) and keep the file mode.

## Security model

- **Trust boundary.** The gateway's authentication. Desktop's main process attaches the native grant to `ctx.rest` calls; the plugin never sees credentials.
- **Reach.** The same files the agent can reach, minus Hermes credential files. `_canon()` gives every path one spelling (no `\\?\` or `\\.\` prefix, symlinks resolved, forward slashes, lower case on Windows and macOS); `_is_secret()` checks it against every Hermes root (the active home, the default root, `HERMES_HOME`, `~/.hermes`, `%LOCALAPPDATA%\hermes`) and every profile under them, at the home's top level (`.env*`, `auth.*`, token, secret, OAuth, credential and password files, `honcho.json`, key files) and in `mcp-tokens/`, `secrets/` and `credentials/`. Listings, Quick Open and search drop those paths too. The roots fall back to the defaults, so an import failure never fails open.
- **No data loss.** No permanent deletes (Windows asks before nuking what it cannot recycle), no overwrite on create or rename, mtime-checked saves, deleted-file saves refused, drafts mirrored with their base version, conflicts surfaced instead of resolved silently, renames carry unsaved tabs.
- **Dev servers.** The command is never taken from the client. Trust is per folder and script. Children get no credentials from the gateway's environment. Static sites bind `127.0.0.1` behind a dotfile and Host check.
- **Desktop surface.** The catalog build uses the SDK only, plus the one maximize call. Page scripts go through `ctx.preview` (declared capability, per-origin consent). The plugin runs with the app's authority, like every desktop plugin; the code is open for review.
- **Agent half.** One tool, `ide_open`, which only emits an event naming an existing local file (network paths are refused) or an http(s) URL.

## Source map

| File | Responsibility |
|---|---|
| `src/plugin.tsx` | `register(ctx)`: decides the window role, registers that role's contributions, commands, keybinds and subscriptions; declares `capabilities: ['preview.executeJavaScript']` |
| `src/core.ts` | State and actions: the IDE window (open request, claim, maximize, tiles, restore), the IDE chat registry, backend calls, tabs, saves, conflicts, drafts, agent-edit review, renames, per-session state, the frame bridge |
| `src/browser.ts` | The project UI: detection, trust, dev-server start, stop and polling, the element picker (webview or `ctx.preview`), page reload |
| `src/ide-chats.ts` | IDE chat rows from the session list, the new-IDE-chat flow (both builds) |
| `src/ui.tsx` | Views: tiles, the catalog `Workbench` and Run view, Sidebar, EditorPane, the project UI parts, toggles, row badge, IDE chats menu, dialogs, status item, settings page, transcript card |
| `src/util.ts` | Pure helpers: paths, `@file` references, fuzzy ranking, tool-argument paths, line endings, the column plan and layout model, address parsing, all unit tested |
| `src/frame/editor.ts` | The editor: CodeMirror setup, languages, theme from tokens, inline edit panel, context menu, `mountEditor` |
| `src/full/*` | Full build only: `layout.ts` (column fitting and memory, seam style), `sidebar.ts` (the session-list group), `browser-tile.tsx` (the Browser column), `row-click.ts` (row-body click) |
| `src/env.d.ts` | `__CATALOG__` and the `virtual:frame-html` module, for editors |
| `dev/build.mjs` | Bundles the plugin to one ESM file per target and fails the build if any import other than `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` remains (from esbuild's metafile) |
| `dashboard/plugin_api.py` | Backend routes |
| `dashboard/static_server.py` | The static-site server |
| `__init__.py` | `ide_open` tool |
