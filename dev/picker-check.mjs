// Picker check: runs the IDE's element picker (PICKER in src/browser.ts) in a local Chrome or Edge
// with real mouse input and asserts it picks the element under the pointer, keeps the click from
// reaching the page, and reports the element's own styles rather than its :hover styles.
// usage: node dev/picker-check.mjs   (needs Chrome or Edge, and playwright-core from the Hermes checkout)
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const agentDir = process.env.HERMES_AGENT_DIR || `${process.env.LOCALAPPDATA}/hermes/hermes-agent`
const { chromium } = createRequire(`${agentDir.replace(/\\/g, '/')}/package.json`)('playwright-core')
const src = readFileSync(new URL('../src/browser.ts', import.meta.url), 'utf8')
const picker = src.match(/const PICKER = String\.raw`([\s\S]*?)`\n/)[1]
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(existsSync)

const browser = await chromium.launch({ executablePath: exe, headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>button{background:rgb(22,163,74)}button:hover{background:rgb(21,128,61)}</style>
    <button class="cta" onclick="document.title='clicked'" style="margin:80px;width:200px;height:40px">Go</button>`)
  const b = await page.locator('.cta').boundingBox()
  const x = b.x + 20, y = b.y + 20
  await page.mouse.move(x, y) // the pointer is already on the element when the pick starts
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cta')).backgroundColor), 'rgb(21, 128, 61)', 'precondition: hovered')
  const pick = page.evaluate(picker)
  await page.waitForTimeout(50)
  await page.mouse.move(x + 2, y)
  await page.mouse.click(x + 2, y)
  const res = await pick
  assert.equal(res.selector, 'button.cta')
  assert.equal(res.styles['background-color'], 'rgb(22, 163, 74)', 'picked styles must not include :hover')
  assert.notEqual(await page.title(), 'clicked', 'the pick click must not reach the page')
  console.log('picker check passed')
} finally {
  await browser.close()
}
