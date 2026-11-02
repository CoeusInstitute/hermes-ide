// The project's UI: finds the project's web UI, runs it through the backend's dev-server manager,
// and shows its page: in the full build's own Browser column, or (catalog build) in the app's
// Browser pane, reached only through ctx.preview with the user's per-site consent. The element
// picker sends what the user picks (selector, markup, styles and the source lines that likely
// render it) to the chat.

import { atom, host } from '@hermes/plugin-sdk'

import { $folderDialog, $root, $runAttention, $runUiRequest, $settings, $view, ackRequest, call, ctx, isMissingBackend, notify, openFile, openInBrowser, openTile, type Pending } from './core'
import { expandPickTokens, fileRef, isInside, pathKey } from './util'

export interface Candidate {
  id: string
  kind: 'node' | 'static'
  dir: string
  rel: string
  name: string
  framework: string
  command: string
  /** The package.json script text the command runs ('' for a static site). */
  run?: string
  installed: boolean
}

export interface Server {
  key: string
  id: string
  framework: string
  command: string
  state: 'installing' | 'starting' | 'ready' | 'exited'
  url: string | null
  exit_code: number | null
  log: string[]
}

export const $candidates = atom<Candidate[]>([])
export const $selected = atom<string | null>(null)
export const $server = atom<Server | null>(null)
/** A project found that the user has not trusted yet: the column asks before running its code. */
export const $askTrust = atom<Candidate | null>(null)
/** The gateway still runs an older IDE backend without project detection (a plugin update's
 *  Python loads only after a gateway restart). */
export const $backendStale = atom(false)

const selected = () => $candidates.get().find(c => c.id === $selected.get()) ?? null

/** A trusted project is the folder AND what it runs: when its dev script changes (a pull, an agent
 *  edit), the IDE asks again before running it. */
export const trustKey = (c: Pick<Candidate, 'dir' | 'command' | 'run'>) => `${pathKey(c.dir)}\n${c.command}\n${c.run ?? ''}`

export const $trusted = atom<string[]>([])

function trusted(): string[] {
  const v = ctx.storage.get('trustedProjects', [])
  // Keys from before v0.4 named only the folder: they no longer match, so those projects ask once.
  return Array.isArray(v) ? v.filter(k => typeof k === 'string' && k.includes('\n')) : []
}

export function trust(c: Candidate) {
  const next = [...new Set([...trusted(), trustKey(c)])]
  ctx.storage.set('trustedProjects', next)
  $trusted.set(next)
}

export function revokeTrust(key: string) {
  const next = trusted().filter(k => k !== key)
  ctx.storage.set('trustedProjects', next)
  $trusted.set(next)
}

let detectedFor = ''

/** Look for a UI in the IDE's folder. A trusted project with installed dependencies starts by
 *  itself (when the setting allows); otherwise the Browser column shows what was found. */
export async function detectProject(force = false) {
  const root = $root.get()
  if (!root || (!force && detectedFor === pathKey(root))) return
  detectedFor = pathKey(root)
  let r: { candidates: Candidate[]; servers: Server[] }
  try {
    r = await call('/project/detect', { root })
    $backendStale.set(false)
  } catch (e) {
    detectedFor = '' // try again next time (a gateway restart, a folder that comes back)
    // FastAPI's "Not Found" is a route this gateway does not have: an update it has not loaded.
    // (A missing folder is this plugin's own lower-case "not found".)
    if (isMissingBackend(e) && /Not Found/.test(String((e as Error)?.message ?? e))) $backendStale.set(true)
    return
  }
  if (pathKey($root.get() ?? '') !== pathKey(root)) return // the folder changed while we asked
  $candidates.set(r.candidates)
  const running = r.servers.find(s => s.state !== 'exited')
  const first = r.candidates.find(c => c.id === running?.id) ?? r.candidates[0]
  $selected.set(first?.id ?? null)
  $askTrust.set(null)
  if (running) {
    track(running)
    showFound()
    return
  }
  if (!first) return
  if (trusted().includes(trustKey(first)) && $settings.get().autoRunUi && first.installed) {
    void startUi()
    return
  }
  $askTrust.set(first)
  showFound(first)
}

/** A project UI was found. The full build opens its Browser column; the catalog build marks the
 *  Explorer panel's Run view and says so, without taking the panel from the files the user is on. */
function showFound(c?: Candidate) {
  if (!__CATALOG__) {
    openTile('browser')
    return
  }
  if ($view.get() === 'run') return
  $runAttention.set(true)
  if (c) {
    host.notify({
      kind: 'info',
      title: 'Hermes IDE',
      message: `Found ${c.kind === 'static' ? 'a static site' : `a ${c.framework} app`}${c.rel ? ` in ${c.rel}` : ''}.`,
      action: { label: 'Show', onClick: () => openTile('browser') }
    })
  }
}

export async function startUi(install = false) {
  const c = selected()
  const root = $root.get()
  if (!c || !root) {
    notify('info', 'No web UI was found in this folder. Type an address in the Browser instead.', 'Hermes IDE')
    return
  }
  $askTrust.set(null)
  openTile('browser')
  try {
    track(await call<Server>('/devserver/start', { root, id: c.id, install: install || !c.installed }))
  } catch (e) {
    notify('error', `Could not start ${c.framework}: ${(e as Error).message}`, 'Hermes IDE')
  }
}

export async function stopUi() {
  const s = $server.get()
  if (!s) return
  await call('/devserver/stop', { key: s.key }).catch(() => undefined)
  $server.set({ ...s, state: 'exited', exit_code: null })
}

export async function restartUi() {
  await stopUi()
  await startUi()
}

let poll = 0
let openedFor = ''

/** Follow one server until it is ready (then show it) or exits. The polls also keep its lease:
 *  the backend stops a server nobody has asked about for two minutes (the IDE window closed). */
function track(s: Server) {
  $server.set(s)
  clearInterval(poll)
  const tick = async () => {
    const root = $root.get()
    if (!root) return
    try {
      const r = await call<{ servers: Server[] }>('/devserver/status', { root })
      const cur = r.servers.find(x => x.key === s.key)
      if (!cur) {
        clearInterval(poll)
        const prev = $server.get()
        if (prev?.key === s.key && prev.state !== 'exited') $server.set({ ...prev, state: 'exited' })
        return
      }
      $server.set(cur)
      if (cur.state === 'ready' && cur.url && openedFor !== cur.key + cur.url) {
        openedFor = cur.key + cur.url
        openInBrowser(cur.url)
      }
      if (cur.state === 'exited') clearInterval(poll)
    } catch {
      /* gateway restarting: keep polling */
    }
  }
  poll = window.setInterval(tick, 1500)
  void tick()
}

// ── requests from the agent (ide_open) and from a new workspace ──────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const live = (s: Server | null) => !!s && s.state !== 'exited'

/** Do what this IDE window was asked, and answer the agent's ide_open call with what happened. */
export async function handleOpenRequest(p: Pending) {
  if (p.folder) $folderDialog.set('workspace')
  if (p.path) {
    const line = Number(p.line) > 0 ? Number(p.line) : undefined
    const shown = await openFile(p.path, { line })
    ackRequest(p.req, shown ? 'opened' : 'error', shown ? `Showing ${p.path}${line ? ` at line ${line}` : ''} in the IDE's editor.` : `The IDE could not open ${p.path}; it showed the user why.`)
  }
  if (p.url) {
    openInBrowser(p.url)
    ackRequest(p.req, 'opened', __CATALOG__ ? `Offered ${p.url} in the IDE's Run view; to show it in the app's Browser, call desktop_preview with action open and this url.` : `Showing ${p.url} in the IDE's Browser column.`, p.url)
  }
  if (p.ui) await runUiForAgent(p.req)
  if (!p.path && !p.url && !p.ui) ackRequest(p.req, 'opened', "The chat's IDE window is open.")
}

/** "Open the project's UI": the IDE's own detection and dev-server manager, never a server the
 *  agent starts (that would duplicate it and keep the chat marked working). An untrusted project
 *  waits for the user's answer in the trust banner; the call reports each step. */
async function runUiForAgent(req?: string) {
  const say = (status: string, detail: string, url = '') => ackRequest(req, status, detail, url)
  for (let i = 0; i < 25 && !$root.get(); i++) await sleep(200) // the folder syncs just after the window opens
  const root = $root.get()
  if (!root) return say('no_folder', 'The IDE has no folder open. Ask the user to choose one (IDE: Open Folder).')
  await detectProject(true)
  const c = selected()
  if (!c) {
    return say('no_ui', `No web UI was found in ${root}: no package.json dev script that runs a known framework's dev server (Vite, Next.js, Nuxt, Remix, SvelteKit, Astro, Angular, CRA and similar, at the root, one level down, or in apps/* or packages/*) and no index.html. Python web UIs are not detected.`)
  }
  const what = `${c.kind === 'static' ? 'static site' : `${c.framework} app`}${c.rel ? ` in ${c.rel}` : ''}`
  openTile('browser')
  if (!trusted().includes(trustKey(c))) {
    $askTrust.set(c)
    say('needs_trust', `Found a ${what} (${c.command}${c.run ? `: ${c.run}` : ''}). It runs the project's own code, so the IDE is asking the user to allow it (Always run for this project, or Run once) in its ${__CATALOG__ ? 'Run view' : 'Browser column'}; it starts when they do.`)
  } else if (!live($server.get())) {
    await startUi()
  }
  // Follow it until it is ready or exits (the user may answer the trust prompt meanwhile).
  for (const until = Date.now() + 50_000; Date.now() < until; await sleep(1000)) {
    const s = $server.get()
    if (s?.id !== c.id) continue
    if (s.state === 'ready' && s.url) {
      return say('running', `The ${what} is running at ${s.url}${__CATALOG__ ? `. It is offered in the IDE's Run view; to show it in the app's Browser, call desktop_preview with action open and this url` : " and showing in the IDE's Browser column"}.`, s.url)
    }
    if (s.state === 'exited') {
      return say('error', `The ${what}'s dev server exited${s.exit_code != null ? ` with code ${s.exit_code}` : ''}. Last output:\n${s.log.slice(-8).join('\n')}`)
    }
  }
  const s = $server.get()
  say(s?.id === c.id ? 'starting' : 'needs_trust', s?.id === c.id ? `The ${what} is still ${s.state}; the IDE shows it when it is ready.` : `Still waiting for the user to allow the ${what} in the IDE.`)
}

export function initBrowser() {
  $trusted.set(trusted())
  ctx.onDispose($root.subscribe(() => void detectProject()))
  ctx.onDispose($runUiRequest.subscribe((n: number) => n && void (selected() ? startUi() : detectProject(true))))
  ctx.onDispose(() => clearInterval(poll))
}

// ── element picker ───────────────────────────────────────────────────────────────────────────

/** Runs inside the page: highlight what the pointer is over, resolve with the clicked element's
 *  description, or null when cancelled (Esc, right-click, the IDE's button again). Self-contained: it
 *  is sent to the page as a string. One pick at a time: a second one ends the first, and
 *  `window.__hermesIdePick(null)` (CANCEL_PICK) ends it from outside. */
const PICKER = String.raw`(() => new Promise(resolve => {
  if (typeof window.__hermesIdePick === 'function') window.__hermesIdePick(null)
  const box = document.createElement('div')
  const tag = document.createElement('div')
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:3px;display:none'
  tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.6 ui-monospace,monospace;color:#fff;background:#1d4ed8;padding:0 6px;border-radius:3px;white-space:nowrap;display:none'
  document.documentElement.append(box, tag)
  let cur = null
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : s)
  const unique = s => { try { return document.querySelectorAll(s).length === 1 } catch (e) { return false } }
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa']
  const byAttr = el => {
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a)
      if (v) { const s = '[' + a + '="' + v.replace(/"/g, '\\"') + '"]'; if (unique(s)) return s }
    }
    return null
  }
  // The shortest selector that matches only this element: a test id, a unique id, else a tag and
  // class path that grows until it is unique.
  const sel = el => {
    const own = byAttr(el) || (el.id && unique('#' + esc(el.id)) ? '#' + esc(el.id) : null)
    if (own) return own
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
      if (n !== el) {
        const anchor = byAttr(n) || (n.id && unique('#' + esc(n.id)) ? '#' + esc(n.id) : null)
        if (anchor) { parts.unshift(anchor); break }
      }
      let p = n.tagName.toLowerCase()
      const cls = [...n.classList].filter(c => !/[\[\]:\/()]/.test(c)).slice(0, 2)
      if (cls.length) p += '.' + cls.map(esc).join('.')
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : []
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')'
      parts.unshift(p)
      if (n === document.body || unique(parts.join(' > '))) break
    }
    return parts.join(' > ')
  }
  // The deepest element under the pointer, through open shadow roots.
  const hit = (x, y) => {
    let el = document.elementFromPoint(x, y)
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner }
    return el
  }
  const paint = () => {
    if (!cur || !cur.isConnected) { box.style.display = tag.style.display = 'none'; return }
    const r = cur.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    tag.textContent = cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.classList.length ? '.' + [...cur.classList].slice(0, 2).join('.') : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    Object.assign(tag.style, { display: 'block', left: Math.max(2, r.left) + 'px', top: (r.top > 22 ? r.top - 20 : r.bottom + 2) + 'px' })
  }
  // The UI component that renders the element, in a framework's development build: React (fiber,
  // _debugSource up to React 18), Vue 3 and 2 (__file), Svelte (__svelte_meta). Absent in
  // production builds, where the IDE falls back to searching the project.
  const component = el => {
    for (let n = el, hops = 0; n && hops < 12; n = n.parentElement, hops++) {
      const fk = Object.keys(n).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
      if (fk) {
        const names = []
        // The element's own fiber carries the JSX line that rendered it: the most exact source.
        const own = n[fk] && n[fk]._debugSource
        let file = own ? own.fileName || '' : '', line = own ? own.lineNumber || 0 : 0
        for (let f = n[fk]; f && names.length < 3; f = f.return) {
          const t = f.type
          if (!t || typeof t === 'string') continue
          const name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || ''
          if (!name || /^(Anonymous|Fragment|Suspense)$/.test(name)) continue
          names.push(name)
          if (!file && f._debugSource) { file = f._debugSource.fileName || ''; line = f._debugSource.lineNumber || 0 }
        }
        if (names.length) return { framework: 'React', names, file, line }
      }
      if (n.__vueParentComponent) {
        const names = []
        let file = ''
        for (let c = n.__vueParentComponent; c && names.length < 3; c = c.parent) {
          const t = c.type || {}
          const name = t.name || t.__name || (t.__file ? t.__file.split('/').pop().replace(/\.vue$/, '') : '')
          if (name) names.push(name)
          if (!file && t.__file) file = t.__file
        }
        if (names.length) return { framework: 'Vue', names, file, line: 0 }
      }
      if (n.__vue__ && n.__vue__.$options) {
        const o = n.__vue__.$options
        return { framework: 'Vue', names: [o.name || o._componentTag || 'component'], file: o.__file || '', line: 0 }
      }
      if (n.__svelte_meta && n.__svelte_meta.loc) {
        const loc = n.__svelte_meta.loc
        return { framework: 'Svelte', names: [loc.file.split('/').pop().replace(/\.svelte$/, '')], file: loc.file, line: (loc.line || 0) + 1 }
      }
    }
    return null
  }
  const ATTRS = ['role', 'aria-label', 'href', 'src', 'alt', 'name', 'type', 'placeholder', 'title', 'for', 'value']
  const describe = el => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const pick = ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius', 'gap', 'width', 'height']
    const styles = {}
    for (const k of pick) { const v = cs.getPropertyValue(k); if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[k] = v }
    const attrs = {}
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v) attrs[a] = v.slice(0, 120) }
    const outer = el.outerHTML.replace(/\s+/g, ' ')
    const open = outer.slice(0, outer.indexOf('>') + 1)
    const html = outer.length <= 600 ? outer : open.slice(0, 400) + ' … </' + el.tagName.toLowerCase() + '>'
    // Inside a shadow root, name the host too (Playwright's >>> piercing form).
    const rootNode = el.getRootNode && el.getRootNode()
    const selector = rootNode && rootNode.host ? sel(rootNode.host) + ' >>> ' + sel(el) : sel(el)
    return { selector, tag: el.tagName.toLowerCase(), id: el.id || '', classes: [...el.classList], text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160), html, rect: { w: Math.round(r.width), h: Math.round(r.height) }, styles, attrs, component: component(el), url: location.href }
  }
  const stop = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation() }
  const move = e => { const el = hit(e.clientX, e.clientY); if (!el || el === box || el === tag) return; cur = el; paint() }
  const click = e => { stop(e); if (!cur) { const el = hit(e.clientX, e.clientY); if (el && el !== box && el !== tag) cur = el } if (!cur) return done(null); let info = null; try { info = describe(cur) } catch (err) { info = null } done(info) }
  const key = e => { if (e.key === 'Escape') { stop(e); done(null) } }
  const cancel = e => { stop(e); done(null) }
  const handlers = [['mousemove', move], ['click', click], ['keydown', key], ['contextmenu', cancel], ['mousedown', stop], ['pointerdown', stop], ['mouseup', stop], ['pointerup', stop], ['auxclick', stop], ['dblclick', stop]]
  function done(v) {
    if (window.__hermesIdePick !== done) return
    window.__hermesIdePick = null
    for (const [t, f] of handlers) removeEventListener(t, f, true)
    removeEventListener('scroll', paint, true)
    removeEventListener('resize', paint)
    box.remove(); tag.remove()
    resolve(v)
  }
  window.__hermesIdePick = done
  for (const [t, f] of handlers) addEventListener(t, f, true)
  addEventListener('scroll', paint, true)
  addEventListener('resize', paint)
}))()`

export interface Picked {
  selector: string
  tag: string
  id: string
  classes: string[]
  text: string
  html: string
  rect: { w: number; h: number }
  styles: Record<string, string>
  attrs?: Record<string, string>
  component?: { framework: string; names: string[]; file: string; line: number } | null
  url: string
}

export const $picking = atom(false)

// Ends a pick in the page through the picker's own handle (no synthetic key event).
const CANCEL_PICK = "typeof window.__hermesIdePick === 'function' ? (window.__hermesIdePick(null), true) : false"
let cancelPick: (() => void) | null = null

/** Pick an element, or cancel the pick that is running. In the full build's own Browser column
 *  (`webview`), else in the app's Browser pane through ctx.preview (the app asks the user once per
 *  site before any script runs there). */
export async function pickElement(webview?: any) {
  if ($picking.get()) {
    cancelPick?.()
    return
  }
  let run: ((code: string) => Promise<unknown>) | null = null
  if (!__CATALOG__ && webview) {
    run = code => {
      webview.focus()
      return webview.executeJavaScript(code, true)
    }
  } else if (ctx.preview?.executeJavaScript) {
    if (!ctx.preview.isAvailable?.()) {
      notify('info', 'Open the page in the Browser pane first (the link in the Project UI column), then pick.', 'Hermes IDE')
      return
    }
    run = code => ctx.preview.executeJavaScript(code)
  }
  if (!run) return
  notify('info', 'Click an element in the page. Esc, a right-click or the pick button again cancels.', 'Hermes IDE')
  $picking.set(true)
  const go = run
  // A page that navigates mid-pick can leave the script's promise pending: a cancel or two minutes
  // ends the pick either way.
  const stopped = new Promise<null>(resolve => {
    const timer = setTimeout(() => resolve(null), 120_000)
    cancelPick = () => {
      clearTimeout(timer)
      void go(CANCEL_PICK).catch(() => undefined)
      resolve(null)
    }
  })
  try {
    const picked = (await Promise.race([go(PICKER), stopped])) as Picked | null
    if (picked) await sendPicked(picked)
  } catch (e) {
    notify('error', `Could not pick from this page: ${(e as Error).message}`, 'Hermes IDE')
  } finally {
    cancelPick = null
    $picking.set(false)
  }
}

/** Catalog build: reload the page in the app's Browser pane (after a change the dev server does not
 *  hot-reload). Same consent as the picker. */
export async function reloadPreview() {
  if (!ctx.preview?.isAvailable?.()) {
    notify('info', 'No page is open in the Browser pane.', 'Hermes IDE')
    return
  }
  try {
    await ctx.preview.executeJavaScript('location.reload(); true')
  } catch (e) {
    notify('error', `Could not reload the page: ${(e as Error).message}`, 'Hermes IDE')
  }
}

/** Source lines that likely render the element: its id, its visible text, then its most specific
 *  class name, searched in the project (ripgrep skips ignored and build folders). */
async function likelySources(p: Picked): Promise<string[]> {
  const root = selected()?.dir || $root.get()
  if (!root) return []
  // A development build names the component's own file: the best source there is.
  const c = p.component
  if (c?.file) {
    const raw = c.file.replace(/\\/g, '/').replace(/^webpack:\/\/[^/]*\//, '').replace(/^\/@fs\//, '/').replace(/\?.*$/, '')
    const path = /^([a-zA-Z]:)?\//.test(raw) ? raw : `${root.replace(/\/$/, '')}/${raw.replace(/^\.?\//, '')}`
    try {
      const st = await call<{ exists: boolean; dir?: boolean; path: string }>('/fs/stat', { path })
      if (st.exists && !st.dir) return [fileRef(st.path, chatRoot(), c.line || undefined)]
    } catch {
      /* not a file on the agent's machine: fall back to searching */
    }
  }
  const queries = [
    p.id && p.id.length > 2 ? p.id : '',
    p.text && p.text.length >= 4 && p.text.length <= 80 && !p.text.includes('\n') ? p.text : '',
    [...p.classes].filter(c => c.length >= 5 && !/[:[\]/]/.test(c)).sort((a, b) => b.length - a.length)[0] || ''
  ].filter(Boolean)
  for (const query of queries) {
    try {
      const r = await call<{ matches: Array<{ path: string; line: number }> }>('/search', { root, query, glob: '!{dist,build,.next,out,coverage}/**' })
      const hits = r.matches.filter(m => !/\.(map|lock|min\.js)$|\/(dist|build|\.next|out)\//.test(m.path)).slice(0, 3)
      if (hits.length) return hits.map(m => fileRef(m.path, chatRoot(), m.line))
    } catch {
      /* search unavailable: send the element without sources */
    }
  }
  return []
}

function chatRoot(): string | null {
  const root = $root.get()
  const cwd = host.state.cwd.get()
  return root && cwd && pathKey(root) === pathKey(cwd) ? root : null
}

// Picked elements wait in the composer as a short token and become the full description when the
// message is sent (COMPOSER_AREAS.middleware), so the input stays one line per element.
const PICKS_KEY = 'hermes-ide:picks'

function storedPicks(): { next: number; blocks: Record<string, string> } {
  try {
    const v = JSON.parse(sessionStorage.getItem(PICKS_KEY) || 'null')
    if (v && typeof v.next === 'number' && v.blocks && typeof v.blocks === 'object') return v
  } catch {
    /* fresh */
  }
  return { next: 1, blocks: {} }
}

function storePick(block: string): number {
  const s = storedPicks()
  const id = s.next
  s.blocks[String(id)] = block
  // Keep the last 50 (a window's tokens live as long as its drafts).
  const ids = Object.keys(s.blocks).map(Number).sort((a, b) => a - b)
  for (const old of ids.slice(0, Math.max(0, ids.length - 50))) delete s.blocks[String(old)]
  sessionStorage.setItem(PICKS_KEY, JSON.stringify({ next: id + 1, blocks: s.blocks }))
  return id
}

/** The draft as it will be sent: every element token replaced by its full description. A token
 *  this window no longer knows is left as it is. */
export function expandPicks(text: string): string {
  return text.includes('[[ element ') ? expandPickTokens(text, storedPicks().blocks) : text
}

/** The description the model reads, sectioned with [[ ]] so it knows where an element starts and
 *  ends. The page address is a plain link (an @url: reference would make Hermes fetch the whole
 *  page on every send, and a dev server's localhost page is refused by its fetcher anyway). */
export function pickBlock(p: Picked, sources: string[]): string {
  const where = __CATALOG__ ? "the app's Browser" : 'the IDE browser'
  const styles = Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join('; ')
  const attrs = Object.entries(p.attrs || {}).map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`).join(' ')
  const c = p.component
  const lines = [
    `[[ Element picked in ${where} (${p.url}):`,
    `- selector: \`${p.selector}\` (<${p.tag}> ${p.rect.w}×${p.rect.h})${p.text ? `, text "${p.text.replace(/"/g, "'")}"` : ''}`,
    c ? `- component: ${[...c.names].reverse().join(' › ')} (${c.framework})` : '',
    attrs ? `- attributes: ${attrs}` : '',
    `- html: \`${p.html.replace(/`/g, "'")}\``,
    styles ? `- styles: ${styles}` : '',
    sources.length ? `- ${c?.file && sources.length === 1 ? 'source' : 'likely source'}: ${sources.join(' ')}` : '',
    ']]'
  ]
  return lines.filter(Boolean).join('\n')
}

async function sendPicked(p: Picked) {
  const sources = await likelySources(p)
  const block = pickBlock(p, sources)
  const id = storePick(block)
  // The token is plain composer text: no brackets (they end it), no @ or backticks (the composer
  // would turn them into reference chips or code).
  const clean = (s: string) => s.replace(/[[\]@`]/g, '')
  const label = clean(`<${p.tag}${p.id ? '#' + p.id : p.classes[0] ? '.' + p.classes[0] : ''}>`)
  const preview = clean(p.text)
  const text = preview ? ` "${preview.length > 24 ? preview.slice(0, 23) + '…' : preview}"` : ''
  const token = `[[ element ${id} · ${label}${text} ]]`
  const sid = host.state.focusedSessionId.get() || null
  if (await host.composer.insertText(sid, token + ' ', { mode: 'inline' })) {
    host.composer.focus(sid)
    notify('info', `Added ${label} to the chat; its full description is sent with your message${sources.length ? `, with ${sources.length} source line${sources.length > 1 ? 's' : ''}` : ''}.`, 'Hermes IDE')
  } else {
    await ctx.os.writeClipboard(block)
    notify('info', 'No chat composer is ready, so the element was copied to the clipboard.', 'Hermes IDE')
  }
}

/** A file inside the running UI's folder, as the dev server would serve it (static sites only). */
export function servedUrl(path: string): string | null {
  const s = $server.get()
  const c = $candidates.get().find(x => x.id === s?.id)
  if (!s?.url || !c || c.kind !== 'static' || !isInside(path, c.dir)) return null
  return s.url.replace(/\/?$/, '/') + path.slice(c.dir.length + 1).split('/').map(encodeURIComponent).join('/')
}

