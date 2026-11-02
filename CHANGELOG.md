# Changelog

All notable changes to Hermes IDE. Versions follow the `version` in `plugin.yaml`.

## 0.4.0 (2026-11-02)

Catalog-ready, reviewed and hardened. One source now builds two ways: a **catalog build** that stays inside the Desktop plugin SDK and passes `hermes plugins validate`, and a **full build** (on `main`) that adds the features the SDK has no hook for yet.

### Catalog build

- The editor no longer ships an inline `<script>`: CodeMirror mounts from the plugin bundle into a script-free iframe document, so the keyboard isolation stays and the bundle is readable for review.
- The IDE window opens with `host.openSession(…, {intent: 'window'})`, finds "a chat on screen" with `host.composer.getDraft`, and hides the session list with `host.paneVisibility('sessions')`.
- The Explorer is a resizable panel inside the Editor column (the SDK cannot size a docked column; a separate Explorer would take a quarter of the window).
- The project UI is a **Run** view in the Explorer panel; its page opens in the app's own Browser pane from a link, and the element picker and page reload run through `ctx.preview.executeJavaScript`, behind the app's per-site consent.
- IDE chats carry a clickable **IDE** badge, and the status-bar **IDE** button gains an IDE chats menu (open, new IDE chat, remove).
- One raw bridge call remains, the window maximize, disclosed in the README.

### Security

- Credential files are refused in every Hermes home and profile, under any spelling of the path (case, `\\?\` prefixes, symlinks): `.env` backups, token, secret, OAuth and password files, `honcho.json`, key files, `mcp-tokens/`, `secrets/`. v0.3 checked two names in the active home only, and a `\\?\` path or a search could read them.
- Search and Quick Open never return credential files.
- Dev servers and dependency installs no longer inherit the gateway's provider keys.
- Static sites run on the plugin's own server: no dotfiles, no folder listings, localhost Host header only (Python's `http.server` served `.env` and `.git`).
- Trust is tied to the folder and the exact dev script; the plain **Run** button no longer grants it; Settings lists trusted projects with **Revoke**.
- Windows trash asks before deleting what it cannot recycle, instead of deleting it for good.
- Rename and trash act on a symlink itself, not its target. `ide_open` refuses network paths.

### Fixes

- Renaming a file or folder keeps its open tabs and their unsaved edits (v0.3 discarded them).
- Trashing a folder closes only the tabs inside it, and never discards unsaved edits.
- A crash-recovery draft typed against an older file version opens with a conflict banner instead of a save that overwrites the agent's newer edit. Drafts are kept per chat.
- Saving a file that was deleted on disk asks first instead of recreating it.
- Disk sync never overwrites a keystroke made during the sync, keeps the cursor and scroll when the agent edits the open file, reviews several agent edits in one turn against the text before the first, and keeps the "agent edit" flag through a debounce.
- Background `git status` never takes `index.lock` while the agent commits.
- Search reports a bad regex instead of "no results", and jumps to the right column on non-ASCII lines.
- Folder listings sort before capping, so folders do not vanish in large directories. Case-only renames work on Windows and macOS.
- OS errors and timeouts come back as readable errors instead of a bare 500.
- Project detection requires the framework's command in the dev script (one `npm run` hop allowed): a `vite` dependency used only by vitest is no longer a UI.
- A Stop during start kills the just-spawned server; the lease clock restarts after the machine sleeps.
- The agent's `ide_open` finds its chat after compaction; open requests are kept per chat.
- The transcript card opens the IDE window from the main window.
- The full build sizes its columns with the app's Browser pane open (it used to keep a half-screen preview and squeeze every IDE column), and hides a date-group row only for chats its group lists.
- The dead Terminal toggle is gone (the SDK allows no terminal action); Ctrl+Alt+E no longer collides with AltGr+E.
- A restored tab whose file is gone closes with a note instead of an error on every open. Mixed line endings no longer collapse a file to one line.

### Docs

- README rewritten (two builds, security and privacy disclosures, known limits), new screenshot. ARCHITECTURE, FEATURES and DEVELOPING updated. Catalog submission kit in `docs/CATALOG-SUBMISSION.md`. CI checks both bundles are reproducible from source.

## 0.3.0 (2026-11-02)

Columns you arrange, the project's UI in a Browser column, IDE chats in the sidebar: Explorer, Editor and Browser as separate app tiles, layout memory per chat, titlebar toggles, project UI detection and dev servers with trust and a lease, an element picker, `ide_open` with a URL, an IDE group under SESSIONS.

## 0.2.0 to 0.2.3 (2026-11-01 to 2026-11-02)

The IDE became its own pop-out window holding one chat: claimed single-session pop-outs, maximize, session list hidden, fixes for opening from a non-chat page, delayed maximize and compacted chats.

## 0.1.0 (2026-11-01)

First release: Explorer, Search, Source Control, a CodeMirror editor in a sandboxed frame, Quick Open, Add to Chat, inline edit, agent-edit review, the backend routes and the `ide_open` tool.
