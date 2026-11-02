// Hermes IDE state and actions. Everything that talks to the backend, the editor frame, the
// composer, or the app shell lives here; ui.tsx only renders atoms and calls these functions.

import { atom, host } from '@hermes/plugin-sdk'

import { baseName, columnPlan, detectEol, fileRef, isInside, normPath, pathKey, pathsFromToolArgs } from './util'

export { columnPlan }

// ── context ──────────────────────────────────────────────────────────────────────────────────

export let ctx: any = null
let renderEditor: (() => unknown) | null = null

export function bindContext(c: any, editorRenderer: () => unknown) {
  ctx = c
  renderEditor = editorRenderer
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
}

const DEFAULTS: Settings = { followSession: true, showHidden: true, wordWrap: false, fontSize: 13, reviewAgentEdits: true }
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

// ── tabs and files ───────────────────────────────────────────────────────────────────────────

let closeEditor: (() => void) | null = null
let disposing = false

export function ensureEditor() {
  // The IDE lives only in its own pop-out window; the main window keeps its normal chat layout.
  if (closeEditor || !renderEditor || !IDE_WINDOW) {
    return
  }
  if (typeof host.openWorkspace !== 'function') {
    notify('warning', 'This Hermes Desktop is too old for the IDE editor. Update Hermes Desktop.')
    return
  }
  closeEditor = host.openWorkspace('hermes-ide-editor', {
    title: 'IDE',
    dock: { pane: 'workspace', pos: 'left' },
    minWidth: '28rem',
    render: renderEditor,
    onClose: () => {
      closeEditor = null
      detachFrame(frameWin)
    }
  })
}

/** Plugin unload or reload: close the tile without recording it as the user's choice. */
export function disposeEditor() {
  disposing = true
  closeEditor?.()
  closeEditor = null
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
  if (active && closeEditor) {
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

export const $browserTarget = atom<string | null>(null)

/** Show a file or URL in Desktop's own Browser (where Annotate picks elements for the chat).
 *  shortcut: plugins have no door that opens a Browser tab directly, so the IDE shows the app's
 *  own preview link (MessageTextContent) and the user's click opens it through core's handler.
 *  Upgrade to host.openPreview(target) when the SDK ships one. */
export function openInBrowser(target: string) {
  $browserTarget.set(target)
}

// ── commands shared by the frame keymap, the palette and the UI ─────────────────────────────

export function revealSidebar(view?: 'explorer' | 'search' | 'scm') {
  if (view) {
    $view.set(view)
  }
  $explorerHidden.set(false)
  ensureEditor()
  host.revealPane?.('plugin-workspace:hermes-ide-editor')
  if (view === 'search') {
    $searchFocus.set($searchFocus.get() + 1)
  }
}

export function showIde() {
  if (!IDE_WINDOW) {
    void openIdeWindow()
    return
  }
  revealSidebar('explorer')
  // Tabs restored from a previous launch load lazily; bring the active one up now.
  const tabs = $tabs.get()
  const want = $active.get() ?? tabs[0]?.path
  if (want && !meta.has(pathKey(want))) {
    activate(want)
  }
  void fitColumns()
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
  if (req.path) {
    sessionStorage.setItem(PENDING_OPEN, JSON.stringify({ path: req.path, line: req.line }))
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

export const $explorerHidden = atom(false)

/** Main window: open the chat on screen in its own IDE window (or front the one it has). */
export async function openIdeWindow(open?: { path?: string; line?: number; sid?: string }) {
  if (IDE_WINDOW) {
    showIde()
    return
  }
  const focused = host.state.focusedStoredSessionId.get()
  // The IDE opens the chat you are looking at. On a page such as Capabilities the app still keeps
  // a "focused" session (the first tile), which is not what the user means, so require the route
  // to be that chat. An agent request names its own session and skips this check.
  const routed = /^#\/([^/?#]+)/.exec(location.hash)?.[1]
  const sid = open?.sid ?? (routed && decodeURIComponent(routed) === focused ? focused : null)
  const bridge = (window as any).hermesDesktop
  if (!sid) {
    notify(
      'info',
      focused && routed ? 'Open the chat you want in the IDE, then click IDE.' : 'Send the first message in this chat, then open it in the IDE.',
      'Hermes IDE'
    )
    return
  }
  if (typeof bridge?.openSessionWindow !== 'function') {
    notify('warning', 'This Hermes Desktop cannot open pop-out windows. Update Hermes Desktop.', 'Hermes IDE')
    return
  }
  const req: OpenRequest = { sid, at: Date.now(), ...(open?.path ? { path: open.path, line: open.line } : {}) }
  // Already in a plain pop-out of this chat: the app would only re-front this window, and a
  // window never receives its own storage events, so convert it here.
  if (isPopout() && windowSessionId() === sid) {
    sessionStorage.setItem(WINDOW_MARK, '1')
    if (req.path) {
      sessionStorage.setItem(PENDING_OPEN, JSON.stringify({ path: req.path, line: req.line }))
    }
    location.reload()
    return
  }
  localStorage.setItem(OPEN_REQUEST, JSON.stringify(req))
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
}

const frames = (n = 2) => new Promise<void>(resolve => {
  const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step))
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
  const ide = document.querySelector<HTMLElement>('.hi-ide')
  const sash = [...document.querySelectorAll<HTMLElement>('[role="separator"]')]
    .filter(el => !ide?.contains(el))
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(s => s.r.height > 200 && s.r.width > 0 && s.r.width < 24 && Math.abs(s.r.left - edge) < 24)
    .sort((a, b) => Math.abs(a.r.left - edge) - Math.abs(b.r.left - edge))[0]
  if (!sash) {
    return false
  }
  const y = Math.round(sash.r.top + sash.r.height / 2)
  const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientY: y }
  sash.el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: Math.round(sash.r.left + sash.r.width / 2), button: 0, buttons: 1 }))
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: Math.round(target), button: -1, buttons: 1 }))
  await frames(2) // the sash previews once per animation frame and commits on release
  window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: Math.round(target), button: 0, buttons: 0 }))
  return true
}

/** Size the chat column (the zone right of the IDE tile) to the column plan. */
export async function fitColumns(): Promise<boolean> {
  await frames(3)
  const ide = document.querySelector<HTMLElement>('.hi-ide')
  if (!ide) {
    return false
  }
  const { chat } = columnPlan(window.innerWidth)
  const right = ide.getBoundingClientRect().right
  const end = previewZones().reduce((x, z) => Math.min(x, z.getBoundingClientRect().left), window.innerWidth)
  return dragSeam(right, Math.max(Math.round(window.innerWidth * 0.3), end - chat))
}

/** Browser and preview zones the app docked to the right of the chat (the core preview pane
 *  carries the Browser's Annotate tool, which picks elements for the chat). */
function previewZones(): HTMLElement[] {
  const chat = document.querySelector<HTMLElement>('[data-tree-group="grp-main"]')
  if (!chat) {
    return []
  }
  const chatRight = chat.getBoundingClientRect().right
  const seen = new Set<string>()
  return [...document.querySelectorAll<HTMLElement>('[data-tree-group]')].filter(z => {
    const r = z.getBoundingClientRect()
    const id = z.getAttribute('data-tree-group') || ''
    if (r.width <= 0 || r.left < chatRight - 2 || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const fittedPreviews = new Set<string>()
let fitting = false

/** A preview docked beside the chat opens as a narrow strip (or comes back oversized after a
 *  reload); fit it to the plan once (the editor gives or takes the space, the chat keeps its
 *  width), then leave any size the user picks. */
async function fitPreview() {
  const zone = previewZones()[0]
  const id = zone?.getAttribute('data-tree-group')
  if (fitting || !zone || !id || fittedPreviews.has(id)) {
    return
  }
  fittedPreviews.add(id)
  fitting = true
  try {
    const W = window.innerWidth
    const { preview } = columnPlan(W)
    if (Math.abs(zone.getBoundingClientRect().width - preview) < preview * 0.1) {
      return
    }
    const chatW = document.querySelector<HTMLElement>('[data-tree-group="grp-main"]')!.getBoundingClientRect().width
    const ide = document.querySelector<HTMLElement>('.hi-ide')
    // Absolute targets, re-measured between moves: each seam drag can shift the others.
    if (ide) {
      await dragSeam(ide.getBoundingClientRect().right, W - preview - chatW)
      await frames(3)
    }
    const left = previewZones()[0]?.getBoundingClientRect().left
    if (left !== undefined && Math.abs(left - (W - preview)) > 8) {
      await dragSeam(left, W - preview)
    }
  } finally {
    fitting = false
  }
}

/** Watch the IDE window's layout for previews the app or the agent opens. */
export function watchPreviews() {
  let timer = 0
  let zones = -1
  const obs = new MutationObserver(() => {
    const n = document.querySelectorAll('[data-tree-group]').length
    if (n === zones) return // chat streaming mutates constantly; only a new or closed zone matters
    zones = n
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (previewZones().length) {
        void fitPreview()
        return
      }
      // A closed preview hands its space to the chat; in an IDE it belongs to the editor.
      const chat = document.querySelector<HTMLElement>('[data-tree-group="grp-main"]')?.getBoundingClientRect().width ?? 0
      if (!fitting && chat > columnPlan(window.innerWidth).chat + 160) {
        void fitColumns()
      }
    }, 400)
  })
  obs.observe(document.body, { childList: true, subtree: true })
  ctx.onDispose(() => {
    clearTimeout(timer)
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

/** IDE window boot: take the room an IDE needs, show the IDE beside the chat, size the columns. */
export async function setupIdeWindow() {
  const bridge = (window as any).hermesDesktop
  // The app opens pop-outs at a compact 420px; maximize once per window (the user can restore it).
  if (!sessionStorage.getItem('hermes-ide:sized') && window.outerWidth < screen.availWidth * 0.85) {
    sessionStorage.setItem('hermes-ide:sized', '1')
    bridge?.windowControls?.toggleMaximize?.()
  }
  ensureEditor()
  styleIdeWindow()
  await maximized()
  await sizeSettled()
  await hideSessionList()
  await frames(2)
  await fitColumns()
  const pending = sessionStorage.getItem(PENDING_OPEN)
  if (pending) {
    sessionStorage.removeItem(PENDING_OPEN)
    try {
      const p = JSON.parse(pending)
      if (typeof p?.path === 'string') {
        await openFile(p.path, { line: Number(p.line) > 0 ? Number(p.line) : undefined })
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
      $explorerHidden.set(!$explorerHidden.get())
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
