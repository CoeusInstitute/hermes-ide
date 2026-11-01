// CDP driver for a sandboxed Hermes Desktop (see docs/DEVELOPING.md). Needs playwright-core, which
// a hermes-agent checkout already has; point HERMES_AGENT_DIR at it.
//
//   node dev/cdp.mjs eval "<js expression>"      evaluate in the main window, print JSON
//   node dev/cdp.mjs frame "<js expression>"     evaluate inside the IDE editor frame
//   node dev/cdp.mjs shot out.png                screenshot
//   node dev/cdp.mjs key "Control+Shift+F"       key press (use the shifted letter for Shift chords)
//   node dev/cdp.mjs type "text"                 type into the focused element
//   node dev/cdp.mjs fclick ".cm-line >> nth=1"  click inside the editor frame
//   node dev/cdp.mjs click 640,320               click window coordinates
//   node dev/cdp.mjs reload 15000                reload the window, print plugin console lines
import { createRequire } from 'node:module'

const agentDir = process.env.HERMES_AGENT_DIR || `${process.env.LOCALAPPDATA}/hermes/hermes-agent`
const require = createRequire(`${agentDir.replace(/\\/g, '/')}/package.json`)
const { chromium } = require('playwright-core')

const [cmd, arg] = process.argv.slice(2)
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`)
const pages = browser.contexts().flatMap(c => c.pages())
const page = pages.find(p => /index\.html(?!.*win=)/.test(p.url())) || pages[0]
const editorFrame = () => page.frames().filter(fr => fr !== page.mainFrame() && !fr.isDetached()).pop()
const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))

// Playwright emulates a light color scheme on attach, which flips an app set to "System" theme
// while the driver is connected. Reset it so screenshots show what the user sees.
await page.emulateMedia({ colorScheme: null, reducedMotion: null }).catch(() => {})
try {
  if (cmd === 'eval') {
    print(await page.evaluate(`(async () => (${arg}))()`))
  } else if (cmd === 'frame') {
    const f = editorFrame()
    if (!f) throw new Error('no editor frame')
    print(await f.evaluate(`(async () => (${arg}))()`))
  } else if (cmd === 'shot') {
    await page.screenshot({ path: arg })
    console.log('saved', arg)
  } else if (cmd === 'reload') {
    const logs = []
    page.on('console', m => /plugin|ide|error/i.test(m.text()) && logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`))
    page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 400)}`))
    await page.reload()
    await page.waitForTimeout(Number(arg) || 15000)
    console.log(logs.join('\n') || '(no plugin console output)')
  } else if (cmd === 'fclick') {
    await editorFrame().locator(arg).first().click()
    console.log('frame-clicked', arg)
  } else if (cmd === 'key') {
    await page.keyboard.press(arg)
    console.log('pressed', arg)
  } else if (cmd === 'type') {
    await page.keyboard.type(arg)
    console.log('typed')
  } else if (cmd === 'click') {
    const [x, y] = arg.split(',').map(Number)
    await page.mouse.click(x, y)
    console.log('clicked', x, y)
  } else {
    console.log('commands: eval frame shot reload fclick key type click')
  }
} finally {
  await browser.close().catch(() => {})
}
