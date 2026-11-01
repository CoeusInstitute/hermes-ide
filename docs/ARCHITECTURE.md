# Architecture

## Shape

```
Hermes Desktop window (renderer)                                     Hermes gateway (agent machine)
┌──────────────────────────────────────────────────────────────┐     ┌───────────────────────────────┐
│ Sessions │ Explorer pane     │ Editor tile        │ Session   │     │ /api/plugins/hermes-ide/*     │
│ (core)   │ (plugin)          │ (plugin)           │ chat      │     │  dashboard/plugin_api.py      │
│          │  Explorer         │  tabs, breadcrumbs │ (core,    │◄───►│  fs list/read/stat/write      │
│          │  Search           │  review banner     │  reused)  │rest │  create/rename/trash          │
│          │  Source Control   │ ┌────────────────┐ │           │     │  files (rg), search (rg)      │
│          │                   │ │ sandboxed      │ │ composer ◄┼─┐   │  git status, git HEAD text    │
│          │                   │ │ srcdoc iframe: │ │           │ │   ├───────────────────────────────┤
│          │                   │ │ CodeMirror 6   │ │           │ │   │ agent half: ide_open tool ────┼─┐
│          │                   │ └───────▲────────┘ │           │ │   └───────────────────────────────┘ │
│          │                   │   postMessage      │  Browser  │ │       plugin.hermes-ide.open event  │
│ Terminal (core) · Review (core) · Browser + Annotate (core)    │ │◄──────────────────────────────────────┘
└────────────────────────────────────────────────────────────────┘ │
            host.composer.insertText / submit ─────────────────────┘
```

The plugin is one package with three halves:

| Half | Files | Loaded by |
|---|---|---|
| Desktop | `desktop/plugin.js` (built from `src/`) | The Desktop disk-plugin loader, after the package installer copies it to `$HERMES_HOME/desktop-plugins/hermes-ide/` |
| Backend | `dashboard/manifest.json`, `dashboard/plugin_api.py` | The gateway web server, mounted at `/api/plugins/hermes-ide/` when the plugin is in `plugins.enabled` |
| Agent | `plugin.yaml`, `__init__.py` | The Hermes plugin loader; registers the `ide_open` tool in toolset `hermes-ide` |

## What is reused, mirrored and added

**Reused, never duplicated.** The session chat and its composer, the Sessions sidebar, the terminal, the Review pane, the Browser with Annotate, the command palette, the theme system, the folder picker, file reference chips (`@file:`), and the agent's own file tools.

**Mirrored.** The IDE subscribes to Desktop state and follows it:

| Desktop state | SDK door | IDE behavior |
|---|---|---|
| Focused chat | `host.state.focusedStoredSessionId` | Swap to that chat's tab set (`tabs:<storedId>` in plugin storage); keep dirty tabs open |
| Chat folder | `host.state.cwd`, `session.cwd.set` | Explorer root follows it; Open Folder moves the chat |
| Agent tool calls | `ctx.onEvent('tool.complete')` | Re-stat open files; reload changed ones with an inline review diff |
| Turn end | `ctx.onEvent('message.complete')` | Apply a folder chosen while the chat was a draft |
| Theme, mode, accent, fonts | computed `--ui-*`, `--font-*` tokens, `$accentOverride`, `@font-face` rules | Re-sent to the editor frame after each repaint settles |
| Agent requests | `ctx.onEvent('plugin.hermes-ide.open')` | Open the file at the line |

**Added.** Explorer, Search and Source Control views, the editor, Quick Open, the Open Folder dialog, the review and conflict banners, the status item, commands, keybinds, the settings page, the transcript card, the backend routes and the `ide_open` tool.

## Source map

| File | Responsibility |
|---|---|
| `src/plugin.tsx` | `register(ctx)`: contributions, commands, keybinds, settings page, event subscriptions |
| `src/core.ts` | State (nanostores atoms) and actions: backend calls, tab model, save and conflict logic, agent-edit review, per-session state, chat wiring, the frame bridge |
| `src/ui.tsx` | Views: Sidebar (Explorer, Search, Source Control), EditorPane, dialogs, status item, settings page, transcript card |
| `src/util.ts` | Pure helpers: paths, `@file` reference formatting, fuzzy ranking, tool-argument path extraction (unit tested) |
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
