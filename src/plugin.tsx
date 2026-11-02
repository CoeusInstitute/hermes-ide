// Hermes IDE desktop plugin entry.
//
// Two roles, decided per window:
//  - Main window: only an entry point. "IDE: Open in IDE Window" (Ctrl+Alt+I), a status-bar
//    button, and the agent's ide_open tool open the focused chat in its own IDE window. The main
//    window's layout is never changed.
//  - IDE window: the app's own single-session pop-out, claimed by this plugin. It holds exactly
//    one chat (the app's real chat, not a copy) with the IDE tile (Explorer | Editor) to its left.

import * as sdk from '@hermes/plugin-sdk'
import { host } from '@hermes/plugin-sdk'

import {
  IDE_WINDOW,
  bindContext,
  disposeEditor,
  loadSettings,
  notify,
  onStorageRequest,
  onToolComplete,
  openFile,
  openIdeWindow,
  openInBrowser,
  revealSidebar,
  runCommand,
  saveAll,
  scheduleRefresh,
  setupIdeWindow,
  showIde,
  switchSession,
  syncRoot,
  watchPreviews,
  windowSessionId,
  $folderDialog,
  $quickOpen,
  $active,
  addToChat,
  applyPendingCwd
} from './core'
import { IdeLayout, OpenCard, SettingsPage, StatusItem } from './ui'

const PLUGIN_ID = 'hermes-ide'

type Command = { id: string; label: string; keys?: string[]; run: () => void; keywords?: string[] }

export default {
  id: PLUGIN_ID,
  name: 'Hermes IDE',
  register(ctx: any) {
    bindContext(ctx, () => <IdeLayout />)
    loadSettings()

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
      registerCommands([
        {
          id: 'show',
          label: 'IDE: Open in IDE Window',
          keys: ['mod+alt+i'],
          run: () => void openIdeWindow(),
          keywords: ['ide', 'editor', 'cursor', 'code', 'popout', 'window']
        }
      ])
      // The agent's ide_open tool: open the chat it ran in, in that chat's IDE window, at the file.
      ctx.onEvent(`plugin.${PLUGIN_ID}.open`, (ev: any) => {
        const p = ev?.payload ?? {}
        const focused = host.state.focusedStoredSessionId.get()
        if (typeof p.path === 'string' && p.path && p.session_id && p.session_id === focused) {
          void openIdeWindow({ path: p.path, line: Number(p.line) > 0 ? Number(p.line) : undefined })
        }
      })
      if (!ctx.storage.get('welcomed-v2', false)) {
        ctx.storage.set('welcomed-v2', true)
        notify('info', 'Press Ctrl+Alt+I, or click IDE in the status bar, to open this chat in its own IDE window.', 'Hermes IDE')
      }
      return
    }

    // ── IDE window ──
    registerCommands([
      { id: 'show', label: 'IDE: Show IDE', keys: ['mod+alt+i'], run: showIde, keywords: ['ide', 'editor', 'cursor', 'code'] },
      { id: 'quickOpen', label: 'IDE: Go to File…', keys: ['mod+alt+p'], run: () => $quickOpen.set(true), keywords: ['quick open', 'file'] },
      { id: 'findInFiles', label: 'IDE: Search in Files', keys: ['mod+alt+f'], run: () => revealSidebar('search'), keywords: ['grep', 'find'] },
      { id: 'explorer', label: 'IDE: Show Explorer', keys: ['mod+alt+e'], run: () => revealSidebar('explorer') },
      { id: 'toggleExplorer', label: 'IDE: Toggle Explorer', run: () => runCommand('toggleSidebar') },
      { id: 'scm', label: 'IDE: Show Source Control', run: () => revealSidebar('scm'), keywords: ['git'] },
      { id: 'openFolder', label: 'IDE: Open Folder…', run: () => $folderDialog.set(true), keywords: ['workspace', 'project'] },
      { id: 'saveAll', label: 'IDE: Save All', run: saveAll },
      { id: 'addActive', label: 'IDE: Add Active File to Chat', run: () => { const a = $active.get(); if (a) void addToChat(a) } },
      { id: 'reveal', label: 'IDE: Reveal Active File in Explorer', run: () => runCommand('revealInExplorer') },
      {
        id: 'openUrl',
        label: 'IDE: Open Active File in Browser',
        run: () => { const a = $active.get(); a ? void openInBrowser(a) : ctx.runAction?.('view.showBrowser') },
        keywords: ['preview', 'render']
      }
    ])

    // The agent drives the IDE: ide_open pushes this event; tool events tell us when files may
    // have changed under open tabs.
    const sid = windowSessionId()
    ctx.onEvent(`plugin.${PLUGIN_ID}.open`, (ev: any) => {
      const p = ev?.payload ?? {}
      if (typeof p.path === 'string' && p.path && (!p.session_id || p.session_id === sid)) {
        void openFile(p.path, { line: Number(p.line) > 0 ? Number(p.line) : undefined })
      }
    })
    ctx.onEvent('tool.complete', onToolComplete)
    ctx.onEvent('message.complete', () => void applyPendingCwd())
    ctx.addEventListener(window, 'focus', () => scheduleRefresh())

    // This window holds one chat, so the IDE's tabs and folder are that chat's.
    ctx.onDispose(host.state.focusedStoredSessionId.subscribe((id: string | null) => void switchSession(id || sid)))
    ctx.onDispose(host.state.cwd.subscribe(() => void syncRoot()))
    ctx.onDispose(disposeEditor)

    watchPreviews()
    void setupIdeWindow()
  }
}
