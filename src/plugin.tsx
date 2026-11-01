// Hermes IDE desktop plugin entry. Registers the IDE's surfaces into Hermes Desktop's own shell:
// the chat stays the app's real session chat; the IDE adds the Explorer, the Editor tile beside it,
// a status item, commands, keybinds, a settings page, and an "open in IDE" transcript card.

import * as sdk from '@hermes/plugin-sdk'
import { host } from '@hermes/plugin-sdk'

import {
  bindContext,
  disposeEditor,
  loadSettings,
  notify,
  onToolComplete,
  openFile,
  openInBrowser,
  revealSidebar,
  runCommand,
  saveAll,
  scheduleRefresh,
  showIde,
  switchSession,
  syncRoot,
  $folderDialog,
  $quickOpen,
  $active,
  addToChat
} from './core'
import { Dialogs, EditorPane, OpenCard, SettingsPage, Sidebar, StatusItem } from './ui'

const PLUGIN_ID = 'hermes-ide'

export default {
  id: PLUGIN_ID,
  name: 'Hermes IDE',
  register(ctx: any) {
    bindContext(ctx, () => <EditorPane />)
    loadSettings()

    const area = (name: string, fallback: string) => ((sdk as any)[name] ?? fallback) as string

    ctx.registerMany([
      {
        id: 'explorer',
        area: area('PANES_AREA', 'panes'),
        title: 'Explorer',
        data: { placement: 'left', width: '280px' },
        render: () => <Sidebar />
      },
      {
        id: 'dialogs',
        area: (sdk as any).TITLEBAR_AREAS?.left ?? 'titleBar.left',
        order: 9999,
        render: () => <Dialogs />
      },
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

    // Commands: in the palette, and as rebindable keybinds. Defaults avoid the app's own chords;
    // inside the editor the Cursor/VS Code keys (Ctrl+P, Ctrl+Shift+F, Ctrl+L, Ctrl+K…) work as-is.
    const commands: Array<{ id: string; label: string; keys?: string[]; run: () => void; keywords?: string[] }> = [
      { id: 'show', label: 'IDE: Show IDE Layout', keys: ['mod+alt+i'], run: showIde, keywords: ['ide', 'editor', 'cursor', 'code'] },
      { id: 'quickOpen', label: 'IDE: Go to File…', keys: ['mod+alt+p'], run: () => $quickOpen.set(true), keywords: ['quick open', 'file'] },
      { id: 'findInFiles', label: 'IDE: Search in Files', keys: ['mod+alt+f'], run: () => revealSidebar('search'), keywords: ['grep', 'find'] },
      { id: 'explorer', label: 'IDE: Show Explorer', keys: ['mod+alt+e'], run: () => revealSidebar('explorer') },
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
    ]
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

    ctx.registerSettingsPage?.({ id: 'settings', title: 'Hermes IDE', icon: 'code', render: () => <SettingsPage /> })

    // The agent drives the IDE: its ide_open tool pushes this event; the gateway's tool events
    // tell us when files may have changed under open tabs.
    ctx.onEvent(`plugin.${PLUGIN_ID}.open`, (ev: any) => {
      const p = ev?.payload ?? {}
      if (typeof p.path === 'string' && p.path) {
        void openFile(p.path, { line: Number(p.line) > 0 ? Number(p.line) : undefined })
      }
    })
    ctx.onEvent('tool.complete', onToolComplete)
    ctx.addEventListener(window, 'focus', () => scheduleRefresh())

    // 1:1 with the session: the IDE's tab set and folder follow the chat in focus.
    ctx.onDispose(host.state.focusedStoredSessionId.subscribe((id: string | null) => void switchSession(id)))
    ctx.onDispose(host.state.cwd.subscribe(() => void syncRoot()))
    ctx.onDispose(disposeEditor)

    void syncRoot().then(() => {
      if (ctx.storage.get('welcomed', false)) return
      ctx.storage.set('welcomed', true)
      notify('info', 'Hermes IDE is on. Run "IDE: Show IDE Layout" (Ctrl+Alt+I) from the command palette.', 'Hermes IDE')
    })
  }
}
