// Hermes IDE desktop plugin entry.
//
// Two roles, decided per window:
//  - Main window: entry points only. "IDE: Open in IDE Window" (Ctrl+Alt+I), a status-bar button,
//    the agent's ide_open tool, and the sidebar's IDE group (IDE chats, which open in their IDE
//    window) and IDE row badges. The main window's layout is never changed.
//  - IDE window: the app's own single-session pop-out, claimed by this plugin. It holds exactly
//    one chat (the app's real chat, not a copy) with the IDE's columns (Explorer, Editor, Browser)
//    as app tiles around it, which the user drags into any arrangement.

import * as sdk from '@hermes/plugin-sdk'
import { host } from '@hermes/plugin-sdk'

import { initBrowser, pickElement, startUi, stopUi } from './browser'
import {
  IDE_WINDOW,
  bindContext,
  disposeTiles,
  loadIdeChats,
  loadSettings,
  notify,
  onStorageRequest,
  onToolComplete,
  openFile,
  openIdeWindow,
  openInBrowser,
  resetLayout,
  revealSidebar,
  runCommand,
  saveAll,
  saveLayout,
  scheduleRefresh,
  setupIdeWindow,
  showIde,
  switchSession,
  syncRoot,
  watchLayout,
  windowSessionId,
  $folderDialog,
  $quickOpen,
  $active,
  addToChat,
  applyPendingCwd
} from './core'
import { initSidebar } from './sidebar'
import { BrowserTile, EditorTile, ExplorerTile, IdeRowBadge, LayoutToggles, OpenCard, SettingsPage, StatusItem } from './ui'

const PLUGIN_ID = 'hermes-ide'

type Command = { id: string; label: string; keys?: string[]; run: () => void; keywords?: string[] }

export default {
  id: PLUGIN_ID,
  name: 'Hermes IDE',
  register(ctx: any) {
    bindContext(ctx, { explorer: () => <ExplorerTile />, editor: () => <EditorTile />, browser: () => <BrowserTile /> })
    loadSettings()
    loadIdeChats()

    const area = (name: string, fallback: string) => ((sdk as any)[name] ?? fallback) as string

    ctx.registerMany([
      {
        id: 'status',
        area: (sdk as any).STATUSBAR_AREAS?.right ?? 'statusBar.right',
        order: 40,
        render: () => <StatusItem />
      },
      {
        id: 'open-card',
        area: area('TRANSCRIPT_DIRECTIVE_AREA', 'transcript.directives'),
        data: { name: 'hermes-ide-open', render: (props: any) => <OpenCard attrs={props.attrs} /> }
      }
    ])

    // Commands appear in the palette and, with keys, as rebindable keybinds. Inside the editor the
    // Cursor/VS Code keys (Ctrl+P, Ctrl+Shift+F, Ctrl+L, Ctrl+K…) work as-is.
    const registerCommands = (commands: Command[]) => {
      for (const c of commands) {
        ctx.register({
          id: `palette-${c.id}`,
          area: area('PALETTE_AREA', 'palette'),
          data: { id: `${PLUGIN_ID}.${c.id}`, label: c.label, keywords: c.keywords, action: c.keys ? `${PLUGIN_ID}.${c.id}` : undefined, run: c.run }
        })
        if (c.keys) {
          ctx.register({
            id: `key-${c.id}`,
            area: area('KEYBINDS_AREA', 'keybinds'),
            data: { id: `${PLUGIN_ID}.${c.id}`, label: c.label, category: 'view', defaults: c.keys, run: c.run }
          })
        }
      }
    }

    ctx.registerSettingsPage?.({ id: 'settings', title: 'Hermes IDE', icon: 'code', render: () => <SettingsPage /> })

    // Every pop-out of a chat listens, so asking for the IDE converts an already open plain
    // pop-out of that chat instead of the app just fronting it.
    ctx.addEventListener(window, 'storage', onStorageRequest as EventListener)

    if (!IDE_WINDOW) {
      ctx.register({
        id: 'row-badge',
        area: (sdk as any).SESSION_ROW_AREAS?.leading ?? 'sessionRow.leading',
        data: { render: (props: { sessionId: string }) => <IdeRowBadge sessionId={props.sessionId} /> }
      })
      registerCommands([
        {
          id: 'show',
          label: 'IDE: Open in IDE Window',
          keys: ['mod+alt+i'],
          run: () => void openIdeWindow(),
          keywords: ['ide', 'editor', 'cursor', 'code', 'popout', 'window']
        }
      ])
      // The agent's ide_open tool: open the chat it ran in, in that chat's IDE window, at the file
      // or page. Only the window showing that chat acts, so two windows never both open it.
      ctx.onEvent(`plugin.${PLUGIN_ID}.open`, (ev: any) => {
        const p = ev?.payload ?? {}
        const focused = host.state.focusedStoredSessionId.get()
        if ((p.path || p.url) && p.session_id && p.session_id === focused) {
          void openIdeWindow({ path: p.path || undefined, line: Number(p.line) > 0 ? Number(p.line) : undefined, url: p.url || undefined, sid: p.session_id })
        }
      })
      initSidebar()
      if (!ctx.storage.get('welcomed-v3', false)) {
        ctx.storage.set('welcomed-v3', true)
        notify('info', 'Press Ctrl+Alt+I, or click IDE in the status bar, to open this chat in its own IDE window. IDE chats get their own group in the sidebar.', 'Hermes IDE')
      }
      return
    }

    // ── IDE window ──
    ctx.register({ id: 'layout-toggles', area: (sdk as any).TITLEBAR_AREAS?.right ?? 'titleBar.right', render: () => <LayoutToggles /> })
    registerCommands([
      { id: 'show', label: 'IDE: Show IDE', keys: ['mod+alt+i'], run: showIde, keywords: ['ide', 'editor', 'cursor', 'code'] },
      { id: 'quickOpen', label: 'IDE: Go to File…', keys: ['mod+alt+p'], run: () => $quickOpen.set(true), keywords: ['quick open', 'file'] },
      { id: 'findInFiles', label: 'IDE: Search in Files', keys: ['mod+alt+f'], run: () => revealSidebar('search'), keywords: ['grep', 'find'] },
      { id: 'explorer', label: 'IDE: Show Explorer', keys: ['mod+alt+e'], run: () => revealSidebar('explorer') },
      { id: 'toggleExplorer', label: 'IDE: Toggle Explorer Column', run: () => runCommand('toggleSidebar'), keywords: ['sidebar', 'files', 'column'] },
      { id: 'toggleEditor', label: 'IDE: Toggle Editor Column', run: () => runCommand('toggleEditor'), keywords: ['code', 'column'] },
      { id: 'toggleBrowser', label: 'IDE: Toggle Browser Column', keys: ['mod+alt+b'], run: () => runCommand('toggleBrowser'), keywords: ['preview', 'web', 'column'] },
      { id: 'resetLayout', label: 'IDE: Reset Column Layout', run: () => void resetLayout(), keywords: ['arrange', 'columns', 'default'] },
      { id: 'runUi', label: "IDE: Run Project's UI", keys: ['mod+alt+r'], run: () => void startUi(), keywords: ['dev server', 'npm run dev', 'vite', 'next', 'start', 'preview'] },
      { id: 'stopUi', label: "IDE: Stop Project's UI", run: () => void stopUi(), keywords: ['dev server', 'stop'] },
      {
        id: 'pick',
        label: 'IDE: Pick Element in Browser',
        run: () => void pickElement(document.querySelector('.hi-tile[data-tile="browser"] webview')),
        keywords: ['inspect', 'select', 'component', 'annotate']
      },
      { id: 'scm', label: 'IDE: Show Source Control', run: () => revealSidebar('scm'), keywords: ['git'] },
      { id: 'openFolder', label: 'IDE: Open Folder…', run: () => $folderDialog.set(true), keywords: ['workspace', 'project'] },
      { id: 'saveAll', label: 'IDE: Save All', run: saveAll },
      { id: 'addActive', label: 'IDE: Add Active File to Chat', run: () => { const a = $active.get(); if (a) void addToChat(a) } },
      { id: 'reveal', label: 'IDE: Reveal Active File in Explorer', run: () => runCommand('revealInExplorer') },
      { id: 'openUrl', label: 'IDE: Open Active File in Browser', run: () => { const a = $active.get(); if (a) openInBrowser(a) }, keywords: ['preview', 'render'] }
    ])

    // The agent drives the IDE: ide_open pushes this event; tool events tell us when files may
    // have changed under open tabs.
    const sid = windowSessionId()
    ctx.onEvent(`plugin.${PLUGIN_ID}.open`, (ev: any) => {
      const p = ev?.payload ?? {}
      if (p.session_id && p.session_id !== sid) return
      if (typeof p.path === 'string' && p.path) void openFile(p.path, { line: Number(p.line) > 0 ? Number(p.line) : undefined })
      if (typeof p.url === 'string' && p.url) openInBrowser(p.url)
    })
    ctx.onEvent('tool.complete', onToolComplete)
    ctx.onEvent('message.complete', () => void applyPendingCwd())
    ctx.addEventListener(window, 'focus', () => scheduleRefresh())
    ctx.addEventListener(window, 'pagehide', saveLayout)

    // This window holds one chat, so the IDE's tabs and folder are that chat's.
    ctx.onDispose(host.state.focusedStoredSessionId.subscribe((id: string | null) => void switchSession(id || sid)))
    ctx.onDispose(host.state.cwd.subscribe(() => void syncRoot()))
    ctx.onDispose(disposeTiles)

    initBrowser()
    watchLayout()
    void setupIdeWindow()
  }
}
