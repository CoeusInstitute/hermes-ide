# Feature map and gates

Every feature is listed with its Cursor counterpart, how it is wired into Hermes Desktop (reused, mirrored, or added), and how it is verified. Gate 0 is what v0.1 ships; each later gate has acceptance tests that must pass before it is called done.

Wiring legend:

- **Reuse**: the Desktop's own surface, used as is. The IDE only arranges it or calls it.
- **Mirror**: the IDE follows Desktop state (session, folder, theme) and stays in sync with it.
- **Add**: built by the plugin because Desktop has no equivalent.

## Gate 0: shipped in v0.1 (verified in a sandboxed Desktop, 2026-11-01)

### Layout and shell

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| IDE layout: Explorer, Editor, chat, terminal side by side | Editor layout | Add the Explorer pane (`panes`, left) and the Editor tile (`host.openWorkspace`, docked left of the chat); Reuse the chat and terminal (`host.revealPane('terminal')`) | Ctrl+Alt+I arranges all four; screenshot review found no overlap or bright borders |
| Session chat | Agent chat (Composer) | Reuse. The IDE renders no chat | The chat in the layout is the Desktop session |
| Sessions list | Agents sidebar | Reuse. The Explorer stacks as a tab beside Sessions | Tabs `SESSIONS / BOTS / EXPLORER` |
| Command palette entries | Ctrl+Shift+P | Add `IDE: …` rows to the Desktop palette; Ctrl+Shift+P and F1 inside the editor open the Desktop palette | Palette opened from the editor |
| Rebindable shortcuts | Keybindings | Add `KEYBINDS_AREA` entries with defaults that avoid the app's chords | Ctrl+Alt+I, Ctrl+Alt+P work |
| Status bar: line, column, selection, EOL, language | Status bar | Add a status item | `Ln 1, Col 1 · CRLF · TypeScript` |
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

| Feature | Cursor | Wiring | Verified |
|---|---|---|---|
| Render a file or URL beside the chat | Open Browser | Reuse the Desktop Browser; the IDE shows the app's own preview card and core opens the tab | `index.html` rendered in a Browser tab |
| Pick an element and send it to the chat | Select element | Reuse Browser **Annotate**: click an element, add a note, **Add comment** | The composer received the selector `#title`, the element's HTML, its styles and a screenshot |

## Gate 1: Cursor parity polish (next)

Ordered by the gap against the reference screenshot (see docs/RESEARCH.md section 2). The first four close the visible differences.

| Feature | Wiring | Acceptance test |
|---|---|---|
| Browser in the center: open a running app (`localhost` dev server or URL) as the main surface, chat on the right | Reuse the Desktop Browser; add an "IDE: Open App URL" command and a layout preset that docks the Browser where the Editor tile sits, with the Editor tile stacked behind it | One command shows Explorer, the rendered app in the center and the chat on the right; Annotate works on it |
| Changed-files strip above the chat ("9 Files · Review") | Add a composer `top` contribution listing files the session's tool calls wrote, each opening the inline review; Keep All / Undo All | After a turn that edits 3 files the strip reads "3 Files"; Undo All restores all 3 byte-for-byte |
| Status bar: branch with dirty marker, ahead/behind, current commit | Mirror `/git/status` (add `git rev-parse --short HEAD`) | Branch and commit update after the agent commits |
| Chats as tabs in the right column | Reuse sessions: open chats with `host.openSession(id, { intent: 'tab' })`, plus a `+` and history in the IDE layout | Two chats open as tabs beside the editor; switching tabs switches the IDE's tab set |
| Language-colored file icons, workspace header, collapsed Outline section | Add | Icons match file type; the header names the workspace |
| Composer mode picker (Agent / Plan / Ask) | Reuse the catalog plugin `composer-modes` rather than rebuild it | Installed alongside; modes reach the session |
| Device / responsive preview sizes | Upstream ask if the Desktop Browser lacks it; otherwise reuse | The rendered app can switch to a phone width |
| Picked element → jump to source | Add: on an Annotate handoff, search the workspace for the element's id, classes and text (`/search`), open the best match | Picking `#title` opens `index.html` at the `<h1>` line |
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
| Ask the Desktop SDK for `host.openPreview(target)` | Opens the Browser directly; removes the one-click card | Open in Browser opens the tab with no dialog |
| Ask for a plugin door to set a draft chat's folder | Starts a new chat in the IDE's folder | A new chat's first turn runs in the opened folder |
| Ask for a keybind scope for focused plugin surfaces | Would allow an in-DOM editor later; the frame works today | Not blocking |
| Publish: make the repo public, tag releases, submit to the Hermes plugin catalog | One-click installs for anyone | `hermes plugins install hermes-ide` from the catalog |

## Explicit non-goals

- A second chat system inside the IDE. The session chat is the chat.
- Running the user's code inside the IDE. Running code is the terminal's and the agent's job.
- Editing Hermes credential files through the IDE.
