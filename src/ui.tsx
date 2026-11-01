// Hermes IDE views. Rendering only; state and actions live in core.ts.

import {
  $accentOverride,
  Button,
  Codicon,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  host,
  Input,
  MessageTextContent,
  SegmentedControl,
  ToggleRow,
  useValue
} from '@hermes/plugin-sdk'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import FRAME_HTML from 'virtual:frame-html'

import {
  $active,
  $backend,
  $browserTarget,
  $banners,
  $confirmClose,
  $cursor,
  $folderDialog,
  $git,
  $quickOpen,
  $reveal,
  $root,
  $rootPicked,
  $searchFocus,
  $settings,
  $tabs,
  $treeVersion,
  $view,
  activate,
  addToChat,
  attachFrame,
  bumpTree,
  call,
  closeTab,
  ctx,
  detachFrame,
  type Entry,
  followSession,
  keepAgentEdit,
  notify,
  onFrameMessage,
  openFile,
  openInBrowser,
  post,
  postLook,
  refreshGit,
  relToRoot,
  resolveConflict,
  saveActive,
  setRoot,
  setSetting,
  syncRoot,
  undoAgentEdit
} from './core'
import { baseName, dirName, joinPath, pathKey, rankFiles, splitLineSuffix } from './util'

// ── styles (scoped by the hi- prefix; theme tokens only, never literal colors) ──────────────

const STYLES = `
.hi-pane{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--font-sans);font-size:12.5px;color:var(--ui-text-secondary)}
.hi-head{display:flex;align-items:center;gap:2px;padding:6px 6px 4px 10px;flex:none}
.hi-title{flex:1;min-width:0;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ui-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hi-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 4px;border-radius:5px;border:0;background:none;color:var(--ui-text-tertiary);cursor:pointer;font:inherit}
.hi-btn:hover{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}
.hi-btn[data-on=true]{background:var(--ui-control-active-background);color:var(--ui-text-primary)}
.hi-views{display:flex;gap:2px;padding:4px 6px 2px;flex:none;border-bottom:1px solid var(--ui-stroke-tertiary)}
.hi-scroll{flex:1;min-height:0;overflow:auto;padding:2px 0 16px}
.hi-row{display:flex;align-items:center;gap:4px;height:22px;padding-right:8px;cursor:pointer;white-space:nowrap;user-select:none;color:var(--ui-text-secondary)}
.hi-row:hover{background:var(--ui-row-hover-background)}
.hi-row[data-active=true]{background:var(--ui-row-active-background);color:var(--ui-text-primary)}
.hi-row[data-ctx=true]{outline:1px solid var(--ui-stroke-secondary);outline-offset:-1px}
.hi-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.hi-dim{color:var(--ui-text-quaternary)}
.hi-git{flex:none;width:14px;text-align:center;font-size:10.5px;font-weight:600}
[data-c=M]{color:var(--ui-yellow)} [data-c="?"],[data-c=A]{color:var(--ui-green)} [data-c=D]{color:var(--ui-red)} [data-c=U],[data-c=R]{color:var(--ui-orange)}
.hi-edit{flex:1;min-width:0;height:20px;font:inherit;color:var(--ui-text-primary);background:var(--ui-bg-input,transparent);border:1px solid var(--ui-accent);border-radius:3px;padding:0 4px;outline:none}
.hi-field{display:flex;gap:4px;padding:6px 8px;flex:none;align-items:center}
.hi-field input{flex:1;min-width:0;height:26px;font:inherit;color:var(--ui-text-primary);background:var(--ui-bg-input,transparent);border:1px solid var(--ui-stroke-secondary);border-radius:5px;padding:0 8px;outline:none}
.hi-field input:focus{border-color:var(--ui-accent)}
.hi-group{display:flex;align-items:center;gap:6px;height:22px;padding:0 8px;cursor:pointer;color:var(--ui-text-primary);font-weight:500}
.hi-hit{padding-left:26px}
.hi-hit mark{background:color-mix(in srgb,var(--ui-yellow) 35%,transparent);color:inherit;border-radius:2px}
.hi-empty{padding:16px 14px;color:var(--ui-text-tertiary);line-height:1.5}
.hi-tabs{display:flex;flex:none;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--ui-stroke-tertiary);min-height:33px}
.hi-tab{position:relative;display:flex;align-items:center;gap:6px;height:33px;padding:0 6px 0 12px;border-right:1px solid var(--ui-stroke-tertiary);color:var(--ui-text-tertiary);cursor:pointer;white-space:nowrap;font-size:12px;user-select:none}
.hi-tab:hover{color:var(--ui-text-secondary)}
.hi-tab[data-active=true]{color:var(--ui-text-primary);background:var(--ui-row-hover-background)}
.hi-tab[data-active=true]::after{content:"";position:absolute;left:0;right:0;top:0;height:1.5px;background:var(--ui-accent)}
.hi-tab[data-preview=true] .hi-tabname{font-style:italic}
.hi-tab .hi-x{width:18px;height:18px;min-width:18px;visibility:hidden}
.hi-tab:hover .hi-x,.hi-tab[data-active=true] .hi-x{visibility:visible}
.hi-dot{width:8px;height:8px;border-radius:50%;background:var(--ui-text-secondary);margin:0 5px}
.hi-tab[data-dirty=true]:hover .hi-dot{display:none}
.hi-tab[data-dirty=true]:not(:hover) .hi-x{display:none}
.hi-crumbs{display:flex;align-items:center;gap:2px;flex:none;height:26px;padding:0 6px 0 12px;font-size:11.5px;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden}
.hi-crumbs .hi-sep{opacity:.6}
.hi-crumbs .hi-spacer{flex:1}
.hi-banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:6px 12px;font-size:12px;color:var(--ui-text-primary);border-bottom:1px solid var(--ui-stroke-tertiary);background:color-mix(in srgb,var(--ui-accent) 9%,transparent)}
.hi-banner .hi-spacer{flex:1}
.hi-frame{flex:1;min-height:0;width:100%;border:0;display:block;background:transparent}
.hi-qo{display:flex;flex-direction:column;gap:6px}
.hi-qo input{height:30px;font:inherit;font-size:13px;color:var(--ui-text-primary);background:var(--ui-bg-input,transparent);border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:0 10px;outline:none}
.hi-qo-list{max-height:52vh;overflow:auto;font-size:12.5px}
.hi-qo-row{display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-radius:5px;cursor:pointer;color:var(--ui-text-secondary)}
.hi-qo-row[data-on=true]{background:var(--ui-row-active-background);color:var(--ui-text-primary)}
.hi-status{display:inline-flex;gap:10px;align-items:center;padding:0 6px;font-size:.6875rem;color:var(--ui-text-tertiary);white-space:nowrap}
.hi-card{display:inline-flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;font-size:12.5px;color:var(--ui-text-primary);background:none;cursor:pointer;font-family:var(--font-mono)}
.hi-card:hover{background:var(--ui-row-hover-background)}
`

export function Styles() {
  return <style>{STYLES}</style>
}

const icon = (name: string, size = 14) => <Codicon name={name} size={size} />

function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(name)) return 'file-media'
  if (/\.(md|mdx|txt|rst)$/i.test(name)) return 'markdown'
  if (/\.(json|ya?ml|toml|ini|env|lock)$/i.test(name)) return 'json'
  if (/\.(zip|tar|gz|7z)$/i.test(name)) return 'file-zip'
  if (/\.(pdf)$/i.test(name)) return 'file-pdf'
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|cs|rb|php|swift|kt|sh|ps1|sql|css|scss|html?|vue|svelte|lua)$/i.test(name)) return 'file-code'
  return 'file'
}

// ── Sidebar: Explorer / Search / Source Control (one pane, like Cursor's side bar) ──────────

export function Sidebar() {
  const view = useValue($view)
  const root = useValue($root)
  const backend = useValue($backend)
  const git = useValue($git)
  const changes = Object.keys(git.files || {}).length

  return (
    <div className="hi-pane">
      <Styles />
      <div className="hi-views">
        <ViewTab current={view} id="explorer" icon="files" label="Explorer" />
        <ViewTab current={view} id="search" icon="search" label="Search" />
        <ViewTab current={view} id="scm" icon="source-control" label={`Source Control${changes ? ` (${changes})` : ''}`} badge={changes} />
        <span style={{ flex: 1 }} />
        <button className="hi-btn" onClick={() => $quickOpen.set(true)} title="Quick Open (Ctrl+P in the editor)">
          {icon('go-to-file')}
        </button>
        <button className="hi-btn" onClick={() => $folderDialog.set(true)} title="Open Folder…">
          {icon('folder-opened')}
        </button>
      </div>
      {backend === 'missing' ? (
        <BackendMissing />
      ) : !root ? (
        <div className="hi-empty">
          No folder is open. Pick one, or start a chat in a project folder and the IDE follows it.
          <div style={{ marginTop: 10 }}>
            <Button size="sm" variant="secondary" onClick={() => $folderDialog.set(true)}>
              Open Folder…
            </Button>
          </div>
        </div>
      ) : view === 'explorer' ? (
        <Explorer root={root} />
      ) : view === 'search' ? (
        <SearchView root={root} />
      ) : (
        <ScmView root={root} />
      )}
    </div>
  )
}

function ViewTab({ current, id, icon: name, label, badge }: { current: string; id: 'explorer' | 'search' | 'scm'; icon: string; label: string; badge?: number }) {
  return (
    <button className="hi-btn" data-on={current === id} onClick={() => $view.set(id)} title={label} aria-label={label}>
      {icon(name, 15)}
      {badge ? <span style={{ fontSize: 10, marginLeft: 3 }}>{badge}</span> : null}
    </button>
  )
}

function BackendMissing() {
  return (
    <div className="hi-empty">
      The IDE backend is not running. Enable the <b>hermes-ide</b> plugin for this profile:
      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, margin: '8px 0', whiteSpace: 'pre-wrap' }}>hermes plugins enable hermes-ide</pre>
      Routes mount without a restart on current Hermes; on older builds run <code>hermes gateway restart</code>.
      <div style={{ marginTop: 8 }}>
        <Button size="sm" variant="secondary" onClick={() => { $backend.set('unknown'); void syncRoot() }}>
          Retry
        </Button>
      </div>
    </div>
  )
}

// ── Explorer ─────────────────────────────────────────────────────────────────────────────────

type Editing = { kind: 'file' | 'folder'; dir: string } | { kind: 'rename'; path: string; dir: string } | null

function Explorer({ root }: { root: string }) {
  const version = useValue($treeVersion)
  const git = useValue($git)
  const active = useValue($active)
  const reveal = useValue($reveal)
  const settings = useValue($settings)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ctx.storage.get(`expanded:${pathKey(root)}`, []) as string[]))
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [editing, setEditing] = useState<Editing>(null)
  const [ctxTarget, setCtxTarget] = useState<{ path: string; dir: boolean } | null>(null)
  const [trashTarget, setTrashTarget] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    async (dir: string) => {
      try {
        const r = await call<{ entries: Entry[] }>('/fs/list', { path: dir, show_hidden: settings.showHidden })
        setChildren(prev => ({ ...prev, [pathKey(dir)]: r.entries }))
      } catch (e) {
        setChildren(prev => ({ ...prev, [pathKey(dir)]: [] }))
        if (pathKey(dir) === pathKey(root)) notify('error', `Could not list ${root}: ${(e as Error).message}`)
      }
    },
    [root, settings.showHidden]
  )

  // Reload the root and every expanded folder whenever something may have changed on disk.
  useEffect(() => {
    void load(root)
    for (const k of expanded) void load(k)
  }, [root, version, load])

  useEffect(() => {
    ctx.storage.set(`expanded:${pathKey(root)}`, [...expanded])
  }, [expanded, root])

  // Reveal: expand every ancestor of the file, then scroll its row into view.
  useEffect(() => {
    if (!reveal) return
    const parts: string[] = []
    for (let d = dirName(reveal); pathKey(d).startsWith(pathKey(root)) && pathKey(d) !== pathKey(root); d = dirName(d)) parts.unshift(d)
    void (async () => {
      const next = new Set(expanded)
      for (const d of parts) {
        next.add(pathKey(d))
        await load(d)
      }
      setExpanded(next)
      $reveal.set(null)
      setTimeout(() => scrollRef.current?.querySelector(`[data-path="${CSS.escape(pathKey(reveal))}"]`)?.scrollIntoView({ block: 'nearest' }), 50)
    })()
  }, [reveal])

  const toggle = (path: string) => {
    const k = pathKey(path)
    const next = new Set(expanded)
    if (next.has(k)) {
      next.delete(k)
    } else {
      next.add(k)
      if (!children[k]) void load(path)
    }
    setExpanded(next)
  }

  const rows: Array<{ entry: Entry; depth: number } | { editing: true; depth: number }> = []
  const walk = (dir: string, depth: number) => {
    if (editing && editing.kind !== 'rename' && pathKey(editing.dir) === pathKey(dir)) rows.push({ editing: true, depth })
    for (const entry of children[pathKey(dir)] || []) {
      rows.push({ entry, depth })
      if (entry.dir && expanded.has(pathKey(entry.path))) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)

  const commitEdit = async (value: string) => {
    const e = editing
    setEditing(null)
    const name = value.trim()
    if (!e || !name) return
    try {
      if (e.kind === 'rename') {
        if (name === baseName(e.path)) return
        const to = joinPath(e.dir, name)
        await call('/fs/rename', { from: e.path, to })
        const tab = $tabs.get().find(t => pathKey(t.path) === pathKey(e.path))
        if (tab) {
          closeTab(tab.path, true)
          void openFile(to)
        }
      } else {
        const path = joinPath(e.dir, name)
        await call('/fs/create', { path, dir: e.kind === 'folder' })
        if (e.kind === 'file') void openFile(path)
      }
      bumpTree()
      void refreshGit()
    } catch (err) {
      notify('error', (err as Error).message)
    }
  }

  const startNew = (kind: 'file' | 'folder', inDir?: string) => {
    const dir = inDir || (ctxTarget ? (ctxTarget.dir ? ctxTarget.path : dirName(ctxTarget.path)) : root)
    if (pathKey(dir) !== pathKey(root) && !expanded.has(pathKey(dir))) toggle(dir)
    setEditing({ kind, dir })
  }

  const doTrash = async () => {
    const p = trashTarget
    if (!p) return
    await call('/fs/trash', { path: p })
    for (const t of $tabs.get()) if (pathKey(t.path).startsWith(pathKey(p))) closeTab(t.path, true)
    bumpTree()
    void refreshGit()
  }

  const t = ctxTarget
  return (
    <>
      <div className="hi-head">
        <span className="hi-title" title={root}>
          {baseName(root)}
          {useValue($rootPicked) ? <span className="hi-dim" title="Opened here, not the chat's folder"> · pinned</span> : null}
        </span>
        <button className="hi-btn" title="New File" onClick={() => startNew('file', root)}>{icon('new-file')}</button>
        <button className="hi-btn" title="New Folder" onClick={() => startNew('folder', root)}>{icon('new-folder')}</button>
        <button className="hi-btn" title="Refresh" onClick={() => { bumpTree(); void refreshGit() }}>{icon('refresh')}</button>
        <button className="hi-btn" title="Collapse Folders" onClick={() => setExpanded(new Set())}>{icon('collapse-all')}</button>
      </div>
      <ContextMenu onOpenChange={open => !open && setCtxTarget(null)}>
        <ContextMenuTrigger asChild>
          <div className="hi-scroll" ref={scrollRef} onContextMenu={e => e.target === e.currentTarget && setCtxTarget(null)}>
            {rows.map((r, i) =>
              'editing' in r ? (
                <div className="hi-row" key="__edit" style={{ paddingLeft: 8 + r.depth * 12 }}>
                  <span style={{ width: 14 }} />
                  {icon(editing?.kind === 'folder' ? 'folder' : 'file')}
                  <InlineName initial="" onDone={commitEdit} />
                </div>
              ) : editing?.kind === 'rename' && pathKey(editing.path) === pathKey(r.entry.path) ? (
                <div className="hi-row" key={r.entry.path} style={{ paddingLeft: 8 + r.depth * 12 }}>
                  <span style={{ width: 14 }} />
                  {icon(r.entry.dir ? 'folder' : fileIcon(r.entry.name))}
                  <InlineName initial={r.entry.name} onDone={commitEdit} />
                </div>
              ) : (
                <TreeRow
                  key={r.entry.path}
                  entry={r.entry}
                  depth={r.depth}
                  open={expanded.has(pathKey(r.entry.path))}
                  active={!!active && pathKey(active) === pathKey(r.entry.path)}
                  ctxOn={!!t && pathKey(t.path) === pathKey(r.entry.path)}
                  code={git.files[pathKey(r.entry.path)] || (r.entry.dir ? folderCode(git.files, r.entry.path) : '')}
                  onToggle={() => toggle(r.entry.path)}
                  onContext={() => setCtxTarget({ path: r.entry.path, dir: r.entry.dir })}
                />
              )
            )}
            {rows.length === 0 ? <div className="hi-empty">This folder is empty.</div> : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {t && !t.dir ? <ContextMenuItem onSelect={() => void openFile(t.path)}>Open</ContextMenuItem> : null}
          {t && !t.dir && /\.(html?|svg|png|jpe?g|gif|webp|pdf|md)$/i.test(t.path) ? (
            <ContextMenuItem onSelect={() => void openInBrowser(t.path)}>Open in Browser</ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => void addToChat(t?.path || root, undefined, undefined, t ? t.dir : true)}>Add to Chat</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => startNew('file')}>New File…</ContextMenuItem>
          <ContextMenuItem onSelect={() => startNew('folder')}>New Folder…</ContextMenuItem>
          {t ? (
            <>
              <ContextMenuItem onSelect={() => setEditing({ kind: 'rename', path: t.path, dir: dirName(t.path) })}>Rename…</ContextMenuItem>
              <ContextMenuItem onSelect={() => setTrashTarget(t.path)}>Move to Trash</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void ctx.os.writeClipboard(t.path)}>Copy Path</ContextMenuItem>
              <ContextMenuItem onSelect={() => void ctx.os.writeClipboard(relToRoot(t.path))}>Copy Relative Path</ContextMenuItem>
              <ContextMenuItem onSelect={() => void ctx.os.revealPath(t.path)}>Reveal in File Manager</ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog
        open={!!trashTarget}
        onClose={() => setTrashTarget(null)}
        onConfirm={doTrash}
        title={`Move ${trashTarget ? baseName(trashTarget) : ''} to the trash?`}
        description="It goes to the system trash, so you can restore it."
        confirmLabel="Move to Trash"
        destructive
        dismissOnConfirm
      />
    </>
  )
}

function folderCode(files: Record<string, string>, dir: string) {
  const prefix = pathKey(dir) + '/'
  for (const k in files) if (k.startsWith(prefix)) return '•'
  return ''
}

function TreeRow({ entry, depth, open, active, ctxOn, code, onToggle, onContext }: {
  entry: Entry; depth: number; open: boolean; active: boolean; ctxOn: boolean; code: string; onToggle: () => void; onContext: () => void
}) {
  const onClick = (e: React.MouseEvent) => {
    if (entry.dir) onToggle()
    else void openFile(entry.path, { preview: e.detail < 2 })
  }
  return (
    <div
      className="hi-row"
      data-path={pathKey(entry.path)}
      data-active={active}
      data-ctx={ctxOn}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={onClick}
      onContextMenu={onContext}
      draggable={!entry.dir}
      onDragStart={e => e.dataTransfer.setData('text/plain', entry.path)}
      title={entry.path}
    >
      <span style={{ width: 14, display: 'inline-flex' }}>{entry.dir ? icon(open ? 'chevron-down' : 'chevron-right', 13) : null}</span>
      {icon(entry.dir ? (open ? 'folder-opened' : 'folder') : fileIcon(entry.name))}
      <span className="hi-name" data-c={code === '•' ? undefined : code || undefined}>{entry.name}</span>
      {code ? <span className="hi-git" data-c={code === '•' ? 'M' : code}>{code === '?' ? 'U' : code}</span> : null}
    </div>
  )
}

function InlineName({ initial, onDone }: { initial: string; onDone: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [])
  const finish = (v: string) => {
    if (!done.current) {
      done.current = true
      onDone(v)
    }
  }
  return (
    <input
      ref={ref}
      className="hi-edit"
      defaultValue={initial}
      onKeyDown={e => {
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') finish('')
        e.stopPropagation()
      }}
      onBlur={e => finish(e.currentTarget.value)}
      onClick={e => e.stopPropagation()}
    />
  )
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────

interface Match { path: string; rel: string; line: number; col: number; text: string }

function SearchView({ root }: { root: string }) {
  const [q, setQ] = useState(() => ctx.storage.get('search.q', '') as string)
  const [regex, setRegex] = useState(false)
  const [caseSens, setCase] = useState(false)
  const [glob, setGlob] = useState('')
  const [res, setRes] = useState<{ matches: Match[]; truncated: boolean } | null>(null)
  const [err, setErr] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const focus = useValue($searchFocus)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => inputRef.current?.focus(), [focus])

  useEffect(() => {
    ctx.storage.set('search.q', q)
    const id = ++seq.current
    if (!q.trim()) {
      setRes(null)
      return
    }
    const timer = setTimeout(async () => {
      try {
        const r = await call('/search', { root, query: q, regex, case: caseSens, glob })
        if (id === seq.current) {
          setRes(r)
          setErr('')
        }
      } catch (e) {
        if (id === seq.current) setErr((e as Error).message)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [q, regex, caseSens, glob, root])

  const groups = useMemo(() => {
    const m = new Map<string, Match[]>()
    for (const hit of res?.matches || []) m.set(hit.path, [...(m.get(hit.path) || []), hit])
    return [...m.entries()]
  }, [res])

  return (
    <>
      <div className="hi-field">
        <input ref={inputRef} value={q} placeholder="Search" onChange={e => setQ(e.target.value)} spellCheck={false} />
        <button className="hi-btn" data-on={caseSens} title="Match Case" onClick={() => setCase(!caseSens)}>{icon('case-sensitive')}</button>
        <button className="hi-btn" data-on={regex} title="Use Regular Expression" onClick={() => setRegex(!regex)}>{icon('regex')}</button>
      </div>
      <div className="hi-field" style={{ paddingTop: 0 }}>
        <input value={glob} placeholder="files to include, e.g. *.ts or src/**" onChange={e => setGlob(e.target.value)} spellCheck={false} />
      </div>
      <div className="hi-scroll">
        {err ? <div className="hi-empty">{err}</div> : null}
        {res && !err ? (
          <div className="hi-empty" style={{ padding: '2px 10px 6px' }}>
            {res.matches.length} result{res.matches.length === 1 ? '' : 's'} in {groups.length} file{groups.length === 1 ? '' : 's'}
            {res.truncated ? ' (first results only)' : ''}
          </div>
        ) : null}
        {groups.map(([path, hits]) => (
          <Fragment key={path}>
            <div className="hi-group" onClick={() => setCollapsed(s => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n })}>
              {icon(collapsed.has(path) ? 'chevron-right' : 'chevron-down', 13)}
              {icon(fileIcon(path))}
              <span className="hi-name">{baseName(path)} <span className="hi-dim">{dirName(hits[0].rel) === hits[0].rel ? '' : dirName(hits[0].rel)}</span></span>
              <span className="hi-dim">{hits.length}</span>
            </div>
            {collapsed.has(path)
              ? null
              : hits.map(h => (
                  <div key={`${h.line}:${h.col}`} className="hi-row hi-hit" title={`${h.rel}:${h.line}`} onClick={() => void openFile(h.path, { line: h.line, col: h.col + 1, preview: true })}>
                    <span className="hi-name"><Highlighted text={h.text.trimStart()} q={q} regex={regex} caseSens={caseSens} /></span>
                  </div>
                ))}
          </Fragment>
        ))}
      </div>
    </>
  )
}

function Highlighted({ text, q, regex, caseSens }: { text: string; q: string; regex: boolean; caseSens: boolean }) {
  let re: RegExp
  try {
    re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSens ? 'g' : 'gi')
  } catch {
    return <>{text}</>
  }
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) break
    out.push(text.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>)
    last = (m.index || 0) + m[0].length
  }
  out.push(text.slice(last))
  return <>{out}</>
}

// ── Source Control ───────────────────────────────────────────────────────────────────────────

const GIT_LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', '?': 'Untracked', U: 'Conflict', R: 'Renamed', C: 'Copied' }

function ScmView({ root }: { root: string }) {
  const git = useValue($git)
  useEffect(() => void refreshGit(), [root])
  if (!git.repo) {
    return <div className="hi-empty">This folder is not a git repository.</div>
  }
  const files = Object.entries(git.files).sort(([a], [b]) => a.localeCompare(b))
  return (
    <>
      <div className="hi-head">
        <span className="hi-title">{icon('git-branch', 12)} {git.branch || 'detached'}</span>
        <button className="hi-btn" title="Add all changes to chat (@diff)" onClick={() => void host.composer.insertText(host.state.focusedSessionId.get() || null, '@diff ', { mode: 'inline' })}>{icon('comment-discussion')}</button>
        <button className="hi-btn" title="Open the Review pane" onClick={() => ctx.runAction?.('view.toggleReview')}>{icon('diff')}</button>
        <button className="hi-btn" title="Refresh" onClick={() => void refreshGit()}>{icon('refresh')}</button>
      </div>
      <div className="hi-scroll">
        {files.length === 0 ? <div className="hi-empty">No changes.</div> : null}
        {files.map(([key, code]) => {
          const path = git.paths?.[key] ?? key
          return (
            <div key={key} className="hi-row" style={{ paddingLeft: 10 }} title={`${GIT_LABEL[code] || code}: ${path}`} onClick={() => void openDiff(path, code)}>
              {icon(fileIcon(path))}
              <span className="hi-name" data-c={code}>{baseName(path)} <span className="hi-dim">{relToRoot(dirName(path)) === '.' ? '' : relToRoot(dirName(path))}</span></span>
              <span className="hi-git" data-c={code}>{code === '?' ? 'U' : code}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

async function openDiff(path: string, code: string) {
  if (code === 'D') {
    notify('info', `${baseName(path)} was deleted. Use the Review pane to restore it.`)
    return
  }
  await openFile(path)
  if (code === '?' || code === 'A') return
  const head = await call<{ text: string | null }>('/git/head', { path })
  if (head.text != null) post({ type: 'setDiff', path, original: head.text })
}

// ── Editor pane: tabs, breadcrumbs, review banner, and the editor frame ─────────────────────

/** The app's theme tokens, resolved for the element the editor sits in. */
const TOKENS = ['--font-sans', '--font-mono', '--ui-text-primary', '--ui-text-secondary', '--ui-text-tertiary', '--ui-text-quaternary', '--ui-accent', '--ui-accent-secondary', '--ui-stroke-primary', '--ui-stroke-secondary', '--ui-stroke-tertiary', '--ui-stroke-quaternary', '--ui-bg-primary', '--ui-bg-secondary', '--ui-bg-tertiary', '--ui-bg-quaternary', '--ui-bg-elevated', '--ui-bg-input', '--ui-bg-editor', '--ui-editor-surface-background', '--ui-selection-background', '--ui-row-hover-background', '--ui-row-active-background', '--ui-control-hover-background', '--ui-control-active-background', '--ui-diff-add-background', '--ui-diff-remove-background', '--ui-diff-add-foreground', '--ui-diff-remove-foreground', '--ui-red', '--ui-green', '--ui-yellow', '--ui-orange', '--ui-blue', '--ui-purple', '--ui-cyan']

function readLook(el: Element) {
  const cs = getComputedStyle(el)
  const vars: Record<string, string> = {}
  for (const name of TOKENS) {
    const v = cs.getPropertyValue(name).trim()
    if (v) vars[name] = v
  }
  return { vars, dark: isLight(vars['--ui-text-primary']) }
}

/** The surface is dark when its primary text is light: works for every skin, including ones
 *  that keep a bright surface in "dark" mode. */
function isLight(color: string | undefined) {
  if (!color) return false
  const probe = document.createElement('span')
  probe.style.color = color
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color // "rgb(r, g, b)" or "color(srgb r g b / a)" with 0-1 channels
  probe.remove()
  const nums = (resolved.match(/[\d.]+/g) || []).map(Number)
  if (nums.length < 3) return false
  const scale = resolved.startsWith('color(') ? 255 : 1
  const [r, g, b] = nums.slice(0, 3).map(v => v * scale)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140
}

export function EditorPane() {
  const tabs = useValue($tabs)
  const active = useValue($active)
  const banners = useValue($banners)
  const confirmClose = useValue($confirmClose)
  const accent = useValue($accentOverride)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    attachFrame(el.contentWindow, () => readLook(el.parentElement || el))
    const off = ctx.addEventListener(window, 'message', onFrameMessage as EventListener)
    // Skins, light/dark and accent repaint by rewriting :root attributes and inline tokens, often
    // in several passes; wait for the writes to settle before reading the resolved tokens. Computed
    // tokens are the source of truth because a skin can keep a bright surface in "dark" mode.
    let timer = 0
    const repaint = () => {
      clearTimeout(timer)
      timer = window.setTimeout(postLook, 250)
    }
    const mo = new MutationObserver(repaint)
    mo.observe(document.documentElement, { attributes: true })
    mo.observe(document.body, { attributes: true })
    return () => {
      off()
      mo.disconnect()
      clearTimeout(timer)
      detachFrame(el.contentWindow)
    }
  }, [])

  useEffect(() => {
    const id = requestAnimationFrame(() => postLook())
    return () => cancelAnimationFrame(id)
  }, [accent])

  const activeTab = tabs.find(t => t.path === active)
  const banner = active ? banners[active] : undefined
  const crumbs = active ? relToRoot(active).split('/') : []

  return (
    <div className="hi-pane" style={{ color: 'var(--ui-text-primary)' }}>
      <Styles />
      <div className="hi-tabs" onWheel={e => (e.currentTarget.scrollLeft += e.deltaY)}>
        {tabs.map(t => (
          <ContextMenu key={t.path}>
            <ContextMenuTrigger asChild>
              <div
                className="hi-tab"
                data-active={t.path === active}
                data-preview={t.preview}
                data-dirty={t.dirty}
                title={t.path}
                onClick={() => activate(t.path)}
                onDoubleClick={() => $tabs.set($tabs.get().map(x => (x === t ? { ...x, preview: false } : x)))}
                onAuxClick={e => e.button === 1 && closeTab(t.path)}
              >
                {icon(fileIcon(t.name), 13)}
                <span className="hi-tabname">{t.name}</span>
                {t.dirty ? <span className="hi-dot" /> : null}
                <button className="hi-btn hi-x" title="Close" onClick={e => { e.stopPropagation(); closeTab(t.path) }}>{icon('close', 13)}</button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => closeTab(t.path)}>Close</ContextMenuItem>
              <ContextMenuItem onSelect={() => $tabs.get().filter(x => x.path !== t.path && !x.dirty).forEach(x => closeTab(x.path))}>Close Others</ContextMenuItem>
              <ContextMenuItem onSelect={() => $tabs.get().filter(x => !x.dirty).forEach(x => closeTab(x.path))}>Close Saved</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void addToChat(t.path)}>Add to Chat</ContextMenuItem>
              <ContextMenuItem onSelect={() => void ctx.os.writeClipboard(t.path)}>Copy Path</ContextMenuItem>
              <ContextMenuItem onSelect={() => { $reveal.set(t.path); $view.set('explorer') }}>Reveal in Explorer</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      {activeTab ? (
        <div className="hi-crumbs">
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i ? <span className="hi-sep">{icon('chevron-right', 11)}</span> : null}
              <span style={i === crumbs.length - 1 ? { color: 'var(--ui-text-secondary)' } : undefined}>{c}</span>
            </Fragment>
          ))}
          <span className="hi-spacer" />
          <button className="hi-btn" title="Add file to chat (Ctrl+L adds the selection)" onClick={() => void addToChat(activeTab.path)}>{icon('comment-discussion')}</button>
          <button className="hi-btn" title="Edit with Hermes (Ctrl+K)" onClick={() => post({ type: 'inlineEdit' })}>{icon('sparkle')}</button>
          {/\.(html?|svg|md)$/i.test(activeTab.path) ? (
            <button className="hi-btn" title="Open in Browser" onClick={() => void openInBrowser(activeTab.path)}>{icon('globe')}</button>
          ) : null}
          <button className="hi-btn" title="Save (Ctrl+S)" onClick={saveActive}>{icon('save')}</button>
        </div>
      ) : null}
      {banner && active ? <ReviewBanner path={active} banner={banner} /> : null}
      <iframe ref={frameRef} className="hi-frame" title="Hermes IDE editor" sandbox="allow-scripts" srcDoc={FRAME_HTML} />
      <ConfirmDialog
        open={!!confirmClose}
        onClose={() => $confirmClose.set(null)}
        onConfirm={() => { if (confirmClose) closeTab(confirmClose, true) }}
        title={`Discard unsaved changes to ${confirmClose ? baseName(confirmClose) : ''}?`}
        description="Your edits in this tab are not saved."
        confirmLabel="Discard"
        destructive
        dismissOnConfirm
        secondaryAction={confirmClose ? { label: 'Save', onClick: () => { const p = confirmClose; post({ type: 'saveRequest', path: p }) } } : undefined}
      />
    </div>
  )
}

function ReviewBanner({ path, banner }: { path: string; banner: NonNullable<ReturnType<typeof $banners.get>[string]> }) {
  if (banner.kind === 'agent') {
    return (
      <div className="hi-banner">
        {icon('sparkle')}
        <span>Hermes edited this file. Review the changes inline; reject single hunks with their buttons.</span>
        <span className="hi-spacer" />
        <Button size="xs" variant="secondary" onClick={() => keepAgentEdit(path)}>Keep</Button>
        <Button size="xs" variant="outline" onClick={() => void undoAgentEdit(path)}>Undo</Button>
      </div>
    )
  }
  return (
    <div className="hi-banner">
      {icon('warning')}
      <span>This file changed on disk while you had unsaved edits.</span>
      <span className="hi-spacer" />
      <Button size="xs" variant="secondary" onClick={() => resolveConflict(path, 'compare')}>{banner.comparing ? 'Hide Compare' : 'Compare'}</Button>
      <Button size="xs" variant="outline" onClick={() => resolveConflict(path, 'theirs')}>Use Disk Version</Button>
      <Button size="xs" variant="outline" onClick={() => resolveConflict(path, 'mine')}>Overwrite with Mine</Button>
    </div>
  )
}

// ── Quick Open and Open Folder (mounted once, from the title bar's permanent slot) ───────────

export function Dialogs() {
  return (
    <>
      <QuickOpen />
      <FolderDialog />
      <BrowserDialog />
    </>
  )
}

function BrowserDialog() {
  const target = useValue($browserTarget)
  const isUrl = !!target && /^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith('file:')
  const text = !target ? '' : isUrl ? `[${target}](${target})` : `MEDIA:${/\s/.test(target) ? `"${target}"` : target}`
  return (
    <Dialog open={!!target} onOpenChange={o => !o && $browserTarget.set(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open in Browser</DialogTitle>
        </DialogHeader>
        <div className="hi-qo" onClickCapture={e => (e.target as HTMLElement).closest('a,button') && setTimeout(() => $browserTarget.set(null), 1500)}>
          <div style={{ fontSize: 12.5, color: 'var(--ui-text-secondary)' }}>
            Click to render it in the Desktop Browser beside the chat. Use the Browser's Annotate tool to pick elements on the page and send them to this chat.
          </div>
          {/* the card resolves the target asynchronously and drops the open if it unmounts first */}
          {target ? <MessageTextContent text={text} /> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => { ctx.runAction?.('view.showBrowser'); $browserTarget.set(null) }}>Show Browser</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

let filesCache: { root: string; at: number; version: number; files: string[] } | null = null

function QuickOpen() {
  const open = useValue($quickOpen)
  const root = useValue($root)
  const version = useValue($treeVersion)
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState(0)

  useEffect(() => {
    if (!open || !root) return
    setInput('')
    setSel(0)
    if (filesCache && filesCache.root === root && filesCache.version === version && Date.now() - filesCache.at < 30_000) {
      setFiles(filesCache.files)
      return
    }
    call<{ files: string[] }>('/fs/files', { root })
      .then(r => {
        filesCache = { root, at: Date.now(), version, files: r.files }
        setFiles(r.files)
      })
      .catch(e => notify('error', (e as Error).message))
  }, [open, root])

  const { query, line, col } = splitLineSuffix(input)
  const results = useMemo(() => rankFiles(query, files, 60), [query, files])

  const choose = (rel: string | undefined) => {
    if (rel === undefined || !root) {
      if (!query && line && $active.get()) post({ type: 'show', path: $active.get(), line, col })
      $quickOpen.set(false)
      return
    }
    $quickOpen.set(false)
    void openFile(joinPath(root, rel), { line, col })
  }

  return (
    <Dialog open={open} onOpenChange={o => $quickOpen.set(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Go to File</DialogTitle>
        </DialogHeader>
        <div className="hi-qo">
          <input
            autoFocus
            value={input}
            placeholder={root ? 'Type a file name. Add :line to jump.' : 'Open a folder first'}
            onChange={e => { setInput(e.target.value); setSel(0) }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
              if (e.key === 'Enter') { e.preventDefault(); choose(results[sel]) }
            }}
          />
          <div className="hi-qo-list">
            {results.map((rel, i) => (
              <div key={rel} className="hi-qo-row" data-on={i === sel} onMouseEnter={() => setSel(i)} onClick={() => choose(rel)}>
                {icon(fileIcon(rel))}
                <span>{baseName(rel)}</span>
                <span className="hi-dim" style={{ fontSize: 11.5 }}>{dirName(rel) === rel ? '' : dirName(rel)}</span>
              </div>
            ))}
            {root && files.length > 0 && results.length === 0 ? <div className="hi-empty">No matching files.</div> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FolderDialog() {
  const open = useValue($folderDialog)
  const root = useValue($root)
  const [path, setPath] = useState('')
  const [apply, setApply] = useState(true)
  useEffect(() => {
    if (open) setPath(root || '')
  }, [open])

  const browse = async () => {
    const r = await ctx.files?.requestFolder?.()
    if (r?.ok && r.folder) {
      setPath(r.folder.path)
      void ctx.files.release?.(r.folder.id) // only the path is needed; the backend does the reading
    }
  }
  const submit = async () => {
    if (path.trim() && (await setRoot(path.trim(), apply))) $folderDialog.set(false)
  }

  return (
    <Dialog open={open} onOpenChange={o => $folderDialog.set(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open Folder</DialogTitle>
        </DialogHeader>
        <div className="hi-qo">
          <div style={{ display: 'flex', gap: 6 }}>
            <input style={{ flex: 1 }} value={path} placeholder="C:/path/to/project or /home/me/project" onChange={e => setPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && void submit()} spellCheck={false} autoFocus />
            {ctx.files?.requestFolder ? <Button variant="secondary" onClick={() => void browse()}>Browse…</Button> : null}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--ui-text-secondary)' }}>
            <input type="checkbox" checked={apply} onChange={e => setApply(e.target.checked)} style={{ height: 'auto' }} />
            Also move this chat's working directory here, so Hermes works in the same folder
          </label>
          {!host.state.focusedSessionId.get() ? (
            <div style={{ fontSize: 12, color: 'var(--ui-text-tertiary)' }}>
              This chat has not started yet. The folder is applied when its first reply finishes; to start a chat directly in a folder, use the composer's folder button.
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {useValue($rootPicked) ? <Button variant="ghost" onClick={() => { followSession(); $folderDialog.set(false) }}>Follow the chat's folder</Button> : null}
            <Button onClick={() => void submit()}>Open</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Status bar, settings page, transcript card ───────────────────────────────────────────────

export function StatusItem() {
  const cursor = useValue($cursor)
  const active = useValue($active)
  if (!active || !cursor) return null
  return (
    <span className="hi-status">
      <Styles />
      <span>Ln {cursor.line}, Col {cursor.col}{cursor.sel ? ` (${cursor.sel} selected)` : ''}</span>
      <span>{cursor.eol}</span>
      <span>{cursor.lang}</span>
    </span>
  )
}

export function SettingsPage() {
  const s = useValue($settings)
  return (
    <div>
      <ToggleRow label="Follow the chat's folder" description="The Explorer opens the working directory of the chat you are looking at." checked={s.followSession} onChange={v => setSetting('followSession', v)} />
      <ToggleRow label="Review agent edits" description="When Hermes edits an open file, show the change inline with Keep and Undo." checked={s.reviewAgentEdits} onChange={v => setSetting('reviewAgentEdits', v)} />
      <ToggleRow label="Show hidden files" checked={s.showHidden} onChange={v => setSetting('showHidden', v)} />
      <ToggleRow label="Word wrap" checked={s.wordWrap} onChange={v => setSetting('wordWrap', v)} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
        <span style={{ fontSize: 13 }}>Editor font size</span>
        <SegmentedControl
          value={String(s.fontSize) as '12' | '13' | '14' | '15' | '16'}
          options={['12', '13', '14', '15', '16'].map(id => ({ id, label: id })) as any}
          onChange={(v: string) => setSetting('fontSize', Number(v))}
        />
      </div>
    </div>
  )
}

export function OpenCard({ attrs }: { attrs: Readonly<Record<string, string>> }) {
  const path = (attrs.path || '').trim()
  const line = Number(attrs.line) > 0 ? Number(attrs.line) : undefined
  if (!path || path.length > 1024) return null
  return (
    <button className="hi-card" onClick={() => void openFile(path, { line })} title="Open in the Hermes IDE">
      <Styles />
      {icon('go-to-file')}
      <span>{baseName(path)}{line ? `:${line}` : ''}</span>
    </button>
  )
}
