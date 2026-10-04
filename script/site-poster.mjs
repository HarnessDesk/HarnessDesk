#!/usr/bin/env node
/** Render the site's poster from preview.html, with the exact same staged Run and real FlowGraph. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { COLLECT, textReasons } from './shots/audit.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}
if (args.includes('--help')) {
  console.log('node script/site-poster.mjs [--out output/site-poster] [--frames]\nRenders light/dark PNG and WebP from the isolated preview harness. --frames also captures the Overview and Run Flow at 1280px and 390px.')
  process.exit(0)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const folder = resolve(flag('out', 'output/site-poster'))
await mkdir(folder, { recursive: true })
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const server = spawn('pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
let browser
try {
  const deadline = Date.now() + 120_000
  for (;;) {
    if (server.exitCode !== null) throw new Error(serverLog)
    try { if ((await fetch(`${origin}/preview.html`)).ok) break } catch {}
    if (Date.now() > deadline) throw new Error(`Preview did not start: ${serverLog}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  browser = await chromium.launch({ headless: true })
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const capture = async name => {
      await page.evaluate(() => document.fonts.ready)
      assert.deepEqual(textReasons(await page.evaluate(COLLECT)), [], 'The frame must carry only placeholder identities.')
      assert.deepEqual(errors, [], 'The preview must render without an exception.')
      await page.screenshot({ path: `${folder}/${name}.png`, fullPage: true })
      console.log(`Rendered ${name}.png`)
    }
    await page.goto(`${origin}/preview.html?site-run=poster&theme=${theme}`)
    await page.locator('[data-slot="flow-step"][data-step="fix"][data-state="working"]').waitFor()
    await capture(`poster-${theme}`)
    await promisify(execFile)('magick', [`${folder}/poster-${theme}.png`, '-quality', '90', `${folder}/poster-${theme}.webp`])
    console.log(`Rendered poster-${theme}.webp`)
    if (args.includes('--frames')) {
      await page.setViewportSize({ width: 390, height: 900 })
      await page.locator('[data-step-row="fix"]').waitFor({ state: 'visible' })
      await capture(`poster-${theme}-390`)
    }
    if (args.includes('--frames')) for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${origin}/preview.html?site-run=flow&stage=you&theme=${theme}`)
      await page.getByRole('button', { name: 'Merged', exact: true }).waitFor()
      await capture(`overview-${theme}-${width}`)
      await page.goto(`${origin}/preview.html?site-run=flow&stage=fix&theme=${theme}`)
      await page.getByRole('button', { name: 'Write, review, land', exact: true }).click()
      if (width === 1280) await capture(`timeline-${theme}`)
      await page.getByRole('radio', { name: 'Flow', exact: true }).click()
      await page.locator('[data-slot="flow-graph"]').waitFor()
      await capture(`flow-${theme}-${width}`)
    }
    await page.close()
  }
} finally {
  await browser?.close()
  try { process.kill(-server.pid, 'SIGTERM') } catch {}
}
