// Builds desktop/plugin.js: one plain ESM file that imports only @hermes/plugin-sdk, react and
// react/jsx-runtime (the only specifiers the Hermes Desktop disk loader resolves). CodeMirror is
// bundled with the rest and renders into the editor iframe, whose srcdoc is plain markup (styles
// and three empty elements, no script).
//
// Two targets, one source:
//   catalog  (default) stays inside the Desktop plugin SDK surface, so `hermes plugins validate`
//            passes: what the Hermes plugin catalog lists.
//   full     adds the features that need the app's own markup until the SDK has hooks for them
//            (src/full/: the sidebar's IDE group, an in-column Browser, column fitting and
//            layout memory, window maximize). For a local install; never listed.
//
//   cd dev && npm ci && npm run build      build once (catalog)
//   npm run build:full                     the full build
//   npm run watch                          rebuild on change

import { build, context } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeLezerTables } from './lezer-tables.mjs'

// Dev tooling lives in dev/ so the installed plugin carries no package.json (Hermes would offer
// to npm-install it). Paths below are relative to the repository root.
const DEV = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DEV, '..')
process.chdir(ROOT)
const nodePaths = [resolve(DEV, 'node_modules')]

const watch = process.argv.includes('--watch')
const targetArg = process.argv.find(a => a.startsWith('--target='))?.slice(9) ?? 'catalog'
if (targetArg !== 'catalog' && targetArg !== 'full') {
  console.error(`unknown --target=${targetArg} (catalog | full)`)
  process.exit(1)
}
const CATALOG = targetArg === 'catalog'
const EXTERNAL = ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']

const FRAME_CSS = `
html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:var(--ui-text-primary);font-family:var(--font-sans,system-ui,sans-serif)}
#editor{position:absolute;inset:0}
#empty{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--ui-text-tertiary);font-size:12.5px}
#empty .wm{display:grid;grid-template-columns:auto auto;column-gap:16px;row-gap:2px;align-items:center}
#empty .wm button{display:contents;font:inherit;color:inherit;cursor:pointer}
#empty .wm span{padding:5px 0;text-align:right;white-space:nowrap}
#empty .wm b{display:flex;gap:3px;padding:5px 0;font-weight:400}
#empty .wm button:hover span{color:var(--ui-text-primary)}
#empty kbd{min-width:12px;padding:1px 5px;border-radius:4px;border:1px solid var(--ui-stroke-tertiary);font-family:var(--font-mono,monospace);font-size:11px;line-height:16px;text-align:center;color:var(--ui-text-secondary);background:color-mix(in srgb,var(--ui-text-primary) 5%,transparent)}
#menu{position:fixed;display:none;z-index:10;min-width:210px;padding:4px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated,var(--ui-bg-secondary));box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:12.5px}
#menu button{display:flex;width:100%;justify-content:space-between;gap:24px;padding:5px 8px;border:0;border-radius:5px;background:none;color:var(--ui-text-primary);font:inherit;cursor:pointer;text-align:left}
#menu button:hover{background:var(--ui-row-active-background)}
#menu kbd{font-family:inherit;color:var(--ui-text-tertiary)}
#menu .sep{height:1px;margin:4px 6px;background:var(--ui-stroke-tertiary)}
.ide-inline{display:flex;align-items:center;gap:10px;padding:7px 12px;font-size:12.5px}
.ide-inline-label{color:var(--ui-accent);white-space:nowrap;font-weight:500}
.ide-inline input{flex:1;height:26px;padding:0 9px;font:inherit;color:var(--ui-text-primary);background:color-mix(in srgb,var(--ui-text-primary) 5%,transparent);border:1px solid var(--ui-accent);border-radius:6px;outline:none}
`

// The empty editor: the keys that matter most, one compact table (each row runs its command).
const WATERMARK = [
  ['quickOpen', 'Go to File', 'Ctrl P'],
  ['findInFiles', 'Search in Files', 'Ctrl Shift F'],
  ['explorer', 'Show Explorer', 'Ctrl Shift E'],
  ['runUi', "Run Project's UI", 'Ctrl Alt R'],
  ['palette', 'Command Palette', 'Ctrl Shift P'],
  ['openFolder', 'Open Folder', '']
]

function frameHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_CSS}</style></head><body>` +
    `<div id="empty"><div class="wm">${WATERMARK.map(([cmd, label, keys]) => `<button data-cmd="${cmd}"><span>${label}</span><b>${keys ? keys.split(' ').map(k => `<kbd>${k}</kbd>`).join('') : ''}</b></button>`).join('')}</div></div>` +
    `<div id="editor"></div><div id="menu"></div></body></html>`
}

const framePlugin = {
  name: 'frame-html',
  setup(b) {
    b.onResolve({ filter: /^virtual:frame-html$/ }, () => ({ path: 'frame-html', namespace: 'virtual' }))
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
      contents: `export default ${JSON.stringify(frameHtml())}`,
      loader: 'js'
    }))
  }
}

// Lezer grammars carry their parse tables as packed strings that the parser decodes at startup;
// the bundle gets them already decoded, as plain integer arrays (dev/lezer-tables.mjs, checked by
// tests/lezer-tables.test.mjs).
const lezerTables = {
  name: 'lezer-tables',
  setup(b) {
    b.onLoad({ filter: /[\\/]node_modules[\\/]@(?:lezer|codemirror)[\\/][^\\/]+[\\/]dist[\\/]index\.js$/ }, async args => {
      const src = await readFile(args.path, 'utf8')
      const out = decodeLezerTables(src)
      return out === src ? undefined : { contents: out, loader: 'js', resolveDir: dirname(args.path) }
    })
  }
}

// The bundle's real imports, from esbuild's own metafile (a text scan would trip over source that
// merely mentions the word import, such as a language's keyword list).
const checkImports = {
  name: 'check-imports',
  setup(b) {
    b.onEnd(result => {
      if (result.errors.length || !result.metafile) return
      const out = Object.values(result.metafile.outputs)[0]
      const specs = out.imports.map(i => i.path)
      const bad = out.imports.filter(i => !i.external || i.kind !== 'import-statement' || !EXTERNAL.includes(i.path))
      if (bad.length) {
        console.error('desktop/plugin.js imports something the Desktop loader refuses:', bad.map(i => `${i.kind} ${i.path}`))
        process.exitCode = 1
      } else {
        console.log(`desktop/plugin.js (${targetArg}) ${(statSync('desktop/plugin.js').size / 1024).toFixed(0)} KB, imports: ${[...new Set(specs)].join(', ')}`)
      }
    })
  }
}

const options = {
  entryPoints: ['src/plugin.tsx'],
  outfile: 'desktop/plugin.js',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  jsx: 'automatic',
  external: EXTERNAL,
  minifySyntax: true,
  legalComments: 'none',
  nodePaths,
  absWorkingDir: ROOT,
  metafile: true,
  // __CATALOG__ is a build constant: the full-only branches (and the src/full/ modules only they
  // import) are dropped from the catalog bundle, not just skipped at run time.
  define: { __CATALOG__: String(CATALOG) },
  banner: { js: `// Hermes IDE desktop plugin (${targetArg} build). Built from src/ by dev/build.mjs; do not edit by hand.` },
  plugins: [lezerTables, framePlugin, checkImports]
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching src/ …')
} else {
  await build(options)
}

