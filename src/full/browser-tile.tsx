// Full build only: the IDE's own Browser column, an Electron <webview> with an address bar, page
// DevTools and the element picker.
//
// shortcut: a plugin-minted <webview> skips the app's per-site consent for page scripts, so the
// catalog build leaves it out (rule 8, "preview guest reach") and shows the page in the app's own
// Browser pane, reaching it only through ctx.preview. This column keeps the page beside the editor
// in one tile until the SDK can point the app's Browser at an address.

import { Button, useValue } from '@hermes/plugin-sdk'
import { createElement, useEffect, useRef, useState } from 'react'

import { $askTrust, $picking, pickElement } from '../browser'
import { $browserNav, $root, ctx } from '../core'
import { icon, ProjectBar, ProjectEmpty, ServerLog, StaleBanner, Styles, TrustBanner } from '../ui'
import { addressToUrl } from '../util'

/** The page itself. Electron throws (synchronously) when a webview method runs before the guest
 *  is attached and has emitted dom-ready, so navigations wait for it and the toolbar goes through
 *  `guest()`, which returns null until then. */
function Webview({ nav, onNav, onRef }: { nav: { url: string; at: number }; onNav: (u: string) => void; onRef: (el: any) => void }) {
  const ref = useRef<any>(null)
  const ready = useRef(false)
  const pending = useRef<string | null>(null)
  const [initial] = useState(nav.url) // later navigations go through loadURL: re-setting src would reload
  const [fail, setFail] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const domReady = () => {
      ready.current = true
      onRef(el)
      const u = pending.current
      pending.current = null
      if (u) el.loadURL(u).catch(() => undefined)
    }
    const navigated = (e: any) => {
      if (e.isMainFrame === false) return
      setFail(null)
      onNav(e.url)
    }
    const failed = (e: any) => {
      if (e.isMainFrame && e.errorCode !== -3) setFail(`${e.errorDescription || 'Load failed'} (${e.validatedURL})`)
    }
    el.addEventListener('dom-ready', domReady)
    el.addEventListener('did-navigate', navigated)
    el.addEventListener('did-navigate-in-page', navigated)
    el.addEventListener('did-fail-load', failed)
    // A fast (cached, local) page can be ready before this effect ran; a method only works then.
    try {
      el.getURL()
      domReady()
    } catch {
      /* not ready yet: dom-ready will come */
    }
    return () => {
      el.removeEventListener('dom-ready', domReady)
      el.removeEventListener('did-navigate', navigated)
      el.removeEventListener('did-navigate-in-page', navigated)
      el.removeEventListener('did-fail-load', failed)
      ready.current = false
      onRef(null)
    }
  }, [])
  useEffect(() => {
    if (nav.url === initial && !ready.current) return // the first page loads from src
    if (ready.current) ref.current?.loadURL(nav.url).catch(() => undefined)
    else pending.current = nav.url
  }, [nav.at])
  return (
    <>
      {createElement('webview', { ref, src: initial, partition: 'persist:hermes-ide', webpreferences: 'contextIsolation=yes' })}
      {fail ? (
        <div className="hi-bempty">
          <div>
            {fail}
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="secondary" onClick={() => { setFail(null); if (ready.current) ref.current?.reload() }}>Retry</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

export function FullBrowserTile() {
  const nav = useValue($browserNav)
  const ask = useValue($askTrust)
  const picking = useValue($picking)
  const root = useValue($root)
  const [url, setUrl] = useState(nav?.url ?? '')
  const [input, setInput] = useState(nav?.url ?? '')
  const [showLog, setShowLog] = useState(false)
  const view = useRef<any>(null) // set once the page is ready for method calls
  const guest = () => view.current
  const isWebview = !!(window as any).hermesDesktop // Electron only; a browser-hosted Desktop has no webview tag

  // A navigation request (the dev server came up, Open in Browser, the agent's ide_open).
  useEffect(() => {
    if (!nav) return
    setInput(nav.url)
    if (!url) setUrl(nav.url)
  }, [nav?.at])

  const go = (raw: string) => {
    const target = addressToUrl(raw)
    if (target) $browserNav.set({ url: target, at: Date.now() })
  }

  return (
    <div className="hi-tile" data-tile="browser">
      <Styles />
      <div className="hi-bbar">
        <button className="hi-btn" title="Back" disabled={!url} onClick={() => guest()?.goBack()}>{icon('arrow-left')}</button>
        <button className="hi-btn" title="Forward" disabled={!url} onClick={() => guest()?.goForward()}>{icon('arrow-right')}</button>
        <button className="hi-btn" title="Reload" disabled={!url} onClick={() => guest()?.reload()}>{icon('refresh')}</button>
        <input
          className="hi-url"
          value={input}
          placeholder="Type an address, e.g. localhost:3000"
          spellCheck={false}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(input); e.stopPropagation() }}
        />
        <button className="hi-btn" data-on={picking} aria-pressed={picking} title={picking ? 'Cancel the pick' : 'Pick an element and send it to the chat'} disabled={!url && !picking} onClick={() => void pickElement(guest())}>{icon('inspect')}</button>
        <button className="hi-btn" title="Page DevTools" disabled={!url} onClick={() => guest()?.openDevTools()}>{icon('debug-console')}</button>
        <button className="hi-btn" title="Open in your browser" disabled={!url} onClick={() => void ctx.os.openExternal?.(url)}>{icon('link-external')}</button>
      </div>
      <ProjectBar showLog={showLog} onToggleLog={() => setShowLog(!showLog)} />
      {ask ? <TrustBanner cand={ask} /> : null}
      <StaleBanner />
      {showLog ? <ServerLog /> : null}
      <div className="hi-web">
        {!isWebview ? (
          <div className="hi-bempty">The Browser column needs the Hermes Desktop app.</div>
        ) : url ? (
          <Webview key={root ?? ''} nav={nav && nav.url ? nav : { url, at: 0 }} onRef={el => (view.current = el)} onNav={u => { setInput(u); setUrl(u) }} />
        ) : (
          <ProjectEmpty fallback="No page yet. Type an address above." />
        )}
      </div>
    </div>
  )
}
