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

import { closeDesk, deskInUse, dismissNotices, launchDesk, seat, sleep, STORE } from '../lib/desk.mjs'
import { ACCOUNTS, ANONYMOUS, VOUCHED } from './accounts.mjs'
import { TILDIFY, USER, refuseUnpublishable, refuseUnvouchedAccounts } from './audit.mjs'
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

  /* The same stubs the stills use — a recording leaks exactly as much as a
     photograph does, and for longer. The accounts matter more here than they
     do there: a still is audited before it is written and a GIF cannot be,
     so for a recording the answer *is* the protection. */
  await cdp.eval(
    `(() => {
      const s = ${STORE}
      if (s.__shotsPatched) return true
      const real = s.transport.request.bind(s.transport)
      const canned = { 'usage/reports': ${q(USAGE)}, 'usage/ledger': ${q(LEDGER)}, 'usage/scan': ${q(SCAN)} }
      const accounts = ${q(ACCOUNTS)}
      const anonymous = ${q(ANONYMOUS)}
      s.transport.request = (m, p) =>
        m === 'runtime/account'
          ? Promise.resolve(accounts[p?.runtime] ?? anonymous)
          : m in canned
            ? Promise.resolve(canned[m])
            : real(m, p)
      s.__shotsPatched = true
      return true
    })()`,
    60_000,
  )
  /* Asked again, because the window asked first: see `stageAnswers` in
     shoot.mjs. No longer swallowed — a rename or a dead renderer should stop
     the take rather than be ignored — but that is the smaller half. Neither
     verb can fail loudly: both catch every request they make, and both return
     early and silently when a later pass overtook them, having patched
     nothing. What the recording is actually held up by is the gate below,
     which reads the answers back. */
  await cdp.eval(`${STORE}.loadAccounts()`, 60_000)
  await cdp.eval(`${STORE}.refreshRuntime({ history: false })`, 60_000)
  await cdp.eval(`${STORE}.setTheme(${q(THEME)}); true`)
  await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
  await sleep(1200)

  const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
  await sleep(1200)

  /* Hide this machine's home before a single frame is taken, not after: a GIF
     cannot be audited frame by frame the way a still can, so the substitution
     has to be in place for the whole recording. The stills' copy of this
     walked `[title]` and this one did not, which left a tooltip carrying the
     real home standing through the take that has no frame-by-frame backstop.
     One copy now, in `audit.mjs`. */
  await cdp.eval(TILDIFY(homedir()))

  const frames = []
  const collected = []
  /* Acknowledge every frame. Chromium stops sending once a few are
     outstanding, so a cast that is never acked delivers about three frames
     and then goes quiet — which looks exactly like a still app. */
  cdp.on('Page.screencastFrame', (params) => {
    collected.push(params)
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })

  /**
   * Refused before it is recorded, not after.
   *
   * A GIF cannot be audited frame by frame, so the check has to happen where
   * it still means something. This is that point, and it is the load-bearing
   * one: nothing has been captured and nothing has been written, so a refusal
   * here costs a launch. The two later gates cost a take. Optimising for the
   * early refusal is why the full audit runs here and only the account half
   * runs during the recording.
   */
  await refuseUnpublishable(cdp, { name: NAME, user: USER, vouched: VOUCHED, subject: 'recording' })

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 })
  const startedAt = Date.now()
  await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
  /* The same nine seconds, asked six times instead of slept through. The one
     door neither bracket can see is the middle of the take — a second account
     slot, an agent registered from the interface — and it is an account door,
     so this is the account half only. It reads the store and touches no DOM:
     sweeping every `[title]` six times during a screencast would record the
     jank into the artifact. */
  for (let sample = 0; sample < 6; sample += 1) {
    await sleep(1500)
    await refuseUnvouchedAccounts(cdp, { name: NAME, vouched: VOUCHED })
  }
  await cdp.send('Page.stopScreencast')

  /* And once more before a single frame reaches the disk. Account state can
     change mid-take, and the frames are written below — so this is the last
     moment at which refusing still costs nothing but the take. */
  await refuseUnpublishable(cdp, { name: NAME, user: USER, vouched: VOUCHED, subject: 'recording' })

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
