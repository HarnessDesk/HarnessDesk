#!/usr/bin/env node
/**
 * Record a turn arriving, as a GIF.
 *
 * A still says what the app looks like; only movement says what it is like to
 * use. The thing worth showing is a turn landing — reasoning first, then the
 * tool calls one at a time, the plan ticking over, and the summary at the end —
 * because that pacing is the product and a screenshot flattens it into a list.
 *
 * Recorded off the real renderer through the DevTools screencast, against the
 * same staged desk `seed.mjs` builds, so nothing here is a mock-up and nothing
 * here is anybody's real work.
 *
 * Two things worth knowing before changing it:
 *
 *  - **The screencast only emits on pixel change.** That is a gift here — a
 *    streaming turn changes pixels constantly — but it means the frames are
 *    unevenly spaced, so each one has to be held for its own real duration.
 *  - **Never floor a frame at `1/fps`.** During a burst frames arrive
 *    milliseconds apart, and rounding each up stretches the take. The concat
 *    demuxer is given true durations and `fps` resamples.
 *
 *   node script/shots/gif.mjs                  # docs/images/app/turn.gif
 *   node script/shots/gif.mjs --theme dark
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { closeDesk, deskInUse, dismissNotices, launchDesk, seat, sleep, STORE } from '../review/lib/desk.mjs'
import { REPOS } from './cast.mjs'
import { HOME, WORK } from './seed.mjs'
import { LEDGER, SCAN, USAGE } from './usage.mjs'

const run = promisify(execFile)
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback
}

const OUT = resolve(flag('out', `${APP}/docs/images/app`))
const THEME = flag('theme', 'light')
const NAME = flag('name', `turn-${THEME}`)
/* 1x, not retina: a GIF has no use for the extra pixels and every one of them
   is paid for in file size, which is the whole difficulty with this format. */
const WIDTH = Number(flag('width', '1280'))
const HEIGHT = Number(flag('height', '800'))
const FPS = Number(flag('fps', '10'))
const REPO = join(WORK, REPOS[0].dir)
const FRAMES = join(HOME, 'frames')
const say = (line) => process.stdout.write(`  ${line}\n`)
const q = (value) => JSON.stringify(value)

const busy = await deskInUse(HOME)
if (busy) {
  process.stderr.write(`\n  A desk is already open on ${HOME} (pid ${busy}). Quit it first.\n\n`)
  process.exit(1)
}

rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
mkdirSync(OUT, { recursive: true })
say(`theme  ${THEME}`)
say(`frame  ${WIDTH}x${HEIGHT} @${FPS}fps`)

const desk = await launchDesk({
  app: APP,
  home: HOME,
  port: 9760 + Math.floor(Math.random() * 60),
  userDataDir: `${HOME}/electron`,
  logPath: `${HOME}/app.log`,
})
const { cdp } = desk

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  await dismissNotices(cdp).catch(() => {})

  // The same money stubs the stills use — a recording leaks exactly as much as
  // a photograph does, and for longer.
  await cdp.eval(
    `(() => {
      const s = ${STORE}
      if (s.__shotsPatched) return true
      const real = s.transport.request.bind(s.transport)
      const canned = { 'usage/reports': ${q(USAGE)}, 'usage/ledger': ${q(LEDGER)}, 'usage/scan': ${q(SCAN)} }
      s.transport.request = (m, p) => (m in canned ? Promise.resolve(canned[m]) : real(m, p))
      s.__shotsPatched = true
      return true
    })()`,
    60_000,
  )
  await cdp.eval(`${STORE}.setTheme(${q(THEME)}); true`)
  await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
  await sleep(1200)

  const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
  await sleep(1200)

  /* Hide this machine's home before a single frame is taken, not after: a GIF
     cannot be audited frame by frame the way a still can, so the substitution
     has to be in place for the whole recording. */
  const tildify = `(() => {
    const home = ${q(homedir())}
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) {
      if (node.nodeValue?.includes(home)) node.nodeValue = node.nodeValue.split(home).join('~')
    }
    return true
  })()`
  await cdp.eval(tildify)

  const frames = []
  const collected = []
  /* Acknowledge every frame. Chromium stops sending once a few are
     outstanding, so a cast that is never acked delivers about three frames
     and then goes quiet — which looks exactly like a still app. */
  cdp.on('Page.screencastFrame', (params) => {
    collected.push(params)
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 })
  const startedAt = Date.now()
  await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
  await sleep(9000)
  await cdp.send('Page.stopScreencast')

  say(`frames ${collected.length}`)
  if (collected.length === 0) throw new Error('the screencast delivered no frames')

  for (const [n, params] of collected.entries()) {
    writeFileSync(join(FRAMES, `f${String(n).padStart(4, '0')}.jpg`), Buffer.from(params.data, 'base64'))
    frames.push({ file: `f${String(n).padStart(4, '0')}.jpg`, at: params.metadata?.timestamp ?? null })
  }

  /* True durations, from the frames' own timestamps. The last one is held for
     a beat so the finished turn is readable before the loop restarts. */
  const lines = []
  for (const [n, frame] of frames.entries()) {
    const next = frames[n + 1]
    const seconds = next && frame.at && next.at ? Math.max(0.02, next.at - frame.at) : 2.2
    lines.push(`file '${frame.file}'`, `duration ${seconds.toFixed(3)}`)
  }
  lines.push(`file '${frames[frames.length - 1].file}'`)
  writeFileSync(join(FRAMES, 'list.txt'), `${lines.join('\n')}\n`)

  /* Two passes: a palette built from the whole clip, then applied. One pass
     with the default 256-colour heuristic bands every gradient in the window,
     and the app is mostly gradients of one grey. */
  const gif = join(OUT, `${NAME}.gif`)
  const palette = join(FRAMES, 'palette.png')
  const scale = `fps=${FPS},scale=${Math.round(WIDTH * 0.72)}:-1:flags=lanczos`
  await run('ffmpeg', ['-y', '-f', 'concat', '-i', 'list.txt', '-vf', `${scale},palettegen=max_colors=160:stats_mode=diff`, palette], { cwd: FRAMES })
  await run(
    'ffmpeg',
    ['-y', '-f', 'concat', '-i', 'list.txt', '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', gif],
    { cwd: FRAMES },
  )

  const { stdout } = await run('/bin/ls', ['-lh', gif])
  say(`✓ ${NAME}.gif  ${stdout.trim().split(/\s+/)[4]}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s of app)`)
} finally {
  await closeDesk(desk).catch(() => {})
}
