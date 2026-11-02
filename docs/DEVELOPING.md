# Developing Hermes IDE

## Layout

```
hermes-ide/
├── plugin.yaml, __init__.py      agent half (ide_open tool)
├── dashboard/                    backend: manifest.json, plugin_api.py, dist/index.js (empty web-dashboard entry)
├── desktop/plugin.js             desktop half, BUILT from src/ and committed (installs do not build)
├── src/                          desktop half source (TSX) and the editor frame (src/frame)
├── dev/                          build tooling: package.json, build.mjs, cdp.mjs
├── tests/                        backend tests (pytest) and helper tests (node --test)
└── docs/
```

Build tooling lives in `dev/` on purpose: a `package.json` at the package root makes `hermes plugins install` offer to install Node dependencies, which the installed plugin does not need.

## Build and test

```bash
cd dev
npm ci
npm run build          # desktop/plugin.js; fails if any import other than @hermes/plugin-sdk, react, react/jsx-runtime remains
npm test               # tests/util.test.mjs
cd ..
uv run --with pytest --with fastapi --with httpx python -m pytest tests -q   # backend routes and the ide_open tool
```

Commit `desktop/plugin.js` with the source change that produced it.

## Live loop against your own Desktop

The app loads the copy at `$HERMES_HOME/desktop-plugins/hermes-ide/plugin.js`, not the package. Two ways to iterate:

- **Linked checkout (hot reload on save).** Link the checkout into the plugins folder (`ln -s` on macOS and Linux, `mklink /J` on Windows), enable the plugin, and run `npm run watch` in `dev/`. Desktop re-syncs the linked copy on every build.
- **Copy.** After `npm run build`, copy `desktop/plugin.js` over the installed copy. Desktop hot-reloads it within a few seconds.

Backend changes need the gateway to re-import `plugin_api.py`: `hermes gateway restart`.

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
7. Drive it with `node dev/cdp.mjs …` (see the header of that file). `node dev/cdp.mjs pages` lists the windows; prefix a command with `WIN=secondary` to target the IDE window. Useful checks:
   - send one message in the main window (a draft has no session to pop out), then `eval "document.querySelector('.hi-open-ide').click()"` and `WIN=secondary node dev/cdp.mjs eval "innerWidth"` (expect the screen width: the IDE window maximizes)
   - `WIN=secondary … eval` on `[data-tree-group]` rects: expect the IDE tile, `grp-main` (the chat) and, after Open in Browser, the preview zone, sized per `columnPlan`
   - `WIN=secondary node dev/cdp.mjs frame "document.querySelector('.cm-content').innerText"` to read the editor
   - `key "Control+Shift+F"`: use the shifted capital letter; a lowercase `f` with Shift is not what a real keyboard sends and CodeMirror routes it differently
8. Close the sandbox app, stop the sandbox gateway, and delete the sandbox home.

`dev/cdp.mjs` resets Playwright's color-scheme emulation on attach. Without that reset, a Desktop set to the System theme flips to light while the driver is connected, and every screenshot and token read lies about what the user sees.

## Release

1. Bump `version` in `plugin.yaml`, `dashboard/manifest.json` and `dev/package.json`.
2. Build, run both test suites, run the sandbox checks for anything you touched.
3. Commit (including `desktop/plugin.js`), tag `vX.Y.Z`, push.
4. Users update with `hermes plugins update hermes-ide` or **Capabilities → Plugins**.
