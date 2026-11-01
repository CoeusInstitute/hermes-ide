// Hermes IDE state and actions. Everything that talks to the backend, the editor frame, the
// composer, or the app shell lives here; ui.tsx only renders atoms and calls these functions.

import { atom, host } from '@hermes/plugin-sdk'

import { baseName, detectEol, fileRef, isInside, normPath, pathKey, pathsFromToolArgs } from './util'

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
  files: Record<string, string>
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
  post({ type: 'look', ...lookSource(), fontSize: s.fontSize, wrap: s.wordWrap })
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
  const pending = queue
  queue = []
  postLook()
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

export function ensureEditor() {
  if (closeEditor || !renderEditor) {
    return
  }
  if (typeof host.openWorkspace !== 'function') {
    notify('warning', 'This Hermes Desktop is too old for the IDE editor. Update Hermes Desktop.')
    return
  }
  closeEditor = host.openWorkspace('hermes-ide-editor', {
    title: 'Editor',
    dock: { pane: 'workspace', pos: 'left' },
    minWidth: '24rem',
    render: renderEditor,
    onClose: () => {
      closeEditor = null
      detachFrame(frameWin)
    }
  })
}

export function disposeEditor() {
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
    for (const [p, code] of Object.entries(st.files || {})) {
      files[pathKey(p)] = code
    }
    $git.set({ ...st, files })
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
  ctx.storage.set('drafts', out)
}

function dropDraft(path: string) {
  const d = drafts()
  if (pathKey(path) in d) {
    delete d[pathKey(path)]
    ctx.storage.set('drafts', d)
  }
}

export async function switchSession(next: string | null) {
  const key = next || 'draft'
  if (key === sessionKey) {
    return
  }
  persistTabs()
  sessionKey = key
  const saved = ctx.storage.get(`tabs:${key}`, { paths: [], active: null }) as { paths: string[]; active: string | null }
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
  if (active) {
    await openFile(active)
  }
}

export function sessionStorageKey() {
  return sessionKey
}

// ── chat wiring: the IDE never runs its own chat; it writes into the session's composer ─────

function focusedSession(): string | null {
  return host.state.focusedSessionId.get() || null
}

export async function addToChat(path: string, from?: number, to?: number, folder = false) {
  const ref = fileRef(path, $root.get(), from, to, folder) + ' '
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
  const text = `In ${fileRef(path, $root.get(), from, to)}: ${instruction}`
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

export async function openInBrowser(target: string) {
  try {
    const r = await call('/preview/open', { url: target, session_id: host.state.focusedSessionId.get() || '' })
    if (r?.ok) {
      return
    }
  } catch {
    /* fall back to the plain Browser below */
  }
  ctx.runAction?.('view.showBrowser')
  await ctx.os.writeClipboard(target)
  notify('info', 'Browser opened. The address is on your clipboard.')
}

// ── commands shared by the frame keymap, the palette and the UI ─────────────────────────────

export function revealSidebar(view?: 'explorer' | 'search' | 'scm') {
  if (view) {
    $view.set(view)
  }
  host.revealPane?.('hermes-ide:explorer')
  if (view === 'search') {
    $searchFocus.set($searchFocus.get() + 1)
  }
}

export function showIde() {
  revealSidebar('explorer')
  ensureEditor()
  host.revealPane?.('terminal')
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
      ctx.runAction?.('view.toggleSidebar')
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
