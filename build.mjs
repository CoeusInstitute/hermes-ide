// Builds desktop/plugin.js: one plain ESM file that imports only @hermes/plugin-sdk, react and
// react/jsx-runtime (the only specifiers the Hermes Desktop disk loader resolves). The CodeMirror
// editor is bundled separately into an IIFE and inlined as the editor frame's srcdoc.
//
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change

import { build, context } from 'esbuild'
import { readFileSync, statSync, writeFileSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const EXTERNAL = ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']

const FRAME_CSS = `
html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:var(--ui-text-primary);font-family:var(--font-sans,system-ui,sans-serif)}
#editor{position:absolute;inset:0}
#empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--ui-text-quaternary);font-size:13px;text-align:center;line-height:1.7}
#empty kbd{font-family:var(--font-mono,monospace);font-size:11.5px;padding:1px 5px;border-radius:4px;border:1px solid var(--ui-stroke-tertiary)}
#menu{position:fixed;display:none;z-index:10;min-width:210px;padding:4px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated,var(--ui-bg-secondary));box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:12.5px}
#menu button{display:flex;width:100%;justify-content:space-between;gap:24px;padding:5px 8px;border:0;border-radius:5px;background:none;color:var(--ui-text-primary);font:inherit;cursor:pointer;text-align:left}
#menu button:hover{background:var(--ui-row-active-background)}
#menu kbd{font-family:inherit;color:var(--ui-text-tertiary)}
#menu .sep{height:1px;margin:4px 6px;background:var(--ui-stroke-tertiary)}
.ide-inline{display:flex;align-items:center;gap:10px;padding:7px 12px;font-size:12.5px}
.ide-inline-label{color:var(--ui-accent);white-space:nowrap;font-weight:500}
.ide-inline input{flex:1;height:26px;padding:0 9px;font:inherit;color:var(--ui-text-primary);background:var(--ui-bg-input,transparent);border:1px solid var(--ui-accent);border-radius:6px;outline:none}
`

async function frameHtml() {
  const out = await build({
    entryPoints: ['src/frame/editor.ts'],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    target: 'chrome120',
    legalComments: 'none'
  })
  // Inline <script>: a literal "</script" anywhere in the bundle would end the element early.
  const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_CSS}</style></head><body>` +
    `<div id="empty">Open a file from the Explorer<br><kbd>Ctrl+P</kbd> go to file &nbsp; <kbd>Ctrl+Alt+F</kbd> search</div>` +
    `<div id="editor"></div><div id="menu"></div><script>${js}</script></body></html>`
}

const framePlugin = {
  name: 'frame-html',
  setup(b) {
    b.onResolve({ filter: /^virtual:frame-html$/ }, () => ({ path: 'frame-html', namespace: 'virtual' }))
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, async () => ({
      contents: `export default ${JSON.stringify(await frameHtml())}`,
      loader: 'js',
      watchFiles: ['src/frame/editor.ts']
    }))
  }
}

const checkImports = {
  name: 'check-imports',
  setup(b) {
    b.onEnd(result => {
      if (result.errors.length) return
      const text = readFileSync('desktop/plugin.js', 'utf8')
      const specs = [...text.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
      const bad = specs.filter(s => !EXTERNAL.includes(s))
      if (bad.length || /\bimport\s*\(/.test(text)) {
        console.error('desktop/plugin.js imports something the Desktop loader refuses:', bad.length ? bad : 'dynamic import()')
        process.exitCode = 1
      } else {
        console.log(`desktop/plugin.js ${(statSync('desktop/plugin.js').size / 1024).toFixed(0)} KB, imports: ${[...new Set(specs)].join(', ')}`)
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
  banner: { js: '// Hermes IDE desktop plugin. Built from src/ by build.mjs; do not edit by hand.' },
  plugins: [framePlugin, checkImports]
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching src/ …')
} else {
  await build(options)
}

