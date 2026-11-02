# Submitting Hermes IDE to the Hermes plugin catalog

The catalog is a human-reviewed directory in [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (`plugin-catalog/`). An entry pins one exact commit; installs check out that commit. The rules are in the hermes-agent docs, *Developer guide → Plugins → Catalog submission*. This page is the kit for this plugin: what is ready, what the owner must do, the entry file, the PR text, and the hook requests to file.

## Status

| Item | State |
|---|---|
| Catalog build passes `hermes plugins validate` | Yes (v0.4.0, `catalog` branch) |
| Desktop surface inside the SDK | Yes; one review warning, the window maximize (disclosed below) |
| Security scan | `caution`, not `dangerous`: 35 `inline_shell_exec` hits, all inside CodeMirror's Lezer parse-table strings (see below) |
| No private core imports, no core overrides | Yes |
| Capabilities declared match registrations | Yes (`ide_open`) |
| `requires_hermes` truthful and declared in `plugin.yaml` | `>=0.22.5`, the version both builds were verified on |
| README with disclosures, screenshots | Yes |
| CI on the repo | `.github/workflows/ci.yml` (tests and reproducible bundles) |
| **Public repository** | **No. The owner must make `CoeusInstitute/hermes-ide` public before the PR.** |
| Entry PR opened | No (owner decision) |

## Steps for the owner

1. Make the repository public (GitHub → Settings → General → Danger Zone → Change visibility). The full history was scanned on 2026-11-02 for committed keys (OpenRouter, OpenAI, GitHub, Supabase, AWS and Slack token formats, private-key blocks) with no hits, and no tracked file names a user folder; re-run the scan if commits land before you flip it.
2. Confirm CI is green on `catalog`.
3. On a `catalog` checkout: `hermes plugins validate . --install-deps` and read the output (expected below).
4. Fork `NousResearch/hermes-agent`, add `plugin-catalog/hermes-ide.yaml` from [catalog/hermes-ide.yaml](catalog/hermes-ide.yaml) with `CATALOG_SHA` replaced by `git rev-parse catalog` (40 characters, in `sha` and the image URLs), and open the PR with the description below. Attach `docs/images/ide-window.png`.
5. Wait for the catalog CI job (it clones the pinned commit and runs `hermes plugins validate`), answer review.
6. Later releases: a SHA-bump PR changing `sha` and `version` together.

## Expected validation output (catalog build)

```
✓ manifest, manifest fields, requires_hermes, config schema, requires_env, oauth
✓ loadable — entry: __init__.py, desktop/plugin.js
✓ python dependencies — none declared
✓ capability probe, declared tools / hooks / middleware, built-in tool collisions
✓ security scan — caution
✓ no core override — no runtime rebinds of Hermes core
✓ desktop surface — stays inside the plugin SDK surface
⚠ security scan caution: inline_shell_exec (plugin.js:…) × 35
⚠ desktop surface review (catalog rule 8): raw bridge window.hermesDesktop (plugin.js:…)
Validation passed.
```

- **`inline_shell_exec` cautions.** The scanner's pattern is the skill-markdown inline-shell syntax (`` !`…` ``). Every hit is inside a Lezer grammar table that CodeMirror's language packages ship as compressed strings (`stateData`, `goto`, `tokenData`, `states`); none is code. They appeared in 0.4 because the editor is now bundled as readable code instead of a minified `srcdoc` string. They were left as they are rather than rewritten to quiet the scanner.
- **The raw bridge call.** `window.hermesDesktop.windowControls.toggleMaximize()`, once per IDE window, in `maximizeOnce()` in `src/core.ts`. The app opens pop-outs at 420 px, which an IDE cannot use, and the SDK has no window verb. Hook request 4 below.

## PR description (draft)

> **Add hermes-ide: a Cursor-style IDE for Hermes Desktop**
>
> Hermes IDE turns any chat into its own IDE window: the app's single-session pop-out, claimed by the plugin, with an Explorer (files, search, git status), a tabbed CodeMirror 6 editor and Quick Open beside the real session chat. The editor is wired to the session: Ctrl+L adds a selection as an `@file:` reference, Ctrl+K sends an inline edit request, and agent edits to open files come back as an inline diff with Keep and Undo. It finds the project's web UI (Node frameworks by their dev script, or a static site), asks the user before running it, runs the dev server on the agent's machine, and opens the page in the app's Browser, where an element picker sends the picked element and its likely source lines to the chat.
>
> **Hermes surfaces used.** Desktop SDK: `host.openSession` (`intent: 'window'`), `host.openWorkspace` tiles with `dock`, `host.paneVisibility`, `ctx.runAction` (`view.toggleSidebar`, `view.showBrowser`, `nav.commandPalette`), `ctx.preview.executeJavaScript` (declared capability), `host.composer` (`getDraft`, `insertText`, `focus`), `host.listPersistedSessions`, `host.newChat`, `host.notify`, `ctx.os` (`openExternal`, `writeClipboard`), `ctx.storage`, `ctx.rest`, `SESSION_ROW_AREAS.leading`, `STATUSBAR_AREAS.right`, `TITLEBAR_AREAS.right`, `PALETTE_AREA`, `KEYBINDS_AREA`, `TRANSCRIPT_DIRECTIVE_AREA`, `ctx.registerSettingsPage`, SDK components (`MessageTextContent`, `Popover`, `ConfirmDialog`, `Dialog`, `ContextMenu`, `Button`, `Codicon`, `ToggleRow`, `SegmentedControl`). Backend: a dashboard plugin router at `/api/plugins/hermes-ide/`. Agent: `ctx.register_tool` (`ide_open`), `hermes_cli.plugin_events.broadcast_plugin_event`, `agent.runtime_cwd.resolve_agent_cwd`.
>
> **Disclosures (rule 13).**
> - Reads and writes files in folders the user opens, on the agent's machine, through its own routes behind the gateway's authentication. Refuses Hermes credential files in every home and profile under any path spelling, and never lists or searches them.
> - Runs shell commands: `git status` / `git show` (read-only, optional locks off), `rg`, and, only for projects the user trusted, the project's package manager (`install`, the dev script).
> - Long-running background processes: those dev servers, in their own process group, stopped two minutes after the last IDE window that asked about them closes, and at gateway exit. They get the gateway's environment minus credential-looking variables. Static sites run on a bundled server bound to 127.0.0.1 that refuses dotfiles, folder listings and non-localhost Host headers.
> - Runs a page script (element picker, reload) only through `ctx.preview`, on origins the user allowed in the app's prompt.
> - No network calls to third parties, no stored credentials, no telemetry.
> - One raw bridge call: `windowControls.toggleMaximize` once per IDE window (no SDK window verb; the pop-out opens at 420 px).
> - The security scan's `inline_shell_exec` cautions are CodeMirror Lezer parse-table strings.
>
> **Builds.** The pinned commit is the `catalog` branch's catalog build. The repository's `main` also has a full build with features that need the app's markup (a session-list group, column sizing, an own Browser webview); it is not part of this entry, lives in `src/full/`, and is tree-shaken from this bundle. Hook requests for those features are linked below.
>
> Screenshots attached. Verified on Hermes 0.22.5 in a sandboxed Desktop over CDP (details in `docs/FEATURES.md`, Gate 0.4).

## Hook requests (drafts for NousResearch/hermes-agent issues)

Each one would let a full-build feature move into the catalog build. The admission guide asks for issues like these ("we would rather add the seam than list a patch").

### 1. A contribution area for session-list sections

**Need.** A plugin wants its own section in the session list (Hermes IDE: an "IDE" section listing chats that open in their IDE window, like the date groups), and to take those rows out of the default grouping. Today the only doors are row decorations (`SESSION_ROW_AREAS`) and the pin/reorder/colour verbs.

**Proposal.** `SESSION_LIST_AREAS.sections` with `data: { id, label, order?, match(row) => boolean, onRowActivate?(row, event) => boolean }`: core renders the section with its own row component under the Pinned section, removes matched rows from the default grouping, and lets `onRowActivate` claim a plain click (returning `true`), modifiers keeping core's meaning.

**Today.** The full build inserts a plain-DOM group under the SESSIONS header found by `data-session-pin-drop` markers and hides rows with a class; the catalog build shows badges and a status-bar menu instead.

### 2. Sizing a docked pane

**Need.** A plugin that docks several workspace tiles (Explorer, Editor, a preview) gets the app's even split: a file tree at a quarter of a 4K window. The app already records shares per pane for re-docking.

**Proposal.** `host.openWorkspace(id, { …, size?: { share?: number; px?: number } })` honoured on adoption, plus `host.setPaneShare(paneId, fraction)` for a user-initiated reset.

**Today.** The full build drags the app's sash with synthetic pointer events; the catalog build nests the Explorer in the Editor tile with its own splitter.

### 3. Opening an address in the Browser pane

**Need.** A plugin that starts a dev server wants its page in the app's Browser. `ctx.preview.executeJavaScript` can script an open page, but nothing opens one; the `preview.open` event is emitted only by the agent's `open_preview` tool.

**Proposal.** `ctx.preview.open(url, { label? })` through the same normalizer and `reachablePreviewUrl` the `preview.open` event uses, scoped to the focused session's window, http(s) and localhost only (no consent needed to show a page; scripts stay consent-gated).

**Today.** The catalog build renders the URL with `MessageTextContent`, so the user's click goes through the app's link handling into the Browser.

### 4. A window verb for plugin-owned pop-outs

**Need.** A plugin that claims a session pop-out for a dense UI (an IDE) needs more than the 420 px default, and has no SDK verb.

**Proposal.** `host.window.maximize()` / `host.window.setBounds({ width, height })` for the calling window, refused for the main window or while the user is resizing.

**Today.** One call to `window.hermesDesktop.windowControls.toggleMaximize()` (the catalog build's only bridge call).
