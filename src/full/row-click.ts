// Full build only: a plain click anywhere on an IDE chat's session row opens its IDE window.
//
// shortcut: the SDK's row slots render a decoration inside the row but give no say over the row's
// click, so this listens on the row body the badge sits in (found by walking up to the element that
// holds the row's own button). Reaching into the row's markup is outside the catalog's SDK surface
// (rule 8); the catalog build opens the IDE window from the badge itself.

import { type RefObject, useLayoutEffect } from 'react'

import { openIdeWindow } from '../core'

export function useIdeRowClick(ref: RefObject<HTMLElement | null>, isIde: boolean, sessionId: string) {
  useLayoutEffect(() => {
    // The row body: the nearest ancestor holding the row's title button (its real button), not
    // the actions cluster. The slot may wrap the badge, so its parent is not enough.
    let body = ref.current?.parentElement ?? null
    while (body && !body.querySelector('button:not([data-row-actions] button)')) body = body.parentElement
    if (!body || !isIde) return
    // Modifier clicks (pin, open in a split) keep the app's meaning.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if ((e.target as HTMLElement).closest('[data-row-actions], [data-reorder-handle]')) return
      e.preventDefault()
      e.stopPropagation()
      void openIdeWindow({ sid: sessionId })
    }
    body.addEventListener('click', onClick, true)
    return () => body.removeEventListener('click', onClick, true)
  }, [isIde, sessionId])
}
