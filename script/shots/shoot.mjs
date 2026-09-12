#!/usr/bin/env node
/**
 * Photograph the real app against the staged desk.
 *
 * The renderer is the product: the window, the sidebar, the panes and the
 * title bar are what a reader is buying, and the preview harness has none of
 * them — it mounts components over a fixture store, which is right for a
 * design catalogue and wrong for a README. So this drives the actual Electron
 * app over CDP and captures what it drew.
 *
 * What keeps it publishable is two things, and the second exists because the
 * first was not enough. `seed.mjs` points the app at an invented home, so
 * there is no real name to leak rather than a real name to hide — but an
 * agent's credential store is not in that home, and a runtime signed in on
 * this machine reported its real identity onto a seat among the twelve
 * invented ones. So `accounts.mjs` answers every runtime's account from the
 * rig, and `audit.mjs` refuses any frame it cannot vouch for: an address
 * outside the sanctioned domains, a home path under any root, a title or an
 * `alt` carrying either, or an account the rig did not author. The first hero
 * image in this README was a photograph of a real desk carrying real branch
 * names, and it was published; a rig that relies on being careful will do that
 * again.
 *
 *   node script/shots/shoot.mjs --survey          # what is on screen
 *   node script/shots/shoot.mjs --scene board     # one scene, both themes
 *   node script/shots/shoot.mjs --all             # every scene, both themes
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeDesk, deskInUse, dismissNotices, launchDesk, makeRoom, seat, sleep, splitKey, STORE } from '../lib/desk.mjs'
import { ACCOUNTS, ANONYMOUS, VOUCHED } from './accounts.mjs'
import { COLLECT, reasonsFor } from './audit.mjs'
import { REPOS } from './cast.mjs'
import { HOME, WORK } from './seed.mjs'
import { LEDGER, SCAN, USAGE } from './usage.mjs'

/**
 * What is on the board, and what has been said in the room.
 *
 * Written as one piece of work split between four agents, because that is what
 * a room is for. The states matter as much as the titles: something claimed,
 * something blocked behind it, something still unclaimed — a board where every
 * card is identical says nothing about what a board does.
 */
const BOARD = [
  { title: 'Add 502 to the retryable status set', detail: 'Only 503 and 504 are listed today, so a bad gateway surfaces as a failed order.' },
  { title: 'Cap the backoff and add jitter', detail: 'Flat 200ms × 3 is three failures in 600ms against a gateway that is still restarting.' },
  { title: 'Cover both in retry.test.ts', detail: 'A 502 that recovers on the second attempt, and one that never does.' },
  { title: 'Make the webhook receiver idempotent', detail: 'Key on the delivery id so a redelivery cannot charge twice.' },
  { title: 'Decide the alert threshold for retry storms', detail: 'Needs a number from whoever owns the on-call rota.' },
]

const CHATTER = [
  'Taking the retry policy itself — the status set and the backoff are one change.',
  'I will take the tests once that lands, so we are not both editing retry.test.ts.',
  'The webhook one is independent; starting on it now.',
]

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const OUT = resolve(flag('out', `${APP}/docs/images/app`))
const WIDTH = Number(flag('width', '1440'))
const HEIGHT = Number(flag('height', '900'))
const THEMES = flag('theme') ? [flag('theme')] : ['light', 'dark']
const REPO = join(WORK, REPOS[0].dir)
const say = (line) => process.stdout.write(`  ${line}\n`)

/**
 * The username this machine runs as.
 *
 * One of the things no frame may contain, and no longer the only one — the
 * audit that called it "the one string" passed a real name and a real address
 * on a seat (#296). It is still worth its own check: it is the one name this
 * machine is certain to know.
 */
const USER = homedir().split('/').filter(Boolean).pop() ?? ''

const busy = await deskInUse(HOME)
if (busy) {
  process.stderr.write(`\n  A desk is already open on ${HOME} (pid ${busy}). Quit it first.\n\n`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
say(`home   ${HOME}`)
say(`out    ${OUT}`)
say(`frame  ${WIDTH}x${HEIGHT} @2x`)

const desk = await launchDesk({
  app: APP,
  home: HOME,
  port: 9840 + Math.floor(Math.random() * 100),
  userDataDir: `${HOME}/electron`,
  logPath: `${HOME}/app.log`,
})
const { cdp } = desk
const q = (value) => JSON.stringify(value)

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false })
  await sleep(2500)
  await dismissNotices(cdp).catch(() => {})

  /**
   * Answer every money question from the rig, before anything asks one.
   *
   * Two different problems wear one name here. `usage/reports` has nothing on
   * disk to read, because the host assembles it per vendor and twelve invented
   * vendors have none — that half is merely missing. `usage/ledger` and
   * `usage/scan` are the dangerous half: they do not read HarnessDesk's home at
   * all. They walk each **agent's** own transcripts under `~/.codex` and
   * `~/.claude` and price them, so a staged home does nothing, and the first
   * take of the dashboard scene carried this machine's real 30-day spend.
   *
   * `store.transport` is a public field, so all three are substituted from out
   * here and no application code is touched to make the picture. It is
   * installed at boot rather than in the dashboard scene, because the ledger
   * starts its own scan the first time anybody asks — including the app,
   * unprompted — and a scan that has already begun has already read the corpus.
   */
  const stageAnswers = async () => {
    await cdp.eval(
      `(() => {
        const s = ${STORE}
        if (s.__shotsPatched) return true
        const real = s.transport.request.bind(s.transport)
        const canned = {
          'usage/reports': ${q(USAGE)},
          'usage/ledger': ${q(LEDGER)},
          'usage/scan': ${q(SCAN)},
        }
        const accounts = ${q(ACCOUNTS)}
        const anonymous = ${q(ANONYMOUS)}
        s.transport.request = (method, params) => {
          /* Every runtime, not the ones the rig seeded: an id nobody
             anticipated gets an invented answer rather than its own store. */
          if (method === 'runtime/account') {
            return Promise.resolve(accounts[params?.runtime] ?? anonymous)
          }
          return method in canned ? Promise.resolve(canned[method]) : real(method, params)
        }
        s.__shotsPatched = true
        return true
      })()`,
      60_000,
    )
    await cdp.eval(`${STORE}.loadUsage()`, 60_000).catch(() => {})
    /* Asked again, because the window asked first. The store loads accounts
       while it boots — before this patch could be installed — so the map it is
       holding at this point was answered by the runtimes themselves. Both
       verbs, because they write different slots: `loadAccounts` replaces the
       per-runtime map every seat and card reads, and `refreshRuntime` replaces
       the singular one the selected agent's surfaces read. The audit refuses
       the frame if either is still real, which is what makes this recoverable
       rather than silent. */
    await cdp.eval(`${STORE}.loadAccounts()`, 60_000).catch(() => {})
    await cdp.eval(`${STORE}.refreshRuntime({ history: false })`, 60_000).catch(() => {})
    await sleep(900)
  }
  await stageAnswers()

  /**
   * Nothing is written until this passes. See `audit.mjs` for what it asks and
   * which way it errs; collected here because only the driver has the window.
   */
  const audit = async (name) => {
    const seen = await cdp.json(
      `(() => {
        const seen = ${COLLECT}
        seen.accounts = ${STORE}.getSnapshot().accountsByRuntime ?? {}
        return seen
      })()`,
    )
    const reasons = reasonsFor(seen ?? {}, { user: USER, vouched: VOUCHED })
    if (reasons.length > 0) {
      throw new Error(`${name}: this frame is not publishable —\n    ${reasons.join('\n    ')}`)
    }
  }

  /**
   * Write this machine's home as `~`, the way the app writes it elsewhere.
   *
   * `shortPath` is applied in the Library, the skill sheet and every diff
   * label, but the repository pane's header prints its root absolute — it has
   * no `home` to shorten against, because home reaches the renderer on the
   * library scan rather than on the app snapshot. That is a real if small
   * defect and it is filed as one; it is not this rig's to fix mid-take.
   *
   * So the substitution happens here, and it is deliberately the narrowest one
   * that helps: the exact home prefix becomes `~`, and nothing else changes.
   * The audit therefore still means something — any *other* home path, under
   * any root, and any bare occurrence of the username, still throws.
   */
  const tildify = async () => {
    await cdp.eval(
      `(() => {
        const home = ${q(homedir())}
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walk.nextNode())) {
          if (node.nodeValue?.includes(home)) node.nodeValue = node.nodeValue.split(home).join('~')
        }
        for (const el of document.querySelectorAll('[title]')) {
          const t = el.getAttribute('title')
          if (t?.includes(home)) el.setAttribute('title', t.split(home).join('~'))
        }
        return true
      })()`,
    )
    await sleep(150)
  }

  const shoot = async (name, expect = null) => {
    /* Prove the app is showing what the filename claims. Staging a pane and
       photographing whatever happens to be in front of it is how a dashboard
       ends up saved as `git-dark.png`. */
    if (expect) {
      const there = await cdp.eval(`(document.body.innerText ?? '').includes(${q(expect)})`)
      if (!there) throw new Error(`${name}: expected ${q(expect)} on screen and it is not there`)
    }
    await tildify()
    await audit(name)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
    say(`✓ ${name}.png`)
  }

  const setTheme = async (theme) => {
    await cdp.eval(`${STORE}.setTheme(${q(theme)}); true`)
    await sleep(900)
  }

  /** Click by what it says, not by where it is — a coordinate is one build's layout. */
  const click = async (text, within = null) => {
    const hit = await cdp.json(
      `(() => {
        const scope = ${within ? `document.querySelector(${q(within)})` : 'document'}
        if (!scope) return false
        const wanted = ${q(text)}
        const all = [...scope.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], li, summary')]
        const hits = all.filter((e) => (e.textContent ?? '').trim().startsWith(wanted) || e.getAttribute('aria-label') === wanted)
        /* The smallest match: once a word is on screen twice the outer one is
           usually a container that happens to contain the row you wanted. */
        const el = hits.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
        if (!el) return false
        el.click()
        return true
      })()`,
    )
    await sleep(1400)
    return hit
  }

  /**
   * Four agents seated in one room, built once.
   *
   * `makeRoom` joins *sessions*, not runtimes, so each member has to be seated
   * first — and the room has to be memoised, because two scenes want it and
   * two rooms of the same name leave the board picking whichever was created
   * first.
   */
  let roomId = null
  const stageRoom = async () => {
    if (roomId) return roomId
    const keys = []
    for (const runtime of ['codex', 'claude-code', 'cursor', 'gemini-cli']) {
      keys.push(await seat(cdp, { work: REPO, runtime, picks: {} }))
    }
    roomId = await makeRoom(cdp, { work: REPO, name: 'Checkout hardening', members: keys.map(splitKey) })

    /* Work on the board and words in the chat, through the host's own verbs.
       An empty room photographs as "Nothing said yet" beside "Nothing on the
       board", which is an accurate picture of a room nobody has used and a
       useless one of the feature. `store.transport` is public, so these are
       the same calls the interface makes when a person types them. */
    const ask = (method, params) => cdp.eval(`${STORE}.transport.request(${q(method)}, ${q(params)})`, 60_000).catch(() => {})
    for (const job of BOARD) await ask('team/add', { room: roomId, title: job.title, detail: job.detail })
    for (const line of CHATTER) await ask('team/post', { room: roomId, text: line })

    /* All four work, not two: four agents on one piece of work is the thing a
       room is for, and two idle columns read as two agents that failed to
       start. */
    for (const key of keys) {
      await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000).catch(() => {})
    }
    await sleep(7000)
    return roomId
  }

  /**
   * Leave the Dashboard, if it is up.
   *
   * It is a full-window overlay, not a pane, so `openGitHistory` and
   * `openBrowser` happily open *behind* it and change nothing on screen. The
   * first take of the git scene was a photograph of the Dashboard, filed under
   * `git-dark.png` — and because that run predated the ledger stub, it was a
   * photograph of the real machine's real spend, under a name that said it was
   * something else. A picture that is wrong about what it shows is worse than
   * no picture, because it is evidence.
   */
  const leaveOverlay = async () => {
    await click('Back to app').catch(() => {})
    await sleep(600)
  }

  /* ------------------------------------------------------------ the scenes */

  /**
   * Each scene stages the app and leaves it on the frame worth keeping.
   *
   * Staging is separated from the capture because both themes photograph the
   * same staged state — re-running the setup per theme would send a second
   * turn and photograph a different conversation each time.
   */
  const SCENES = {
    /** The desk itself: twelve agents, three projects, work in the sidebar. */
    desk: { expect: 'Workspaces', run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await sleep(1500)
    } },

    /** One conversation, mid-work: reasoning, a plan and tool calls. */
    conversation: { expect: 'Worked for', run: async () => {
      const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
      await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
      // Long enough for the scripted turn to reach its summary.
      await sleep(6500)
      /* Unfold the steps. The app folds a finished turn down to one line, which
         is the right default for somebody scrolling a day's work and the wrong
         one for a photograph — folded, this pane is two paragraphs and a great
         deal of white. Open, it shows the reasoning and the tool calls, which
         is the part that is worth looking at. */
      await click('Worked for')
    } },

    /** What every agent has left, and what it has cost. */
    dashboard: { expect: 'What is left', run: async () => {
      if (!(await click('Dashboard'))) throw new Error('no Dashboard row in the sidebar')
      await sleep(1600)
    } },

    /** The repository pane: a real graph over real git objects. */
    git: { leaveOverlay: true, expect: 'History', run: async () => {
      await cdp.eval(`${STORE}.openGitHistory(${q(REPO)}); true`)
      await sleep(2200)
    } },

    /** A room of agents, and the board they claim work from. */
    board: { leaveOverlay: true, expect: 'Ready', run: async () => {
      await stageRoom()
      await cdp.eval(`${STORE}.openTeamBoard(${q(roomId)}); true`)
      await sleep(2200)
    } },

    /** The same room, as a room: several agents' turns side by side. */
    room: { leaveOverlay: true, expect: 'AGENTS', run: async () => {
      await stageRoom()
      await cdp.eval(`${STORE}.openTeamRoom(${q(roomId)}); true`)
      await sleep(2200)
    } },

    /** The browser pane — a real `<webview>`, driven by the agent's tools. */
    browser: { leaveOverlay: true, expect: 'harnessdesk', run: async () => {
      await cdp.eval(`${STORE}.openBrowser('https://harnessdesk.app'); true`)
      await sleep(3500)
    } },
  }

  /* Every `--scene` on the line, not just the first: a take is usually two or
     three scenes, and silently shooting only one of them is the kind of miss
     you find after the app has been shut down. */
  const named = argv.flatMap((one, i) => (one === '--scene' && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []))
  const wanted = has('all') ? Object.keys(SCENES) : named

  if (has('survey')) {
    const survey = await cdp.json(`(() => {
      const s = ${STORE}.getSnapshot()
      return {
        sessions: s.sessions?.size ?? 0,
        workspaces: (s.workspaces ?? []).length,
        runtimes: (s.runtimes ?? []).map((r) => r.id),
        usage: (s.usage ?? []).length,
      }
    })()`)
    say(`sessions ${survey.sessions} · workspaces ${survey.workspaces} · usage ${survey.usage} · runtimes ${survey.runtimes?.length}`)
  }

  for (const name of wanted) {
    const scene = SCENES[name]
    if (!scene) throw new Error(`no scene "${name}" — have ${Object.keys(SCENES).join(', ')}`)
    say(`— ${name}`)
    if (scene.leaveOverlay) await leaveOverlay()
    await scene.run()
    for (const theme of THEMES) {
      await setTheme(theme)
      await shoot(`${name}-${theme}`, scene.expect ?? null)
    }
  }
} finally {
  await closeDesk(desk).catch(() => {})
}
