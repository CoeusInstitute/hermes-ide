// Full build only: IDE chats get their own group under SESSIONS, like the date groups.
//
// shortcut: the SDK has no door to add a group to the session list, so the group is a plain-DOM
// block inserted under the SESSIONS header (plugins get no react-dom for a portal), anchored on the
// list's own stable drop-target attributes, and the IDE chats' rows in the date groups are hidden
// while the group is shown. That reaches into the app's markup, outside the catalog's SDK surface
// (rule 8), so the catalog build lists IDE chats in the status bar's IDE menu instead. Upgrade to a
// session-list group door when the SDK ships one. If the anchors move, the group simply does not
// appear and nothing is hidden: the badges and the click still work.

import { $ideChats, ctx, openIdeWindow, unmarkIdeChat } from '../core'
import { $sessionRows, age, durable, ideRows, matches, newIdeWorkspace } from '../ide-chats'

const CSS = `
.hi-sb{margin:2px 0 4px}
.hi-sb-head{display:flex;align-items:center;gap:8px;padding:8px 8px 2px;user-select:none}
.hi-sb-head button.hi-sb-label{display:flex;flex:1;min-width:0;align-items:center;gap:8px;border:0;padding:0;background:none;cursor:pointer;color:var(--ui-text-quaternary);font:inherit}
.hi-sb-name{flex:none;font-size:.64rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
.hi-sb-count{flex:none;font-size:.6rem;color:var(--ui-text-quaternary)}
.hi-sb-rule{height:1px;min-width:16px;flex:1;background:var(--ui-stroke-tertiary)}
.hi-sb-add{display:grid;place-items:center;width:18px;height:18px;border:0;border-radius:4px;background:none;color:var(--ui-text-tertiary);cursor:pointer;opacity:0;transition:opacity .12s}
.hi-sb:hover .hi-sb-add,.hi-sb-add:focus-visible{opacity:1}
.hi-sb-add:hover{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}
.hi-sb-row{position:relative;display:flex;align-items:center;gap:8px;min-height:44px;padding:4px 8px;border-radius:6px;cursor:pointer;color:var(--ui-text-secondary)}
.hi-sb-row:hover{background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.hi-sb-row:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.hi-sb-lead{display:grid;place-items:center;width:16px;flex:none;color:var(--ui-accent)}
.hi-sb-main{display:flex;flex-direction:column;min-width:0;flex:1}
.hi-sb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8125rem}
.hi-sb-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;font-size:.625rem;color:var(--ui-text-tertiary)}
.hi-sb-age{flex:none;font-size:.625rem;color:var(--ui-text-tertiary)}
.hi-sb-x{display:none;place-items:center;width:20px;height:20px;border:0;border-radius:4px;background:none;color:var(--ui-text-tertiary);cursor:pointer;flex:none}
.hi-sb-row:hover .hi-sb-x,.hi-sb-row:focus-within .hi-sb-x{display:grid}
.hi-sb-row:hover .hi-sb-age{display:none}
.hi-sb-x:hover{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}
.hi-sb-empty{padding:4px 10px 8px 32px;font-size:.6875rem;color:var(--ui-text-tertiary)}
.hi-ide-hidden{display:none !important}
`

let group: HTMLDivElement | null = null
let collapsed = false
let disposed = false // a frame queued before dispose must not put this instance's group back

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const codicon = (name: string) => el('span', `codicon codicon-${name}`)

let pinnedKey = ''

/** IDE chats pinned right now: their badge sits in the Pinned section. (Pinned shows those; the
 *  backend's flag lags a pin or unpin until the next refresh, which would drop an unpinned chat
 *  from both lists in between.) */
const pinnedNow = () => new Set([...document.querySelectorAll<HTMLElement>('[data-session-pin-drop] .hi-ide-badge[data-ide-sid]')].map(b => b.dataset.ideSid!))

function render() {
  if (!group) return
  const pinned = pinnedNow()
  const list = ideRows().filter(r => !pinned.has(durable(r)))
  group.replaceChildren()
  const head = el('div', 'hi-sb-head')
  const label = el('button', 'hi-sb-label')
  label.type = 'button'
  label.title = collapsed ? 'Show IDE chats' : 'Hide IDE chats'
  label.setAttribute('aria-expanded', String(!collapsed))
  label.append(el('span', 'hi-sb-name', 'IDE'), el('span', 'hi-sb-count', list.length ? String(list.length) : ''), el('span', 'hi-sb-rule'))
  label.onclick = () => {
    collapsed = !collapsed
    ctx.storage.set('sidebarCollapsed', collapsed)
    render()
  }
  const add = el('button', 'hi-sb-add')
  add.type = 'button'
  add.title = 'New IDE workspace: a new chat in its own IDE window, in a folder you choose'
  add.append(codicon('add'))
  add.onclick = e => {
    e.stopPropagation()
    void newIdeWorkspace()
  }
  head.append(label, add)
  group.append(head)
  if (collapsed) return
  if (!list.length) {
    group.append(el('div', 'hi-sb-empty', 'New IDE workspaces are listed here. Start one with + or the IDE button.'))
    return
  }
  for (const r of list) {
    const row = el('div', 'hi-sb-row')
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.title = 'Open in the Hermes IDE window'
    row.dataset.sid = durable(r)
    const lead = el('span', 'hi-sb-lead')
    lead.append(codicon('code'))
    const main = el('span', 'hi-sb-main')
    const meta = [r.model?.split('/').pop(), r.message_count ? `${r.message_count} messages` : ''].filter(Boolean).join(' · ')
    main.append(el('span', 'hi-sb-title', r.title || r.preview || 'Untitled chat'), el('span', 'hi-sb-meta', meta))
    const x = el('button', 'hi-sb-x')
    x.type = 'button'
    x.title = 'Remove from IDE chats (it goes back to the session list)'
    x.append(codicon('close'))
    x.onclick = e => {
      e.stopPropagation()
      unmarkIdeChat(Object.keys($ideChats.get()).filter(id => matches(r, id)))
    }
    row.append(lead, main, el('span', 'hi-sb-age', age(r.last_active || r.started_at)), x)
    const open = () => void openIdeWindow({ sid: durable(r) })
    row.onclick = open
    row.onkeydown = e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())
    group.append(row)
  }
}

/** Mount the group under SESSIONS (flat list only) and hide the IDE chats' date-group rows. */
function sync() {
  if (disposed || !group) return
  const list = document.querySelector<HTMLElement>('[data-sessions-mode]')
  const flat = list?.getAttribute('data-sessions-mode') === 'flat'
  const recents = flat ? list!.querySelector<HTMLElement>(':scope > [data-session-pin-drop] ~ [data-session-unpin-drop]') : null
  const header = recents?.firstElementChild
  // Collapsed SESSIONS section: only its header (and the group) are left; the group hides with it.
  const open = !!recents && [...recents.children].some(c => c !== header && c !== group)
  if (recents && header && header !== group && open) {
    if (group!.parentElement !== recents || header.nextElementSibling !== group) header.after(group!)
  } else if (group!.isConnected) {
    group!.remove()
  }
  const mounted = !!recents && group!.isConnected
  // Hide a date-group row only when the group lists that chat: a chat the group could not load
  // (the list failed, or it is older than the 500 rows fetched) must not vanish from both.
  const listed = new Set([...group!.querySelectorAll<HTMLElement>('.hi-sb-row[data-sid]')].map(r => r.dataset.sid!))
  for (const badge of document.querySelectorAll<HTMLElement>('.hi-ide-badge[data-ide-sid]')) {
    if (!mounted || !recents!.contains(badge) || !listed.has(badge.dataset.ideSid!)) continue
    // Virtualized rows sit in [data-index] wrappers; a short list's rows are the content's children.
    const wrapper = badge.closest<HTMLElement>('[data-index]') ?? climbTo(badge, recents!)
    wrapper?.classList.add('hi-ide-hidden')
  }
  for (const hidden of document.querySelectorAll<HTMLElement>('.hi-ide-hidden')) {
    const sid = hidden.querySelector<HTMLElement>('.hi-ide-badge')?.dataset.ideSid
    if (!mounted || !sid || !listed.has(sid)) hidden.classList.remove('hi-ide-hidden')
  }
  const key = [...pinnedNow()].sort().join()
  if (key !== pinnedKey) {
    pinnedKey = key
    render()
  }
}

/** The ancestor of `node` that is a direct child of the list content inside `recents`. */
function climbTo(node: HTMLElement, recents: HTMLElement): HTMLElement | null {
  let n: HTMLElement | null = node
  while (n && n.parentElement && n.parentElement.parentElement !== recents) n = n.parentElement
  return n && n.parentElement && n.parentElement !== group ? n : null
}

export function initSidebar() {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)
  collapsed = !!ctx.storage.get('sidebarCollapsed', false)
  group = document.createElement('div')
  group.className = 'hi-sb'
  group.setAttribute('data-hermes-ide-group', '')
  render()

  let queued = false
  const obs = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      sync()
    })
  })
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sessions-mode'] })
  const offRows = $sessionRows.subscribe(() => render())
  const offChats = $ideChats.subscribe(() => {
    render()
    sync()
  })

  ctx.onDispose(() => {
    disposed = true
    obs.disconnect()
    offRows()
    offChats()
    group?.remove()
    for (const hidden of document.querySelectorAll('.hi-ide-hidden')) hidden.classList.remove('hi-ide-hidden')
    style.remove()
  })
}
