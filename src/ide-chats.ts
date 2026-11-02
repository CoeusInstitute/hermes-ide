// IDE chats: which chats open in their IDE window, with the session-list rows that describe them.
// Shared by the status bar's IDE menu (both builds) and the sidebar's IDE group (full build).

import { atom, host } from '@hermes/plugin-sdk'

import { $ideChats, ctx, loadIdeChats, markIdeChat, notify, openIdeWindow, setIdeChats } from './core'

export interface Row {
  id: string
  _lineage_root_id?: string | null
  title?: string | null
  preview?: string | null
  model?: string | null
  message_count?: number
  last_active?: number
  started_at?: number
  archived?: boolean
  pinned?: boolean
}

/** Every session row the backend listed (newest first is not guaranteed; sort where shown). */
export const $sessionRows = atom<Row[]>([])

export const durable = (r: Row) => r._lineage_root_id || r.id
export const matches = (r: Row, id: string) => r.id === id || r._lineage_root_id === id

export function age(sec?: number): string {
  if (!sec) return ''
  const m = Math.max(0, (Date.now() / 1000 - sec) / 60)
  return m < 1 ? 'now' : m < 60 ? `${Math.floor(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

/** The IDE chats the backend knows, not archived, most recent first. */
export function ideRows(rows = $sessionRows.get(), chats = $ideChats.get()): Row[] {
  const ids = Object.keys(chats)
  return rows
    .filter(r => !r.archived && ids.some(id => matches(r, id)))
    .sort((a, b) => (b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0))
}

export async function refreshRows() {
  try {
    const profile = host.state.profile.get() || 'default'
    const r: any = await host.listPersistedSessions(null, { profile, limit: 500 })
    $sessionRows.set(Array.isArray(r?.sessions) ? r.sessions : [])
  } catch {
    return // backend restarting: keep what we have
  }
  const rows = $sessionRows.get()
  // Key IDE chats by their durable id, the one the row badge sees and that survives compaction.
  loadIdeChats()
  const chats = $ideChats.get()
  let changed = false
  const next: Record<string, number> = {}
  for (const [id, at] of Object.entries(chats)) {
    const row = rows.find(r => matches(r, id))
    const key = row ? durable(row) : id
    if (key !== id) changed = true
    next[key] = Math.max(next[key] || 0, at)
  }
  if (changed) setIdeChats(next)
}

// Model-facing, never painted (the gateway's "hidden" seed): it also makes the gateway store the
// session at once, so the new workspace has a window and a session-list row before any message.
const WORKSPACE_SEED =
  'This chat is a Hermes IDE workspace: the user works in its Hermes IDE window, with the project folder in an Explorer, ' +
  "a code editor and the project's running web UI beside this chat. For how to work with the IDE, load the skill hermes-ide:guide."

/** A new IDE workspace: a new chat, its IDE window, and a prompt there to choose or create the
 *  project folder. It is an IDE chat from the start. */
export async function newIdeWorkspace() {
  let sid: string | undefined
  try {
    const r: any = await host.request('session.create', { messages: [{ role: 'system', content: WORKSPACE_SEED, display_kind: 'hidden' }] })
    sid = r?.stored_session_id || r?.session_id
  } catch (e) {
    notify('error', `Could not start a new IDE workspace: ${(e as Error).message}`, 'Hermes IDE')
    return
  }
  if (!sid) return notify('error', 'Could not start a new IDE workspace: the gateway returned no session.', 'Hermes IDE')
  markIdeChat(sid)
  await openIdeWindow({ sid, folder: true })
  void refreshRows()
}

/** Main window: keep the rows current (another window's change, a turn that retitles an IDE chat,
 *  focus). */
export function initIdeChats() {
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'hermes.plugin.hermes-ide.ideChats') {
      loadIdeChats()
      void refreshRows()
    }
  }
  const onFocus = () => void refreshRows()
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', onFocus)
  const tick = window.setInterval(onFocus, 60_000)
  // An IDE chat's turn can retitle it; other chats' turns do not touch the list.
  const offTurn = host.onEvent?.('message.complete', (ev: any) => {
    const sid = ev?.payload?.session_id ?? ev?.session_id
    const rows = $sessionRows.get()
    if (!sid || Object.keys($ideChats.get()).some(id => id === sid || rows.some(r => matches(r, id) && matches(r, sid)))) void refreshRows()
  })
  void refreshRows()
  ctx.onDispose(() => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', onFocus)
    clearInterval(tick)
    offTurn?.()
  })
}
