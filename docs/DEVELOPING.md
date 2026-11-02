# Developing Hermes IDE

## Layout

```
hermes-ide/
├── plugin.yaml, __init__.py      agent half (ide_open tool)
├── dashboard/                    backend: manifest.json, plugin_api.py, static_server.py
├── desktop/plugin.js             desktop half, BUILT from src/ and committed (installs do not build)
├── src/                          desktop half source (TSX), the editor (src/frame), full-build extras (src/full)
├── dev/                          build tooling: package.json, build.mjs, cdp.mjs
├── tests/                        backend tests (pytest) and helper tests (node --test)
└── docs/
```

Build tooling lives in `dev/` on purpose: a `package.json` at the package root makes `hermes plugins install` offer to install Node dependencies, which the installed plugin does not need.

## Build and test

```bash
cd dev
npm ci
npm run build          # catalog build → desktop/plugin.js (the default)
npm run build:full     # full build → desktop/plugin.js
npm test               # tests/util.test.mjs
cd ..
uv run --with pytest --with fastapi --with httpx python -m pytest tests -q   # backend routes and the ide_open tool
hermes plugins validate .                                                    # catalog admission checks
```

Both builds fail if any import other than `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` remains (read from esbuild's metafile). The first line of `desktop/plugin.js` names the build it holds; CI rebuilds that target and fails if the committed file differs.

**Which build goes where.** `main` carries the full build (what **Install from Git** installs); the `catalog` branch carries the catalog build of the same source, and the catalog entry pins a commit on it. After a change: build and commit the full build on `main`, then on `catalog` merge `main`, rebuild with `npm run build`, run `hermes plugins validate .`, and commit the catalog bundle. Commit `desktop/plugin.js` with the source change that produced it.

**Writing code that stays listable.** Anything that reads or changes the app's own markup (`data-*` attributes of core UI, a `document.body` MutationObserver, synthetic input on core controls, a raw `window.hermesDesktop` call other than the maximize, a `<webview>`) goes in `src/full/` and is called only from `if (!__CATALOG__)`. `hermes plugins validate .` on the catalog build is the check; it must keep saying "stays inside the plugin SDK surface", with the maximize call as its only review warning. The security scan's `inline_shell_exec` cautions are CodeMirror's Lezer parse tables (`stateData`, `goto`, `tokenData` strings), not code.

## Live loop against your own Desktop

The app loads the copy at `$HERMES_HOME/desktop-plugins/hermes-ide/plugin.js`, not the package. Two ways to iterate:

- **Linked checkout (hot reload on save).** Link the checkout into the plugins folder (`ln -s` on macOS and Linux, `mklink /J` on Windows), enable the plugin, and run `npm run watch` in `dev/`. Desktop re-syncs the linked copy on every build.
- **Copy.** After `npm run build`, copy `desktop/plugin.js` over the installed copy. Desktop hot-reloads it within a few seconds.

Backend changes need the gateway to re-import `plugin_api.py`: `hermes gateway restart`. The same is true for users updating a plugin over a running gateway; the project UI shows a banner when `/project/detect` is missing (a FastAPI "Not Found").

nanostores `subscribe` calls its listener at once; use `listen` for "when this changes", or a listener runs at boot before the window has its columns (that once saved an empty tile list as a chat's layout).

Hot reload keeps earlier module instances alive (ES modules cannot be unloaded), so judge behavior after a window reload, not after a chain of hot reloads.

## Verifying a release in a sandboxed Desktop

Never test against your real profile. Run a second Desktop with its own Hermes home, user-data folder and app name, and drive it over CDP.

1. Create the sandbox home and copy only `config.yaml`, `.env`, `auth.json` and `profile.yaml` into it. Those copies are secrets: delete the sandbox when you are done.
2. In the sandbox `config.yaml`, empty `mcp_servers`, set `plugins.enabled` to `[hermes-ide]`, and clear `memory.provider`, so the sandbox starts no MCP servers and writes nothing to shared memory. In the sandbox `.env`, delete every `API_SERVER_*` line: a copied `API_SERVER_PORT` binds the same port as your real gateway.
3. Install into the sandbox. From GitHub: `HERMES_HOME=<sandbox> hermes plugins install CoeusInstitute/hermes-ide --enable`. To test an unpushed build, copy the package to `<sandbox>/plugins/hermes-ide/` and `desktop/plugin.js` to `<sandbox>/desktop-plugins/hermes-ide/plugin.js`.
4. Start the sandbox gateway yourself (the packaged app cannot spawn a detached gateway from a script-launched process on Windows and reports `windows_breakaway_unavailable`): `HERMES_HOME=<sandbox> hermes gateway run` in a background shell.
5. Launch the packaged app against your existing Hermes checkout, so it does not install a second runtime (Windows example):

   ```bash
   HERMES_HOME='C:\…\sandbox' HERMES_DESKTOP_USER_DATA_DIR='C:\…\sandbox\userdata' HERMES_DESKTOP_APP_NAME=HermesIDESandbox \
   HERMES_DESKTOP_HERMES_ROOT='C:\…\hermes\hermes-agent' \
     powershell -NoProfile -Command "Start-Process '<…>\Hermes.exe' -ArgumentList '--remote-debugging-port=9223'"
   ```

   Pass native Windows paths; a Git Bash `/c/...` path silently creates an empty twin home. The first boot may build its own Python environment inside the sandbox (about 800 MB, a few minutes); it does not touch your real one.
6. Turn on the desktop half in **Capabilities → Plugins** (search `Hermes IDE`), or set `{"hermes-ide": true}` in the `hermes.desktop.pluginDecisions.v2` localStorage key and reload the window.
7. Drive it with `node dev/cdp.mjs …` (see the header of that file). `node dev/cdp.mjs pages` lists the windows; prefix a command with `WIN=secondary` to target the IDE window, plus `SID=<part of the session id>` when several IDE windows are open. Set them per command, never with `export`: the shell keeps exports between commands, and every later "main window" check silently runs against an IDE window instead (with no main page matched, the harness falls back to the first window). The full build's IDE window exposes `window.__hermesIde` (`readColumns`, `fitColumns`, `savedLayout`, `captureLayout`) for these checks; the catalog build exposes nothing. Useful checks:
   - columns: `WIN=secondary node dev/cdp.mjs eval "__hermesIde.readColumns().map(c => c.ids.join('+') + ':' + Math.round(c.width))"`
   - move a column with a real pointer drag of its tab: read the tab's centre (`[role=tab]` whose text is `Editor`), then `WIN=secondary node dev/cdp.mjs drag "364,17 3820,760"` (onto the right edge of the chat zone)
   - project UI: create a small Vite app (`package.json` with `"dev": "vite"` and `vite` in devDependencies, an `index.html`), leave `node_modules` out to exercise **Install & run**, open it with Open Folder, and read `.hi-bsub` and the webview's `getURL()`. A page that calls `alert()` blocks its webview until the native message box (titled with the app name) is answered, so keep alerts out of demo pages
   - element picker: the webview guest is not a CDP page; read element positions with `webview.executeJavaScript(...)` from the IDE window and click with `click x,y` (real input reaches the guest)
   - the main window's IDE group: `[data-hermes-ide-group]`, hidden rows `.hi-ide-hidden`, badges `.hi-ide-badge`; pin with `globalThis.__HERMES_PLUGIN_SDK__.host.sessions.pin(id, true)`
   - a saved layout is rewritten by the window's own saver every few seconds and on unload, so set `hermes.plugin.hermes-ide.layout` and reload in the same `eval`, or use **IDE: Reset Column Layout**
   - send one message in the main window (a draft has no session to pop out), then `eval "document.querySelector('.hi-open-ide').click()"` and `WIN=secondary node dev/cdp.mjs eval "innerWidth"` (expect the screen width: the IDE window maximizes)
   - `WIN=secondary node dev/cdp.mjs frame "document.querySelector('.cm-content').innerText"` to read the editor
   - `key "Control+Shift+F"`: use the shifted capital letter; a lowercase `f` with Shift is not what a real keyboard sends and CodeMirror routes it differently
   - inputs without a `type` attribute: select them with `[role=dialog] input` and `i.type === 'text'`, not `input[type=text]`; focus and `select()` before `type`, or the text is appended to the current value
   - catalog build, project UI: the Run view is `button[aria-label="Project UI"]`; the page link is `.hi-open-page a` (click it with real input); the picker raises the app's consent dialog (`[role=dialog]`, **Allow on this site**); the page's `webview` is the app's own, so read positions with `executeJavaScript` from the test harness only
   - the full build's IDE group mounts only in the date-grouped list (`data-sessions-mode="flat"`). A sandbox whose chat sits in an auto-discovered project shows the project view instead: **Filters → Reset to defaults** in the session list brings back the date-grouped list
   - the app restores a chat's Browser pane at the share it last had, so a pane opened in one test run changes the next run's column widths
   - a desktop chat does not start in the sandbox `config.yaml`'s `terminal.cwd`; open the demo project with **Open Folder** (with **Also move this chat's working directory** ticked, the default, so the agent works there too), and make sure the folder exists first: a missing one leaves the dialog open
   - the element picker: engage with the inspect button, then `webview.executeJavaScript("typeof window.__hermesIdePick")` says whether a pick is live; the composer holds tokens (`[[ element N · … ]]`) and `sessionStorage['hermes-ide:picks']` their blocks; send a message to check the expansion in the transcript. For component detection use a React 18 dev app (`@vitejs/plugin-react`): React 19 has no `_debugSource`
   - the agent half: `plugin-data/hermes-ide/ide-sessions.json` in the sandbox home holds the open IDE chats; to check the hook, ask the sandbox agent to quote the [Hermes IDE] note; to check the skill, ask it whether `hermes-ide:guide` is in its skill index (`hermes skills list` does not show plugin skills)
8. Close the sandbox app, stop the sandbox gateway, and delete the sandbox home. Pick processes precisely:
   - the app: `Hermes.exe` processes whose `--user-data-dir` points into the sandbox. Never match a bare substring such as `9223` or `sandbox`: the cleanup shell's own command line contains it (the shell kills itself mid-command), and a renderer of your real Hermes app can carry the same digits in its arguments;
   - the gateway: the PID in `<sandbox>/gateway.pid`, once the real home's gateway status shows your own gateway under a different PID. The app restarts a sandbox gateway that dies while the app is open, so close the app first. Run the kill as a command of its own: Hermes refuses any command (or script) that mentions a gateway lifecycle command next to a kill, because from inside your session it cannot tell a sandbox gateway from the one running that session.

`dev/cdp.mjs` resets Playwright's color-scheme emulation on attach. Without that reset, a Desktop set to the System theme flips to light while the driver is connected, and every screenshot and token read lies about what the user sees.

## Release

1. Bump `version` in `plugin.yaml`, `dashboard/manifest.json`, `dev/package.json` and `VERSION` in `dashboard/plugin_api.py`; add the release to `CHANGELOG.md`.
2. Build both targets, run both test suites and `hermes plugins validate .` on the catalog build, and run the sandbox checks for anything you touched.
3. On `main`: commit the full build (including `desktop/plugin.js`), tag `vX.Y.Z`, push.
4. On `catalog`: merge `main`, `npm run build`, validate, commit the catalog bundle, push. For a catalog listing, open the SHA-bump PR described in [CATALOG-SUBMISSION.md](CATALOG-SUBMISSION.md).
5. Users update with `hermes plugins update hermes-ide` or **Capabilities → Plugins**, then `hermes gateway restart` when the backend changed.
