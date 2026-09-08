#!/usr/bin/env node
/**
 * The 1280×640 card GitHub shows when a link to this repository is shared.
 *
 * There is exactly one of these, and it cannot be a light/dark pair. The card
 * becomes `og:image` — a static URL in a meta tag that Slack, X, Discord,
 * iMessage and Google fetch **server-side, once**, with no viewer and no
 * theme to ask about. The README's `<picture>` works because a real browser
 * evaluates the media query at draw time; nothing in Open Graph has that
 * mechanism. So: one image, opaque, and it has to hold on a light surface and
 * a dark one. Dark, because the product is dark and a dark rectangle reads as
 * deliberate on both.
 *
 * The card is assembled here rather than by hand because the alternative was a
 * paragraph of prose telling somebody to re-render it in headless Chrome and
 * crop — which is a generated artifact with no generator, and drifts the first
 * time a screenshot is re-shot.
 *
 * Everything is inlined as base64: the card must render with no network and no
 * font to install, because the machine that renders it next may be neither
 * this one nor online.
 *
 *   node script/social-preview.mjs
 */
import { execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Cdp } from './review/lib/desk.mjs'

const run = promisify(execFile)
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9793
const WIDTH = 1280
const HEIGHT = 640
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (line) => process.stdout.write(`  ${line}\n`)

const HTML = join(APP, 'assets/brand/social-preview.src.html')
const PNG = join(APP, 'assets/brand/social-preview.png')

/** A file as a `data:` URL, so the page has nothing to fetch. */
const inline = (path, mime) =>
  `data:${mime};base64,${readFileSync(join(APP, path)).toString('base64')}`

const shot = inline('docs/images/app/board-dark.png', 'image/png')
const wordmark = inline('assets/brand/svgs/harnessdesk-icon-white-transparent.svg', 'image/svg+xml')
/* The bare strip, not the labelled one the README uses. At the width a link
   unfurl actually gives this card — about a third of its own 1280 — ten names
   at 10.5px are illegible smears rather than information. `agent-marks.mjs`
   writes both. */
const marks = inline('docs/images/agents-bare-dark.svg', 'image/svg+xml')

const html = `<!doctype html><meta charset=utf-8>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{background:#0d1117;color:#e6edf3;position:relative;
    font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  /* The screenshot is texture, not something to read: it sits behind
     everything, bleeds off both right and bottom, and is dissolved by the wash
     below. At the size this card is seen it reads as "an application", which
     is all it is being asked to say. */
  .shot{position:absolute;top:96px;left:620px;width:900px;border-radius:14px;
    border:1px solid rgba(255,255,255,.10);box-shadow:0 30px 90px rgba(0,0,0,.7)}
  .wash{position:absolute;inset:0;background:
    linear-gradient(96deg,#0d1117 0%,#0d1117 40%,rgba(13,17,23,.86) 55%,rgba(13,17,23,.35) 78%,rgba(13,17,23,.2) 100%),
    linear-gradient(0deg,#0d1117 0%,rgba(13,17,23,0) 26%)}
  .fg{position:absolute;inset:0;padding:66px 0 62px 66px;
    display:flex;flex-direction:column;justify-content:space-between}
  .mark{display:flex;align-items:center;gap:16px}
  .mark img{width:54px;height:54px}
  .mark b{font-size:35px;font-weight:600;letter-spacing:-.022em}
  h1{font-size:52px;line-height:1.08;font-weight:600;letter-spacing:-.028em;
    margin:30px 0 18px;max-width:13ch}
  p{font-size:20px;color:#adb5bd;max-width:33ch;line-height:1.45}
  /* No "Works with" eyebrow. At 11.5px it is four pixels tall in an unfurl —
     it cannot be read, and a row of vendor marks along the foot of a card
     already says what it would have said. */
  .agents img{width:560px;opacity:.92;display:block}
</style>
<img class=shot src="${shot}">
<div class=wash></div>
<div class=fg>
  <div>
    <div class=mark><img src="${wordmark}"><b>HarnessDesk</b></div>
    <h1>Where your agents work — whoever made them.</h1>
    <p>A control plane for coding agents that you own. One history, one policy, one audit log.</p>
  </div>
  <div class=agents><img src="${marks}"></div>
</div>
`

writeFileSync(HTML, html)
say(`✓ social-preview.src.html  ${(html.length / 1024).toFixed(0)}KB`)

let cdp = null
const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--hide-scrollbars',
    '--user-data-dir=/tmp/hd-social-preview',
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

  cdp = await Cdp.open(page.webSocketDebuggerUrl)
  const send = (method, params = {}) => cdp.send(method, params, 60_000)

  await send('Page.enable')
  /* 2× for the same reason the diagrams are shot at 2×: GitHub serves this
     card to retina displays, and an upscaled 1280 is visibly soft. */
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await send('Page.navigate', { url: `file://${HTML}` })
  await sleep(2500)

  /* The card is built at exactly 1280×640, so the viewport *is* the crop and
     there is nothing to trim afterwards.
     
     The body deliberately overflows — the screenshot bleeds off the right and
     the bottom — so the body's own extent says nothing. What must fit is the
     foreground: wordmark, headline, subhead, marks. This fails if the headline
     ever wraps to another line or the strip grows, which is exactly the change
     that would otherwise ship as a card with its logos sliced off. */
  const box = await send('Runtime.evaluate', {
    expression: `(() => {
      const fg = document.querySelector('.fg')
      return JSON.stringify({ content: fg.scrollHeight, frame: fg.clientHeight })
    })()`,
    returnByValue: true,
  })
  const { content, frame } = JSON.parse(box.result.value)
  if (content > frame) throw new Error(`the foreground needs ${content}px and the card is ${frame}px tall`)

  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(PNG, Buffer.from(data, 'base64'))

  const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', PNG])
  const px = stdout.match(/pixel(?:Width|Height): (\d+)/g)?.map((m) => Number(m.split(': ')[1]))
  /* 2× of the design size, or the viewport override did not take and the card
     is soft. GitHub accepts it either way and says nothing. */
  if (px?.[0] !== WIDTH * 2 || px?.[1] !== HEIGHT * 2)
    throw new Error(`captured ${px?.join('×')}, wanted ${WIDTH * 2}×${HEIGHT * 2}`)
  const { stdout: ls } = await run('/bin/ls', ['-lh', PNG])
  say(`✓ social-preview.png  ${px.join('×')} (2× of ${WIDTH}×${HEIGHT})  ${ls.trim().split(/\s+/)[4]}`)
} finally {
  cdp?.close()
  child.kill('SIGTERM')
}
