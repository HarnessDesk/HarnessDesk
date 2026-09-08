#!/usr/bin/env node
/**
 * Flatten a rendered diagram to PNG, in both themes.
 *
 * The interactive HTML is the better artifact and GitHub will not show it: a
 * link to a committed `.html` opens seven hundred kilobytes of source, not a
 * diagram. Verified rather than assumed — the blob page renders the file as
 * code, and the `#gh-dark-mode-only` mechanism that used to help is gone from
 * GitHub's stylesheets entirely.
 *
 * So the HTML stays as the thing to open, and this produces the thing to
 * *see*: a still of the same diagram, from the same JSON, embedded in the
 * Markdown where a reader is already looking. Generated, never drawn — if the
 * two ever disagree it is because somebody forgot to re-run this, which is a
 * different and much louder kind of wrong than two hand-maintained diagrams
 * drifting apart.
 *
 *   node script/diagram-export.mjs docs/diagrams/architecture.html
 */
import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Cdp } from './review/lib/desk.mjs'

const run = promisify(execFile)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9791
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const target = resolve(process.argv[2] ?? 'docs/diagrams/architecture.html')
const base = target.replace(/\.html$/, '')
const say = (line) => process.stdout.write(`  ${line}\n`)

let cdp = null
const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--user-data-dir=/tmp/hd-diagram-export',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

try {
  let list = null
  for (let attempt = 0; attempt < 40 && !list; attempt += 1) {
    await sleep(250)
    list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      .then((r) => r.json())
      .catch(() => null)
  }
  const page = list?.find((tab) => tab.type === 'page')
  if (!page) throw new Error('headless Chrome never offered a page target')

  /* The repository already has a CDP client — `script/review/lib/desk.mjs` —
     with the timeouts and the event hook worked out. A second hand-rolled one
     here would be a second place for the same bugs. */
  cdp = await Cdp.open(page.webSocketDebuggerUrl)
  const send = (method, params = {}) => cdp.send(method, params, 60_000)
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 60_000)
    return r?.result?.value
  }

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 2, mobile: false })

  for (const theme of ['light', 'dark']) {
    /* The page reads its theme from localStorage on boot, so it is set before
       navigation rather than toggled after — a click would animate, and an
       animation is a race against the shutter. */
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('archify-theme', ${JSON.stringify(theme)}) } catch {}`,
    })
    await send('Page.navigate', { url: `file://${target}` })
    await sleep(3500)

    const on = await evaluate(`document.documentElement.getAttribute('data-theme')`)
    if (on !== theme) throw new Error(`asked for ${theme} and the page is showing ${on ?? 'nothing'}`)

    /* Clip to the diagram's own box. A viewport shot carries the toolbar —
       Light / Classic / Present / Export — which is chrome for somebody
       driving the page and noise for somebody reading a document. */
    const box = await evaluate(`(() => {
      const el = document.querySelector('.diagram-container') ?? document.body
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height })
    })()`)
    const clip = JSON.parse(box)
    if (!(clip.width > 0 && clip.height > 0)) throw new Error('the diagram has no box to clip to')

    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      /* scale 1: the device scale factor already renders at 2x, and clip.scale
         multiplies it again. */
      clip: { ...clip, scale: 1 },
    })
    const file = `${base}-${theme}.png`
    writeFileSync(file, Buffer.from(data, 'base64'))
    const { stdout } = await run('/bin/ls', ['-lh', file])
    say(`✓ ${file.split('/').pop()}  ${Math.round(clip.width)}×${Math.round(clip.height)}  ${stdout.trim().split(/\s+/)[4]}`)
  }
} finally {
  cdp?.close()
  child.kill('SIGTERM')
}
