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
2. In the sandbox `config.yaml`, empty `mcp_servers` and `plugins`, and clear `memory.provider`, so the sandbox starts no MCP servers and writes nothing to shared memory.
3. Install from GitHub into the sandbox: `HERMES_HOME=<sandbox> hermes plugins install CoeusInstitute/hermes-ide --enable`.
4. Launch the packaged app (Windows example):

   ```bash
   HERMES_HOME='C:\…\sandbox' HERMES_DESKTOP_USER_DATA_DIR='C:\…\sandbox\userdata' HERMES_DESKTOP_APP_NAME=HermesIDESandbox \
     powershell -NoProfile -Command "Start-Process '<…>\Hermes.exe' -ArgumentList '--remote-debugging-port=9223'"
   ```

   Pass native Windows paths; a Git Bash `/c/...` path silently creates an empty twin home.
5. Turn on the desktop half in **Capabilities → Plugins** (search `Hermes IDE`).
6. Drive it with `node dev/cdp.mjs …` (see the header of that file). Useful checks:
   - `node dev/cdp.mjs key "Control+Alt+i"` then `eval "document.querySelectorAll('.hi-pane').length"` (expect 2)
   - `frame "document.querySelector('.cm-content').innerText"` to read the editor
   - `key "Control+Shift+F"`: use the shifted capital letter; a lowercase `f` with Shift is not what a real keyboard sends and CodeMirror routes it differently
7. Close the sandbox app and delete the sandbox home.

`dev/cdp.mjs` resets Playwright's color-scheme emulation on attach. Without that reset, a Desktop set to the System theme flips to light while the driver is connected, and every screenshot and token read lies about what the user sees.

## Release

1. Bump `version` in `plugin.yaml`, `dashboard/manifest.json` and `dev/package.json`.
2. Build, run both test suites, run the sandbox checks for anything you touched.
3. Commit (including `desktop/plugin.js`), tag `vX.Y.Z`, push.
4. Users update with `hermes plugins update hermes-ide` or **Capabilities → Plugins**.
