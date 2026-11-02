// The IDE's Browser column: finds the project's web UI, runs it through the backend's dev-server
// manager, and points the column's webview at it. The element picker sends what the user picks
// (selector, markup, styles and the source lines that likely render it) to the chat.

import { atom, host } from '@hermes/plugin-sdk'

import { $root, $runUiRequest, $settings, call, ctx, notify, openInBrowser, openTile } from './core'
import { fileRef, isInside, pathKey } from './util'

export interface Candidate {
  id: string
  kind: 'node' | 'static'
  dir: string
  rel: string
  name: string
  framework: string
  command: string
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

const selected = () => $candidates.get().find(c => c.id === $selected.get()) ?? null

function trusted(): string[] {
  const v = ctx.storage.get('trustedProjects', [])
  return Array.isArray(v) ? v : []
}

export function trust(c: Candidate) {
  ctx.storage.set('trustedProjects', [...new Set([...trusted(), pathKey(c.dir)])])
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
  } catch {
    return // older backend or not a folder: no UI support, the column still browses
  }
  $candidates.set(r.candidates)
  const running = r.servers.find(s => s.state !== 'exited')
  const first = r.candidates.find(c => c.id === running?.id) ?? r.candidates[0]
  $selected.set(first?.id ?? null)
  $askTrust.set(null)
  if (running) {
    track(running)
    openTile('browser')
    return
  }
  if (!first) return
  if (trusted().includes(pathKey(first.dir)) && $settings.get().autoRunUi && first.installed) {
    void startUi()
    return
  }
  $askTrust.set(first)
  openTile('browser')
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

export function initBrowser() {
  ctx.onDispose($root.subscribe(() => void detectProject()))
  ctx.onDispose($runUiRequest.subscribe((n: number) => n && void (selected() ? startUi() : detectProject(true))))
  ctx.onDispose(() => clearInterval(poll))
}

// ── element picker ───────────────────────────────────────────────────────────────────────────

/** Runs inside the page: highlight what the pointer is over, resolve with the clicked element's
 *  description, or null on Escape. Self-contained: it is sent to the page as a string. */
const PICKER = `(() => new Promise(resolve => {
  const box = document.createElement('div')
  const tag = document.createElement('div')
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:3px'
  tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.6 ui-monospace,monospace;color:#fff;background:#1d4ed8;padding:0 6px;border-radius:3px;white-space:nowrap'
  document.documentElement.append(box, tag)
  let cur = null
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : s)
  const sel = el => {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break }
      let p = n.tagName.toLowerCase()
      const cls = [...n.classList].filter(c => !/^(hover|focus|active):/.test(c)).slice(0, 2)
      if (cls.length) p += '.' + cls.map(esc).join('.')
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : []
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')'
      parts.unshift(p)
      if (n === document.body) break
    }
    return parts.join(' > ')
  }
  const move = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === box || el === tag) return
    cur = el
    const r = el.getBoundingClientRect()
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    tag.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    Object.assign(tag.style, { left: Math.max(2, r.left) + 'px', top: (r.top > 22 ? r.top - 20 : r.bottom + 2) + 'px' })
  }
  const stop = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation() }
  const done = v => {
    for (const [t, f] of handlers) removeEventListener(t, f, true)
    box.remove(); tag.remove(); resolve(v)
  }
  const click = e => {
    stop(e)
    if (!cur) return done(null)
    const cs = getComputedStyle(cur)
    const r = cur.getBoundingClientRect()
    const pick = ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius', 'gap', 'width', 'height']
    const styles = {}
    for (const k of pick) { const v = cs.getPropertyValue(k); if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[k] = v }
    done({ selector: sel(cur), tag: cur.tagName.toLowerCase(), id: cur.id || '', classes: [...cur.classList], text: (cur.innerText || cur.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160), html: cur.outerHTML.slice(0, 1200), rect: { w: Math.round(r.width), h: Math.round(r.height) }, styles, url: location.href })
  }
  const key = e => { if (e.key === 'Escape') { stop(e); done(null) } }
  const handlers = [['mousemove', move], ['click', click], ['keydown', key], ['mousedown', stop], ['pointerdown', stop], ['mouseup', stop]]
  for (const [t, f] of handlers) addEventListener(t, f, true)
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
  url: string
}

export const $picking = atom(false)

export async function pickElement(webview: any) {
  if (!webview || $picking.get()) return
  $picking.set(true)
  try {
    webview.focus()
    const picked = (await webview.executeJavaScript(PICKER, true)) as Picked | null
    if (picked) await sendPicked(picked)
  } catch (e) {
    notify('error', `Could not pick from this page: ${(e as Error).message}`, 'Hermes IDE')
  } finally {
    $picking.set(false)
  }
}

/** Source lines that likely render the element: its id, its visible text, then its most specific
 *  class name, searched in the project (ripgrep skips ignored and build folders). */
async function likelySources(p: Picked): Promise<string[]> {
  const root = selected()?.dir || $root.get()
  if (!root) return []
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

async function sendPicked(p: Picked) {
  const sources = await likelySources(p)
  const styles = Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join('; ')
  const text = [
    `Element picked in the IDE browser (${p.url}):`,
    `- selector: \`${p.selector}\` (<${p.tag}> ${p.rect.w}×${p.rect.h})${p.text ? `, text "${p.text}"` : ''}`,
    `- html: \`${p.html.replace(/`/g, "'").replace(/\s+/g, ' ')}\``,
    styles ? `- styles: ${styles}` : '',
    sources.length ? `- likely source: ${sources.join(' ')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const sid = host.state.focusedSessionId.get() || null
  if (await host.composer.insertText(sid, text + '\n', { mode: 'block' })) {
    host.composer.focus(sid)
    notify('info', `Added <${p.tag}> to the chat${sources.length ? ` with ${sources.length} likely source line${sources.length > 1 ? 's' : ''}` : ''}.`, 'Hermes IDE')
  } else {
    await ctx.os.writeClipboard(text)
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

