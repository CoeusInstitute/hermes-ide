# Feature map and gates

Every feature is listed with its Cursor counterpart, how it is wired into Hermes Desktop (reused, mirrored, or added), and how it is verified. Gate 0 is what v0.1 ships; each later gate has acceptance tests that must pass before it is called done.

Wiring legend:

- **Reuse**: the Desktop's own surface, used as is. The IDE only arranges it or calls it.
- **Mirror**: the IDE follows Desktop state (session, folder, theme) and stays in sync with it.
- **Add**: built by the plugin because Desktop has no equivalent.

## Gate 0.4: catalog-ready, reviewed, hardened (shipped in v0.4, verified in a sandboxed Desktop, 2026-11-02)

v0.4 splits one source into a catalog build (Desktop plugin SDK only) and a full build (`src/full/`), and fixes what a fresh-eyes review of v0.3 found. Evidence is from a sandboxed packaged Desktop at 3840 px driven over CDP with real pointer and keyboard input, `hermes plugins validate`, and the test suites (JS 13, Python 19).

| Feature | Wiring | Verified |
|---|---|---|
| The catalog build passes the catalog's admission checks | `__CATALOG__` build constant; markup-reaching code only in `src/full/`, tree-shaken from the catalog bundle | `hermes plugins validate`: **Validation passed**, desktop surface "stays inside the plugin SDK surface"; v0.3 failed with four refusals |
| Editor without an inline script | `mountEditor(win, send)` mounts CodeMirror from the plugin bundle into a script-free `srcdoc` document | Typing marks the tab dirty, Ctrl+S writes the file, Ctrl+P inside the editor opens Quick Open; the iframe has no `sandbox` attribute and no `<script>` |
| The IDE window opens through the SDK | `host.openSession(id, {intent: 'window'})`; "chat on screen" from `host.composer.getDraft(null)` | The IDE button opened the claimed pop-out; it maximized to 3840 |
| The session list hides through the SDK | `host.paneVisibility('sessions')` plus `view.toggleSidebar`, waiting for each toggle | `paneVisibility('sessions')` false after boot |
| Catalog: Explorer as a panel with its own width | `Workbench`: Explorer panel, the plugin's own splitter, the editor; both stay mounted | Explorer 300 px, editor the rest of its column, at 3840 |
| Catalog: project UI as a Run view, the page in the app's Browser | Run view in the Explorer panel; a `MessageTextContent` link the user clicks | Static site found, trust prompt, **Run once**, `running`; a real click on the link opened `http://localhost:<port>/` in the app's Browser pane |
| Catalog: element picker through `ctx.preview` | `capabilities: ['preview.executeJavaScript']`; the app's per-origin consent | The app asked "Let Hermes IDE run scripts on this page? … http://localhost:56852"; after **Allow on this site** a real click on the page's button put its selector, size, text, markup, styles and `likely source: index.html:1` in the composer |
| Catalog: IDE chats without the session-list group | Clickable `SESSION_ROW_AREAS` badge; status-bar IDE chats menu (SDK `Popover`) | Badge `role=button` on the chat's row; the menu listed "IDE CHATS · 1", the chat, **Open this chat in the IDE**, **New IDE chat** |
| Credential files refused under every spelling and profile | `_canon` + `_is_secret` over every Hermes root and profile; listings and search filtered | pytest: `\\?\`, `//?/`, upper case, `.env.bak-*`, `google_token.json`, `honcho.json`, `.gmail-app-password`, `mcp-tokens/`, a profile's `.env`: 403 on read and write; search and Quick Open from the home and a folder above it return none; `hermes-agent/agent/oauth.py` still opens |
| Dev servers get no credentials | `_child_env()` drops `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `HERMES_*` (registry tokens kept) | pytest |
| A static site does not leak dotfiles | `static_server.py` | Live: `/` 200, `/.env` 404, `/%2eenv` 404, `/.git/config` 404, a folder listing 404, `Host: evil.example` 403 |
| Trust follows the script | Trust key = folder + command + script text; the Run pill no longer grants trust; Settings lists and revokes | Code review; the banner asks again for a changed script |
| Rename keeps unsaved edits | `movedOnDisk` re-keys tabs, meta, banners and drafts and sends the frame `rename` | Renamed a dirty `index.html` to `page.html` in the Explorer: the tab followed, still dirty, the text kept; Ctrl+S wrote `page.html` and did not recreate `index.html` |
| A restored tab whose file is gone closes itself | `openFile` on a 404 for an existing tab | The stale `page.html` tab closed with an info note instead of an error on every open |
| Saving a deleted file asks first | `409 deleted`; a second save writes it back on purpose | pytest |
| Draft typed against an older file version | Draft keeps its base mtime; a mismatch opens a conflict banner and keeps the base for the save check | Code review |
| Full build: a foreign zone no longer squeezes the columns | `columnWidths` plans a zone the IDE does not own like the Browser column, sharing its room | With the app's Browser pane restored at half the screen: Explorer 340, Editor 1510, Browser 615, chat 845, app pane 530 |
| Full build: the sidebar group still works on the shared data layer | `ide-chats.ts` rows; group hides only rows it lists | Date-grouped list: group mounted, one row, its date-group row hidden |
| Detection without false positives | The script must run the framework's command (one `npm run` hop allowed); meta-frameworks need the dependency; Electron scripts skipped | pytest: vite-only-for-vitest and a nodemon dev script are not UIs; `npm run web` → `vite --port 4000` is |
| Mixed line endings | Dominant line ending; the editor normalizes to it | Unit test |
| No dead Terminal toggle | The SDK allows no terminal action; the toggle is gone, the editor's Ctrl+J explains the app's own key | Toggles: Explorer, Editor, Project UI |

## Gate 0.3: columns you arrange, the project's UI, IDE chats in the sidebar (shipped in v0.3, verified in a sandboxed Desktop, 2026-11-02)

Evidence is from a sandboxed packaged Desktop at 3840 px driven over CDP with real pointer and keyboard input, against a real Vite project whose dependencies were not installed at the start.

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| Columns are separate tiles you drag into any arrangement | Drag views between editor groups and side bars | Add: Explorer, Editor and Browser as three `host.openWorkspace` tiles; Reuse the app's tab drag (FancyZones) to move them | A real pointer drag of the Editor tab onto the chat zone's right edge moved it there: order `[explorer, chat, editor]` |
| The arrangement is remembered | Layout restore | Add: `readColumns` by geometry, `layout` in plugin storage, `dockPlan` rebuilds it as chained docks on open | Closed the IDE window, reopened it from the sidebar: `[explorer, browser, chat, editor]` came back with the same widths; after the half-sash correction the Explorer stayed 396 px across reloads (it had shrunk 4 px per open before) |
| Column widths on open | Cursor's proportions | Add `columnPlan` targets, saved fractions win; seams moved from the measured neighbour | Reset gave Explorer 340, Editor 1426, Browser 1229, chat 845 (the app's floor) at 3840 |
| Show or hide each column | Toggle Primary Side Bar, Panel, Secondary Side Bar | Add four toggles in the titlebar's right cluster (Explorer, Editor, Browser, Terminal) and palette commands | A real click on the Browser toggle opened the column left of the chat at 1229 px |
| Reset the layout | View → Reset Layout | Add **IDE: Reset Column Layout**: clear the saved layout, reload through the restore path | Run from the palette with real keys: the default four columns came back |
| Header rows line up across columns | One header height | Add `--hi-bar` (35 px) and `--hi-sub` (28 px) for every column's first two rows | Explorer, Editor, Browser bars all top 34 / height 35; second rows 69 / 28 |
| Empty editor shows a compact, clickable shortcut list | Editor watermark | Add: one table block (it used to be a grid that spread each word over the column) | Block 186 px tall, centred; clicking **Go to File** opened Quick Open |
| Find the project's web UI | n/a (Cursor runs tasks you configure) | Add backend `/project/detect`: package.json dev scripts for 16 frameworks (root, one level down, `apps/*`, `packages/*`), lockfile picks the package manager, else a static `index.html` | Detected the Vite demo; pytest covers Vite, pnpm, a Next.js monorepo app beside an API and an Electron shell, a static site, and a home folder that must not be scanned |
| Ask once before running a project's code | Workspace Trust | Add a trust banner (**Always run for this project**, **Run once**, **Not now**); `trustedProjects` in plugin storage | The banner appeared for the untrusted demo; after **Always**, reopening started it with no prompt |
| Install and run | n/a | Add `/devserver/start` with `install`: the backend runs `<pm> install`, then the dev script | `installing` → `running` within 9 s; page loaded |
| Start the UI when the IDE opens | n/a | Add: trusted, installed project and the setting on → start on folder change | Reopened the IDE: `running` and the page loaded within 3 s |
| URL from the dev server's own output | n/a | Add: a `Local:` line wins; the framework's usual port is the fallback | Webview at `http://localhost:5173/`; pytest: a proxy URL printed first loses to the `Local:` line |
| Stop, restart, live log; no orphans | Terminal tasks | Add process-tree kill, a 120 s lease renewed by the column's polling, stop all on gateway exit | **Stop**: state `stopped` and nothing listening on 5173; a reload re-attached to the running server; pytest checks npm's child node process dies too |
| Browser column | Cursor's built-in browser | Add an Electron `<webview>` (pop-outs allow it) with address bar, back, forward, reload, DevTools, open externally | Showed the demo page; inputs use a theme tint (the app's `--ui-bg-input` is near-white in dark mode and was fixed after measuring rgb(252,252,252)) |
| Pick an element and send it to the chat with its likely source | Select element | Add a picker script run in the page; search the project for the element's id, text or class; insert a block into the composer | Clicked the demo button with a real pointer: the composer got its selector, 83×31 size, text, markup, styles and `@file:index.html:3` |
| The agent opens a page | n/a | Add `url` to `ide_open` | A real turn called `ide_open` with a URL; the Browser column navigated to it |
| IDE chats get their own sidebar group | Agents list | Add a plain-DOM group under SESSIONS (no SDK door for list groups), hide those chats from the date groups | Group listed the chat with model, message count and age; its date-group row was hidden; one group after hot reloads (a queued frame used to re-add old copies) |
| Clicking an IDE chat opens the IDE | n/a | Add: `SESSION_ROW_AREAS.leading` badge with a capture-phase click on the row body; group rows open the window directly | With the IDE window closed, a real click on the pinned row opened it with the saved layout |
| Pinned IDE chats are marked | n/a | Add an `IDE` badge in the accent colour | Badge shown in Pinned; the group dropped the chat at once and took it back on unpin |
| New IDE chat | New agent | Add **+** on the group: a new chat that opens in the IDE after its first message | Sent the first message: its IDE window opened and the group listed two chats, newest first |
| Remove from IDE chats | n/a | Add **×** on a group row | The chat went back to the normal list, no badge, nothing hidden |

## Gate 0: shipped in v0.1, reworked in v0.2 to a pop-out IDE window (verified in a sandboxed Desktop, 2026-11-01)

### Layout and shell

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| IDE window: one chat in its own OS window | Cursor's own app window | Reuse the app's single-session pop-out (`window.hermesDesktop.openSessionWindow`); Add the claim (localStorage request, sessionStorage mark), maximize, and the IDE tile (`host.openWorkspace`, docked left of the chat) | v0.2: the status-bar IDE button opened a pop-out that maximized to 3840 px with Explorer, Editor and the chat; the main window kept its own layout (sandbox, 2026-11-01) |
| Column sizing on open | Cursor's three-column agent layout | Add `columnPlan` (Explorer 14% clamped 220 to 340 px, chat 30% clamped 380 to 760 px, preview 32% clamped 520 to 1280 px) applied by dragging the app's own seams | v0.2 at 3840 px: Explorer 340, chat 845 (the app's chat floor), preview 1233; closing the preview returned its space to the editor; reload kept the plan |
| Column separation | Cursor's tone steps and 1px dividers | Add: theme surfaces in Cursor's order (sidebar, chrome, elevated) and a neutral divider from the theme base colour; app seams restyled in the IDE window only | v0.2.1 pixel readout: Explorer rgb(1,4,9), chat rgb(13,16,20), editor rgb(22,24,28), crisp 1px dividers rgb(43,46,51) and rgb(53,56,60); steps larger than Cursor's measured rgb(20)/rgb(24) with rgb(36 to 39) dividers |
| Single session only | One agent chat per window | Reuse the pop-out (no global session strip); Add: hide its session list (`view.toggleSidebar`, memory-only in pop-outs) | v0.2: no session list, one chat tab; the main window's sidebar unchanged |
| Session chat | Agent chat (Composer) | Reuse. The IDE renders no chat | The chat in the IDE window is the Desktop session (Ctrl+L chip went to it; the agent answered about the referenced line) |
| The chat on screen, not a background one | n/a | Add: open the focused chat only while a chat composer is on screen; the agent's `ide_open` names its own session | v0.2.2 sandbox: IDE clicked on Capabilities showed "Open the chat you want in the IDE" and opened no window (v0.2.1 opened the first pinned chat). v0.2.2's route-equals-focused test refused a compacted chat on the live app (the route keeps an earlier stored id), so v0.2.3 tests for a visible composer instead |
| Plain pop-out of the same chat | n/a | Add: a storage-event listener converts it to the IDE instead of a second window | v0.2: plain 420 px pop-out became the IDE on the IDE click; still one pop-out |
| Command palette entries | Ctrl+Shift+P | Add `IDE: …` rows to the Desktop palette; Ctrl+Shift+P and F1 inside the editor open the Desktop palette | Palette opened from the editor |
| Rebindable shortcuts | Keybindings | Add `KEYBINDS_AREA` entries with defaults that avoid the app's chords. Main window: only Ctrl+Alt+I (open the IDE window). IDE window: the full set | Ctrl+Alt+I, Ctrl+Alt+P work |
| Status bar: line, column, selection, EOL, language; IDE button in the main window | Status bar | Add a status item | `Ln 1, Col 1 · CRLF · TypeScript` |
| Settings page | Settings | Add under Settings → Plugins (follow folder, review edits, hidden files, wrap, font size) | Page registered |
| Theme and font parity | Themes | Mirror: the editor reads the app's resolved `--ui-*` tokens and `--font-*`, and loads the app's JetBrains Mono bytes; re-reads after every skin, mode or accent change | Switched the app dark → light → dark: the editor followed both ways within 2.5 s; the frame reported JetBrains Mono 400, 700 and italic loaded |

### Files and editing

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| Explorer tree with lazy folders, git colors, active-file highlight | Explorer | Add; backend `/fs/list`, `/git/status` | Tree listed `.git, src, index.html, README.md` with `M` badges |
| New file, new folder, rename, move to trash, copy path, copy relative path, reveal in file manager | Explorer menu | Add; backend `/fs/create`, `/fs/rename`, `/fs/trash`; `ctx.os` | Create/rename never overwrite; trash refuses rather than unlink (tests) |
| Open folder | File → Open Folder | Add a dialog with the app's folder picker (`ctx.files.requestFolder`) and a path field; Mirror: also moves the chat (`session.cwd.set`) | State DB showed the session's `cwd` moved to the folder in 251 ms |
| Follow the chat's folder | Workspace per window | Mirror `host.state.cwd`; per-session pinned folder in plugin storage | Title switched from `· pinned` to following after the move |
| Tabbed editor, preview tabs, dirty dots, middle-click close, close others | Editor tabs | Add | A single click opened `index.html` as a preview tab; the next single click replaced it with `notes.txt` |
| Breadcrumbs | Breadcrumbs | Add | `src › app.ts` |
| CodeMirror 6 editor: highlighting for 25+ languages, folding, brackets, multi-cursor, find and replace, go to line, word completion | Monaco | Add, inside a sandboxed frame that owns its keyboard | Ctrl+F, Ctrl+G, Ctrl+D, Ctrl+/ handled by the editor, not the app |
| Save with conflict detection; CRLF and BOM preserved | Save | Add; backend `/fs/write` with `expected_mtime`, atomic replace | CRLF file saved as CRLF (byte dump); stale save refused with 409 (test) |
| Unsaved edits survive a frame remount and an app restart | Hot exit | Add; drafts mirrored to plugin storage | After a full window reload the README tab came back dirty with the unsaved text |
| Quick Open with fuzzy ranking and `:line` | Ctrl+P | Add; backend `/fs/files` (ripgrep, gitignore-aware) | Ctrl+P → `readme` → Enter opened README.md |
| Search in files with case and regex toggles and a glob filter | Ctrl+Shift+F | Add; backend `/search` (ripgrep JSON, Python fallback) | Found `greet` in `src/app.ts`, click opened it at the line |
| Source Control list with branch and per-file status; open a diff against HEAD | SCM view | Add; backend `/git/status`, `/git/head`; Reuse the Review pane for staging and commits | Listed `README.md M`, `app.ts M`; clicking `app.ts` opened it with the HEAD diff inline |

### Agent wiring (the session is the unit)

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| Add selection to chat | Ctrl+L | Add; writes `@file:path:from-to` into the session composer with `host.composer.insertText`, which hydrates the app's file chip | Chip `src/app.ts:1-2` appeared and the composer took focus |
| Paths in references match the chat's folder | None | Mirror: relative when the IDE shows the chat's folder, absolute otherwise | Absolute before the move, relative after |
| Inline edit | Ctrl+K | Add a prompt panel in the editor; submits `In @file:path:a-b: <instruction>` to the session with `host.composer.submit` | The agent changed line 2 three times from Ctrl+K requests |
| Review agent edits inline with per-hunk Accept/Reject and file-level Keep/Undo | Keep / Undo, Agent Review | Add; listens to `tool.complete`, reloads changed tabs, shows a unified diff against the pre-edit text (`@codemirror/merge`) | Banner and hunks appeared after each agent edit; Undo restored the previous text on disk with CRLF intact |
| Conflict handling when a dirty file changes on disk | Merge conflict prompt | Add: Compare, Use Disk Version, Overwrite with Mine | Overwrite wrote the editor text; nothing lost |
| Editor state per session | Per-agent context | Mirror `host.state.focusedStoredSessionId`: each chat keeps its own tabs; dirty tabs stay open across switches; a chat the IDE has not seen keeps the current tabs | New chat showed its own tabs; returning restored the session's |
| The agent opens files in the IDE | None | Add the `ide_open` tool (agent half) → `broadcast_plugin_event` → the desktop half opens the file at the line | "Use your ide_open tool to open README.md at line 3" opened it with line 3 active |
| Transcript card `::hermes-ide-open{path="…" line="…"}` | None | Add a transcript directive the model can emit | Registered; rendering not exercised yet |
| Git changes to chat | `@` git context | Reuse Hermes's `@diff` reference | Button wired to insert `@diff`; not exercised yet |

### Browser and element picking

Superseded in v0.3 by the IDE's own Browser column and picker (see Gate 0.3). v0.2 reused the Desktop Browser and its **Annotate** tool through the app's preview card, which needed a click and docked the preview where the app put it.

## Gate 1: Cursor parity polish (next)

Ordered by the gap against the reference screenshot (see docs/RESEARCH.md section 2). The first four close the visible differences.

| Feature | Wiring | Acceptance test |
|---|---|---|
| Changed-files strip above the chat ("9 Files · Review") | Add a composer `top` contribution listing files the session's tool calls wrote, each opening the inline review; Keep All / Undo All | After a turn that edits 3 files the strip reads "3 Files"; Undo All restores all 3 byte-for-byte |
| Status bar: branch with dirty marker, ahead/behind, current commit | Mirror `/git/status` (add `git rev-parse --short HEAD`) | Branch and commit update after the agent commits |
| Chats as tabs in the right column | Reuse sessions: open chats with `host.openSession(id, { intent: 'tab' })`, plus a `+` and history in the IDE layout | Two chats open as tabs beside the editor; switching tabs switches the IDE's tab set |
| Language-colored file icons, workspace header, collapsed Outline section | Add | Icons match file type; the header names the workspace |
| Composer mode picker (Agent / Plan / Ask) | Reuse the catalog plugin `composer-modes` rather than rebuild it | Installed alongside; modes reach the session |
| Device / responsive preview sizes | Upstream ask if the Desktop Browser lacks it; otherwise reuse | The rendered app can switch to a phone width |
| Explorer keyboard navigation, multi-select, drag to move, drop files from the OS | Add | Arrow keys move, Enter opens, F2 renames, Delete trashes; dragging a file into a folder moves it without overwrite |
| Split editor and tab drag-reorder | Add a second editor frame bound to the same buffers | Edits in one split appear in the other; order persists per session |
| Image, SVG and Markdown preview tabs | Add read-only tabs; Reuse the Browser for HTML | A PNG opens as an image tab; Markdown toggles source and preview |
| Stage, unstage, discard, commit from Source Control | Add backend git routes; Reuse the Review pane for diffs | Stage one file and commit; `git log` shows it; discard asks first |
| Branch in the status bar, ahead/behind | Mirror `/git/status` | Branch and counts update after the agent commits |
| "Explain", "Fix", "Write tests" on a selection | Add editor menu rows that submit templated prompts with `@file` ranges | Each row sends one message with the right range |

## Gate 2: language intelligence

| Feature | Wiring | Acceptance test |
|---|---|---|
| Diagnostics, hover, go to definition, rename symbol | Add a backend LSP bridge (`ctx.socket`) that starts language servers per workspace; the gateway already installs `typescript-language-server` for its own tools, so reuse that install | TypeScript and Python files show errors within 2 s; F12 jumps across files |
| Format on save | Add, via the language server or the project's formatter | Saving a file with a Prettier config formats it |
| AI next-edit suggestions (Cursor Tab) | Add, with a cheap model through a backend route; off by default | Suggestions appear in under 500 ms on a warm model and never block typing |

## Gate 3: upstream and distribution

| Item | Why | Acceptance test |
|---|---|---|
| Ask the Desktop SDK for a session-list group door (`sidebar.sessionGroups`) | The IDE group exists only in the full build (DOM markers) | The group renders through the SDK in the catalog build |
| Ask for a door to size a split (`host.setPaneShare`) and a size hint for `host.openWorkspace` | Column sizing exists only in the full build (synthetic sash drags) | Columns size with no synthetic pointer events, in both builds |
| Ask for `ctx.preview.open(url)` | The catalog build opens the dev server's page from a link the user clicks | The page opens in the app's Browser as soon as the server is up |
| Ask for a window verb on `host` (maximize) | The one raw bridge call in the catalog build | No `window.hermesDesktop` in the catalog bundle |
| Open the picked element's source in the editor | v0.3 sends likely source lines to the chat; jumping to them in the editor is next | Picking an element opens its best match at the line |
| Python web UIs (Streamlit, Flask, Django, Gradio) in project detection | v0.3 detects Node and static UIs only | A Streamlit app is found and starts |
| Ask for a plugin door to set a draft chat's folder | Starts a new chat in the IDE's folder | A new chat's first turn runs in the opened folder |
| Ask for a keybind scope for focused plugin surfaces | Would allow an in-DOM editor later; the frame works today | Not blocking |
| Publish: make the repo public, open the catalog PR (prepared in docs/CATALOG-SUBMISSION.md) | One-click installs for anyone | `hermes plugins install hermes-ide` from the catalog |
| Explorer keyboard model (roving tabindex tree, F2, Delete), non-UTF-8 files, Python UIs | From the v0.4 review | Arrow keys move in the tree; a Latin-1 file round-trips; a Streamlit app is found |

## Explicit non-goals

- A second chat system inside the IDE. The session chat is the chat.
- Running the user's code inside the IDE. Running code is the terminal's and the agent's job.
- Editing Hermes credential files through the IDE.
