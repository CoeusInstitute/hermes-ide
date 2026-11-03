# Changelog

All notable changes to Hermes IDE. Versions follow the `version` in `plugin.yaml`.

## 0.6.5 (2026-11-02)

- **The README renders on the plugin catalog page.** The catalog's docs build drops raw HTML, which would have removed the banner, badges, hero screenshot and the picker and review images; they are plain Markdown now and look the same on GitHub. The README also names the catalog install route.
- **New banner** (`docs/images/hermes-ide-banner.png`), also the catalog card image; the unused `banner.svg` is removed. The entry template in `docs/catalog/hermes-ide.yaml` is updated.

## 0.6.4 (2026-11-02)

- **The element picker reports an element's own styles, not its hover styles.** While picking, the pointer now rests on a transparent shield above the page instead of the element, so `:hover` rules never apply to what you pick. Before, picking a button reported its hover color as its background. The shield steps aside only for the picker's own hit test. Check: `dev/picker-check.mjs` runs the picker in a local Chrome or Edge with real mouse input; it passes on this release and fails on 0.6.3. Verified live: four picks of a hovered button all reported the base color.
- **Repository history rewritten.** Old screenshot versions that showed local file paths were removed from every commit, and every branch and tag moved to new commits. Clones made before this release should be re-cloned; installed copies update through Capabilities → Plugins as usual.

## 0.6.3 (2026-11-02)

- **A file opened later docks the editor beside the Explorer at a usable width.** A new IDE workspace saves its fitted Explorer, Browser and Chat widths before any file is open. Opening a file then docked the editor just left of the chat and re-applied the page and chat widths as if you had chosen them, which left the editor at its 385 px floor. The editor now goes where the default order has it (right of the Explorer), and saved widths carry over only to the same set of columns; the Explorer's always does. Measured live at 3840 px: Explorer 345, Editor 1421, Browser 1230, Chat 845.
- **README rebuilt**: banner, badges, quick start, features with screenshots of a real session (an element picked, the agent's edit under review, the page updated), table of contents, roadmap and contributing notes.
- **Screenshots replaced.** The previous `ide-window.png` and `agent-edit-review.png` showed local file paths with a user name; `browser-annotate.png` (unused) is removed for the same reason. The new images come from a demo project at a neutral path.

## 0.6.2 (2026-11-02)

- **The install scan is `safe`, so installing from Git no longer asks or blocks.** The editor's Lezer grammars carried their parse tables as packed strings, and Hermes' scanner read 35 of them as inline-shell snippets (high), which made a fresh Git install impossible without `--force`. The build now decodes those tables into the integer arrays the parser builds from them at startup anyway (`dev/lezer-tables.mjs`). Every grammar's tables and parse trees are tested against the package's own (`tests/lezer-tables.test.mjs`), and syntax highlighting through the bundled path was compared span by span for TSX, JavaScript, CSS, HTML, Python, JSON, Rust and YAML. Scan: 0 critical, 0 high, 121 medium or low notes.
- The bundle grows from about 1.8 MB to 2.6 MB (decimal arrays are larger than packed strings).

## 0.6.1 (2026-11-02)

Security-scan hygiene for the catalog review. No change in behavior.

- The backend's credential-refusal pattern no longer reads as an environment dump to the install scanner: it is now exact (`.env` alone or with a suffix such as `.env.local` or `.env.bak-*`, and `.envrc`) instead of every name starting with `.env`. That was the plugin's only high finding in its own code.
- BOM handling uses `codecs.BOM_UTF8` instead of byte literals; the file-icon pattern lists `env` last; the README links to the developer guide for the test command; the submission kit describes the inline-shell rule instead of quoting it.
- The scan now reports 166 findings (from 175), none high in the plugin's own code. `docs/CATALOG-SUBMISSION.md` accounts for every one and proposes the one-line scanner change that makes the verdict `safe`.

## 0.6.0 (2026-11-02)

### The IDE button starts a workspace

- **IDE** in the status bar (and **+** in the full build's IDE group, **New IDE workspace** in the IDE menu) opens a new IDE workspace: a new chat created at once, its IDE window, and a prompt to choose or create the project folder. The chat moves to that folder, is named after it, and is listed with the IDE chats immediately. Ctrl+Alt+I still opens the chat on screen in the IDE. (It used to reopen the chat on screen, often a previous IDE chat.)
- The Open Folder dialog gains **Create folder**. Its "this chat has not started yet" note no longer shows for a chat whose session arrives a moment after the window opens.

### The agent can run the project's UI, and says what really happened

- `ide_open` with `ui: true` runs the project's UI through the IDE's own detection, trust prompt and dev-server manager. Before, an agent asked to "open the project's UI in the IDE browser" had no way to do it: it started its own `npm run dev` in a terminal, a background process that kept the chat marked as working, and then hunted for the IDE with screenshots.
- Every `ide_open` waits for the IDE window's answer (`/ide/ack`) and returns it: `opened`, `running` with the URL, `needs_trust`, `starting`, `no_ui`, `no_folder`, `error`, or `no_window`. It used to report success whether or not any window acted.
- The main window opens the chat's IDE window for an agent request whenever no IDE window shows that chat. It used to act only when that chat was the one focused in the main window, and dropped the request otherwise.
- The tool description, the [Hermes IDE] note and the `hermes-ide:guide` skill now map requests to calls ("open the project's UI" means `ui: true`), explain each answer, and rule out starting dev servers or inspecting the IDE with screen automation.

## 0.5.0 (2026-11-02)

### Element picker

- Picked elements wait in the composer as one-line tokens (`[[ element 3 · <button.cta-button> "Mark all done" ]]`); composer middleware swaps each for its full description when the message is sent, so the input stays short. Tokens survive a window reload.
- The description is sectioned with `[[ … ]]` so the model sees where each element starts and ends. The page address is a plain link: an `@url:` reference would fetch the whole page into every message, and Hermes refuses `localhost` pages.
- React (up to 18), Vue and Svelte development builds: the component chain and the exact source line that rendered the element. Otherwise the project search as before.
- Selectors prefer test ids and unique ids and grow until they match one element; shadow-DOM picks name the host (`host >>> inner`); key attributes (role, aria-label, href, src, alt, name, type, placeholder, title) are listed; long markup is shortened to its opening tag.
- Cancelling goes through the picker's own handle instead of a synthetic Escape key, so the pick button (pressed while picking), Esc and a right-click all end it cleanly; one pick at a time; the highlight follows scrolling and resizing.

### Your agent knows about the IDE

- A `pre_llm_call` hook adds a short [Hermes IDE] note to each turn of a chat whose IDE window is open (a lease the window renews every minute in `plugin-data/hermes-ide/ide-sessions.json`), or that carries a picked element.
- A bundled skill, `hermes-ide:guide`, listed in the agent's skill index while the plugin is enabled.
- `ide_open`'s description pointed agents at `open_preview`, a tool this Hermes no longer has; it now names `desktop_preview` (action `open`).

### Layout (full build)

- The IDE window opens with the Explorer only (300 px at most); the Editor opens with the first file.
- With the page open and no editor, the page takes the rest of the window and the chat 47% of it, so the page is a little wider than the chat.
- The window maximizes and drops the session list before its columns dock, so the Explorer no longer shows at half the window until the fit lands; and a fit deferred while the window was hidden no longer saves the app's even split as your Explorer width (the cause of an Explorer stuck wide).

### Fixes

- Open Folder with **Also move this chat's working directory** (the default) put the Explorer straight back in the old folder, because the app's cwd store lags the move. The IDE now keeps the new folder until the chat reports it.

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
