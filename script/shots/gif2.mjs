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
if (SCENARIO === 'hero') {
  const agentsPath = join(HOME, 'agents.json')
  const roster = JSON.parse(readFileSync(agentsPath, 'utf8'))
  for (const agent of roster.agents) {
    if (agent.id === rigRuntimeId('claude-code')) agent.env.SHOT_TURN = '4,6'
    if (agent.id === rigRuntimeId('codex')) agent.env.SHOT_TURN = '5'
  }
  writeFileSync(agentsPath, `${JSON.stringify(roster, null, 2)}\n`)
  say('patched agents.json: claude-code plays turn 4 then 6, codex plays turn 5')
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
    // Beat 1: Claude's turn streams — `agent.mjs`'s `TURNS[4]` (this file's
    // own `agents.json` patch above), the real fix, ending with a real
    // hand-off ("Codex — … can you check checkout end to end?") rather than
    // one this recording has to narrate for it.
    const claudeKey = await cdp.eval(
      `${STORE}.seatGoal({ goal: ${q(room)}, agent: 'room-claude-code' })
        .then((seat) => seat.session.runtime + String.fromCharCode(0) + seat.session.sessionId)`,
      60_000,
    )
    // Posted the instant Claude is a member — its own standing-order turn
    // (`TURNS[4]`) has a 700ms `think` delay before its first token, which is
    // room enough for these two lines to land first and read as context the
    // room already had, not as a narration of what is about to happen.
    await cdp.eval(`${STORE}.send([{ type: 'text', text: 'The room is ready for the checkout hardening hand-off.' }], ${q(claudeKey)})`, 60_000)
    await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Earlier context: checkout currently fails on a transient 502.' }], ${q(claudeKey)})`, 60_000)
    await sleep(9000)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 2: Codex is seated and immediately says "on it" (`TURNS[5]`'s own
    // `opening`), then — a beat later, timed to land while its scripted
    // `browser_open` tool call is the *pending* one in its turn — the real
    // browser pane opens on the storefront's checkout page. The pane's own
    // "driven by" mark (`BrowserPane.tsx`'s `useDriving`) reads whichever
    // session has an in-progress call to a browser-plugin tool; `TURNS[5]`
    // titles that call `browser_open` (the plugin's own tool name) for
    // exactly this reason, so the mark reads "Codex" for the window this
    // recording holds it open, never "Claude".
    const codexKey = await cdp.eval(
      `${STORE}.seatGoal({ goal: ${q(room)}, agent: 'room-codex' })
        .then((seat) => seat.session.runtime + String.fromCharCode(0) + seat.session.sessionId)`,
      60_000,
    )
    await sleep(1300)
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
    // Held through the rest of the `browser_open` call's own pending window
    // (2.6s from when it was announced) — the frame this beat exists for.
    await sleep(2600)
    await answerApprovals(cdp).catch(() => {})
    await retildify()
    // The rest of Codex's turn: its own "checked" result posted to the room.
    await sleep(1800)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 3: Claude acknowledges — a second, later turn on the *same*
    // session (`TURNS[6]`, this file's own `agents.json` patch), a real
    // second `send` rather than a `team/post` the person would have typed.
    await sleep(600)
    await cdp.eval(
      `${STORE}.send([{ type: 'text', text: 'Codex found a nit in checkout — see above.' }], ${q(claudeKey)})`,
      60_000,
    )
    await sleep(1500)
    await answerApprovals(cdp).catch(() => {})
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

    // Beat 2: the expanded board — the fixer's card, To do → Working (a real
    // seat the flow engine opened, not one this script arranged) → published,
    // read back through `team/state` rather than guessed: a round's cards
    // are numbered by the engine, not by this file, and answering the wrong
    // id is the rejected take's own bug — every `team/intent` here silently
    // failed against a guess, which is why nothing ever showed as approved.
    await cdp.eval(`${STORE}.openTeamBoard(${q(room)}); true`)
    await cdp.eval(`${STORE}.zoomPanel('right', 'content'); true`)
    await sleep(2200)

    const teamState = () => cdp.json(`${STORE}.transport.request('team/state', ${q({ room })})`, 60_000)
    const resolved = new Set()
    /** The next round's cards of `role`, not already answered — polled, because the engine opens a round in its own time. */
    const nextRound = async (role, count) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await teamState().catch(() => null)
        const hits = (state?.intents ?? []).filter((one) => one.role === role && !resolved.has(one.id))
        if (hits.length >= count) {
          for (const one of hits) resolved.add(one.id)
          return hits
        }
        await sleep(1000)
      }
      throw new Error(`timed out waiting for a ${role} round of ${count}`)
    }
    const answer = (id, outcome, note) =>
      cdp
        .eval(`${STORE}.teamIntent(${q(room)}, ${id}, 'done', undefined, ${q(outcome)}${note ? `, ${q(note)}` : ''})`, 60_000)
        .catch(() => {})

    const [fixer1] = await nextRound('fixer', 1)
    await sleep(1800)
    await answer(fixer1.id, 'published', 'Opened #482 on fix/checkout-retry-502.')
    await sleep(2200)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 3: the loop — three reviewer cards claimed (three distinguishable
    // seats — the flow's own `seat:` list, not one runtime three times), one
    // requests changes, the fixer answers, a second round opens and every
    // reviewer approves.
    const round1 = await nextRound('reviewer', 3)
    await sleep(1800)
    await answer(round1[0].id, 'request-changes', 'The 502 case is untested.')
    await answer(round1[1].id, 'approve')
    await answer(round1[2].id, 'approve')
    await sleep(2200)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    const [fixer2] = await nextRound('fixer', 1)
    await sleep(1500)
    await answer(fixer2.id, 'published', 'Added the missing 502 case; both rounds pass now.')
    await sleep(2200)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    const round2 = await nextRound('reviewer', 3)
    await sleep(1800)
    await answer(round2[0].id, 'approve')
    await answer(round2[1].id, 'approve')
    await answer(round2[2].id, 'approve')
    await sleep(2500)
    await answerApprovals(cdp).catch(() => {})
    await retildify()

    // Beat 4: settled — every reviewer approved (drawn as such, not as
    // "nothing checked"), so the goal lands on "Needs you" for the person's
    // own merge. Held for the loop's final beat; the merge itself stays
    // the person's, so this never clicks it.
    await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Needs you')`), Boolean).catch(() => {})
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
