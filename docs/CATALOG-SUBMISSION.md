# Submitting Hermes IDE to the Hermes plugin catalog

The catalog is a human-reviewed directory in [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (`plugin-catalog/`). An entry pins one exact commit; installs check out that commit. The rules are in the hermes-agent docs, *Developer guide → Plugins → Catalog submission*. This page is the kit for this plugin: what is ready, what the owner must do, the entry file, the PR text, and the hook requests to file.

## Status

| Item | State |
|---|---|
| Catalog build passes `hermes plugins validate` | Yes (v0.6.7, tag `catalog-v0.6.7`) |
| Desktop surface inside the SDK | Yes; one review warning, the window maximize (disclosed below) |
| Security scan | `safe` (0 critical, 0 high; 121 medium or low notes, accounted for below). Installs from Git proceed without a prompt |
| No private core imports, no core overrides | Yes |
| Capabilities declared match registrations | Yes (`ide_open`; hook `pre_llm_call`; skill `hermes-ide:guide`) |
| `requires_hermes` truthful and declared in `plugin.yaml` | `>=0.22.5`, the version both builds were verified on |
| README with disclosures, screenshots | Yes |
| CI on the repo | `.github/workflows/ci.yml` (tests and reproducible bundles) |
| Public repository | Yes. Rulesets keep `main` from force-push or deletion and make `v*` / `catalog-v*` tags immutable, so the pinned commit stays fetchable; secret scanning with push protection, private vulnerability reporting, and approval for workflows from outside contributors are on |
| Entry PR opened | [NousResearch/hermes-agent#148226](https://github.com/NousResearch/hermes-agent/pull/148226), pinned to `d6c88b0dfd817a8de82141a8e621d892c99d6615` (`catalog-v0.6.6`; first submitted at `87855854d3a2c536a433fb3ad1f8e03622918062`, `catalog-v0.6.5`). Hook request for the maximize call: [#148224](https://github.com/NousResearch/hermes-agent/issues/148224) |

## Steps for the owner

1. Make the repository public (GitHub → Settings → General → Danger Zone → Change visibility). The full history was scanned on 2026-11-02 for committed keys (OpenRouter, OpenAI, GitHub, Supabase, AWS and Slack token formats, private-key blocks) with no hits, and no tracked file names a user folder; re-run the scan if commits land before you flip it.
2. Confirm CI is green on the `catalog-v0.6.7` tag.
3. On a checkout of the tag (`git checkout catalog-v0.6.7`): `hermes plugins validate . --install-deps` and read the output (expected below).
4. Fork `NousResearch/hermes-agent`, add `plugin-catalog/hermes-ide.yaml` from [catalog/hermes-ide.yaml](catalog/hermes-ide.yaml) with `CATALOG_SHA` replaced by `git rev-parse catalog-v0.6.7^{commit}` (40 characters, in `sha` and the image URLs), and open the PR with the description below. Attach `docs/images/ide-window.png`.
5. Wait for the catalog CI job (it clones the pinned commit and runs `hermes plugins validate`), answer review.
6. Later releases: a SHA-bump PR changing `sha` and `version` together.

## Expected validation output (catalog build)

```
✓ manifest, manifest fields, requires_hermes, config schema, requires_env, oauth
✓ loadable — entry: __init__.py, desktop/plugin.js
✓ python dependencies — none declared
✓ capability probe, declared tools / hooks / middleware, built-in tool collisions
✓ security scan — safe
✓ no core override — no runtime rebinds of Hermes core
✓ desktop surface — stays inside the plugin SDK surface
⚠ desktop surface review (catalog rule 8): raw bridge window.hermesDesktop (plugin.js:…)
Validation passed.
```

Every finding of the plugin scanner (`tools/plugin_guard.py`, what install, update and validate run) at this release, by source:

| Where | Findings | What they are |
|---|---|---|
| `desktop/plugin.js`, vendored CodeMirror 6 and Lezer | 96 `js_char_code`, 4 `unicode_escape_chain`, 4 `hex_encoded_string` | Character handling in `@lezer/markdown`, `@codemirror/merge`, `view`, `state`, `search` and the language packages |
| same | 1 `oversized_file` | The bundle is about 2.6 MB: an editor, 14 grammars with their parse tables as plain integer arrays, and the diff view, unminified so it can be read |
| `dashboard/plugin_api.py` | 7 `python_subprocess` | The plugin's real commands: `git status`/`git show`, `rg`, the system trash (`osascript`, `gio`), the trusted project's dev server and its stop (`taskkill`) |
| `tests/` (stepped down by the scanner, as designed) | 7 | Fixtures the tests prove are refused (a `file:` URL to a system password file, a request id that climbs out of its folder), a Vite log line with a LAN address, binary bytes, a `git` call that builds a test repo |
| `docs/DEVELOPING.md`, `.github/workflows/ci.yml` | 2 `uv_run` | The documented test command and CI |

Since 0.6.2 the build decodes the Lezer grammars' packed parse tables into the typed arrays the parser builds from them anyway (`dev/lezer-tables.mjs`; `tests/lezer-tables.test.mjs` checks every grammar's tables and parse trees against the package's own). Before, those packed strings scored 35 high `inline_shell_exec` and 10 `backtick_subshell`. Earlier releases also had a high `dump_all_env` on the backend's credential-refusal pattern (a `.env` alternative followed by the regex's or-bar) and three BOM byte literals; 0.6.1 replaced them with an exact pattern and `codecs.BOM_UTF8`.
- **`inline_shell_exec` cautions.** The rule looks for the skill-markdown inline-shell syntax (an exclamation mark followed by a backtick-quoted command), which only expands in a `SKILL.md` body. Every hit is inside a Lezer grammar table that CodeMirror's language packages ship as compressed strings (`stateData`, `goto`, `tokenData`, `states`) in `desktop/plugin.js`; none is code, and the plugin's one `SKILL.md` has no finding. They are left as they are rather than rewritten to quiet the scanner.
- **The raw bridge call.** `window.hermesDesktop.windowControls.toggleMaximize()`, once per IDE window, in `maximizeOnce()` in `src/core.ts`. The app opens pop-outs at 420 px, which an IDE cannot use, and the SDK has no window verb. Hook request 4 below.

## PR description (draft)

> **Add hermes-ide: a Cursor-style IDE for Hermes Desktop**
>
> Hermes IDE turns any chat into its own IDE window: the app's single-session pop-out, claimed by the plugin, with an Explorer (files, search, git status), a tabbed CodeMirror 6 editor and Quick Open beside the real session chat. The editor is wired to the session: Ctrl+L adds a selection as an `@file:` reference, Ctrl+K sends an inline edit request, and agent edits to open files come back as an inline diff with Keep and Undo. It finds the project's web UI (Node frameworks by their dev script, or a static site), asks the user before running it, runs the dev server on the agent's machine, and opens the page in the app's Browser, where an element picker sends the picked element (selector, markup, styles, its React, Vue or Svelte component and source line) to the chat as a compact composer token. While a chat's IDE window is open, a `pre_llm_call` note tells the agent the message comes from the IDE, and a bundled skill (`hermes-ide:guide`) explains the IDE.
>
> **Hermes surfaces used.** Desktop SDK: `host.openSession` (`intent: 'window'`), `host.openWorkspace` tiles with `dock`, `host.paneVisibility`, `ctx.runAction` (`view.toggleSidebar`, `view.showBrowser`, `nav.commandPalette`), `ctx.preview.executeJavaScript` (declared capability), `host.composer` (`getDraft`, `insertText`, `focus`), `COMPOSER_AREAS.middleware` (expands picked-element tokens at send), `host.listPersistedSessions`, `host.newChat`, `host.notify`, `ctx.os` (`openExternal`, `writeClipboard`), `ctx.storage`, `ctx.rest`, `SESSION_ROW_AREAS.leading`, `STATUSBAR_AREAS.right`, `TITLEBAR_AREAS.right`, `PALETTE_AREA`, `KEYBINDS_AREA`, `TRANSCRIPT_DIRECTIVE_AREA`, `ctx.registerSettingsPage`, SDK components (`MessageTextContent`, `Popover`, `ConfirmDialog`, `Dialog`, `ContextMenu`, `Button`, `Codicon`, `ToggleRow`, `SegmentedControl`). Backend: a dashboard plugin router at `/api/plugins/hermes-ide/`. Agent: `ctx.register_tool` (`ide_open`), `ctx.register_hook` (`pre_llm_call`), `ctx.register_skill` (`guide`), `plugins.plugin_storage.plugin_data_dir`, `hermes_cli.plugin_events.broadcast_plugin_event`, `agent.runtime_cwd.resolve_agent_cwd`.
>
> **Disclosures (rule 13).**
> - Reads and writes files in folders the user opens, on the agent's machine, through its own routes behind the gateway's authentication. Refuses Hermes credential files in every home and profile under any path spelling, and never lists or searches them.
> - Runs shell commands: `git status` / `git show` (read-only, optional locks off), `rg`, and, only for projects the user trusted, the project's package manager (`install`, the dev script).
> - Long-running background processes: those dev servers, in their own process group, stopped two minutes after the last IDE window that asked about them closes, and at gateway exit. They get the gateway's environment minus credential-looking variables. Static sites run on a bundled server bound to 127.0.0.1 that refuses dotfiles, folder listings and non-localhost Host headers.
> - Runs a page script (element picker, reload) only through `ctx.preview`, on origins the user allowed in the app's prompt.
> - Adds context to the model: a `pre_llm_call` hook appends a fixed note (about 800 characters, no user data) to the current turn of a chat whose IDE window is open, or whose message carries a picked element. Not persisted, system prompt untouched. The open windows are known from a lease file, `plugin-data/hermes-ide/ide-sessions.json` (chat ids and timestamps only).
> - No network calls to third parties, no stored credentials, no telemetry.
> - One raw bridge call: `windowControls.toggleMaximize` once per IDE window (no SDK window verb; the pop-out opens at 420 px).
> - Security scan: `safe` (no critical or high finding; 121 medium or low notes, mostly character handling in the bundled CodeMirror, plus the backend's real subprocess calls and test fixtures). The build ships the editor's Lezer parse tables decoded, as integer arrays, instead of the packed strings the scanner read as inline shell.
>
> **Builds.** The pinned commit is the release's catalog build (tag `catalog-v0.6.7`, one commit on top of the release that swaps in the catalog bundle). The repository's `main` also has a full build with features that need the app's markup (a session-list group, column sizing, an own Browser webview); it is not part of this entry, lives in `src/full/`, and is tree-shaken from this bundle. Hook requests for those features are linked below.
>
> Screenshots attached. Verified on Hermes 0.22.5 in a sandboxed Desktop over CDP (details in `docs/FEATURES.md`, Gates 0.4 and 0.5).

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

**Need.** A plugin that starts a dev server wants its page in the app's Browser. `ctx.preview.executeJavaScript` can script an open page, but nothing opens one; the `preview.open` event is emitted only by the agent's `desktop_preview` tool (action `open`).

**Proposal.** `ctx.preview.open(url, { label? })` through the same normalizer and `reachablePreviewUrl` the `preview.open` event uses, scoped to the focused session's window, http(s) and localhost only (no consent needed to show a page; scripts stay consent-gated).

**Today.** The catalog build renders the URL with `MessageTextContent`, so the user's click goes through the app's link handling into the Browser.

### 4. A window verb for plugin-owned pop-outs

**Need.** A plugin that claims a session pop-out for a dense UI (an IDE) needs more than the 420 px default, and has no SDK verb.

**Proposal.** `host.window.maximize()` / `host.window.setBounds({ width, height })` for the calling window, refused for the main window or while the user is resizing.

**Today.** One call to `window.hermesDesktop.windowControls.toggleMaximize()` (the catalog build's only bridge call).

### 5. The plugin scanner: the inline-shell rule on code files

**Need.** `inline_shell_exec` flags the skill-markdown inline-shell syntax, which only expands in a `SKILL.md` body. In a code file the same bytes are data: every plugin that bundles a Lezer-based CodeMirror ships dozens of them in its grammar tables, and each scores high, so the plugin cannot install without a caution prompt whatever its own code does.

**Proposal.** Add `inline_shell_exec` to `CODE_EXEMPT_PATTERN_IDS` in `tools/plugin_guard.py`, next to the other patterns that are "meaningless inside code". A plugin's own `SKILL.md` is not a code file and keeps the rule at full severity. A ready patch with a regression test (it fails on today's scanner and passes with the change) is kept outside this repository.

**Effect, measured on 0.6.1.** `caution`, 166 findings (35 high); with the change, `safe`, and a hostile inline-shell line in a bundled `SKILL.md` still flagged high. Hermes IDE no longer needs it (0.6.2 decodes the tables at build time), but every other plugin that bundles a Lezer-based CodeMirror does.

