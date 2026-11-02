// Pure-helper tests. Node 24 strips the TypeScript types itself: `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addressToUrl, columnPlan, columnWidths, DEFAULT_LAYOUT, detectEol, dockPlan, expandPickTokens, fileRef, fuzzyScore, isInside, normalizeLayout, pathOrUrl, pathsFromToolArgs, rankFiles, relPath, splitLineSuffix, widthsFor } from '../src/util.ts'

test('fileRef emits the @file syntax Hermes expands, relative to the workspace', () => {
  assert.equal(fileRef('D:/proj/src/app.ts', 'D:/proj'), '@file:src/app.ts')
  assert.equal(fileRef('D:/proj/src/app.ts', 'd:/proj', 10, 20), '@file:src/app.ts:10-20')
  assert.equal(fileRef('D:/proj/src/app.ts', 'D:/proj', 7, 7), '@file:src/app.ts:7')
  assert.equal(fileRef('D:/My apps/x.ts', 'C:/other'), '@file:"D:/My apps/x.ts"')
  assert.equal(fileRef('D:/proj/lib', 'D:/proj', undefined, undefined, true), '@folder:lib')
})

test('paths compare case-insensitively on Windows drives only', () => {
  assert.ok(isInside('d:\\Proj\\a.ts', 'D:/proj'))
  assert.ok(!isInside('/home/Me/a', '/home/me'))
  assert.ok(!isInside('D:/projector/a', 'D:/proj'))
  assert.equal(relPath('D:/proj', 'D:/proj'), '.')
})

test('quick open ranks name hits above deep path hits', () => {
  const files = ['src/components/Button.tsx', 'docs/button-guide.md', 'src/lib/utils.ts', 'tests/b/u/t/t/o/n.txt']
  const top = rankFiles('button', files)
  assert.deepEqual(top.slice(0, 2).sort(), ['docs/button-guide.md', 'src/components/Button.tsx'])
  assert.equal(top[2], 'tests/b/u/t/t/o/n.txt')
  assert.equal(rankFiles('util', files)[0], 'src/lib/utils.ts')
  assert.ok(!top.includes('src/lib/utils.ts'))
  assert.equal(fuzzyScore('zzz', 'abc'), -1)
  assert.deepEqual(splitLineSuffix('app.ts:42:7'), { query: 'app.ts', line: 42, col: 7 })
  assert.deepEqual(splitLineSuffix(':12'), { query: '', line: 12, col: undefined })
})

test('tool arguments yield the files an agent turn may have written', () => {
  assert.deepEqual(pathsFromToolArgs({ path: 'src/a.ts', content: 'x' }), ['src/a.ts'])
  assert.deepEqual(
    pathsFromToolArgs({ patch: '*** Begin Patch\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** Add File: new.md\n' }).sort(),
    ['new.md', 'src/b.ts']
  )
  assert.deepEqual(pathsFromToolArgs({ edits: [{ file_path: 'c.py' }] }), ['c.py'])
  assert.deepEqual(pathsFromToolArgs(null), [])
})

test('columnPlan sizes Explorer, chat and preview to the window, within usable clamps', () => {
  assert.deepEqual(columnPlan(1920), { explorer: 269, chat: 576, preview: 614 })
  assert.deepEqual(columnPlan(1280), { explorer: 220, chat: 384, preview: 520 })
  assert.deepEqual(columnPlan(3840), { explorer: 300, chat: 760, preview: 1229 })
  assert.deepEqual(columnPlan(900), { explorer: 220, chat: 380, preview: 520 })
})

const P = id => `plugin-workspace:hermes-ide-${id}`

test('dockPlan rebuilds the default IDE arrangement outward from the chat', () => {
  assert.deepEqual(dockPlan(DEFAULT_LAYOUT, ['explorer', 'editor', 'browser']), [
    { id: 'browser', dock: { pane: 'workspace', pos: 'left' } },
    { id: 'editor', dock: { pane: P('browser'), pos: 'left' } },
    { id: 'explorer', dock: { pane: P('editor'), pos: 'left' } }
  ])
  // Closed tiles drop out and the chain closes over the gap.
  assert.deepEqual(dockPlan(DEFAULT_LAYOUT, ['explorer', 'editor']), [
    { id: 'editor', dock: { pane: 'workspace', pos: 'left' } },
    { id: 'explorer', dock: { pane: P('editor'), pos: 'left' } }
  ])
})

test('dockPlan reproduces a user arrangement: chat in the middle, stacked tabs, columns right of it', () => {
  const layout = { columns: [['explorer'], ['chat'], ['editor', 'browser']], widths: {} }
  assert.deepEqual(dockPlan(layout, ['explorer', 'editor', 'browser']), [
    { id: 'explorer', dock: { pane: 'workspace', pos: 'left' } },
    { id: 'editor', dock: { pane: 'workspace', pos: 'right' } },
    { id: 'browser', dock: { pane: P('editor'), pos: 'center' } }
  ])
  // A tile stacked with the chat docks center on the chat.
  assert.deepEqual(dockPlan({ columns: [['chat', 'browser']], widths: {} }, ['browser']), [
    { id: 'browser', dock: { pane: 'workspace', pos: 'center' } }
  ])
})

test('normalizeLayout tolerates junk and places tiles the saved layout never saw', () => {
  assert.deepEqual(normalizeLayout({ columns: [['chat']], widths: {} }, ['explorer', 'editor', 'browser']), [['explorer'], ['editor'], ['browser'], ['chat']])
  assert.deepEqual(normalizeLayout({ columns: 'x', widths: {} }, ['editor']), [['editor'], ['chat']])
  assert.deepEqual(normalizeLayout({ columns: [['editor', 'editor'], ['nope'], []], widths: {} }, ['editor']), [['editor'], ['chat']])
})

test('a file opened later docks the editor beside the Explorer, not between the page and the chat', () => {
  // The arrangement a new IDE workspace saves before any file is open.
  const saved = { columns: [['explorer'], ['browser'], ['chat']], widths: { explorer: 0.091, browser: 0.482, chat: 0.427 } }
  assert.deepEqual(normalizeLayout(saved, ['explorer', 'browser', 'editor']), [['explorer'], ['editor'], ['browser'], ['chat']])
  assert.deepEqual(dockPlan(saved, ['explorer', 'browser', 'editor']).find(s => s.id === 'editor'), {
    id: 'editor',
    dock: { pane: 'plugin-workspace:hermes-ide-browser', pos: 'left' }
  })
  // No Explorer: the editor still goes where the default order has it, ahead of the page.
  assert.deepEqual(normalizeLayout({ columns: [['browser'], ['chat']], widths: {} }, ['browser', 'editor']), [['editor'], ['browser'], ['chat']])
})

test('widthsFor: widths saved for another set of columns do not apply, except the Explorer', () => {
  const saved = { columns: [['explorer'], ['browser'], ['chat']], widths: { explorer: 0.091, browser: 0.482, chat: 0.427 } }
  // The editor opened: the page/chat split of the three-column window is stale.
  assert.deepEqual(widthsFor(saved, [['explorer'], ['editor'], ['browser'], ['chat']]), { explorer: 0.091 })
  // Same columns in another order (the user dragged one): every width still applies.
  assert.deepEqual(widthsFor(saved, [['chat'], ['explorer'], ['browser']]), saved.widths)
  // The fit then gives the editor the rest instead of its floor.
  const widths = columnWidths(['explorer', 'editor', 'browser', 'chat'], 3840, widthsFor(saved, [['explorer'], ['editor'], ['browser'], ['chat']]))
  assert.deepEqual(widths, [349, null, 1229, 760])
  assert.ok(3840 - 349 - 1229 - 760 > 1229, 'the editor is the widest column')
})

test('columnWidths: plan by default, saved fractions win, the editor takes the rest', () => {
  assert.deepEqual(columnWidths(['explorer', 'editor', 'browser', 'chat'], 3840), [300, null, 1229, 760])
  assert.deepEqual(columnWidths(['explorer', 'editor', 'chat'], 3840, { explorer: 0.1, chat: 2 }), [384, null, 760])
  // A zone the IDE does not own gets the Browser column's room (it used to keep its own width).
  assert.deepEqual(columnWidths(['explorer', 'chat', null], 1920), [269, null, 614])
})

test('address bar input becomes a URL the webview can load', () => {
  // The bug this guards: "localhost:5173" passed a naive scheme test and loaded nothing.
  assert.equal(addressToUrl('localhost:5173/?second=1'), 'http://localhost:5173/?second=1')
  assert.equal(addressToUrl('127.0.0.1:8000'), 'http://127.0.0.1:8000')
  assert.equal(addressToUrl('myhost:3000/app'), 'http://myhost:3000/app')
  assert.equal(addressToUrl('example.com/docs'), 'https://example.com/docs')
  assert.equal(addressToUrl(' http://a.test/x '), 'http://a.test/x')
  assert.equal(addressToUrl('about:blank'), 'about:blank')
  assert.equal(addressToUrl(''), '')
})

test('Open in Browser turns local paths into file URLs and leaves URLs alone', () => {
  assert.equal(pathOrUrl('C:\\My apps\\site\\index.html'), 'file:///C:/My%20apps/site/index.html')
  assert.equal(pathOrUrl('/home/me/site/a b.html'), 'file:///home/me/site/a%20b.html')
  assert.equal(pathOrUrl('http://localhost:5173/'), 'http://localhost:5173/')
  assert.equal(pathOrUrl('file:///C:/x.html'), 'file:///C:/x.html')
})


test('detectEol takes the dominant line ending, not the first CRLF it sees', () => {
  assert.equal(detectEol('a\nb\nc\r\nd\n'), '\n')
  assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n')
  assert.equal(detectEol('one line'), '\n')
})

test('columnWidths: a zone the IDE does not own shares the Browser column room', () => {
  const w = columnWidths(['explorer', 'editor', 'browser', 'chat', null], 3840)
  assert.deepEqual(w, [300, null, 615, 760, 615])
  assert.deepEqual(columnWidths(['editor', 'chat', null], 3840), [null, 760, 1229])
})

test('columnWidths: without the editor the page takes the rest, a little wider than the chat', () => {
  const w = columnWidths(['explorer', 'browser', 'chat'], 3840)
  assert.deepEqual(w, [300, null, 1664])
  const browser = 3840 - 300 - 1664
  assert.ok(browser > 1664 && browser < 1664 * 1.2, `browser ${browser} vs chat 1664`)
})

test('columnWidths: an Explorer width saved before any fit (a quarter of the window) is ignored', () => {
  assert.deepEqual(columnWidths(['explorer', 'editor', 'chat'], 3840, { explorer: 0.25 }), [300, null, 760])
  assert.deepEqual(columnWidths(['explorer', 'editor', 'chat'], 3840, { explorer: 0.09 }), [346, null, 760])
})

test('picked-element tokens expand to their [[ ]] blocks when the message is sent', () => {
  const blocks = { 3: '[[ Element picked in the IDE browser (http://localhost:5173/):\n- selector: `#Times`\n]]' }
  const sent = expandPickTokens('Make [[ element 3 · <span#Times> "0:00 / 0:00" ]] bold', blocks)
  assert.equal(sent, 'Make \n[[ Element picked in the IDE browser (http://localhost:5173/):\n- selector: `#Times`\n]]\n bold')
  // Unknown tokens (another window's, or after a reload of storage) stay as typed; other text is untouched.
  assert.equal(expandPickTokens('[[ element 9 · <a> ]]', blocks), '[[ element 9 · <a> ]]')
  assert.equal(expandPickTokens('no tokens [[ here ]]', blocks), 'no tokens [[ here ]]')
  // Two picks in one message.
  const two = expandPickTokens('[[ element 3 · <span> ]] and [[ element 3 · <span> ]]', blocks)
  assert.equal(two.split('[[ Element picked').length - 1, 2)
})

test('columnWidths: an app pane docked beside them does not leave the chat wider than the page', () => {
  const w = columnWidths(['explorer', 'browser', 'chat', null], 3840)
  const browser = 3840 - w.reduce((a, b) => a + (b ?? 0), 0)
  assert.equal(w[3], 615)
  assert.ok(browser > w[2], `browser ${browser} vs chat ${w[2]}`)
})
