// Hermes IDE state and actions. Everything that talks to the backend, the editor frame, the
// composer, or the app shell lives here; ui.tsx only renders atoms and calls these functions.

import { atom, host } from '@hermes/plugin-sdk'

import {
  baseName,
  columnPlan,
  type ColumnId,
  columnWidths,
  DEFAULT_LAYOUT,
  detectEol,
  type DockStep,
  dockPlan,
  fileRef,
  isInside,
  type Layout,
  normPath,
  pathKey,
  pathOrUrl,
  pathsFromToolArgs,
  TILE_IDS,
  type TileId,
  tilePane
} from './util'

export { columnPlan }

// ── context ──────────────────────────────────────────────────────────────────────────────────

export let ctx: any = null
let renderers: Record<TileId, () => unknown> | null = null

export function bindContext(c: any, tileRenderers: Record<TileId, () => unknown>) {
  ctx = c
  renderers = tileRenderers
}

export function notify(kind: 'info' | 'warning' | 'error' | 'success', message: string, title?: string) {
  host.notify({ kind, message, title })
}

// ── backend ──────────────────────────────────────────────────────────────────────────────────

export interface Entry {
  name: string
  path: string
  dir: boolean
}

export function call<T = any>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  return ctx.rest(route, { method: 'POST', body })
}

export const isConflict = (e: unknown) => /\b409\b|conflict/i.test(String((e as Error)?.message ?? e))
export const isMissingBackend = (e: unknown) => /\b404\b|not found|unavailable/i.test(String((e as Error)?.message ?? e))

// ── settings ─────────────────────────────────────────────────────────────────────────────────

export interface Settings {
  followSession: boolean
  showHidden: boolean
  wordWrap: boolean
  fontSize: number
  reviewAgentEdits: boolean
  /** Start a detected project UI when the IDE opens (each project is trusted once first). */
  autoRunUi: boolean
}

const DEFAULTS: Settings = { followSession: true, showHidden: true, wordWrap: false, fontSize: 13, reviewAgentEdits: true, autoRunUi: true }
export const $settings = atom<Settings>(DEFAULTS)

export function loadSettings() {
  $settings.set({ ...DEFAULTS, ...(ctx.storage.get('settings', {}) as Partial<Settings>) })
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  const next = { ...$settings.get(), [key]: value }
  $settings.set(next)
  ctx.storage.set('settings', next)
  if (key === 'fontSize' || key === 'wordWrap') {
    postLook()
  }
  if (key === 'showHidden') {
    bumpTree()
  }
}

// ── atoms ────────────────────────────────────────────────────────────────────────────────────

export interface Tab {
  path: string
  name: string
  dirty: boolean
  preview: boolean
}

export type Banner =
  | { kind: 'agent'; before: string }
  | { kind: 'conflict'; diskText: string; diskMtime: string; comparing?: boolean }

export interface GitState {
  repo: boolean
  root?: string
  branch?: string
  /** pathKey → status code (M, A, D, ?, U, R) */
  files: Record<string, string>
  /** pathKey → the path as git reported it (original case, for display and opening) */
  paths?: Record<string, string>
}

export const $root = atom<string | null>(null)
export const $rootPicked = atom(false)
export const $tabs = atom<Tab[]>([])
export const $active = atom<string | null>(null)
export const $cursor = atom<null | { line: number; col: number; sel: number; lang: string; eol: string }>(null)
export const $git = atom<GitState>({ repo: false, files: {} })
export const $view = atom<'explorer' | 'search' | 'scm'>('explorer')
export const $banners = atom<Record<string, Banner>>({})
export const $treeVersion = atom(0)
export const $reveal = atom<string | null>(null)
export const $quickOpen = atom(false)
export const $folderDialog = atom(false)
export const $searchFocus = atom(0)
export const $backend = atom<'unknown' | 'ok' | 'missing'>('unknown')

interface Meta {
  path: string
  mtime: string
  eol: string
  bom: boolean
  savedText: string
  draft?: string | null
  forceNext?: boolean
}

const meta = new Map<string, Meta>()
let sessionKey = 'draft'

export const bumpTree = () => $treeVersion.set($treeVersion.get() + 1)

// ── editor frame bridge ──────────────────────────────────────────────────────────────────────

let frameWin: Window | null = null
let frameReady = false
let queue: Array<[any, Transferable[] | undefined]> = []
let fonts: Array<{ family: string; weight: string; style: string; buffer: ArrayBuffer }> | null = null
let lookSource: (() => { vars: Record<string, string>; dark: boolean }) | null = null
let lastLook = ''

export function attachFrame(win: Window | null, look: () => { vars: Record<string, string>; dark: boolean }) {
  frameWin = win
  frameReady = false
  lookSource = look
}

export function detachFrame(win: Window | null) {
  if (frameWin === win) {
    frameWin = null
    frameReady = false
  }
}

export function post(msg: any, transfer?: Transferable[]) {
  if (frameWin && frameReady) {
    frameWin.postMessage(msg, '*', transfer)
  } else {
    queue.push([msg, transfer])
  }
}

export function postLook() {
  if (!lookSource) {
    return
  }
  const s = $settings.get()
  const look = { type: 'look', ...lookSource(), fontSize: s.fontSize, wrap: s.wordWrap }
  const key = JSON.stringify(look)
  if (key !== lastLook || !frameReady) {
    lastLook = key
    post(look)
  }
}

/** The app's mono font files, read once from its own @font-face rules and handed to the frame
 *  (an opaque-origin document cannot load the app's font URLs itself). */
async function appFonts(): Promise<typeof fonts> {
  if (fonts) {
    return fonts
  }
  const found: NonNullable<typeof fonts> = []
  try {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
    const families = new Set(stack.split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase()))
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSFontFaceRule)) {
          continue
        }
        const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')
        const src = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1]
        if (!src || !families.has(family.toLowerCase())) {
          continue
        }
        const res = await fetch(new URL(src, sheet.href || location.href).href)
        if (res.ok) {
          found.push({
            family,
            weight: rule.style.getPropertyValue('font-weight') || '400',
            style: rule.style.getPropertyValue('font-style') || 'normal',
            buffer: await res.arrayBuffer()
          })
        }
      }
    }
  } catch {
    /* the frame keeps its fallback mono stack */
  }
  fonts = found
  return fonts
}

/** Rebuild the frame from plugin state: it may be a fresh document after a remount. */
async function onFrameReady() {
  frameReady = true
  lastLook = ''
  const pending = queue
  queue = []
  postLook()
  setTimeout(postLook, 1500) // the app may still be applying its skin during startup
  for (const f of (await appFonts()) || []) {
    const buffer = f.buffer.slice(0)
    post({ type: 'font', family: f.family, weight: f.weight, style: f.style, buffer }, [buffer])
  }
  const active = $active.get()
  for (const tab of $tabs.get()) {
    const m = meta.get(pathKey(tab.path))
    if (m) {
      post({ type: 'open', path: m.path, text: m.draft ?? m.savedText, saved: m.savedText, eol: m.eol, show: false })
    }
  }
  for (const [msg, transfer] of pending) {
    if (msg.type !== 'look' && msg.type !== 'font') {
      post(msg, transfer)
    }
  }
  if (active && meta.has(pathKey(active))) {
    post({ type: 'show', path: meta.get(pathKey(active))!.path })
  }
}

export function onFrameMessage(e: MessageEvent) {
  if (!frameWin || e.source !== frameWin || !e.data || typeof e.data.type !== 'string') {
    return
  }
  const m = e.data
  switch (m.type) {
    case 'ready':
      void onFrameReady()
      break
    case 'dirty':
      $tabs.set($tabs.get().map(t => (pathKey(t.path) === pathKey(m.path) ? { ...t, dirty: m.dirty, preview: m.dirty ? false : t.preview } : t)))
      break
    case 'draft': {
      const meta0 = meta.get(pathKey(m.path))
      if (meta0) {
        meta0.draft = m.text
        persistDrafts()
      }
      break
    }
    case 'save':
      void saveText(m.path, m.text)
      break
    case 'cursor':
      $cursor.set({ line: m.line, col: m.col, sel: m.sel, lang: m.lang, eol: m.eol })
      break
    case 'addToChat':
      void addToChat(m.path, m.empty ? undefined : m.from, m.empty ? undefined : m.to)
      break
    case 'inlineEdit':
      void inlineEdit(m.path, m.from, m.to, m.instruction)
      break
    case 'diffResolved':
      if ($banners.get()[m.path]?.kind === 'agent') {
        keepAgentEdit(m.path)
      }
      break
    case 'command':
      runCommand(m.id)
      break
  }
}

// ── tiles: Explorer, Editor and Browser are separate app tiles beside the chat ──────────────
//
// Each column is the app's own workspace tile, so its tab is a real drag handle: the user drags a
// column to any edge of another (the app's FancyZones engine) or stacks it as a tab, exactly like
// the app's own panes. The arrangement is saved and rebuilt when the IDE window opens.

const TILE_TITLE: Record<TileId, string> = { explorer: 'Explorer', editor: 'Editor', browser: 'Browser' }
const TILE_MIN: Record<TileId, string> = { explorer: '13rem', editor: '24rem', browser: '22rem' }
const closers = new Map<TileId, () => void>()
let disposing = false

export const $openTiles = atom<TileId[]>([])

/** Each IDE window keeps its own arrangement (several can be open, and they must not overwrite
 *  each other); the last one saved anywhere is the template for a chat that has none yet. */
const perChat = (key: string) => `${key}:${windowSessionId() ?? 'draft'}`

function readPerChat<T>(key: string): T | null {
  return (ctx.storage.get(perChat(key), null) as T | null) ?? (ctx.storage.get(key, null) as T | null)
}

function writePerChat(key: string, value: unknown) {
  ctx.storage.set(perChat(key), value)
  ctx.storage.set(key, value)
}

function savedTiles(): TileId[] {
  const v = readPerChat<TileId[]>('tiles')
  return Array.isArray(v) ? TILE_IDS.filter(id => v.includes(id)) : ['explorer', 'editor']
}

function noteTiles() {
  const open = TILE_IDS.filter(id => closers.has(id))
  $openTiles.set(open)
  if (!disposing) writePerChat('tiles', open)
}

export function isTileOpen(id: TileId) {
  return closers.has(id)
}

/** Open (or front) one column. Without an explicit dock it goes where the saved arrangement puts it. */
export function openTile(id: TileId, dock?: DockStep['dock']) {
  // The IDE lives only in its own pop-out window; the main window keeps its normal chat layout.
  if (!IDE_WINDOW || !renderers) {
    return
  }
  if (closers.has(id)) {
    host.revealPane?.(tilePane(id))
    return
  }
  if (typeof host.openWorkspace !== 'function') {
    notify('warning', 'This Hermes Desktop is too old for the Hermes IDE. Update Hermes Desktop.')
    return
  }
  const place = dock ?? dockPlan(savedLayout(), [...$openTiles.get(), id]).find(s => s.id === id)?.dock
  closers.set(
    id,
    host.openWorkspace(`hermes-ide-${id}`, {
      title: TILE_TITLE[id],
      dock: place ?? { pane: 'workspace', pos: 'left' },
      minWidth: TILE_MIN[id],
      render: renderers[id],
      onClose: () => {
        closers.delete(id)
        if (id === 'editor') detachFrame(frameWin)
        noteTiles()
      }
    })
  )
  noteTiles()
}

export function closeTile(id: TileId) {
  closers.get(id)?.()
}

export function toggleTile(id: TileId) {
  if (closers.has(id)) closeTile(id)
  else openTile(id)
}

export function ensureEditor() {
  openTile('editor')
}

/** Plugin unload or reload: close the tiles without recording that as the user's choice. */
export function disposeTiles() {
  disposing = true
  for (const close of [...closers.values()]) close()
  closers.clear()
}

function setTabs(next: Tab[]) {
  $tabs.set(next)
  persistTabs()
}

export async function openFile(path: string, opts: { line?: number; col?: number; preview?: boolean } = {}) {
  ensureEditor()
  const key = pathKey(path)
  const existing = $tabs.get().find(t => pathKey(t.path) === key)
  if (existing && meta.has(key)) {
    if (!opts.preview && existing.preview) {
      setTabs($tabs.get().map(t => (t === existing ? { ...t, preview: false } : t)))
    }
    $active.set(existing.path)
    post({ type: 'show', path: meta.get(key)!.path, line: opts.line, col: opts.col })
    persistTabs()
    return
  }
  let r: any
  try {
    r = await call('/fs/read', { path })
  } catch (e) {
    notify('error', `Could not open ${baseName(path)}: ${(e as Error).message}`)
    return
  }
  if (r.binary || r.too_large) {
    const what = r.too_large ? 'larger than 5 MB' : 'a binary file'
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|mp4|webm)$/i.test(path)) {
      void openInBrowser(r.path)
    } else {
      notify('info', `${baseName(path)} is ${what}, so it is not opened in the editor.`)
    }
    return
  }
  const draft = drafts()[pathKey(r.path)]
  meta.set(pathKey(r.path), { path: r.path, mtime: r.mtime, eol: detectEol(r.text), bom: !!r.bom, savedText: r.text, draft })
  let tabs = $tabs.get().filter(t => pathKey(t.path) !== key)
  if (opts.preview) {
    const old = tabs.find(t => t.preview && !t.dirty)
    if (old) {
      tabs = tabs.filter(t => t !== old)
      post({ type: 'close', path: old.path })
    }
  }
  const tab: Tab = { path: r.path, name: baseName(r.path), dirty: draft != null, preview: !!opts.preview && draft == null }
  const at = existing ? $tabs.get().indexOf(existing) : -1
  if (at >= 0) {
    tabs.splice(at, 0, tab)
  } else {
    const activeIdx = tabs.findIndex(t => t.path === $active.get())
    tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab)
  }
  setTabs(tabs)
  $active.set(r.path)
  post({ type: 'open', path: r.path, text: draft ?? r.text, saved: r.text, eol: detectEol(r.text), line: opts.line, col: opts.col })
  persistTabs()
}

export function activate(path: string) {
  const m = meta.get(pathKey(path))
  if (!m) {
    void openFile(path)
    return
  }
  $active.set(m.path)
  post({ type: 'show', path: m.path })
  persistTabs()
}

export function closeTab(path: string, force = false) {
  const tabs = $tabs.get()
  const idx = tabs.findIndex(t => pathKey(t.path) === pathKey(path))
  if (idx < 0) {
    return
  }
  if (tabs[idx].dirty && !force) {
    $confirmClose.set(tabs[idx].path)
    return
  }
  const next = tabs.filter((_, i) => i !== idx)
  setTabs(next)
  meta.delete(pathKey(path))
  clearBanner(path)
  dropDraft(path)
  post({ type: 'close', path })
  if ($active.get() === path) {
    const fallback = next[Math.min(idx, next.length - 1)]
    $active.set(fallback?.path ?? null)
    if (fallback) {
      activate(fallback.path)
    } else {
      $cursor.set(null)
    }
  }
  persistTabs()
}

export const $confirmClose = atom<string | null>(null)

export function saveActive() {
  const a = $active.get()
  if (a) {
    post({ type: 'saveRequest', path: a })
  }
}

export function saveAll() {
  for (const t of $tabs.get()) {
    if (t.dirty) {
      post({ type: 'saveRequest', path: t.path })
    }
  }
}

async function saveText(path: string, text: string) {
  const m = meta.get(pathKey(path))
  if (!m) {
    return
  }
  try {
    const r = await call('/fs/write', { path: m.path, text, expected_mtime: m.forceNext ? null : m.mtime, bom: m.bom })
    m.mtime = r.mtime
    m.savedText = text
    m.draft = null
    m.forceNext = false
    dropDraft(path)
    clearBanner(path)
    post({ type: 'saved', path: m.path })
    post({ type: 'setDiff', path: m.path, original: null })
    scheduleRefresh()
  } catch (e) {
    if (isConflict(e)) {
      const disk = await call('/fs/read', { path: m.path })
      setBanner(m.path, { kind: 'conflict', diskText: disk.text ?? '', diskMtime: disk.mtime })
    } else {
      notify('error', `Save failed for ${baseName(path)}: ${(e as Error).message}`)
    }
  }
}

// ── agent edits and external changes ─────────────────────────────────────────────────────────

function setBanner(path: string, banner: Banner) {
  $banners.set({ ...$banners.get(), [path]: banner })
}

function clearBanner(path: string) {
  const next = { ...$banners.get() }
  delete next[path]
  $banners.set(next)
}

/** Re-read open files whose mtime moved: clean ones reload (with a reviewable diff when the change
 *  arrived during an agent turn), dirty ones get a conflict banner instead of losing edits. */
export async function syncFromDisk(onlyPaths?: string[], fromAgent = false) {
  const keys = onlyPaths ? new Set(onlyPaths.map(pathKey)) : null
  for (const tab of $tabs.get()) {
    const m = meta.get(pathKey(tab.path))
    if (!m || (keys && !keys.has(pathKey(tab.path)))) {
      continue
    }
    let st: any
    try {
      st = await call('/fs/stat', { path: m.path })
    } catch {
      continue
    }
    if (!st.exists || st.mtime === m.mtime) {
      continue
    }
    const disk = await call('/fs/read', { path: m.path }).catch(() => null)
    if (!disk || disk.text == null || disk.text === m.savedText) {
      if (disk) {
        m.mtime = disk.mtime
      }
      continue
    }
    if (tab.dirty) {
      setBanner(m.path, { kind: 'conflict', diskText: disk.text, diskMtime: disk.mtime })
      continue
    }
    const before = m.savedText
    m.mtime = disk.mtime
    m.savedText = disk.text
    const review = fromAgent && $settings.get().reviewAgentEdits
    post({ type: 'replace', path: m.path, text: disk.text, original: review ? before : null })
    if (review) {
      setBanner(m.path, { kind: 'agent', before })
    }
  }
}

export function keepAgentEdit(path: string) {
  post({ type: 'setDiff', path, original: null })
  clearBanner(path)
}

export async function undoAgentEdit(path: string) {
  const b = $banners.get()[path]
  const m = meta.get(pathKey(path))
  if (!b || b.kind !== 'agent' || !m) {
    return
  }
  try {
    const r = await call('/fs/write', { path: m.path, text: b.before, expected_mtime: m.mtime, bom: m.bom })
    m.mtime = r.mtime
    m.savedText = b.before
    post({ type: 'replace', path: m.path, text: b.before, original: null })
    clearBanner(path)
    scheduleRefresh()
  } catch (e) {
    notify('error', isConflict(e) ? 'The file changed again since the edit; reopen it to review.' : String((e as Error).message))
  }
}

export function resolveConflict(path: string, choice: 'mine' | 'theirs' | 'compare') {
  const b = $banners.get()[path]
  const m = meta.get(pathKey(path))
  if (!b || b.kind !== 'conflict' || !m) {
    return
  }
  if (choice === 'compare') {
    post({ type: 'setDiff', path, original: b.comparing ? null : b.diskText })
    setBanner(path, { ...b, comparing: !b.comparing })
    return
  }
  if (choice === 'mine') {
    m.forceNext = true
    post({ type: 'saveRequest', path })
  } else {
    m.mtime = b.diskMtime
    m.savedText = b.diskText
    m.draft = null
    dropDraft(path)
    post({ type: 'replace', path, text: b.diskText, original: null })
  }
  post({ type: 'setDiff', path, original: null })
  clearBanner(path)
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let agentPaths = new Set<string>()

/** Debounced: tree + git refresh, and re-sync open files. */
export function scheduleRefresh(paths: string[] = [], fromAgent = false) {
  paths.forEach(p => agentPaths.add(p))
  if (refreshTimer) {
    clearTimeout(refreshTimer)
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    agentPaths = new Set()
    bumpTree()
    void refreshGit()
    void syncFromDisk(undefined, fromAgent)
  }, 450)
}

export function onToolComplete(event: any) {
  const payload = event?.payload ?? {}
  scheduleRefresh(pathsFromToolArgs(payload.args), true)
}

// ── workspace root (follows the focused session's working directory) ────────────────────────

export async function canonical(path: string): Promise<string | null> {
  try {
    const st = await call('/fs/stat', { path })
    $backend.set('ok')
    return st.exists && st.dir ? st.path : null
  } catch (e) {
    if (isMissingBackend(e)) {
      $backend.set('missing')
    }
    return null
  }
}

export async function syncRoot() {
  const picked = ctx.storage.get(`root:${sessionKey}`, null) as string | null
  const cwd = normPath(host.state.cwd.get() || '')
  const target = picked || ($settings.get().followSession ? cwd : $root.get() || cwd)
  $rootPicked.set(!!picked)
  if (!target) {
    $root.set(null)
    return
  }
  const root = await canonical(target)
  if (root && root !== $root.get()) {
    $root.set(root)
    bumpTree()
    void refreshGit()
  }
}

export async function setRoot(path: string, applyToSession: boolean) {
  const root = await canonical(path)
  if (!root) {
    notify('error', `Not a folder on the agent's machine: ${path}`)
    return false
  }
  ctx.storage.set(`root:${sessionKey}`, root)
  $rootPicked.set(true)
  $root.set(root)
  bumpTree()
  void refreshGit()
  const sid = host.state.focusedSessionId.get()
  if (applyToSession && sid) {
    try {
      await host.request('session.cwd.set', { session_id: sid, cwd: root })
      ctx.storage.remove(`root:${sessionKey}`) // the session now owns it; keep following
      $rootPicked.set(false)
    } catch (e) {
      notify('warning', `The IDE opened ${baseName(root)}, but the chat stays in its folder: ${(e as Error).message}`)
    }
  }
  return true
}

export function followSession() {
  ctx.storage.remove(`root:${sessionKey}`)
  void syncRoot()
}

export async function refreshGit() {
  const root = $root.get()
  if (!root) {
    $git.set({ repo: false, files: {} })
    return
  }
  try {
    const st = await call<GitState>('/git/status', { root })
    const files: Record<string, string> = {}
    const paths: Record<string, string> = {}
    for (const [p, code] of Object.entries(st.files || {})) {
      files[pathKey(p)] = code
      paths[pathKey(p)] = p
    }
    $git.set({ ...st, files, paths })
  } catch {
    $git.set({ repo: false, files: {} })
  }
}

// ── per-session tabs (the IDE follows the chat you are looking at) ──────────────────────────

function persistTabs() {
  ctx?.storage.set(`tabs:${sessionKey}`, { paths: $tabs.get().filter(t => !t.preview).map(t => t.path), active: $active.get() })
}

function drafts(): Record<string, string> {
  return (ctx.storage.get('drafts', {}) as Record<string, string>) || {}
}

function persistDrafts() {
  const out: Record<string, string> = {}
  for (const [k, m] of meta) {
    if (m.draft != null && m.draft.length < 1_000_000) {
      out[k] = m.draft
    }
  }
  try {
    ctx.storage.set('drafts', out)
  } catch {
    // Storage full: the open editor still holds the text; only crash recovery is lost.
  }
}

function dropDraft(path: string) {
  const d = drafts()
  if (pathKey(path) in d) {
    delete d[pathKey(path)]
    ctx.storage.set('drafts', d)
  }
}

let sessionLoaded = false

export async function switchSession(next: string | null) {
  const key = next || 'draft'
  if (key === sessionKey && sessionLoaded) {
    return
  }
  if (sessionLoaded) {
    persistTabs()
  }
  // A folder opened in a draft chat follows that chat once it exists, and is applied to it as
  // soon as its first turn ends (the gateway refuses to move a running session).
  const draftRoot = sessionKey === 'draft' && key !== 'draft' ? (ctx.storage.get('root:draft', null) as string | null) : null
  if (draftRoot) {
    ctx.storage.set(`root:${key}`, draftRoot)
    ctx.storage.remove('root:draft')
    pendingCwd = { stored: key, cwd: draftRoot }
  }
  sessionLoaded = true
  sessionKey = key
  const stored = ctx.storage.get(`tabs:${key}`, null) as { paths: string[]; active: string | null } | null
  if (!stored) {
    // A chat the IDE has not seen yet (a draft that just became a session, or an old chat):
    // keep the editors that are open rather than blanking the IDE.
    persistTabs()
    await syncRoot()
    return
  }
  const saved = stored
  const keepDirty = $tabs.get().filter(t => t.dirty)
  for (const t of $tabs.get()) {
    if (!t.dirty && !saved.paths.some(p => pathKey(p) === pathKey(t.path))) {
      meta.delete(pathKey(t.path))
      post({ type: 'close', path: t.path })
    }
  }
  const tabs: Tab[] = [...keepDirty]
  for (const p of saved.paths) {
    if (!tabs.some(t => pathKey(t.path) === pathKey(p))) {
      tabs.push({ path: p, name: baseName(p), dirty: false, preview: false })
    }
  }
  $tabs.set(tabs)
  $active.set(null)
  await syncRoot()
  const active = saved.active && tabs.some(t => pathKey(t.path) === pathKey(saved.active!)) ? saved.active : tabs[0]?.path
  if (active && closers.has('editor')) {
    await openFile(active)
  }
}

let pendingCwd: { stored: string; cwd: string } | null = null

/** After a turn ends, move a just-created chat into the folder the IDE opened for it. */
export async function applyPendingCwd() {
  const p = pendingCwd
  const sid = host.state.focusedSessionId.get()
  if (!p || !sid || host.state.focusedStoredSessionId.get() !== p.stored) {
    return
  }
  try {
    await host.request('session.cwd.set', { session_id: sid, cwd: p.cwd })
    pendingCwd = null
    ctx.storage.remove(`root:${p.stored}`)
    $rootPicked.set(false)
    notify('info', `This chat now works in ${baseName(p.cwd)}.`)
  } catch {
    /* still busy: the next message.complete retries */
  }
}

// ── chat wiring: the IDE never runs its own chat; it writes into the session's composer ─────

function focusedSession(): string | null {
  return host.state.focusedSessionId.get() || null
}

/** Refs are relative only when the IDE shows the chat's own folder; otherwise the agent would
 *  resolve them against a different directory, so they stay absolute. */
function chatRoot(): string | null {
  const root = $root.get()
  const cwd = host.state.cwd.get()
  return root && cwd && pathKey(root) === pathKey(cwd) ? root : null
}

export async function addToChat(path: string, from?: number, to?: number, folder = false) {
  const ref = fileRef(path, chatRoot(), from, to, folder) + ' '
  const sid = focusedSession()
  let ok = await host.composer.insertText(sid, ref, { mode: 'inline' })
  if (!ok && sid) {
    ok = await host.composer.insertText(null, ref, { mode: 'inline' })
  }
  if (ok) {
    host.composer.focus(sid)
  } else {
    await ctx.os.writeClipboard(ref.trim())
    notify('info', 'No chat composer is open, so the reference was copied to the clipboard.')
  }
}

export async function inlineEdit(path: string, from: number, to: number, instruction: string) {
  const text = `In ${fileRef(path, chatRoot(), from, to)}: ${instruction}`
  const sid = focusedSession()
  if (host.composer.submit(sid, text)) {
    notify('info', 'Sent to Hermes. The edit will show here for review when it lands.')
    return
  }
  if (await host.composer.insertText(sid, text, { mode: 'block' })) {
    host.composer.focus(sid)
    notify('info', 'The chat is busy or not ready; your request is in the composer.')
  } else {
    notify('warning', 'Open a chat first, then try again.')
  }
}

/** A navigation request for the IDE's Browser column (the column reads it and loads the page). */
export const $browserNav = atom<{ url: string; at: number } | null>(null)
/** Bumped to ask the Browser column to run the project's UI. */
export const $runUiRequest = atom(0)

/** Show a URL, or a local file, in the IDE's Browser column.
 *  shortcut: a file opens as file:// in the column's webview, which only reaches files on this
 *  machine; against a remote backend, run the project's UI instead. */
export function openInBrowser(target: string) {
  const url = pathOrUrl(target)
  $browserNav.set({ url, at: Date.now() })
  openTile('browser')
}

// ── commands shared by the frame keymap, the palette and the UI ─────────────────────────────

export function revealSidebar(view?: 'explorer' | 'search' | 'scm') {
  if (view) {
    $view.set(view)
  }
  openTile('explorer')
  if (view === 'search') {
    $searchFocus.set($searchFocus.get() + 1)
  }
}

export function showIde() {
  if (!IDE_WINDOW) {
    void openIdeWindow()
    return
  }
  for (const id of savedTiles().length ? savedTiles() : (['explorer', 'editor'] as TileId[])) openTile(id)
  // Tabs restored from a previous launch load lazily; bring the active one up now.
  const tabs = $tabs.get()
  const want = $active.get() ?? tabs[0]?.path
  if (want && !meta.has(pathKey(want))) {
    activate(want)
  }
}

// ── the IDE window: one pop-out window per chat, holding only that chat ─────────────────────
//
// The main window opens the app's own single-session pop-out (the window a session opens in
// with "Open in new window") and leaves a request in localStorage, which that window's copy of
// this plugin claims on load. sessionStorage keeps the claim across a reload of that window.

const OPEN_REQUEST = 'hermes-ide:open-window'
const WINDOW_MARK = 'hermes-ide:window'
const PENDING_OPEN = 'hermes-ide:pending-open'

interface OpenRequest {
  sid: string
  at: number
  path?: string
  line?: number
  url?: string
}

const isPopout = () => new URLSearchParams(location.search).get('win') === 'secondary'

/** The stored session id this pop-out window was opened for (its route is `#/<id>`). */
export function windowSessionId(): string | null {
  const m = /^#\/([^/?#]+)/.exec(location.hash)
  return m ? decodeURIComponent(m[1]) : host.state.focusedStoredSessionId.get() || null
}

function readRequest(): OpenRequest | null {
  try {
    const req = JSON.parse(localStorage.getItem(OPEN_REQUEST) || 'null')
    return req && typeof req.sid === 'string' && typeof req.at === 'number' ? req : null
  } catch {
    return null
  }
}

/** Take a request addressed to this window; stale requests (over a minute old) are ignored. */
function claimRequest(): OpenRequest | null {
  const req = readRequest()
  const sid = windowSessionId()
  if (!req || !sid || req.sid !== sid || Date.now() - req.at > 60_000) {
    return null
  }
  localStorage.removeItem(OPEN_REQUEST)
  if (req.path || req.url) {
    sessionStorage.setItem(PENDING_OPEN, JSON.stringify({ path: req.path, line: req.line, url: req.url }))
  }
  return req
}

function detectIdeWindow(): boolean {
  if (!isPopout()) {
    return false
  }
  if (sessionStorage.getItem(WINDOW_MARK) === '1') {
    return true
  }
  if (claimRequest()) {
    sessionStorage.setItem(WINDOW_MARK, '1')
    return true
  }
  return false
}

export const IDE_WINDOW = detectIdeWindow()

// ── IDE chats: the chats opened in an IDE window, listed in their own sidebar group ─────────

const IDE_CHATS = 'ideChats'
export const $ideChats = atom<Record<string, number>>({})

export function loadIdeChats() {
  const v = ctx.storage.get(IDE_CHATS, {})
  $ideChats.set(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
}

export function setIdeChats(next: Record<string, number>) {
  $ideChats.set(next)
  ctx.storage.set(IDE_CHATS, next)
}

/** Remember a chat as an IDE chat (by any of its ids; the sidebar maps it to the durable one). */
export function markIdeChat(id: string | null | undefined) {
  if (!id) return
  loadIdeChats() // another window may have written since
  setIdeChats({ ...$ideChats.get(), [id]: Date.now() })
}

export function unmarkIdeChat(ids: string[]) {
  loadIdeChats()
  const next = { ...$ideChats.get() }
  for (const id of ids) delete next[id]
  setIdeChats(next)
}

/** Main window: open the chat on screen in its own IDE window (or front the one it has). */
export async function openIdeWindow(open?: { path?: string; line?: number; url?: string; sid?: string }) {
  if (IDE_WINDOW) {
    showIde()
    return
  }
  const focused = host.state.focusedStoredSessionId.get()
  // The IDE opens the chat you are looking at. On a page such as Capabilities the app still keeps
  // a "focused" session (the first tile), which is not what the user means, so require a chat on
  // screen: its composer is visible. (The route id is no test: a compacted chat continues under a
  // new stored id while the route can keep an earlier one.) An agent request names its own session.
  const chatOnScreen = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].some(
    el => !el.closest('.hi-tile, [role="dialog"]') && el.getBoundingClientRect().width > 0
  )
  const sid = open?.sid ?? (chatOnScreen ? focused : null)
  const bridge = (window as any).hermesDesktop
  if (!sid) {
    notify(
      'info',
      chatOnScreen ? 'Send the first message in this chat, then open it in the IDE.' : 'Open the chat you want in the IDE, then click IDE.',
      'Hermes IDE'
    )
    return
  }
  if (typeof bridge?.openSessionWindow !== 'function') {
    notify('warning', 'This Hermes Desktop cannot open pop-out windows. Update Hermes Desktop.', 'Hermes IDE')
    return
  }
  const req: OpenRequest = { sid, at: Date.now(), ...(open?.path ? { path: open.path, line: open.line } : {}), ...(open?.url ? { url: open.url } : {}) }
  // Already in a plain pop-out of this chat: the app would only re-front this window, and a
  // window never receives its own storage events, so convert it here.
  if (isPopout() && windowSessionId() === sid) {
    sessionStorage.setItem(WINDOW_MARK, '1')
    if (req.path || req.url) {
      sessionStorage.setItem(PENDING_OPEN, JSON.stringify({ path: req.path, line: req.line, url: req.url }))
    }
    location.reload()
    return
  }
  localStorage.setItem(OPEN_REQUEST, JSON.stringify(req))
  markIdeChat(sid)
  const owner = host.state.focusedSessionOwner?.get?.()
  try {
    await bridge.openSessionWindow(sid, {
      profile: owner?.profile ?? host.state.focusedSessionProfile?.get?.() ?? null,
      connectionId: owner?.connectionId ?? null
    })
  } catch (e) {
    localStorage.removeItem(OPEN_REQUEST)
    notify('error', `Could not open the IDE window: ${(e as Error).message}`, 'Hermes IDE')
  }
}

/** Every pop-out listens: a request for its chat either converts a plain pop-out of that chat
 *  into the IDE (the app fronts the existing window instead of opening a second one) or, in the
 *  IDE window, carries a file to open. */
export function onStorageRequest(e: StorageEvent) {
  if (e.key !== OPEN_REQUEST || !e.newValue || !isPopout()) {
    return
  }
  const req = claimRequest()
  if (!req) {
    return
  }
  if (!IDE_WINDOW) {
    sessionStorage.setItem(WINDOW_MARK, '1')
    location.reload()
    return
  }
  showIde()
  if (req.path) {
    sessionStorage.removeItem(PENDING_OPEN)
    void openFile(req.path, { line: req.line })
  }
  if (req.url) {
    openInBrowser(req.url)
  }
}

/** Wait `n` animation frames, or a moment when the window is not painting: a window behind
 *  another gets no animation frames, which would otherwise stall the layout code. */
const frames = (n = 2) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, 80 * n)
  const step = () => (--n <= 0 ? (clearTimeout(timer), resolve()) : requestAnimationFrame(step))
  requestAnimationFrame(step)
})

/** Resolve once the window size has held still for `quiet` ms (a maximize lands in steps). */
function sizeSettled(quiet = 300, cap = 2500) {
  return new Promise<void>(resolve => {
    let timer = window.setTimeout(done, quiet)
    const cap_ = window.setTimeout(done, cap)
    function onResize() {
      clearTimeout(timer)
      timer = window.setTimeout(done, quiet)
    }
    function done() {
      clearTimeout(timer)
      clearTimeout(cap_)
      window.removeEventListener('resize', onResize)
      resolve()
    }
    window.addEventListener('resize', onResize)
  })
}

/** Resolve once the window is close to the screen's width (the maximize can land well after the
 *  first resize on large or multiple displays), or after 6 s if the user's window manager refuses. */
function maximized(cap = 6000) {
  return new Promise<void>(resolve => {
    const start = Date.now()
    const check = () => {
      if (window.outerWidth >= screen.availWidth * 0.85 || Date.now() - start > cap) resolve()
      else setTimeout(check, 100)
    }
    check()
  })
}

/** Move the app's split seam at `edge` (window x) to `target`. shortcut: the SDK has no door to
 *  size a split, so this drags the app's own sash with synthetic pointer events (tree-split.tsx
 *  accepts them, clamps to each zone's floor, and commits once on release). Upgrade to a host
 *  door when the SDK ships one; without a sash the layout keeps the app's even split. */
async function dragSeam(edge: number, target: number): Promise<boolean> {
  const sash = [...document.querySelectorAll<HTMLElement>('[role="separator"]')]
    .filter(el => !el.closest('.hi-tile'))
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(s => s.r.height > 200 && s.r.width > 0 && s.r.width < 24 && Math.abs(s.r.left - edge) < 24)
    .sort((a, b) => Math.abs(a.r.left - edge) - Math.abs(b.r.left - edge))[0]
  if (!sash) {
    return false
  }
  const y = Math.round(sash.r.top + sash.r.height / 2)
  const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientY: y }
  // The seam moves by the pointer's travel from where it pressed (the sash's middle), so aim the
  // pointer that far past the target or every fitted column lands half a sash short.
  const down = Math.round(sash.r.left + sash.r.width / 2)
  const to = Math.round(target + down - sash.r.left)
  sash.el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: down, button: 0, buttons: 1 }))
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: to, button: -1, buttons: 1 }))
  await frames(2) // the sash previews once per animation frame and commits on release
  window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: to, button: 0, buttons: 0 }))
  return true
}

interface Column {
  ids: ColumnId[]
  left: number
  width: number
}

/** The window's top-row columns, left to right, with the IDE columns and the chat they hold.
 *  Zones that start lower (a terminal panel) are not columns. shortcut: a column split top and
 *  bottom is read as one column holding both stacks; it is rebuilt side by side. */
function readColumns(): Column[] {
  const zones = [...document.querySelectorAll<HTMLElement>('[data-tree-group]:not([data-pane-host])')]
    .map(el => ({ r: el.getBoundingClientRect(), id: el.getAttribute('data-tree-group') || '' }))
    .filter(z => z.r.width > 0 && z.r.height > 0 && z.id !== 'grp-sessions')
  if (!zones.length) return []
  const top = Math.min(...zones.map(z => z.r.top))
  const cols: Column[] = []
  for (const z of zones.filter(z => z.r.top <= top + 4).sort((a, b) => a.r.left - b.r.left)) {
    if (!cols.some(c => Math.abs(c.left - z.r.left) < 4)) cols.push({ ids: [], left: z.r.left, width: z.r.width })
  }
  // By geometry, not DOM nesting: a pane body can be hosted outside its zone element.
  const colAt = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect()
    if (!r || r.width <= 0) return undefined
    const x = r.left + r.width / 2
    return cols.find(c => x >= c.left && x <= c.left + c.width)
  }
  const composer = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].find(
    el => !el.closest('.hi-tile, [role="dialog"]') && el.getBoundingClientRect().width > 0
  )
  colAt(composer)?.ids.push('chat')
  // A closed tile's DOM can linger hidden for a moment; take the copy that is on screen.
  for (const id of TILE_IDS) colAt([...document.querySelectorAll(`.hi-tile[data-tile="${id}"]`)].find(el => el.getBoundingClientRect().width > 0))?.ids.push(id)
  return cols
}

export function savedLayout(): Layout {
  const v = readPerChat<Layout>('layout')
  return v && Array.isArray(v.columns) ? { columns: v.columns, widths: v.widths && typeof v.widths === 'object' ? v.widths : {} } : DEFAULT_LAYOUT
}

let layoutReady = false
let fitting = false

/** Record the arrangement the user has now. Tabs stacked behind another are not on screen, so an
 *  open tile that cannot be found keeps the column it had in the saved layout. */
function captureLayout(): Layout | null {
  const cols = readColumns().filter(c => c.ids.length)
  if (!cols.length || !cols.some(c => c.ids.includes('chat'))) return null
  const prev = savedLayout()
  const placed = new Set(cols.flatMap(c => c.ids))
  for (const id of $openTiles.get()) {
    if (placed.has(id)) continue
    const mates = prev.columns.find(col => col.includes(id)) || []
    const home = cols.find(c => c.ids.some(x => mates.includes(x)))
    if (home) home.ids.push(id)
  }
  const W = window.innerWidth
  const widths: Layout['widths'] = { ...prev.widths }
  for (const c of cols) for (const id of c.ids) widths[id] = Math.round((c.width / W) * 1000) / 1000
  return { columns: cols.map(c => c.ids), widths }
}

let lastSaved = ''

export function saveLayout() {
  if (!IDE_WINDOW || !layoutReady || fitting) return
  const layout = captureLayout()
  if (!layout) return
  const prev = savedLayout()
  if (JSON.stringify(layout.columns) !== JSON.stringify(prev.columns)) {
    // A column moved: the app re-splits the window evenly after a move, so keep each column's
    // own width (keyed by column, not position) and refit before recording widths again.
    writePerChat('layout', { columns: layout.columns, widths: prev.widths })
    lastSaved = ''
    void fitColumns().then(saveLayout)
    return
  }
  const json = JSON.stringify(layout)
  if (json !== lastSaved) {
    lastSaved = json
    writePerChat('layout', layout)
  }
}

/** Size the columns: saved widths where the user set them, the column plan elsewhere; the editor
 *  (or the chat, with the editor closed) takes the rest. Columns the IDE does not own keep theirs. */
let refitWhenShown = false

export async function fitColumns(): Promise<void> {
  if (fitting) return
  // The app's sash only previews (and so moves) on animation frames: fit once the window paints.
  if (document.visibilityState !== 'visible') {
    refitWhenShown = true
    return
  }
  fitting = true
  try {
    await frames(3)
    const W = window.innerWidth
    const saved = savedLayout().widths
    const measure = () => readColumns()
    let cols = measure()
    const ids = cols.map(c => (c.ids.includes('editor') ? 'editor' : c.ids.includes('chat') ? 'chat' : (c.ids[0] ?? null)))
    const planned = columnWidths(ids, W, saved)
    const widths = planned.map((w, i) => (w === null && ids[i] === null ? cols[i].width : w))
    const flex = widths.indexOf(null)
    if (flex < 0) return
    // Work outward-in toward the flexible column, re-measuring after each move and aiming from
    // where the neighbour really ended up: the app clamps a column at its floor (the chat's is
    // wider than its plan on large screens), so planned sums would misplace the next seam.
    for (let k = 0; k < flex; k++) {
      const edge = cols[k].left + cols[k].width
      const target = cols[k].left + (widths[k] as number)
      if (Math.abs(edge - target) > 6 && (await dragSeam(edge, target))) {
        await frames(3)
        cols = measure()
      }
    }
    for (let k = cols.length - 1; k > flex; k--) {
      const edge = cols[k].left
      const target = cols[k].left + cols[k].width - (widths[k] as number)
      if (Math.abs(edge - target) > 6 && (await dragSeam(edge, target))) {
        await frames(3)
        cols = measure()
      }
    }
  } finally {
    fitting = false
  }
}

/** Rebuild the saved arrangement: open each tile docked against its already placed neighbour. */
async function restoreLayout() {
  for (const step of dockPlan(savedLayout(), savedTiles())) {
    openTile(step.id, step.dock)
    await frames(2) // let the app adopt the tile before the next one docks against it
  }
}

/** Put every column back where a fresh install has it: forget the arrangement and rebuild the
 *  window through the same restore path it boots with. (Closing and reopening tiles in place races
 *  the app's pane adoption and can leave an empty zone.) */
export function resetLayout() {
  layoutReady = false // no save on the way out (pagehide) may write the old arrangement back
  ctx.storage.remove(perChat('layout'))
  ctx.storage.remove('layout')
  location.reload()
}

/** Fit columns when one opens or closes, and save the arrangement while the user works. */
export function watchLayout() {
  let timer = 0
  let zones = -1
  const obs = new MutationObserver(() => {
    const n = document.querySelectorAll('[data-tree-group]').length
    if (n === zones) return // chat streaming mutates constantly; only a new or closed zone matters
    zones = n
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (layoutReady) void fitColumns().then(saveLayout)
    }, 400)
  })
  obs.observe(document.body, { childList: true, subtree: true })
  const save = () => window.setTimeout(saveLayout, 300)
  window.addEventListener('pointerup', save, true)
  const shown = () => {
    if (refitWhenShown && document.visibilityState === 'visible') {
      refitWhenShown = false
      void fitColumns().then(saveLayout)
    }
  }
  document.addEventListener('visibilitychange', shown)
  window.addEventListener('focus', shown)
  const tick = window.setInterval(saveLayout, 3000)
  ctx.onDispose(() => {
    clearTimeout(timer)
    clearInterval(tick)
    window.removeEventListener('pointerup', save, true)
    document.removeEventListener('visibilitychange', shown)
    window.removeEventListener('focus', shown)
    obs.disconnect()
  })
}

/** The IDE window shows one chat: hide the app's session list there (pop-out layout state is
 *  memory-only, so this never touches the main window's sidebar). */
async function hideSessionList() {
  const visible = () => (document.querySelector<HTMLElement>('[data-tree-group="grp-sessions"]')?.getBoundingClientRect().width ?? 0) > 0
  // The toggle only takes effect once the window is wide (a narrow window treats the list as an
  // overlay), so verify and retry a few times instead of trusting one call.
  for (let i = 0; i < 4 && visible(); i++) {
    ctx.runAction?.('view.toggleSidebar')
    await new Promise(r => setTimeout(r, 400))
  }
}

/** IDE window only: the app draws its zone seams at 10% so a chat window stays calm; an IDE needs
 *  its columns readable at a glance (Cursor draws a full 1px line), so draw them at full strength in
 *  the same neutral divider the IDE tile uses (theme base colour at 18%). Removed with the plugin. */
function styleIdeWindow() {
  const el = document.createElement('style')
  el.id = 'hermes-ide-window'
  el.textContent =
    '[data-sash-overlap] > span:first-child{opacity:1 !important;transform:none !important;translate:none !important;background:color-mix(in srgb,var(--ui-base) 18%,transparent) !important}' +
    // The chat is the middle tone between the Explorer and the editor; glass skins leave it clear.
    '[data-tree-group="grp-main"]{background:var(--ui-bg-chrome)}'
  document.head.append(el)
  ctx.onDispose(() => el.remove())
}

/** IDE window boot: take the room an IDE needs, rebuild the columns beside the chat, size them. */
export async function setupIdeWindow() {
  const bridge = (window as any).hermesDesktop
  markIdeChat(windowSessionId())
  // The app opens pop-outs at a compact 420px; maximize once per window (the user can restore it).
  if (!sessionStorage.getItem('hermes-ide:sized') && window.outerWidth < screen.availWidth * 0.85) {
    sessionStorage.setItem('hermes-ide:sized', '1')
    bridge?.windowControls?.toggleMaximize?.()
  }
  styleIdeWindow()
  // For the CDP checks in docs/DEVELOPING.md.
  ;(window as any).__hermesIde = { fitColumns, readColumns, savedLayout, captureLayout, browserNav: $browserNav }
  await restoreLayout()
  // The chat's tabs were restored before the editor tile existed; load the active one now.
  const want = $active.get() ?? $tabs.get()[0]?.path
  if (want && !meta.has(pathKey(want)) && closers.has('editor')) activate(want)
  await maximized()
  await sizeSettled()
  await hideSessionList()
  await frames(2)
  await fitColumns()
  layoutReady = true
  saveLayout()
  const pending = sessionStorage.getItem(PENDING_OPEN)
  if (pending) {
    sessionStorage.removeItem(PENDING_OPEN)
    try {
      const p = JSON.parse(pending)
      if (typeof p?.path === 'string') {
        await openFile(p.path, { line: Number(p.line) > 0 ? Number(p.line) : undefined })
      }
      if (typeof p?.url === 'string') {
        openInBrowser(p.url)
      }
    } catch {
      /* malformed request: ignore */
    }
  }
}

export function runCommand(id: string) {
  const active = $active.get()
  switch (id) {
    case 'quickOpen':
      $quickOpen.set(true)
      break
    case 'palette':
      ctx.runAction?.('nav.commandPalette')
      break
    case 'findInFiles':
      revealSidebar('search')
      break
    case 'explorer':
      revealSidebar('explorer')
      break
    case 'toggleSidebar':
      toggleTile('explorer')
      break
    case 'toggleEditor':
      toggleTile('editor')
      break
    case 'toggleBrowser':
      toggleTile('browser')
      break
    case 'openFolder':
      $folderDialog.set(true)
      break
    case 'runUi':
      openTile('browser')
      $runUiRequest.set($runUiRequest.get() + 1)
      break
    case 'toggleTerminal':
      host.revealPane?.('terminal')
      break
    case 'closeTab':
      if (active) {
        closeTab(active)
      }
      break
    case 'nextTab':
    case 'prevTab': {
      const tabs = $tabs.get()
      const i = tabs.findIndex(t => t.path === active)
      const next = tabs[(i + (id === 'nextTab' ? 1 : -1) + tabs.length) % tabs.length]
      if (next) {
        activate(next.path)
      }
      break
    }
    case 'saveAll':
      saveAll()
      break
    case 'copyRelativePath':
      if (active) {
        void ctx.os.writeClipboard(fileRef(active, $root.get()).replace(/^@file:/, '').replace(/^"|"$/g, ''))
      }
      break
    case 'openInBrowser':
      if (active) {
        void openInBrowser(active)
      }
      break
    case 'revealInExplorer':
      if (active) {
        $reveal.set(active)
        revealSidebar('explorer')
      }
      break
  }
}

export function relToRoot(path: string) {
  const root = $root.get()
  return root && isInside(path, root) ? normPath(path).slice(normPath(root).length + 1) : normPath(path)
}
