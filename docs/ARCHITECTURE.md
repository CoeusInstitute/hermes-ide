# Architecture

## Shape

```
Main Hermes Desktop window                    IDE window: the app's single-session pop-out, claimed by the plugin
┌───────────────────────────────────┐         ┌───────────────────────────────────────────────────────────────────────┐
│ Sessions │ Session chat (core)    │ Ctrl+   │ IDE tile (plugin)                        │ Session chat  │ Preview +     │
│ (core)   │                        │ Alt+I   │ ┌──────────┬──────────────────────────┐  │ (core, the    │ Annotate      │
│          │                        │ ──────► │ │ Explorer │ tabs, breadcrumbs, review│  │  same session │ (core, docked │
│          │                        │ IDE     │ │ Search   │ ┌──────────────────────┐ │  │  as the main  │  by the app)  │
│          │                        │ button  │ │ Source   │ │ sandboxed srcdoc     │ │  │  window)      │               │
│          │ status bar: [IDE]      │         │ │ Control  │ │ iframe: CodeMirror 6 │ │  │  composer ◄───┼─ Ctrl+L,      │
└───────────────────────────────────┘         │ │          │ └──────────▲───────────┘ │  │               │  Ctrl+K       │
   window.hermesDesktop.openSessionWindow     │ └──────────┴────postMessage──────────┘  │               │               │
   + localStorage open request                └───────────────────────────────────────────────────────────────────────┘
                                                        │ ctx.rest                                 ▲ plugin.hermes-ide.open
                                                        ▼                                          │ (carries session_id)
                                    Hermes gateway (agent machine): /api/plugins/hermes-ide/*  ·  agent half: ide_open tool
                                    fs list/read/stat/write, create/rename/trash, rg files/search, git status/HEAD text
```

The plugin is one package with three halves:

| Half | Files | Loaded by |
|---|---|---|
| Desktop | `desktop/plugin.js` (built from `src/`) | The Desktop disk-plugin loader, after the package installer copies it to `$HERMES_HOME/desktop-plugins/hermes-ide/` |
| Backend | `dashboard/manifest.json`, `dashboard/plugin_api.py` | The gateway web server, mounted at `/api/plugins/hermes-ide/` when the plugin is in `plugins.enabled` |
| Agent | `plugin.yaml`, `__init__.py` | The Hermes plugin loader; registers the `ide_open` tool in toolset `hermes-ide` |

## What is reused, mirrored and added

**Reused, never duplicated.** The session chat and its composer, the single-session pop-out window, the terminal, the Review pane, the Browser with Annotate, the command palette, the theme system, the folder picker, file reference chips (`@file:`), and the agent's own file tools.

**Mirrored.** The IDE subscribes to Desktop state and follows it:

| Desktop state | SDK door | IDE behavior |
|---|---|---|
| The window's chat | `#/<storedId>` route of the pop-out, `host.state.focusedStoredSessionId` | Load that chat's tab set (`tabs:<storedId>` in plugin storage); an IDE window never switches chats |
| Chat folder | `host.state.cwd`, `session.cwd.set` | Explorer root follows it; Open Folder moves the chat |
| Agent tool calls | `ctx.onEvent('tool.complete')` | Re-stat open files; reload changed ones with an inline review diff |
| Turn end | `ctx.onEvent('message.complete')` | Apply a folder chosen while the chat was a draft |
| Theme, mode, accent, fonts | computed `--ui-*`, `--font-*` tokens, `$accentOverride`, `@font-face` rules | Re-sent to the editor frame after each repaint settles |
| Agent requests | `ctx.onEvent('plugin.hermes-ide.open')` | Open the file at the line |

**Added.** The IDE window role (claiming a pop-out, maximizing it, hiding its session list, sizing its columns), Explorer, Search and Source Control views, the editor, Quick Open, the Open Folder dialog, the review and conflict banners, the status item, commands, keybinds, the settings page, the transcript card, the backend routes and the `ide_open` tool.

## The IDE window

Opening: the main window writes `hermes-ide:open-window = {sid, at, path?, line?}` to localStorage and calls `window.hermesDesktop.openSessionWindow(sid, {profile, connectionId})`, the same door the app's "Open in new window" uses. The app opens (or re-fronts) one pop-out per chat, at `index.html?win=secondary…#/<sid>`.

Claiming: the plugin copy in that pop-out reads the request at load. If the request names its chat and is under a minute old, it removes the request and sets `hermes-ide:window` in sessionStorage, so a reload of that window stays an IDE window. A plain pop-out that already exists gets the request through a `storage` event and reloads itself as the IDE. A plain pop-out asking for itself (its own IDE button) converts directly, because a window never receives its own storage events.

Layout: the window maximizes once (`windowControls.toggleMaximize`), opens the IDE tile with `host.openWorkspace` docked left of the chat, hides the app's session list with `view.toggleSidebar` (pop-out layout state is memory-only, so the main window's sidebar is untouched), and sizes the columns from `columnPlan(width)` in `util.ts`. The SDK has no door to size a split, so `dragSeam` drags the app's own sash with synthetic pointer events; `tree-split.tsx` accepts them, clamps every zone to its floor and commits once on release. A preview docked right of the chat is fitted once per zone to about a third of the window, taking or giving space from the editor; a closed preview hands its space back to the editor. A `MutationObserver` triggers that fit only when the number of layout zones changes, so a streaming chat costs one `querySelectorAll` per mutation batch.

## Source map

| File | Responsibility |
|---|---|
| `src/plugin.tsx` | `register(ctx)`: decides the window role (main or IDE window), then registers that role's contributions, commands, keybinds and event subscriptions |
| `src/core.ts` | State (nanostores atoms) and actions: the IDE window (open request, claim, maximize, column fitting by seam drag, preview fitting), backend calls, tab model, save and conflict logic, agent-edit review, per-session state, chat wiring, the frame bridge |
| `src/ui.tsx` | Views: IdeLayout (Explorer and Editor with their own seam, plus the dialogs), Sidebar (Explorer, Search, Source Control), EditorPane, status item (the IDE button in the main window), settings page, transcript card |
| `src/util.ts` | Pure helpers: paths, `@file` reference formatting, fuzzy ranking, tool-argument path extraction, the column plan (unit tested) |
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

Writes are atomic (temp file in the same folder, then replace) and keep the file mode. Every path is resolved and checked against the Hermes credential files before use.

## Security model

- **Trust boundary.** The gateway's authentication. Desktop's main process attaches the native grant to `ctx.rest` calls; the plugin never sees credentials.
- **Reach.** The same files the agent can reach, minus Hermes credential files, which every route refuses.
- **No data loss by design.** No permanent deletes, no overwrite on create or rename, mtime-checked saves, drafts mirrored for crash recovery, conflicts surfaced instead of resolved silently.
- **Isolation.** The editor runs at an opaque origin with `allow-scripts` only. The plugin itself runs with full app authority, like every desktop plugin; the code is open for review.
- **Agent half.** One tool, `ide_open`, which only emits an event naming an existing file.

## SDK gaps and the workarounds used

| Gap | Workaround in v0.1 | Upstream ask |
|---|---|---|
| No door opens a Browser tab from a plugin; `preview.open` reaches a window only during that session's turn | Render the app's own preview card (`MessageTextContent` with `MEDIA:`); the user's click opens it | `host.openPreview(target)` |
| A draft chat's folder is renderer state plugins cannot write | Apply the folder with `session.cwd.set` after the first reply | `host.setDraftWorkspace(cwd)` or a `newChat({ cwd })` option |
| Global `mod+…` chords fire inside every text input | Editor in a sandboxed frame | A keybind scope for focused plugin surfaces |

Each workaround is explained where it lives in the code, with the upgrade path.
