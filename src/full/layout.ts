// Full build only: column sizing, layout memory and window chrome for the IDE window.
//
// shortcut: the Desktop plugin SDK has no door to size a split, read the arrangement of a window's
// zones or restyle zone seams, so this reads the app's own pane markup
// ([data-tree-group] zones, [role=separator] sashes) and drags its sashes with synthetic pointer
// events. That is outside the catalog's SDK surface (rule 8), so the catalog build leaves it out
// and keeps the app's own split. Upgrade each piece to a host door when the SDK ships one.

import { $browserNav, $openTiles, ctx, frames, IDE_WINDOW, layoutState, savedLayout, writePerChat } from '../core'
import { type ColumnId, columnWidths, type Layout, TILE_IDS } from '../util'

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

// True once a fit has really run in this window. Until then the columns are the app's even split,
// and recording them would save a quarter-window Explorer as the user's chosen width (it stuck).
let fittedOnce = false

export function fullSaveLayout() {
  if (!IDE_WINDOW || !layoutState.ready || layoutState.fitting || !fittedOnce) return
  const layout = captureLayout()
  if (!layout) return
  const prev = savedLayout()
  if (JSON.stringify(layout.columns) !== JSON.stringify(prev.columns)) {
    // A column moved: the app re-splits the window evenly after a move, so keep each column's
    // own width (keyed by column, not position) and refit before recording widths again.
    writePerChat('layout', { columns: layout.columns, widths: prev.widths })
    lastSaved = ''
    void fitColumns().then(fullSaveLayout)
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
  if (layoutState.fitting) return
  // The app's sash only previews (and so moves) on animation frames: fit once the window paints.
  if (document.visibilityState !== 'visible') {
    refitWhenShown = true
    return
  }
  layoutState.fitting = true
  try {
    await frames(3)
    fittedOnce = true
    const W = window.innerWidth
    const saved = savedLayout().widths
    const measure = () => readColumns()
    let cols = measure()
    // A zone the IDE does not own (null: the app's own Browser pane, opened by the agent) gets a
    // planned width too; kept at its own, a half-screen preview squeezes every IDE column.
    const ids = cols.map(c => (c.ids.includes('editor') ? 'editor' : c.ids.includes('chat') ? 'chat' : (c.ids[0] ?? null)))
    const widths = columnWidths(ids, W, saved)
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
    layoutState.fitting = false
  }
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
      if (layoutState.ready) void fitColumns().then(fullSaveLayout)
    }, 400)
  })
  obs.observe(document.body, { childList: true, subtree: true })
  const save = () => window.setTimeout(fullSaveLayout, 300)
  window.addEventListener('pointerup', save, true)
  const shown = () => {
    if (refitWhenShown && document.visibilityState === 'visible') {
      refitWhenShown = false
      void fitColumns().then(fullSaveLayout)
    }
  }
  document.addEventListener('visibilitychange', shown)
  window.addEventListener('focus', shown)
  const tick = window.setInterval(fullSaveLayout, 3000)
  ctx.onDispose(() => {
    clearTimeout(timer)
    clearInterval(tick)
    window.removeEventListener('pointerup', save, true)
    document.removeEventListener('visibilitychange', shown)
    window.removeEventListener('focus', shown)
    obs.disconnect()
  })
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

/** Draw the seams, and expose the layout helpers to the CDP checks in docs/DEVELOPING.md. */
export function fullWindowSetup() {
  styleIdeWindow()
  ;(window as any).__hermesIde = { fitColumns, readColumns, savedLayout, captureLayout, browserNav: $browserNav }
}
