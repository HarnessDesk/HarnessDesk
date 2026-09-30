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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { answerApprovals, closeDesk, deskInUse, dismissNotices, launchDesk, seat, sleep, STORE, waitForSnapshot } from '../lib/desk.mjs'
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

/**
 * `shoot.mjs`'s own `FLOW` (its `flow-board`/`flow` scenes), with two
 * changes for this GIF: the fixer is Codex over the camera row whenever
 * `HD_SHOTS_NATIVE_CODEX=0` is set for this recording (so its name is
 * "Codex", never the native adapter this rig otherwise prefers), and the
 * reviewer role names three *different* runtimes instead of one runtime
 * three times — `seat:` takes a list, one per card of the round — so the
 * three reviewer seats read as three distinguishable agents rather than
 * "Cursor" repeated three times.
 */
const FLOW = `name: Fix and review
description: One fixer, three reviewers, and the merge stays yours.

inputs:
  work:
    label: What to fix

roles:
  fixer:
    kind: agent
    seat: ${NATIVE_CODEX ? `${rigRuntimeId('claude-code')}=opus` : `${rigRuntimeId('codex')}=gpt-5.6-sol`}
    permission: publish
    outcomes: [published, cannot]
    order: |
      Make the change, run the tests, and open a pull request for it.
  reviewer:
    kind: agent
    seat: [${rigRuntimeId('cursor')}=gemini-3.8-flash, ${rigRuntimeId('claude-code')}=sonnet, ${rigRuntimeId('gemini-cli')}=gemini-3.8-pro]
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

/**
 * `hero` plays two agents through turns `seed.mjs`'s own `ROOM_TURN` never
 * assigns them — Claude's fix ending with a real hand-off to Codex, and
 * Codex's own end-to-end check — so this patches `agents.json` (read once,
 * when `launchDesk` below starts the app) rather than touching that shared
 * mapping, which every other scene's `board`/`room` still needs at its
 * default. `TURNS[4,6]`/`TURNS[5]` are `agent.mjs`'s own; see its own
 * comment for what each plays.
 */
if (SCENARIO === 'hero' || SCENARIO === 'flow') {
  const agentsPath = join(HOME, 'agents.json')
  const roster = JSON.parse(readFileSync(agentsPath, 'utf8'))
  for (const agent of roster.agents) {
    if (SCENARIO === 'hero') {
      if (agent.id === rigRuntimeId('claude-code')) agent.env.SHOT_TURN = '7,7,4,6'
      if (agent.id === rigRuntimeId('claude-code')) agent.env.SHOT_ROOM_MESSAGE = JSON.stringify({
        to: 'Codex', onTurn: 2,
        text: '502 is retryable alongside 503 and 504 now, with exponential backoff capped at 2s and full jitter (`src/checkout/retry.ts`). Codex — can you check checkout end to end in the browser?',
      })
      if (agent.id === rigRuntimeId('codex')) agent.env.SHOT_TURN = '8,8,5'
    } else {
      delete agent.env.SHOT_CLAIM
      const flow = (outcomes, delayMs) => JSON.stringify({
        outcomes, delayMs, files: ['src/checkout/retry.ts'], state: join(HOME, 'flow-passes', `${agent.id}.json`),
      })
      if (agent.id === rigRuntimeId('codex')) agent.env.SHOT_FLOW = flow(['published', 'published'], 4800)
      if (agent.id === rigRuntimeId('cursor')) agent.env.SHOT_FLOW = flow(['request-changes', 'approve'], 4200)
      if (agent.id === rigRuntimeId('claude-code')) agent.env.SHOT_FLOW = flow(['approve', 'approve'], 4200)
      if (agent.id === rigRuntimeId('gemini-cli')) agent.env.SHOT_FLOW = flow(['approve', 'approve'], 4200)
    }
  }
  mkdirSync(join(HOME, 'flow-passes'), { recursive: true })
  writeFileSync(agentsPath, `${JSON.stringify(roster, null, 2)}\n`)
  say(SCENARIO === 'hero'
    ? 'patched agents.json: Claude plays context, fix, then acknowledgement; Codex plays the browser check'
    : 'patched agents.json: the flow seats claim and complete their own cards through MCP')
}

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
  const followRoomChat = () =>
    cdp.eval(`(() => {
      const stream = document.querySelector('[data-slot="room-stream"]')
      if (!stream) return false
      stream.scrollTop = stream.scrollHeight
      stream.dispatchEvent(new Event('scroll', { bubbles: true }))
      return true
    })()`)
  await retildify()

  /**
   * Click by what it says, not by where it is — `shoot.mjs`'s own `click`,
   * copied rather than imported: it is a closure over that file's own `cdp`
   * and never exported, and this file needs exactly one thing from it (the
   * `flow` scenario's own dialog) rather than a shared refactor neither
   * scenario otherwise asks for.
   */
  const click = async (text, within = null, { wait = 4000 } = {}) => {
    const find = () =>
      cdp.json(
        `(() => {
        const scope = ${within ? `document.querySelector(${q(within)})` : 'document'}
        if (!scope) return false
        const wanted = ${q(text)}
        const all = [...scope.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], li, summary')]
        const hits = all.filter((e) => {
          if (!((e.textContent ?? '').trim().startsWith(wanted) || e.getAttribute('aria-label') === wanted)) return false
          if (e.matches(':disabled, [aria-disabled="true"]')) return false
          if (e.closest('[aria-hidden="true"], [inert]')) return false
          const rect = e.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
        const el = hits.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
        if (!el) return false
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = el.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`,
      )
    let hit = await find()
    for (let waited = 0; !hit && waited < wait; waited += 200) {
      await sleep(200)
      hit = await find()
    }
    if (hit) {
      await sleep(200)
      hit = await find()
    }
    if (hit) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hit })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...hit, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...hit, button: 'left', clickCount: 1 })
    }
    await sleep(700)
    return Boolean(hit)
  }

  /** Types into an input found by its label — `shoot.mjs`'s own `fill`, copied for the same reason as `click`. */
  const fill = (label, value) =>
    cdp.eval(`(() => {
    const tag = [...document.querySelectorAll('label')].find((one) => one.textContent.trim() === ${q(label)})
    let input = (tag && document.getElementById(tag.getAttribute('for'))) || document.querySelector('[aria-label=' + JSON.stringify(${q(label)}) + ']')
    if (!input) input = [...document.querySelectorAll('input, textarea')].find((one) => one !== document.querySelector('[aria-label="What finishes this?"]'))
    if (!input) return false
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${q(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // Staged before the camera starts, so the recording opens on settled state
  // rather than on the room or the flow file coming into being — an empty
  // room, or a catalogue with nothing in it yet, is not the beat either GIF
  // is meant to show.
  let room = null
  if (SCENARIO === 'hero') {
    // The room itself, opened ahead of the camera — `team/post` refuses a
    // room with no members yet ("This room has no members yet. Add one from
    // the roster.", drawn as a visible red chip on the post), so the two
    // context lines below cannot land until *some* seat exists. They are
    // posted the moment Claude is kept, before its own turn has streamed
    // anything — see the recorded beats below.
    room = await cdp.eval(
      `${STORE}.createGoal({ root: ${q(REPO)}, sentence: 'Checkout hardening' }).then((view) => view.goal.id)`,
      60_000,
    )
    await cdp.eval(`${STORE}.openTeamRoom(${q(room)}); true`)
    await sleep(1200)
    await dismissNotices(cdp).catch(() => {})
    await retildify()
  } else if (SCENARIO === 'flow') {
    // The shape itself, written before the New Goal dialog ever opens: a
    // project-local `.harnessdesk/flows` entry is exactly what the "Start a
    // team" catalogue reads (`packages/server/src/flow-catalog.ts`), the same
    // way the shipped "Independent review" shape reaches `front-door`'s own
    // dialog in `shoot.mjs` — so "Fix and review" is a real catalogue row,
    // not a room the dialog is skipped past.
    mkdirSync(join(REPO, '.harnessdesk', 'flows'), { recursive: true })
    writeFileSync(join(REPO, '.harnessdesk', 'flows', 'fix-and-review.yml'), FLOW)
  }

  /**
   * A named room seat starts its standing-order turn as it is kept.  Later
   * prompts are safe only once every member is idle: ACP deliberately rejects
   * a second prompt instead of queueing it.  Keeping that wait in one helper
   * makes the hero's follow-up and acknowledgement real scripted turns rather
   * than an optimistic race with the one the host already started.
   */
  const waitForRoomIdle = async (label) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await answerApprovals(cdp)
      const peers = await cdp.json(`${STORE}.transport.request('team/peers', { room: ${q(room)} })`, 60_000).catch(() => [])
      if (!peers.some((peer) => peer.busy)) return
      await sleep(250)
    }
    throw new Error(`${label}: room members did not settle`)
  }
  const waitForSeatBusy = async (key, label) => {
    const [runtime, sessionId] = key.split(String.fromCharCode(0))
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const peers = await cdp.json(`${STORE}.transport.request('team/peers', { room: ${q(room)} })`, 60_000).catch(() => [])
      if (peers.some((peer) => peer.runtime === runtime && peer.sessionId === sessionId && peer.busy)) return
      await sleep(100)
    }
    throw new Error(`${label}: the room delivery never started its turn`)
  }
  const startRoomDelivery = async (key, text, label) => {
    await waitForRoomIdle(label)
    const before = await cdp.eval(`${STORE}.getSnapshot().teams.get(${q(room)})?.channel.length ?? 0`)
    const [runtime, sessionId] = key.split(String.fromCharCode(0))
    await cdp.eval(`(() => {
      void ${STORE}.transport.request('team/post', {
        room: ${q(room)}, text: ${q(text)}, to: { runtime: ${q(runtime)}, sessionId: ${q(sessionId)} },
      })
      return true
    })()`, 60_000)
    return before
  }
  const startIdleSeatTurn = async (key, text, label) => {
    await waitForRoomIdle(label)
    await cdp.eval(`void ${STORE}.send([{ type: 'text', text: ${q(text)} }], ${q(key)}); true`, 60_000)
    await waitForSeatBusy(key, label)
  }
  const waitForRoomDelivery = async (before, label) => {
    await waitForSnapshot(
      () => cdp.eval(`${STORE}.getSnapshot().teams.get(${q(room)})?.channel.length ?? 0`),
      count => count > before,
    ).catch(() => { throw new Error(`${label}: room delivery did not reach the channel`) })
  }

  // A short attributed context turn exists before the camera rolls, so the
  // first recorded frame is a working room rather than its empty state.  The
  // next two scripted Claude turns are deliberately started only by an
  // idle-checked room delivery below, after the seat's standing order ends.
  let heroClaudeKey = null
  let heroCodexKey = null
  if (SCENARIO === 'hero') {
    heroClaudeKey = await cdp.eval(
      `${STORE}.seatGoal({ goal: ${q(room)}, agent: 'room-claude-code' })
        .then((seat) => seat.session.runtime + String.fromCharCode(0) + seat.session.sessionId)`,
      60_000,
    )
    await waitForRoomIdle('hero context')
    const contextDelivery = await startRoomDelivery(heroClaudeKey, 'Checkout fails on a transient 502. Can you take the retry fix?', 'hero context delivery')
    await waitForRoomDelivery(contextDelivery, 'hero context delivery')
    await waitForRoomIdle('hero context reply')
    // Keep Codex a named, idle room member before Claude hands the fix over.
    // Its initial scripted turn has no chat text, so the camera still opens
    // on exactly the first two spoken lines.
    heroCodexKey = await cdp.eval(
      `${STORE}.seatGoal({ goal: ${q(room)}, agent: 'room-codex' })
        .then((seat) => seat.session.runtime + String.fromCharCode(0) + seat.session.sessionId)`,
      60_000,
    )
    await waitForRoomIdle('hero Codex seating')
    // The seeded desktop's historical conversation list can briefly include
    // a placeholder session while Codex is warming. The hero is about the
    // room, not that list, so remove the outer sidebar before any frame.
    await cdp.eval(`${STORE}.toggleSidebar(); true`)
    await dismissNotices(cdp)
    await retildify()
  }

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
    // HarnessDesk never shows two conversation panes at once, so "two agents
    // working together" is the Room itself: both seats' turns land in the
    // one channel `openTeamRoom` already draws, and the browser — a docked,
    // non-conversation pane — pops open beside it the way `shoot.mjs`'s own
    // `browser` scene does, driven by Codex's own turn rather than opened
    // from outside it.
    //
    // Beat 1: Claude's own next turn streams (`agent.mjs`'s `TURNS[4]`) with
    // the completed fix and hand-off. It is a direct seat turn, so its room
    // answer follows the opening exchange without a staged person message.
    const claudeKey = heroClaudeKey
    const claudeFix = await cdp.eval(`${STORE}.getSnapshot().teams.get(${q(room)})?.channel.length ?? 0`)
    await startIdleSeatTurn(claudeKey, 'Make the 502 retry fix and hand the finished checkout to Codex.', 'Claude fix')
    await answerApprovals(cdp)
    await waitForRoomDelivery(claudeFix, 'Claude fix')
    await sleep(900)
    await retildify()

    // Beat 2: Claude's real inter-agent hand-off reaches the already-seated
    // Codex, whose received turn is silent; the person then hands Codex the
    // inspection, which lands while its scripted
    // `browser_open` tool call is the *pending* one in its turn — the real
    // browser pane opens on the storefront's checkout page. The pane's own
    // "driven by" mark (`BrowserPane.tsx`'s `useDriving`) reads whichever
    // session has an in-progress call to a browser-plugin tool; `TURNS[5]`
    // titles that call `browser_open` (the plugin's own tool name) for
    // exactly this reason, so the mark reads "Codex" for the window this
    // recording holds it open, never "Claude".
    const codexKey = heroCodexKey
    if (!codexKey) throw new Error('Codex seat failed before the recording started')
    const codexCheck = await startRoomDelivery(codexKey, 'Over to you, Codex.', 'Codex browser check')
    await waitForSeatBusy(codexKey, 'Codex browser check')
    await answerApprovals(cdp)
    await sleep(700)
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
    // A 1280px framed window gives the right-docked browser a narrow room.
    // At that width the room intentionally shows its rail until the reader
    // picks a surface; select Chat again so the channel, rather than the
    // roster, remains beside the page for the rest of the recording.
    if (!(await click('Chat'))) throw new Error('the narrow room did not offer its Chat surface')
    // Held through the rest of the `browser_open` call's own pending window
    // (2.6s from when it was announced) — the frame this beat exists for.
    await sleep(2600)
    await answerApprovals(cdp).catch(() => {})
    await retildify()
    // The rest of Codex's turn: its own "checked" result posted to the room.
    await sleep(1800)
    await waitForRoomDelivery(codexCheck, 'Codex browser check')
    await waitForRoomIdle('Codex browser check')
    await retildify()

    // Beat 3: Claude acknowledges — a second, later turn on the *same*
    // session (`TURNS[6]`, this file's own `agents.json` patch), a real
    // second `send` rather than a `team/post` the person would have typed.
    const acknowledgement = await startRoomDelivery(claudeKey, 'Your call on the nit.', 'Claude acknowledgement')
    await waitForRoomDelivery(acknowledgement, 'Claude acknowledgement')
    await waitForRoomIdle('Claude acknowledgement')
    await followRoomChat()
    await retildify()
    // Hold the settled frame — both agents' messages and the open browser —
    // for a beat before the loop restarts. The screencast is stopped by the
    // shared code just below; the browser pane itself is closed there too,
    // after the frames are already collected (see its own comment) — closing
    // it here would record the pane disappearing as the GIF's own last beat.
    await sleep(2000)
  } else if (SCENARIO === 'flow') {
    // Beat 1: the real New Goal dialog — "Start with a team" (or the redesign's
    // "Team" radio, whichever this build has, exactly `front-door`'s own
    // check in `shoot.mjs`), the "Fix and review" shape this file wrote into
    // `.harnessdesk/flows` above, and its dry run held on screen before
    // Start is ever clicked — the beat the rejected take skipped straight
    // past.
    if (!(await click('New session', '[aria-label="Workspace actions"]'))) {
      throw new Error('no New session button in the sidebar')
    }
    const chooser = '[role="dialog"][aria-label="What are you starting?"]'
    await waitForSnapshot(() => cdp.eval(`document.querySelector(${q(chooser)}) !== null`), Boolean)
    const hasTeamRadio = await cdp.eval(`(() => {
      const root = document.querySelector(${q(chooser)})
      if (!root) return false
      return [...root.querySelectorAll('[role="radio"]')].some((one) => (one.textContent ?? '').trim().startsWith('Team'))
    })()`)
    if (hasTeamRadio) {
      if (!(await click('Team', chooser))) throw new Error('no Team radio in the New session dialog')
      if (!(await click('Continue', chooser))) throw new Error('no Continue button in the New session dialog')
    } else if (!(await click('Start with a team', chooser))) {
      throw new Error('no "Start with a team" choice in the New session dialog')
    }
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[role="dialog"][aria-label="Start a team"]') !== null`),
      Boolean,
    )
    if (!(await click('Fix and review', '[role="dialog"][aria-label="Start a team"]'))) {
      throw new Error('no "Fix and review" shape in the catalogue — is .harnessdesk/flows/fix-and-review.yml there?')
    }
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[role="dialog"][aria-label="Start Fix and review"]') !== null`),
      Boolean,
    )
    if (!(await fill('What to fix', 'Retry the checkout call on a 502'))) throw new Error('no "What to fix" field')
    if (!(await fill('What finishes this?', 'Checkout hardening'))) throw new Error('no sentence field')
    await waitForSnapshot(
      () => cdp.eval(`(() => {
        const button = [...document.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Start')
        return Boolean(button) && !button.disabled
      })()`),
      Boolean,
    )
    // Held: the dialog's own dry run — seats with human names, the round
    // trace — visible and unstarted.
    await sleep(3000)
    if (!(await click('Start', '[role="dialog"][aria-label="Start Fix and review"]'))) {
      throw new Error('no enabled Start button in the New Goal dialog')
    }
    await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Checkout hardening')`), Boolean)
    room = await cdp.eval(`(() => {
      for (const view of ${STORE}.getSnapshot().goals.values()) {
        if (view.goal.sentence === 'Checkout hardening') return view.goal.id
      }
      return null
    })()`)
    if (!room) throw new Error('the started Goal is not in the snapshot')
    await sleep(700)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 2 onward: the flow seats themselves use `await_work`, `claim_next`,
    // and `complete_claim` through agent.mjs's real MCP bridge. This driver
    // observes each genuine board transition; it never applies a person verb
    // or guesses an intent id.
    await cdp.eval(`${STORE}.openTeamBoard(${q(room)}); true`)
    await cdp.eval(`${STORE}.zoomPanel('right', 'content'); true`)
    await sleep(2200)

    const teamState = () => cdp.json(`${STORE}.transport.request('team/state', ${q({ room })})`, 60_000)
    const awaitState = async (label, predicate) => {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const state = await teamState().catch(() => null)
        if (state && predicate(state.intents ?? [])) return state
        await sleep(250)
      }
      throw new Error(`${label}: agents did not reach the expected real board state`)
    }

    // The first fixation is visibly claimed before the delayed completion
    // opens the three reviewer seats.
    await awaitState('fixer claim', (intents) => intents.some((one) => one.role === 'fixer' && one.state === 'claimed'))
    await sleep(1600)
    await retildify()

    await awaitState('first reviewer round', (intents) =>
      intents.filter((one) => one.role === 'reviewer' && one.state === 'claimed').length === 3,
    )
    await sleep(1600)
    await retildify()

    await awaitState('requested changes', (intents) =>
      intents.some((one) => one.role === 'reviewer' && one.state === 'done' && one.outcome === 'request-changes') &&
      intents.some((one) => one.role === 'fixer' && one.state === 'claimed' && /Answer round/.test(one.title)),
    )
    await sleep(1400)
    await retildify()

    await awaitState('second reviewer round', (intents) =>
      intents.filter((one) => one.role === 'reviewer' && one.state === 'claimed').length === 3 &&
      intents.some((one) => one.role === 'fixer' && one.state === 'done' && /Answer round/.test(one.title)),
    )
    await sleep(1400)
    await retildify()

    // Every reviewer has now completed its real approval. The only remaining
    // card is the person's merge, so the flow correctly ends at Needs you.
    await awaitState('merge hand-off', (intents) =>
      intents.some((one) => one.role === 'referee' && one.state === 'open') &&
      intents.filter((one) => one.role === 'reviewer').filter((one) => one.state === 'done' && one.outcome === 'approve').length >= 5,
    )
    await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Needs you')`), Boolean)
    await sleep(2500)
  } else {
    throw new Error(`unknown --scenario ${q(SCENARIO)}`)
  }

  await cdp.send('Page.stopScreencast')
  await refuseUnpublishable(cdp, {
    name: NAME, user: USER, vouched: VOUCHED, roots: REPOS.map(repo => join(WORK, repo.dir)), nativeCodex: NATIVE_CODEX,
    rigOrigin: browserServer?.url ?? null, subject: 'recording',
  })
  // Closed now, after every frame is already collected: an open browser pane
  // is part of the persisted layout, and the *next* launch against this same
  // home would otherwise restore it pointed at a static server that no
  // longer exists — failing that run's own `refuseUnpublishable` before it
  // ever opens a browser of its own.
  if (browserServer) await cdp.eval(`${STORE}.closeBrowser(); true`).catch(() => {})

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
  const poster = join(OUT, `${NAME}-poster.png`)
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
  // The flow tile is deliberately unlike the hero: its README cell supplies
  // the frame, so the camera takes a fixed main-area crop, with no sidebar,
  // padding, shadow, or rounded window around it.
  const outputFilter = SCENARIO === 'flow'
    ? `fps=${FPS},crop=960:600:${WIDTH - 960}:0`
    : padFilter
  await run('ffmpeg', ['-y', '-f', 'concat', '-i', 'list.txt', '-vf', `${outputFilter},palettegen=max_colors=160:stats_mode=diff`, palette], { cwd: FRAMES })
  await run(
    'ffmpeg',
    ['-y', '-f', 'concat', '-i', 'list.txt', '-i', palette, '-lavfi', `${outputFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', gif],
    { cwd: FRAMES },
  )
  await run('ffmpeg', ['-y', '-i', join(FRAMES, frames[frames.length - 1].file), '-vf', outputFilter, '-frames:v', '1', poster])

  const { stdout } = await run('/bin/ls', ['-lh', gif])
  say(`✓ ${NAME}.gif  ${stdout.trim().split(/\s+/)[4]}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s of app)`)
} finally {
  await browserServer?.close().catch(() => {})
  await closeDesk(desk).catch(() => {})
}
