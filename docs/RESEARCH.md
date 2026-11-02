# Research: Cursor's IDE, Hermes Desktop, and what the plugin should be

This records how the Hermes IDE design was derived, so later changes can be checked against the same evidence. Observations are marked as observed (read from an artifact or a live run), inferred (a conclusion from observations), or unknown.

## 1. What is being asked for, and why

The request: a Cursor-like IDE for Hermes Desktop, packaged as a Hermes plugin installable from GitHub, with chats tied one-to-one to Desktop sessions, a render window and browser for picking UI elements into the chat, workstation file and folder access, and visual parity with the Desktop theme and fonts. The chat should be reused from the Desktop, not rebuilt.

The underlying need, inferred from that request and from prior history:

1. **One agent, one memory, in the editor.** Cursor is the daily development harness, but its agent is not Hermes. Hermes carries the memory, skills, model routing and vault context. The IDE exists so code work happens with Hermes in the loop instead of switching tools.
2. **No fork.** An earlier IDE was built as a fork of the Desktop app (branch `feat/hermes-ide` in `CoeusInstitute/hermes-agent`, retired 2026-10-02). Every `hermes update` resets the managed checkout, so a fork has to be rebuilt and reinstalled by hand, and it cannot be shared. A plugin survives updates, installs with one command, and can be published.
3. **The session is the unit of work.** In Cursor an agent chat owns a set of edits. Here the Desktop session is that unit, so the IDE must follow it: its folder, its open files, the edits it makes.
4. **Designers and engineers want different surfaces.** Some people want an editor, tabs and a file tree; others are happy in the chat. Both should act on the same session.

## 2. Cursor on this workstation (observed)

Static inspection only; Cursor was not run or modified.

| Item | Value |
|---|---|
| Install | `%LOCALAPPDATA%\Programs\cursor`, Cursor 3.27.22, commit `b1aa50cb`, built 2026-10-27 |
| App tree | `resources/app`, 19,564 files; REA inventory Evidence `ev_7d403481bf4d932445c799853874658f84b40051a714e4a485c2d15058ea633d` (directory digest `b8e669a7…c528a2`), summary view `ev_ba0726b271f658274b80a3351be1c0e2032597ed374007a49bd1993fc79d3425` |
| Workbench | `out/vs/workbench/workbench.desktop.main.js` (41.6 MB), `workbench.desktop.main.css` (1.28 MB), a separate `workbench.glass.main.js` |
| Cursor extensions | `cursor-agent-exec`, `cursor-agent-host`, `cursor-agent-worker`, `cursor-browser-automation` (an MCP server for browser automation), `cursor-computer-use`, `cursor-explorer`, `cursor-file-service`, `cursor-retrieval`, `cursor-mcp`, `cursor-shadow-workspace`, `cursor-worktree-textmate`, `theme-cursor` and others |
| Themes | Cursor Dark, Dark Midnight, Dark High Contrast, Light, Light High Contrast, and colorblind variants |

Cursor is a VS Code fork. The IDE surface (editor groups, explorer, search, SCM, terminal panel, Monaco editor) is VS Code's workbench. Cursor's own layer sits on top, as React UI inside the workbench bundle. Its CSS class families show the components (counts are class-name occurrences in `workbench.desktop.main.css`):

| Family | Count | Component |
|---|---|---|
| `agent-sidebar`, `agent-tab`, `agent-layout` | 164, 71, 71 | The Agents sidebar and the agent/editor layout switch |
| `composer-*` (messages, toolbar, plan, thinking, tool, questionnaire, context, sticky) | 300+ | The agent chat (Cursor calls it Composer) |
| `review-widget`, `inline-diff`, `diff-review`, `review-changes` | 96, 43, 29, 18 | Agent edit review in the editor |
| `aislash-editor` | 36 | The chat input, with `@` mentions |
| `browser-*` (cert, lock, device, error) | 40+ | The built-in browser |
| `cursor-blame`, `cursor-prediction`, `cursorGhostTextWidget` | | AI blame, next-edit prediction, ghost text |

UI strings in the workbench bundle and `nls.messages.json` confirm the behaviors: **Add to Chat**, **Add Files to Chat**, **Keep All / Undo All / Keep File / Undo File**, **Agent Review**, **Inline Edit**, **Open Browser**, **Select element** (command `browser.selectElementClick`), **Device emulation**, **Layout • Left / Right / Zen**, **Toggle Agents Side Bar**, **New Agent**, **Run Many Agents in Parallel**.

Cursor's interaction model, as it applies here:

- The agent chat sits beside the editor, not inside it. The editor is the primary surface in the editor layout; the agent chat is primary in the agent layout.
- Ctrl+L adds the selection to the chat; Ctrl+K edits in place; Ctrl+I opens the agent.
- Agent edits appear in the editor as inline diffs with per-hunk and per-file Keep and Undo.
- The browser can select an element on the page and attach it to the chat.

The reference screenshot (Cursor with the Omni-53 workspace, received after v0.1 shipped) confirms this layout and adds detail:

- **Three columns:** Explorer about 1/8 of the width, the center about 7/12, the agent about 1/3.
- **The center is the built-in browser, not a code editor.** It renders the running app in an editor tab with an address bar, an element picker, a device/responsive toggle and a comment tool. Cursor treats the rendered app as the main working surface.
- **Agent chats are tabs** in the right column (`+`, history), separate from the editor tabs.
- **A `9 Files · Review` strip sits above the composer:** every file the chat changed, reviewable in one place.
- **The composer** has a mode picker (`Agent`), a model picker, `/` for skills and `@` for context.
- **The status bar** shows the git branch with dirty state, problem counts, and the current commit.
- **The Explorer** uses language-colored file icons, a workspace header, git dots on folders, and collapsed Outline and Timeline sections.

## 3. Hermes Desktop (observed)

Source: the managed checkout `%LOCALAPPDATA%\hermes\hermes-agent` (`apps/desktop`, Desktop v0.22.5), the Desktop Plugin SDK reference (`website/docs/developer-guide/desktop-plugin-sdk.md`, the SDK barrel `apps/desktop/src/sdk/index.ts`), and live runs in a sandboxed Desktop.

Hermes Desktop already has most of an IDE's pieces:

| Desktop piece | IDE role | Where |
|---|---|---|
| Session chat (`workspace` pane) | The agent chat, one per session | core pane |
| Sessions sidebar (`sessions` pane) | Cursor's Agents sidebar | core pane |
| Terminal (`terminal` pane) | Terminal panel | core pane |
| Files (`files` pane) and file preview with a CodeMirror spot editor | A single-file viewer/editor | `app/chat/right-rail/preview-file.tsx` |
| Review (`review` pane) | Git changes review | core pane |
| Browser preview with **Annotate** | The render window; pick an element or area, write a note, hand it to the chat with selector, HTML, styles and a screenshot | `app/chat/right-rail/preview-pane.tsx`, `lib/preview-annotate/` |
| `@file:path:a-b`, `@folder:`, `@diff`, `@staged`, `@url:` references | Context attachments the agent expands | `agent/context_references.py` |
| `session.cwd.set` RPC | Moves a session to a folder | `tui_gateway/methods_session.py` |

What it lacks for IDE work: a multi-file tabbed editor, a file tree tied to the session, workspace search, Quick Open, per-session editor state, an inline edit that targets lines, and in-editor review of agent edits.

The plugin SDK is a real extension surface, not a bolt-on: panes, main-area workspace tiles (`host.openWorkspace`), palette commands, rebindable keybinds, status bar items, settings pages, transcript directives, theme tokens, the composer API (`host.composer.insertText/submit`), gateway RPC (`host.request`), the gateway event stream (`ctx.onEvent`), and a scoped backend namespace (`ctx.rest` → `plugin_api.py`). One package can carry an agent half, a backend and a desktop half, and installs from Git with `hermes plugins install owner/repo`.

## 4. Constraints found while building (observed)

These shaped the architecture; each was confirmed in source or in a live run.

1. **Disk plugins import only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.** Everything else must be bundled into one ESM file. CodeMirror is bundled; the loader's import scanner accepts it because the editor bundle is inlined as a string.
2. **The app's keybind dispatcher listens on `window` in the capture phase and fires every `mod+…` chord even inside text inputs** (`app/hooks/use-keybinds.ts`, `lib/keybinds/combo.ts::actionAllowedInInput`). An editor in the app DOM would lose Ctrl+F (find in page), Ctrl+D (switch to the default profile), Ctrl+/ (shortcuts panel), Ctrl+G, Ctrl+K and Ctrl+P. Key events inside a child document never reach the parent window, so the editor runs in a sandboxed iframe and owns its keyboard, exactly like an IDE.
3. **An opaque-origin frame cannot load the app's font files.** The plugin reads the app's `@font-face` rules for `--font-mono` (JetBrains Mono) and hands the font bytes to the frame, which registers them with `FontFace`.
4. **Skins repaint by rewriting `:root` attributes and inline tokens, sometimes in several passes.** The editor re-reads tokens after the writes settle, and decides light or dark from the luminance of `--ui-text-primary`, so any skin, including one with a bright surface in dark mode, matches.
5. **Plugins have no door that opens a Browser tab.** The core `preview.open` event only reaches a window while that session's agent turn is running (`gateway/local_desktop_ui.py::_emit` raises outside a turn). The IDE renders the app's own preview card (`MessageTextContent` with a `MEDIA:` line), whose click opens the Browser through core's handler. The card drops the open if it unmounts before resolving, so the dialog stays up briefly after the click.
6. **A chat that has not started has no session to move.** The draft's folder lives in renderer state that plugins cannot write. The IDE applies a folder chosen in a draft once its first reply ends (`message.complete`).
7. **FastAPI `async def` routes run on the gateway's event loop.** A blocking `git` or `rg` call there stalls every Desktop request. All IDE routes are plain `def`, which FastAPI runs in its threadpool.
8. **CodeMirror joins lines with `\n` in `doc.toString()`.** Saving uses `state.sliceDoc()`, which honors the line separator, so CRLF files stay CRLF.
9. **Playwright's `connectOverCDP` emulates a light color scheme on attach.** A Desktop set to the System theme flips to light while a test driver is attached. The test driver resets the emulation.

## 5. Design decision

Build the IDE as **a layout and a set of surfaces around the Desktop's own session**, not as a second app:

- **Reuse** the session chat, Sessions sidebar, terminal, Review pane, Browser and Annotate exactly as they are. The IDE never renders a chat; it writes into the session's composer through `host.composer` and reads the session through `host.state` and the event stream. That is what makes the parity one-to-one by construction.
- **Add** only what Desktop lacks: the Explorer, Search and Source Control views, the tabbed editor with inline review, Quick Open, inline edit, per-session editor state, and the agent's `ide_open` tool.
- **Run the file system on the backend**, next to the agent, so the IDE edits the same files the agent edits, including against a remote backend.

Alternatives considered:

| Alternative | Why not |
|---|---|
| Fork Desktop again | Lost on every update; cannot be shared; already retired once |
| Rebuild a chat inside the IDE | Duplicates the most complex part of the app and breaks parity |
| Monaco instead of CodeMirror | Needs web workers and AMD loading that the single-file loader does not support; CodeMirror 6 bundles cleanly and the app already uses it |
| Editor in the app DOM | Loses the editing keys to the app's global shortcuts (constraint 2) |
| `ctx.files` (desktop-side, per-folder grants) for files | No search, no git, refuses `.env`-like names, and reads the Desktop machine instead of the agent's machine on a remote backend |
| A plugin-owned `<webview>` browser | Rejected for v0.1 and v0.2: it bypasses the Desktop's per-origin consent for page scripts and duplicates the Browser that already has Annotate. **Adopted in v0.3** (see below) |

## v0.3 revision: the IDE's own Browser column (2026-11-02)

Michai's v0.2 review asked for the IDE to find a project's UI, run it and open it in the browser automatically, and for every column (browser included) to be movable by dragging. Neither is possible with the Desktop Browser from a plugin: no SDK door opens or navigates a Browser tab (`preview.open` reaches a window only during that session's running turn), and the core preview docks where the app puts it. The v0.1 reasons against an own `<webview>` were weighed again:

- **Per-origin consent for page scripts.** The Desktop asks before its Browser runs agent scripts on a site. The IDE's webview runs exactly one script, the element picker, and only when the user presses the picker button, on the page the user is looking at (normally their own dev server). That is the user's own action, not an agent's.
- **Duplicating Annotate.** The picker is smaller than Annotate (no notes, no screenshot) but adds what Annotate lacks for development: the likely source lines of the picked element.

So v0.3 adds a Browser column with a `<webview>` on its own partition (`persist:hermes-ide`, outside the preview partition's preload and guest rules), and keeps the Desktop Browser untouched for everything else. The dev server itself runs in the backend, which derives the command from the project's files and asks the user once per project before running its code (Cursor and VS Code call this Workspace Trust).

