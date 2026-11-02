// Hermes IDE editor frame. Runs inside a sandboxed srcdoc iframe (opaque origin) so the editor owns
// the keyboard: keydown inside a child document never reaches the app's window-capture keybind
// dispatcher, which otherwise claims Ctrl+D/F/G/K/P and Ctrl+/ from any in-DOM editor.
// It talks to the plugin only through postMessage. One EditorView; one EditorState per open file, so
// undo history survives tab switches.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting
} from '@codemirror/language'
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { getChunks, unifiedMergeView } from '@codemirror/merge'
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension, StateEffect, StateField, Text } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Panel,
  rectangularSelection,
  showPanel
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

type Msg = Record<string, any> & { type: string }

const send = (msg: Msg, transfer?: Transferable[]) => window.parent.postMessage(msg, '*', transfer)

// ── languages ────────────────────────────────────────────────────────────────────────────────

const legacy = (mode: any) => () => StreamLanguage.define(mode)

const LANGS: Array<[RegExp, string, () => Extension]> = [
  [/\.(tsx)$/i, 'TypeScript JSX', () => javascript({ jsx: true, typescript: true })],
  [/\.(ts|mts|cts)$/i, 'TypeScript', () => javascript({ typescript: true })],
  [/\.(jsx)$/i, 'JavaScript JSX', () => javascript({ jsx: true })],
  [/\.(js|mjs|cjs)$/i, 'JavaScript', () => javascript()],
  [/\.(py|pyi|pyw)$/i, 'Python', () => python()],
  [/\.(json|jsonc|json5)$|^\.?(babelrc|eslintrc)$/i, 'JSON', () => json()],
  [/\.(css|scss|less)$/i, 'CSS', () => css()],
  [/\.(html?|vue|svelte|astro)$/i, 'HTML', () => html()],
  [/\.(md|mdx|markdown)$/i, 'Markdown', () => markdown()],
  [/\.rs$/i, 'Rust', () => rust()],
  [/\.(ya?ml)$/i, 'YAML', () => yaml()],
  [/\.sql$/i, 'SQL', () => sql()],
  [/\.(xml|svg|xaml|csproj|props|targets|plist)$/i, 'XML', () => xml()],
  [/\.java$/i, 'Java', () => java()],
  [/\.(c|h|cc|cpp|cxx|hpp|hh|ino)$/i, 'C++', () => cpp()],
  [/\.go$/i, 'Go', () => go()],
  [/\.php$/i, 'PHP', () => php()],
  [/\.(sh|bash|zsh|ksh)$|^\.(bashrc|zshrc|profile)$/i, 'Shell', legacy(shell)],
  [/\.(ps1|psm1|psd1)$/i, 'PowerShell', legacy(powerShell)],
  [/\.toml$|^(Cargo\.lock|poetry\.lock)$/i, 'TOML', legacy(toml)],
  [/^(Dockerfile|Containerfile)(\..*)?$|\.dockerfile$/i, 'Dockerfile', legacy(dockerFile)],
  [/\.(ini|cfg|conf|properties|env)$|^\.env(\..*)?$|^\.(gitignore|gitattributes|editorconfig|npmrc)$/i, 'Properties', legacy(properties)],
  [/\.lua$/i, 'Lua', legacy(lua)],
  [/\.(rb|rake|gemspec)$|^(Gemfile|Rakefile)$/i, 'Ruby', legacy(ruby)],
  [/\.swift$/i, 'Swift', legacy(swift)],
  [/\.cs$/i, 'C#', legacy(csharp)],
  [/\.(kt|kts)$/i, 'Kotlin', legacy(kotlin)],
  [/\.(diff|patch)$/i, 'Diff', legacy(diff)]
]

function languageFor(path: string): { name: string; ext: Extension } {
  const base = path.split('/').pop() || path
  for (const [re, name, make] of LANGS) {
    if (re.test(base)) {
      return { name, ext: make() }
    }
  }
  return { name: 'Plain Text', ext: [] }
}

// ── theme: the app's own tokens, forwarded by the plugin as CSS variables ───────────────────

// Same GitHub palettes the app's built-in editor uses, so the IDE and Desktop's file preview agree.
const PALETTES = {
  dark: { comment: '#8b949e', constant: '#79c0ff', entity: '#d2a8ff', fg: '#e6edf3', keyword: '#ff7b72', string: '#a5d6ff', tag: '#7ee787', type: '#ffa657' },
  light: { comment: '#6e7781', constant: '#0550ae', entity: '#8250df', fg: '#1f2328', keyword: '#cf222e', string: '#0a3069', tag: '#116329', type: '#953800' }
}

function highlight(dark: boolean) {
  const p = dark ? PALETTES.dark : PALETTES.light
  return syntaxHighlighting(
    HighlightStyle.define([
      { color: p.keyword, tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.moduleKeyword] },
      { color: p.string, tag: [t.string, t.special(t.string), t.attributeValue] },
      { color: p.tag, tag: [t.regexp, t.escape, t.tagName] },
      { color: p.comment, fontStyle: 'italic', tag: [t.comment, t.lineComment, t.blockComment, t.docComment] },
      { color: p.entity, tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.labelName] },
      { color: p.constant, tag: [t.number, t.bool, t.atom, t.constant(t.variableName), t.standard(t.variableName), t.attributeName, t.propertyName] },
      { color: p.type, tag: [t.typeName, t.className, t.namespace] },
      { color: p.fg, tag: [t.variableName, t.operator, t.punctuation, t.bracket] },
      { color: p.comment, tag: [t.meta, t.processingInstruction] },
      { color: p.constant, tag: [t.link, t.url], textDecoration: 'underline' },
      { color: p.constant, fontWeight: 'bold', tag: [t.heading] },
      { fontWeight: 'bold', tag: [t.strong] },
      { fontStyle: 'italic', tag: [t.emphasis] },
      { color: p.keyword, tag: [t.deleted, t.invalid] },
      { color: p.tag, tag: [t.inserted] }
    ])
  )
}

const chrome = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--ui-text-primary)', fontSize: 'var(--ide-font-size, 13px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, Consolas, monospace)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--ui-text-primary)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-text-primary)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--ui-selection-background, rgba(56,139,253,0.25)) !important'
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ui-text-quaternary)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--ui-row-hover-background)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ui-text-secondary)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--ui-bg-tertiary)', border: 'none', color: 'var(--ui-text-secondary)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ui-control-hover-background)', outline: '1px solid var(--ui-stroke-secondary)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ui-control-active-background)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--ui-yellow) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--ui-orange) 45%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--ui-bg-elevated, var(--ui-bg-secondary))', color: 'var(--ui-text-primary)', fontFamily: 'var(--font-sans)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--ui-stroke-tertiary)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--ui-stroke-tertiary)' },
  '.cm-panel input, .cm-panel button, .cm-textfield, .cm-button': {
    fontFamily: 'inherit', fontSize: '12px', color: 'var(--ui-text-primary)', backgroundColor: 'color-mix(in srgb, var(--ui-text-primary) 5%, transparent)',
    border: '1px solid var(--ui-stroke-secondary)', borderRadius: '5px', backgroundImage: 'none'
  },
  '.cm-tooltip': { backgroundColor: 'var(--ui-bg-elevated, var(--ui-bg-secondary))', color: 'var(--ui-text-primary)', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ui-row-active-background)', color: 'var(--ui-text-primary)' },
  // Agent-edit review (unified diff against the pre-edit text). Low-chroma fills so the code keeps
  // its own colors and stays readable; hunk buttons get their own row instead of covering code.
  '.cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--ui-green) 9%, transparent) !important' },
  '.cm-changedText': { background: 'color-mix(in srgb, var(--ui-green) 20%, transparent) !important' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--ui-red) 9%, transparent)', paddingTop: '2px' },
  '.cm-deletedChunk .cm-deletedText, .cm-deletedChunk del': { background: 'color-mix(in srgb, var(--ui-red) 20%, transparent)', textDecoration: 'none' },
  '.cm-deletedChunk .cm-chunkButtons': { position: 'static', display: 'flex', gap: '6px', padding: '2px 0 4px 6px' },
  '.cm-deletedChunk .cm-chunkButtons button': {
    fontFamily: 'var(--font-sans)', fontSize: '11px', lineHeight: '16px', padding: '1px 9px', borderRadius: '5px', cursor: 'pointer',
    color: 'var(--ui-text-primary)', border: '1px solid var(--ui-stroke-secondary)', background: 'var(--ui-bg-quaternary, transparent)'
  },
  '.cm-deletedChunk .cm-chunkButtons button[name=accept]': { borderColor: 'color-mix(in srgb, var(--ui-green) 45%, transparent)' },
  '.cm-deletedChunk .cm-chunkButtons button[name=reject]': { borderColor: 'color-mix(in srgb, var(--ui-red) 45%, transparent)' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '1px' },
  '.cm-changedLineGutter': { background: 'var(--ui-green)' },
  '.cm-deletedLineGutter': { background: 'var(--ui-red)' }
})

// ── inline edit (Ctrl+K): a prompt panel bound to the current selection ──────────────────────

const toggleInline = StateEffect.define<boolean>()
const inlineField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(toggleInline) ? e.value : acc), v),
  provide: f => showPanel.from(f, on => (on ? inlinePanel : null))
})

function lineRange(state: EditorState) {
  const sel = state.selection.main
  const from = state.doc.lineAt(sel.from).number
  let to = state.doc.lineAt(sel.to).number
  if (sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to && to > from) {
    to -= 1 // a selection ending at the start of a line does not include that line
  }
  return { from, to }
}

function inlinePanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'ide-inline'
  const { from, to } = lineRange(view.state)
  const label = document.createElement('span')
  label.className = 'ide-inline-label'
  label.textContent = from === to ? `Edit line ${from} with Hermes` : `Edit lines ${from}-${to} with Hermes`
  const input = document.createElement('input')
  input.placeholder = 'Describe the change, then Enter. Esc to cancel.'
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      view.dispatch({ effects: toggleInline.of(false) })
      view.focus()
    } else if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault()
      const r = lineRange(view.state)
      send({ type: 'inlineEdit', path: currentPath, from: r.from, to: r.to, instruction: input.value.trim() })
      view.dispatch({ effects: toggleInline.of(false) })
      view.focus()
    }
  })
  dom.append(label, input)
  return { dom, top: true, mount: () => input.focus() }
}

// ── state ────────────────────────────────────────────────────────────────────────────────────

interface FileState {
  state: EditorState
  saved: Text
  pendingSave: Text | null
  eol: string
  lang: string
  wasDirty: boolean
}

const files = new Map<string, FileState>()
let currentPath: string | null = null
let dark = true
let fontSize = 13
let wrap = false

const themeComp = new Compartment()
const wrapComp = new Compartment()
const diffComp = new Compartment()
const readOnlyComp = new Compartment()

let draftTimer = 0
let cursorTimer = 0

function commandKey(id: string) {
  return () => {
    send({ type: 'command', id })
    return true
  }
}

// The empty-editor table: each row runs its command. Mac keyboards say ⌘ and ⌥.
document.getElementById('empty')?.addEventListener('click', e => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]')?.dataset.cmd
  if (id) send({ type: 'command', id })
})
if (/Mac/.test(navigator.platform)) {
  for (const k of document.querySelectorAll('#empty kbd')) k.textContent = ({ Ctrl: '⌘', Alt: '⌥' } as Record<string, string>)[k.textContent || ''] ?? k.textContent
}

function addToChat(view: EditorView) {
  const r = lineRange(view.state)
  send({ type: 'addToChat', path: currentPath, from: r.from, to: r.to, empty: view.state.selection.main.empty })
  return true
}

function save() {
  const f = currentPath ? files.get(currentPath) : null
  if (!f || !currentPath) {
    return true
  }
  f.pendingSave = f.state.doc
  send({ type: 'save', path: currentPath, text: f.state.sliceDoc() })
  return true
}

const ideKeymap = keymap.of([
  { key: 'Mod-s', run: save, preventDefault: true },
  { key: 'Mod-l', run: addToChat, preventDefault: true },
  { key: 'Mod-k', run: v => (v.dispatch({ effects: toggleInline.of(true) }), true), preventDefault: true },
  { key: 'Mod-g', run: gotoLine, preventDefault: true },
  { key: 'Mod-p', run: commandKey('quickOpen'), preventDefault: true },
  { key: 'Mod-Shift-p', run: commandKey('palette'), preventDefault: true },
  { key: 'F1', run: commandKey('palette'), preventDefault: true },
  { key: 'Mod-Shift-f', run: commandKey('findInFiles'), preventDefault: true },
  { key: 'Mod-Shift-e', run: commandKey('explorer'), preventDefault: true },
  { key: 'Mod-b', run: commandKey('toggleSidebar'), preventDefault: true },
  { key: 'Mod-j', run: commandKey('toggleTerminal'), preventDefault: true },
  { key: 'Ctrl-`', run: commandKey('toggleTerminal'), preventDefault: true },
  { key: 'Mod-w', run: commandKey('closeTab'), preventDefault: true },
  { key: 'Mod-Alt-ArrowRight', run: commandKey('nextTab'), preventDefault: true },
  { key: 'Mod-Alt-ArrowLeft', run: commandKey('prevTab'), preventDefault: true },
  { key: 'Mod-PageDown', run: commandKey('nextTab'), preventDefault: true },
  { key: 'Mod-PageUp', run: commandKey('prevTab'), preventDefault: true },
  { key: 'Mod-Shift-s', run: commandKey('saveAll'), preventDefault: true }
])

function extensions(path: string, lang: Extension, eol: string): Extension[] {
  return [
    EditorState.lineSeparator.of(eol),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    inlineField,
    ideKeymap,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    lang,
    chrome,
    themeComp.of(highlight(dark)),
    wrapComp.of(wrap ? EditorView.lineWrapping : []),
    diffComp.of([]),
    readOnlyComp.of([]),
    EditorView.updateListener.of(u => {
      if (u.docChanged) {
        onDocChanged(path)
      }
      if (u.selectionSet || u.docChanged) {
        clearTimeout(cursorTimer)
        cursorTimer = window.setTimeout(postCursor, 60)
      }
    })
  ]
}

const view = new EditorView({ parent: document.getElementById('editor')!, state: EditorState.create({ doc: '' }) })
view.dom.style.display = 'none'

function postCursor() {
  if (!currentPath) {
    return
  }
  const s = view.state
  const sel = s.selection.main
  const line = s.doc.lineAt(sel.head)
  const f = files.get(currentPath)
  send({ type: 'cursor', path: currentPath, line: line.number, col: sel.head - line.from + 1, sel: Math.abs(sel.to - sel.from), lang: f?.lang, eol: f?.eol === '\r\n' ? 'CRLF' : 'LF' })
}

function onDocChanged(path: string) {
  const f = files.get(path)
  if (!f) {
    return
  }
  if (path === currentPath) {
    f.state = view.state
  }
  const dirty = !f.state.doc.eq(f.saved)
  if (dirty !== f.wasDirty) {
    f.wasDirty = dirty
    send({ type: 'dirty', path, dirty })
  }
  // Mirror unsaved text to the plugin so a remount of this frame never loses edits.
  clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    const cur = files.get(path)
    if (cur) {
      send({ type: 'draft', path, text: cur.wasDirty ? cur.state.sliceDoc() : null })
    }
  }, 400)
  const chunks = getChunks(f.state)
  if (chunks && chunks.chunks.length === 0) {
    send({ type: 'diffResolved', path })
  }
}

function stash() {
  if (currentPath && files.has(currentPath)) {
    files.get(currentPath)!.state = view.state
  }
}

function show(path: string, line?: number, col?: number) {
  const f = files.get(path)
  if (!f) {
    return
  }
  stash()
  currentPath = path
  // Re-apply the live theme/wrap to a state created under older settings.
  view.setState(f.state)
  view.dispatch({ effects: [themeComp.reconfigure(highlight(dark)), wrapComp.reconfigure(wrap ? EditorView.lineWrapping : [])] })
  f.state = view.state
  view.dom.style.display = ''
  document.getElementById('empty')!.style.display = 'none'
  if (line && line > 0) {
    const ln = view.state.doc.line(Math.min(line, view.state.doc.lines))
    const pos = Math.min(ln.from + Math.max(0, (col || 1) - 1), ln.to)
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  }
  view.focus()
  postCursor()
}

function setDiff(path: string, original: string | null) {
  const f = files.get(path)
  if (!f) {
    return
  }
  const ext = original == null ? [] : unifiedMergeView({ original, mergeControls: true, highlightChanges: true, gutter: true })
  if (path === currentPath) {
    view.dispatch({ effects: diffComp.reconfigure(ext) })
    f.state = view.state
  } else {
    f.state = f.state.update({ effects: diffComp.reconfigure(ext) }).state
  }
}

function replace(path: string, text: string, markSaved: boolean) {
  const f = files.get(path)
  if (!f) {
    return
  }
  const spec = { changes: { from: 0, to: f.state.doc.length, insert: text } }
  if (path === currentPath) {
    view.dispatch(spec)
    f.state = view.state
  } else {
    f.state = f.state.update(spec).state
  }
  if (markSaved) {
    f.saved = f.state.doc
    f.wasDirty = false
    send({ type: 'dirty', path, dirty: false })
  }
}

// ── context menu ─────────────────────────────────────────────────────────────────────────────

const menu = document.getElementById('menu')!
const MENU: Array<[string, string, () => void] | null> = [
  ['Add to Chat', 'Ctrl+L', () => addToChat(view)],
  ['Edit with Hermes…', 'Ctrl+K', () => view.dispatch({ effects: toggleInline.of(true) })],
  null,
  ['Find', 'Ctrl+F', () => openSearchPanel(view)],
  ['Go to Line…', 'Ctrl+G', () => gotoLine(view)],
  ['Copy Relative Path', '', () => send({ type: 'command', id: 'copyRelativePath' })],
  null,
  ['Open in Browser', '', () => send({ type: 'command', id: 'openInBrowser' })],
  ['Reveal in Explorer', '', () => send({ type: 'command', id: 'revealInExplorer' })]
]

function hideMenu() {
  menu.style.display = 'none'
}

view.dom.addEventListener('contextmenu', e => {
  e.preventDefault()
  menu.replaceChildren(
    ...MENU.map(item => {
      if (!item) {
        const sep = document.createElement('div')
        sep.className = 'sep'
        return sep
      }
      const row = document.createElement('button')
      row.innerHTML = '<span></span><kbd></kbd>'
      row.firstChild!.textContent = item[0]
      row.lastChild!.textContent = item[1]
      row.onclick = () => {
        hideMenu()
        item[2]()
        view.focus()
      }
      return row
    })
  )
  menu.style.display = 'block'
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 4) + 'px'
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 4) + 'px'
})
addEventListener('mousedown', e => !menu.contains(e.target as Node) && hideMenu())
addEventListener('blur', hideMenu)
addEventListener('keydown', e => e.key === 'Escape' && hideMenu())

// ── protocol ─────────────────────────────────────────────────────────────────────────────────

function applyVars(vars: Record<string, string>) {
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars || {})) {
    root.style.setProperty(k, v)
  }
}

function applyLook(m: Msg) {
  if (typeof m.dark === 'boolean') {
    dark = m.dark
  }
  if (typeof m.fontSize === 'number') {
    fontSize = m.fontSize
  }
  if (typeof m.wrap === 'boolean') {
    wrap = m.wrap
  }
  applyVars(m.vars)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.documentElement.style.setProperty('--ide-font-size', fontSize + 'px')
  if (currentPath) {
    view.dispatch({ effects: [themeComp.reconfigure(highlight(dark)), wrapComp.reconfigure(wrap ? EditorView.lineWrapping : [])] })
    files.get(currentPath)!.state = view.state
  }
}

const handlers: Record<string, (m: Msg) => void> = {
  look: applyLook,
  font: m => {
    try {
      const face = new FontFace(m.family, m.buffer, { style: m.style || 'normal', weight: m.weight || '400' })
      face.load().then(f => document.fonts.add(f)).catch(() => undefined)
    } catch {
      /* a font we cannot decode keeps the fallback stack */
    }
  },
  open: m => {
    if (!files.has(m.path) && typeof m.text === 'string') {
      const eol = m.eol === '\r\n' ? '\r\n' : '\n'
      const { name, ext } = languageFor(m.path)
      const savedText = typeof m.saved === 'string' ? m.saved : m.text
      const state = EditorState.create({ doc: m.text, extensions: extensions(m.path, ext, eol) })
      const saved = savedText === m.text ? state.doc : Text.of(savedText.split(/\r\n|\r|\n/))
      files.set(m.path, { state, saved, pendingSave: null, eol, lang: name, wasDirty: !state.doc.eq(saved) })
      if (!state.doc.eq(saved)) {
        send({ type: 'dirty', path: m.path, dirty: true })
      }
    }
    if (typeof m.original === 'string') {
      setDiff(m.path, m.original)
    }
    if (m.show !== false) {
      show(m.path, m.line, m.col)
    }
  },
  show: m => show(m.path, m.line, m.col),
  close: m => {
    files.delete(m.path)
    if (currentPath === m.path) {
      currentPath = null
      view.setState(EditorState.create({ doc: '' }))
      view.dom.style.display = 'none'
      document.getElementById('empty')!.style.display = ''
    }
  },
  rename: m => {
    const f = files.get(m.from)
    if (f) {
      files.delete(m.from)
      files.set(m.to, f)
      if (currentPath === m.from) {
        currentPath = m.to
      }
    }
  },
  replace: m => {
    replace(m.path, m.text, m.markSaved !== false)
    if (m.original !== undefined) {
      setDiff(m.path, m.original)
    }
  },
  setDiff: m => setDiff(m.path, m.original ?? null),
  saved: m => {
    const f = files.get(m.path)
    if (f) {
      f.saved = f.pendingSave ?? f.state.doc
      f.pendingSave = null
      const dirty = !f.state.doc.eq(f.saved)
      f.wasDirty = dirty
      send({ type: 'dirty', path: m.path, dirty })
      send({ type: 'draft', path: m.path, text: dirty ? f.state.sliceDoc() : null })
    }
  },
  saveRequest: m => {
    const f = files.get(m.path)
    if (f) {
      if (m.path === currentPath) {
        f.state = view.state
      }
      f.pendingSave = f.state.doc
      send({ type: 'save', path: m.path, text: f.state.sliceDoc() })
    }
  },
  inlineEdit: () => view.dispatch({ effects: toggleInline.of(true) }),
  find: () => openSearchPanel(view),
  focus: () => view.focus()
}

addEventListener('message', e => {
  if (e.source !== window.parent || !e.data || typeof e.data.type !== 'string') {
    return
  }
  handlers[e.data.type]?.(e.data)
})

send({ type: 'ready' })
