#!/usr/bin/env node
/**
 * The README's two story GIFs: two agents working a room together, and a
 * flow running end to end.
 *
 * Same recording approach as `gif.mjs` — the real renderer, over the
 * DevTools screencast, against the staged desk `seed.mjs` builds — extended
 * to a scene with more than one beat. Where `gif.mjs` captures one turn
 * landing, this captures a short story: several `sleep`-separated beats,
 * each one advancing the room or the flow, all under one continuous
 * recording so the cuts between them are real elapsed time rather than a
 * splice.
 *
 * HarnessDesk never shows two conversation panes at once (an explicit
 * product rule) — so "two agents on one piece of work" is the Room itself
 * (`openTeamRoom`), which already draws every seat's attributed turn in one
 * feed, beside a *docked, non-conversation* pane: the browser, popping open
 * on the right the way `shoot.mjs`'s own `browser` scene does.
 *
 *   node script/shots/gif2.mjs --scenario hero --theme light
 *   node script/shots/gif2.mjs --scenario flow --theme dark
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { answerApprovals, closeDesk, deskInUse, dismissNotices, launchDesk, seat, sleep, STORE } from '../lib/desk.mjs'
import { RUNTIME_ACCOUNTS as ACCOUNTS, ANONYMOUS, VOUCHED } from './accounts.mjs'
import { TILDIFY, USER, refuseUnpublishable, refuseUnvouchedAccounts } from './audit.mjs'
import { REPOS, rigRuntimeId } from './cast.mjs'
import { HOME, NATIVE_CODEX, WORK, SHOT_ENV, requireSeeded } from './config.mjs'
import { startStaticServer } from './static-server.mjs'
import { LEDGER, SCAN, USAGE } from './usage.mjs'

const run = promisify(execFile)
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback
}

const SCENARIO = flag('scenario', 'hero')
const OUT = resolve(flag('out', `${APP}/docs/images/app`))
const THEME = flag('theme', 'light')
const NAME = flag('name', `${SCENARIO}-${THEME}`)
const WIDTH = Number(flag('width', '1280'))
const HEIGHT = Number(flag('height', '800'))
const FPS = Number(flag('fps', '13'))
const REPO = join(WORK, REPOS[0].dir)

/** `shoot.mjs`'s own `FLOW` (its `flow-board`/`flow` scenes), verbatim — one fixer, three reviewers, the merge stays the person's own. */
const FLOW = `name: Fix and review
description: One fixer, three reviewers, and the merge stays yours.

inputs:
  work:
    label: What to fix

roles:
  fixer:
    kind: agent
    seat: ${NATIVE_CODEX ? `${rigRuntimeId('claude-code')}=opus` : 'codex=gpt-5.6-sol'}
    permission: publish
    outcomes: [published, cannot]
    order: |
      Make the change, run the tests, and open a pull request for it.
  reviewer:
    kind: agent
    seat: ${rigRuntimeId('cursor')}=gemini-3.8-flash
    count: 3
    permission: read
    outcomes: [approve, request-changes]
    order: |
      Review the pull request on your own. Approve only if you would merge it.
  referee:
    kind: person
    outcomes: [merged, dropped]

seed:
  role: fixer
  title: "{{work}}"

rules:
  - id: review-it
    on: fixer
    when: { every: published }
    then:
      role: reviewer
      title: "Review round {{round}} — {{n}} of {{count}}"
      detail: |
        Review the pull request the fixer's context package names. You are one
        of {{count}} reviewers and will not see the others' answers.
  - id: fix-again
    on: reviewer
    when: { any: request-changes }
    then: { role: fixer, title: "Answer round {{round}}'s reviews" }
  - id: hand-to-the-person
    on: reviewer
    when: { every: approve }
    then: { role: referee, title: "Merge it — every reviewer approved" }
`
const FRAMES = join(HOME, 'frames')
const say = (line) => process.stdout.write(`  ${line}\n`)
const q = (value) => JSON.stringify(value)

requireSeeded()

const busy = await deskInUse(HOME)
if (busy) {
  process.stderr.write(`\n  A desk is already open on ${HOME} (pid ${busy}). Quit it first.\n\n`)
  process.exit(1)
}

rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
mkdirSync(OUT, { recursive: true })
say(`scenario ${SCENARIO}`)
say(`theme  ${THEME}`)
say(`frame  ${WIDTH}x${HEIGHT} @${FPS}fps`)

const desk = await launchDesk({ app: APP, home: HOME, userDataDir: `${HOME}/electron`, logPath: `${HOME}/app.log`, env: SHOT_ENV })
const { cdp } = desk
let browserServer = null

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  await dismissNotices(cdp).catch(() => {})

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
  await cdp.eval(`${STORE}.loadAccounts()`, 60_000)
  await cdp.eval(`${STORE}.refreshRuntime({ history: false })`, 60_000)
  await cdp.eval(`${STORE}.setNoticeMuted('usage:pace', true); ${STORE}.setNoticeMuted('usage:spent', true); true`).catch(() => {})
  await cdp.eval(`${STORE}.setTheme(${q(THEME)}); true`)
  await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
  await sleep(1200)
  await dismissNotices(cdp)
  await cdp.eval(`${STORE}.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }); true`)
  await sleep(300)

  /**
   * Re-applied after every beat that can add fresh `[title]`/`[placeholder]`
   * elements (a new seat, a new pane) — `TILDIFY` rewrites the DOM as it is
   * at the moment it runs, not continuously, and a GIF's own later beats add
   * elements no earlier call ever saw.
   */
  const retildify = async () => {
    await cdp.eval(TILDIFY(homedir()))
    await cdp.eval(TILDIFY(dirname(WORK)))
    await cdp.eval(TILDIFY(HOME, '~/.harnessdesk'))
  }
  await retildify()

  const frames = []
  const collected = []
  cdp.on('Page.screencastFrame', (params) => {
    collected.push(params)
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })

  await refuseUnpublishable(cdp, { name: NAME, user: USER, vouched: VOUCHED, roots: REPOS.map(repo => join(WORK, repo.dir)), nativeCodex: NATIVE_CODEX, subject: 'recording' })

  const startedAt = Date.now()
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 })

  if (SCENARIO === 'hero') {
    // HarnessDesk never shows two conversation panes at once, so "two
    // agents' conversations side by side" is adapted rather than shown
    // literally: one real conversation (Claude, builder) streams its turn
    // in the main pane — reasoning, three tool calls, and a summary that
    // itself names the hand-off ("I have left retry.test.ts alone — #3 is
    // claimed") — and the browser, a *docked, non-conversation* pane, pops
    // open beside it the way `shoot.mjs`'s own `browser` scene does,
    // standing in for the tester picking the change up and checking it.
    //
    // Beat 1: the builder's turn streams — `agent.mjs`'s own `TURNS[0]`,
    // played for real over ACP.
    const key = await seat(cdp, { work: REPO, runtime: rigRuntimeId('claude-code'), picks: {} })
    await sleep(600)
    await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
    await sleep(10_000)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 2: the browser pane pops open — the storefront the room is
    // hardening, checked over the rig's own loopback server, never a
    // `file://` URL.
    const browseDir = join(WORK, 'browse')
    mkdirSync(browseDir, { recursive: true })
    writeFileSync(join(browseDir, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>Storefront checkout</title>
<style>
  body{font:16px/1.5 system-ui;margin:0;padding:4rem;color:#1a2233;background:#f7f9fc}
  h1{font-size:1.75rem;margin:0 0 .5rem}
  .ok{display:inline-flex;align-items:center;gap:.5rem;color:#166534;background:#dcfce7;padding:.5rem 1rem;border-radius:999px;font-weight:600}
</style>
<h1>Checkout</h1>
<p class="ok">✓ Order placed — the 502 retried and checkout completed.</p>`)
    browserServer = await startStaticServer(browseDir)
    await cdp.eval(`${STORE}.openBrowser(${q(`${browserServer.url}/index.html`)}); true`)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const title = await cdp.eval(`document.querySelector('webview')?.getTitle?.() ?? ''`).catch(() => '')
      if (title === 'Storefront checkout') break
      await sleep(100)
    }
    await sleep(2500)
    await answerApprovals(cdp).catch(() => {})
    await retildify()
    // Hold the settled frame — both the room's turns and the open browser —
    // for a beat before the loop restarts.
    await sleep(2000)
  } else if (SCENARIO === 'flow') {
    // Driven through the host's own verbs — `stageFlow`/`FLOW` and the
    // round sequence are `shoot.mjs`'s own `flow-board` scene, known to
    // work, rather than a second attempt at the same thing through the New
    // Goal dialog's own radiogroup (fragile to reach by keyboard alone).
    mkdirSync(join(REPO, '.harnessdesk', 'flows'), { recursive: true })
    writeFileSync(join(REPO, '.harnessdesk', 'flows', 'fix-and-review.yml'), FLOW)
    const room = await cdp.eval(
      `${STORE}.createGoal({ root: ${q(REPO)}, sentence: 'Checkout hardening' }).then((view) => view.goal.id)`,
      60_000,
    )
    await cdp.eval(`${STORE}.openGoal(${q(room)}); true`)
    await sleep(1500)

    // Beat 1: the flow starts — the dry run's own trace, the fixer's card
    // seated and working.
    const source = await cdp.eval(`${STORE}.readFlow(${q(REPO)}, '.harnessdesk/flows/fix-and-review.yml')`, 60_000)
    await cdp.eval(
      `${STORE}.startFlow(${q(room)}, ${q(source)}, { path: '.harnessdesk/flows/fix-and-review.yml', vars: { work: 'Retry the checkout call on a 502' } })`,
      180_000,
    )
    await sleep(3000)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 2: the expanded board — the fixer's card, then its answer opens
    // the review round: three reviewer cards.
    await cdp.eval(`${STORE}.openTeamBoard(${q(room)}); true`)
    await cdp.eval(`${STORE}.zoomPanel('right', 'content'); true`)
    await sleep(1500)
    await cdp.eval(
      `${STORE}.teamIntent(${q(room)}, 1, 'done', undefined, 'published', 'Opened #482 on fix/checkout-retry-502.')`,
      60_000,
    ).catch(() => {})
    await sleep(2500)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 3: the loop — one reviewer requests changes, the fixer answers,
    // a second round opens and every reviewer approves.
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 2, 'done', undefined, 'request-changes', 'The 502 case is untested.')`, 60_000).catch(() => {})
    await sleep(1800)
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 3, 'done', undefined, 'approve')`, 60_000).catch(() => {})
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 4, 'done', undefined, 'approve')`, 60_000).catch(() => {})
    await sleep(2200)
    await answerApprovals(cdp).catch(() => {})
    await retildify()
    await cdp.eval(
      `${STORE}.teamIntent(${q(room)}, 5, 'done', undefined, 'published', 'Added the missing 502 case; both rounds pass now.')`,
      60_000,
    ).catch(() => {})
    await sleep(2500)
    await answerApprovals(cdp).catch(() => {})
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 6, 'done', undefined, 'approve')`, 60_000).catch(() => {})
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 7, 'done', undefined, 'approve')`, 60_000).catch(() => {})
    await cdp.eval(`${STORE}.teamIntent(${q(room)}, 8, 'done', undefined, 'approve')`, 60_000).catch(() => {})
    await sleep(2500)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 4: settled — every reviewer approved, so the goal lands on
    // "Needs you" for the person's own merge. Held for the loop's final beat.
    await sleep(2500)
  } else {
    throw new Error(`unknown --scenario ${q(SCENARIO)}`)
  }

  await cdp.send('Page.stopScreencast')
  await refuseUnpublishable(cdp, {
    name: NAME, user: USER, vouched: VOUCHED, roots: REPOS.map(repo => join(WORK, repo.dir)), nativeCodex: NATIVE_CODEX,
    rigOrigin: browserServer?.url ?? null, subject: 'recording',
  })

  say(`frames ${collected.length}`)
  if (collected.length === 0) throw new Error('the screencast delivered no frames')

  for (const [n, params] of collected.entries()) {
    writeFileSync(join(FRAMES, `f${String(n).padStart(4, '0')}.jpg`), Buffer.from(params.data, 'base64'))
    frames.push({ file: `f${String(n).padStart(4, '0')}.jpg`, at: params.metadata?.timestamp ?? null })
  }

  const lines = []
  for (const [n, frame] of frames.entries()) {
    const next = frames[n + 1]
    const seconds = next && frame.at && next.at ? Math.max(0.02, next.at - frame.at) : 2.2
    lines.push(`file '${frame.file}'`, `duration ${seconds.toFixed(3)}`)
  }
  lines.push(`file '${frames[frames.length - 1].file}'`)
  writeFileSync(join(FRAMES, 'list.txt'), `${lines.join('\n')}\n`)

  const gif = join(OUT, `${NAME}.gif`)
  const palette = join(FRAMES, 'palette.png')
  // The presentation frame's own padding/backdrop, applied as a video
  // filter rather than per-frame in ImageMagick (hundreds of raw frames):
  // `pad` centres the recorded window on the backdrop colour before the
  // palette is built, so every frame of the GIF carries it, not only the
  // stills' own `frame.mjs` pass. Corner rounding and the drop shadow are
  // `frame.mjs`'s alone — expensive per frame and, on a moving image,
  // unnecessary: the backdrop and the margin are what make a GIF and a
  // still read as one set.
  //
  // Straight off the concat-demuxed JPEGs, the same as `gif.mjs`'s own
  // pipeline — not through an intermediate `.mp4`: piping the screencast's
  // full-range JPEGs (`yuvj420p`) through an interim H.264 encode left its
  // *later* frames reading as their own colours inverted toward light once
  // `palettegen`/`paletteuse` ran over them (a real-range mismatch between
  // the intermediate's tagged colour range and what the palette filters
  // assumed), invisible in the raw frames and in the encode's own log, only
  // in the finished GIF. One fewer encode is also one fewer thing to get
  // half right.
  const backdrop = THEME === 'dark' ? '0x0b0b0d' : '0xe9e9e7'
  const pad = 48
  const scaledWidth = Math.round(WIDTH * 0.94)
  const padFilter = `fps=${FPS},scale=${scaledWidth}:-1:flags=lanczos,pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:${backdrop}`
  await run('ffmpeg', ['-y', '-f', 'concat', '-i', 'list.txt', '-vf', `${padFilter},palettegen=max_colors=160:stats_mode=diff`, palette], { cwd: FRAMES })
  await run(
    'ffmpeg',
    ['-y', '-f', 'concat', '-i', 'list.txt', '-i', palette, '-lavfi', `${padFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', gif],
    { cwd: FRAMES },
  )

  const { stdout } = await run('/bin/ls', ['-lh', gif])
  say(`✓ ${NAME}.gif  ${stdout.trim().split(/\s+/)[4]}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s of app)`)
} finally {
  await browserServer?.close().catch(() => {})
  await closeDesk(desk).catch(() => {})
}
