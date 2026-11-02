// Pure helpers shared by the plugin UI. No SDK or DOM imports here, so tests/util.test.mjs can run
// them under plain Node.

/** Forward slashes, no trailing slash (except a bare drive or root). */
export function normPath(p: string): string {
  let s = (p || '').replace(/\\/g, '/')
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.slice(0, -1)
  }
  return s
}

/** Path comparison key: Windows paths are case-insensitive. */
export function pathKey(p: string): string {
  const s = normPath(p)
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s
}

export function isInside(child: string, root: string): boolean {
  const c = pathKey(child)
  const r = pathKey(root)
  return c === r || c.startsWith(r.endsWith('/') ? r : r + '/')
}

export function relPath(path: string, root: string | null): string {
  if (!root || !isInside(path, root)) {
    return normPath(path)
  }
  const rest = normPath(path).slice(normPath(root).length).replace(/^\//, '')
  return rest || '.'
}

export function baseName(p: string): string {
  const s = normPath(p)
  return s.slice(s.lastIndexOf('/') + 1) || s
}

export function dirName(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  return i <= 0 ? s : /^[A-Za-z]:$/.test(s.slice(0, i)) ? s.slice(0, i + 1) : s.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  const d = normPath(dir)
  return d.endsWith('/') ? d + name : d + '/' + name
}

/** A Hermes context reference the agent expands (`agent/context_references.py`):
 *  `@file:path`, `@file:path:10-20`, quoted when the path has spaces. */
export function fileRef(path: string, root: string | null, from?: number, to?: number, folder = false): string {
  const rel = relPath(path, root)
  const value = /\s|"/.test(rel) ? `"${rel.replace(/"/g, '\\"')}"` : rel
  const range = from ? (to && to !== from ? `:${from}-${to}` : `:${from}`) : ''
  return `@${folder ? 'folder' : 'file'}:${value}${range}`
}

/** Fuzzy subsequence score for Quick Open: higher is better, -1 means no match. Rewards matches
 *  in the file name, at word starts, and consecutive runs (the VS Code feel without its engine). */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) {
    return 0
  }
  const c = candidate.toLowerCase()
  const nameStart = c.lastIndexOf('/') + 1
  let score = 0
  let ci = 0
  let run = 0
  for (const ch of q) {
    const found = c.indexOf(ch, ci)
    if (found < 0) {
      return -1
    }
    const boundary = found === 0 || '/_-. '.includes(c[found - 1])
    run = found === ci ? run + 1 : 0
    score += 1 + run * 2 + (boundary ? 3 : 0) + (found >= nameStart ? 2 : 0)
    ci = found + 1
  }
  if (c.slice(nameStart).startsWith(q)) {
    score += 10
  }
  return score - c.length * 0.01
}

export function rankFiles(query: string, files: readonly string[], limit = 60): string[] {
  if (!query.trim()) {
    return files.slice(0, limit)
  }
  const scored: Array<[number, string]> = []
  for (const f of files) {
    const s = fuzzyScore(query, f)
    if (s >= 0) {
      scored.push([s, f])
    }
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
  return scored.slice(0, limit).map(x => x[1])
}

/** "src/app.ts:42" or "src/app.ts:42:7" → parts. */
export function splitLineSuffix(input: string): { query: string; line?: number; col?: number } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(input.trim())
  return m ? { query: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined } : { query: input.trim() }
}

export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Paths a finished tool call may have written, from its arguments. Tool names vary (write_file,
 *  patch, edit, MCP tools), so this reads the common argument shapes rather than a name list. */
export function pathsFromToolArgs(args: unknown): string[] {
  const out = new Set<string>()
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > 3 || v == null) {
      return
    }
    if (typeof v === 'string') {
      if (/^(path|file_?path|filename|target|target_file|file)$/i.test(key) && v.length < 1024) {
        out.add(v)
      }
      if (key === 'patch' || key === 'diff') {
        for (const m of v.matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/)(.+)$/gm)) {
          out.add(m[1].trim())
        }
      }
      return
    }
    if (Array.isArray(v)) {
      v.forEach(x => visit(x, key, depth + 1))
      return
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        visit(x, k, depth + 1)
      }
    }
  }
  visit(args, '', 0)
  return [...out]
}

/** Column plan for a window `width` px wide. Proportions follow Cursor's agent layout; clamps keep
 *  each column usable on small and huge screens. The editor takes whatever is left. */
export function columnPlan(width: number) {
  const explorer = Math.round(Math.min(340, Math.max(220, width * 0.14)))
  const chat = Math.round(Math.min(760, Math.max(380, width * 0.3)))
  const preview = Math.round(Math.min(1280, Math.max(520, width * 0.32)))
  return { explorer, chat, preview }
}

// ── IDE window layout: which columns, in which order, how wide ───────────────────────────────

export type TileId = 'explorer' | 'editor' | 'browser'
export type ColumnId = TileId | 'chat'
export const TILE_IDS: readonly TileId[] = ['explorer', 'editor', 'browser']

/** The user's arrangement: columns left to right, each a stack of tabs (the first one is the
 *  column's anchor), plus column widths as fractions of the window. */
export interface Layout {
  columns: ColumnId[][]
  widths: Partial<Record<ColumnId, number>>
}

export const DEFAULT_LAYOUT: Layout = { columns: [['explorer'], ['editor'], ['browser'], ['chat']], widths: {} }

export const tilePane = (id: ColumnId) => (id === 'chat' ? 'workspace' : `plugin-workspace:hermes-ide-${id}`)

export interface DockStep {
  id: TileId
  dock: { pane: string; pos: 'left' | 'right' | 'center' }
}

/** Keep only `open` tiles (plus the chat), drop empty columns, and place open tiles the layout
 *  does not know: the Explorer leftmost, the editor and browser just left of the chat. */
export function normalizeLayout(layout: Layout, open: readonly TileId[]): ColumnId[][] {
  const want = new Set<ColumnId>([...open, 'chat'])
  const seen = new Set<ColumnId>()
  const cols = (Array.isArray(layout?.columns) ? layout.columns : [])
    .map(col => (Array.isArray(col) ? col : []).filter(id => want.has(id) && !seen.has(id) && (seen.add(id), true)))
    .filter(col => col.length)
  if (!seen.has('chat')) cols.push(['chat'])
  for (const id of TILE_IDS) {
    if (!want.has(id) || seen.has(id)) continue
    const chatAt = cols.findIndex(col => col.includes('chat'))
    cols.splice(id === 'explorer' ? 0 : chatAt, 0, [id])
  }
  return cols
}

/** The order to open tiles in, and where to dock each, so the app's pane tree reproduces the
 *  arrangement: columns are chained outward from the chat column; stacked tabs dock center. */
export function dockPlan(layout: Layout, open: readonly TileId[]): DockStep[] {
  const cols = normalizeLayout(layout, open)
  const c = cols.findIndex(col => col.includes('chat'))
  const steps: DockStep[] = []
  const anchor = (k: number) => (k === c ? 'workspace' : tilePane(cols[k][0]))
  const place = (k: number, pos: 'left' | 'right') => {
    const [first, ...rest] = cols[k] as TileId[]
    steps.push({ id: first, dock: { pane: anchor(pos === 'left' ? k + 1 : k - 1), pos } })
    for (const id of rest) steps.push({ id, dock: { pane: tilePane(first), pos: 'center' } })
  }
  for (const id of cols[c]) if (id !== 'chat') steps.push({ id: id as TileId, dock: { pane: 'workspace', pos: 'center' } })
  for (let k = c - 1; k >= 0; k--) place(k, 'left')
  for (let k = c + 1; k < cols.length; k++) place(k, 'right')
  return steps
}

/** Target width (px) of each column, or null for the one that takes the rest (the editor, or the
 *  chat when the editor is closed). Saved fractions win over the plan. */
export function columnWidths(columns: Array<ColumnId | null>, width: number, saved: Layout['widths'] = {}): Array<number | null> {
  const plan = columnPlan(width)
  const planned: Record<ColumnId, number> = { explorer: plan.explorer, chat: plan.chat, browser: plan.preview, editor: 0 }
  const flex = columns.includes('editor') ? 'editor' : columns.includes('chat') ? 'chat' : null
  return columns.map(id => {
    if (!id || id === flex) return null
    const f = saved[id]
    return typeof f === 'number' && f > 0.04 && f < 0.9 ? Math.round(f * width) : planned[id]
  })
}

// ── Browser column addresses ─────────────────────────────────────────────────────────────────

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const BARE_SCHEME = /^(about|data):/i

/** What the user typed in the address bar, as a URL. "localhost:5173" looks like a scheme to a
 *  naive test; only "scheme://" (or about:, data:) is one. Local hosts and host:port get http. */
export function addressToUrl(input: string): string {
  const v = input.trim()
  if (!v || HAS_SCHEME.test(v) || BARE_SCHEME.test(v)) return v
  return /^(localhost|127\.|0\.0\.0\.0|\[)/i.test(v) || /^[^\s/]+:\d+(\/|$)/.test(v) ? `http://${v}` : `https://${v}`
}

/** A URL, or a local file path (Windows or POSIX) as a file:// URL. */
export function pathOrUrl(target: string): string {
  if (HAS_SCHEME.test(target) || BARE_SCHEME.test(target)) return target
  const parts = normPath(target).replace(/^\/+/, '').split('/').map(encodeURIComponent)
  return 'file:///' + parts.join('/').replace(/^([a-z])%3A/i, '$1:')
}

