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
