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
import { fileURLToPath, pathToFileURL } from 'node:url'

import { answerApprovals, closeDesk, deskInUse, dismissNotices, launchDesk, makeRoom, seat, sleep, splitKey, STORE } from '../lib/desk.mjs'
import { ACCOUNTS, ANONYMOUS, VOUCHED } from './accounts.mjs'
import { TILDIFY, USER, refuseUnpublishable } from './audit.mjs'
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

const APP = process.env['HD_SHOTS_APP'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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
  executable: process.env['HD_SHOTS_EXECUTABLE'],
  home: HOME,
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
          'runtime/skills': [
            { name: 'review', description: 'Review the current changes and report actionable findings with reproducible checks.', enabled: true, toggleable: false },
            { name: 'plan', description: 'Plan the implementation, identify the affected components, and wait for approval before changing files.', enabled: true, toggleable: false },
          ],
          'library/read': {
            generatedAt: 1, home: '/home/user', runtimes: ['codex', 'claude-code'], gaps: [],
            locations: ['codex', 'claude-code'].map(runtime => ({ runtime, kind: 'skill', path: '/home/user/.agents/skills', scope: 'user', scanned: true, exists: true, readOnly: true })),
            entries: ['Accessibility audit', 'Review changes', 'Run project tests', 'Write release notes', 'Inspect workspace'].map((name, index) => ({
              kind: 'skill', name: name.toLowerCase().replaceAll(' ', '-'), title: name,
              description: 'Inspect the workspace and report actionable findings with reproducible checks and clear evidence.',
              copies: [{ path: '/home/user/.agents/skills/demo-' + index, scope: 'user', readBy: ['codex', 'claude-code'], hollow: false, digest: 'demo', readOnly: true }],
              reach: ['codex', 'claude-code'].map(runtime => ({ runtime, state: 'reaches', basis: 'scanned' })),
            })),
          },
          'library/usage': { generatedAt: 1, sessionsScanned: 0, skills: {} },
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
   * which way it errs; asked from here because only the driver has the window.
   */
  const audit = (name) => refuseUnpublishable(cdp, { name, user: USER, vouched: VOUCHED })

  /** Hide this machine's home, the one substitution a frame is allowed. */
  const tildify = async () => {
    await cdp.eval(TILDIFY(homedir()))
    // Native verification repositories may live in a unique temporary root.
    // Normalize that synthetic path too so concurrency-safe random suffixes
    // never become public screenshot content.
    await cdp.eval(TILDIFY(WORK))
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
    // Numeric/style facts accompany comparisons without recording user text.
    if (has('measure')) {
      const metrics = await cdp.json(`(() => {
        const selectors = {
          body: 'body', pageTitle: '[class*="pageTitle"]', pageBlurb: '[class*="pageBlurb"]',
          row: 'button[class*="rowButton"], button[class*="rowChoice"]',
          rowTitle: 'button[class*="rowButton"] [class*="rowTitle"]', rowDescription: '[class*="rowDesc"]', rowMark: '[class*="rowMark"]',
          faceChoice: '[class*="faceChoice"]', faceTile: '[class*="faceTile"]',
          agentHeader: '[class*="headOpen"]', agentName: '[class*="headName"]',
          footer: '[class*="accountRow"]', footerName: '[class*="accountLabel"]',
          agentBadge: '[class*="seatAvatar"]', agentGlyph: '[class*="seatAvatar"] svg', statusDot: '[class*="statusDot"]',
          menu: '[role="menu"]', menuItem: '[role="menuitem"]',
          popover: '[data-slot="popover-popup"]', accountMenu: '[class*="accountMenu_"]',
          usageAccount: 'button[class*="acct_"]', usageName: '[class*="acctName"]', usageTrack: '[class*="acctTrack"]',
          usageCards: '[class*="cards_"]', usageCard: '[class*="card_"]',
          segmentedItem: '[data-slot="toggle-group-item"]',
        }
        const measure = node => {
          const css = getComputedStyle(node), rect = node.getBoundingClientRect()
          let opacity = 1
          for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity)
          return { width: rect.width, height: rect.height, font: css.fontFamily, size: css.fontSize,
            weight: css.fontWeight, lineHeight: css.lineHeight, padding: css.padding, gap: css.gap,
            radius: css.borderRadius, shadow: css.boxShadow, border: css.borderWidth, opacity }
        }
        const output = {}
        for (const [key, selector] of Object.entries(selectors)) {
          const node = [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().height > 0)
          if (node) output[key] = measure(node)
        }
        output.reviewerOptions = [...document.querySelectorAll('[data-slot="toggle-group-item"]')]
          .filter(node => ['You', 'Automatic review', 'Guardian sub-agent'].includes(node.textContent.trim()))
          .map(node => ({ label: node.textContent.trim(), ...measure(node) }))
        const menu = document.querySelector('[role="menu"]')
        if (menu) {
          output.menuAncestors = []
          for (let node = menu; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).boxShadow !== 'none') output.menuAncestors.push(measure(node))
          }
        }
        return output
      })()`)
      writeFileSync(`${OUT}/${name}.metrics.json`, JSON.stringify(metrics, null, 2) + '\n')
    }
    if (has('assert-layout')) {
      const faults = await cdp.json(`(() => {
        const faults = []
        const visible = node => node.getBoundingClientRect().height > 0
        const sidebar = document.querySelector('nav[aria-label="Workspace actions"]')?.parentElement
        if (sidebar && visible(sidebar)) {
          for (const node of [sidebar, ...sidebar.querySelectorAll('*')]) {
            if (['auto', 'scroll'].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 1) {
              faults.push('horizontal sidebar overflow: ' + node.className)
            }
          }
          const footer = sidebar.querySelector('button[class*="accountRow"]')
          if (footer) {
            const row = footer.getBoundingClientRect(), column = sidebar.getBoundingClientRect()
            if (column.right - row.right > 8) faults.push('sidebar footer no longer fills its column')
          }
        }
        for (const row of document.querySelectorAll('button[class*="rowButton"], button[class*="rowChoice"]')) {
          if (!visible(row)) continue
          const box = row.getBoundingClientRect()
          for (const child of row.querySelectorAll('[class*="rowTitle"], [class*="rowDesc"], [class*="rowMark"]')) {
            const rect = child.getBoundingClientRect()
            if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1) faults.push('row overflow: ' + row.textContent.slice(0, 80))
          }
        }
        for (const header of document.querySelectorAll('button[class*="headOpen"]')) {
          const mark = header.querySelector('[class*="rowMark"]')
          if (!mark || !visible(header)) continue
          const box = header.getBoundingClientRect(), icon = mark.getBoundingClientRect()
          const padding = parseFloat(getComputedStyle(header).getPropertyValue('--hd-space-3'))
          if (icon.top - box.top < padding || box.bottom - icon.bottom < padding) faults.push('agent header lost its Settings row padding')
        }
        for (const row of document.querySelectorAll('button[class*="acct_"]')) {
          if (!visible(row)) continue
          const box = row.getBoundingClientRect(), css = getComputedStyle(row)
          if (parseFloat(css.paddingTop) < 4 || parseFloat(css.paddingBottom) < 4 || box.height < 26) faults.push('Dashboard account row collapsed')
          const meter = row.querySelector('[class*="acctTrack"]')?.getBoundingClientRect()
          const name = row.querySelector('[class*="acctName"]')?.getBoundingClientRect()
          if (meter && (meter.width < box.width / 2 || meter.top - name.bottom < 3)) faults.push('Dashboard meter lost its grid track')
        }
        for (const option of document.querySelectorAll(':is(section, [role="dialog"])[aria-label="Settings"] [data-slot="toggle-group-item"]')) {
          if (!visible(option)) continue
          const box = option.getBoundingClientRect(), css = getComputedStyle(option)
          const range = document.createRange()
          range.selectNodeContents(option)
          const text = range.getBoundingClientRect()
          if (text.left - box.left < parseFloat(css.paddingLeft) - 1 || box.right - text.right < parseFloat(css.paddingRight) - 1) faults.push('Settings segment label overflows its option')
        }
        for (const row of document.querySelectorAll('[class*="groupHead"]:hover, [class*="rowWrap"]:hover')) {
          const action = row.querySelector('[class*="groupAdd"], button[aria-haspopup="menu"]')
          if (!action || !visible(action)) continue
          for (const mark of row.querySelectorAll('[class*="groupPin"], [class*="groupCount"], [class*="rowGone"], [class*="rowWorktree"]')) {
            if (mark.getBoundingClientRect().right > action.getBoundingClientRect().left) faults.push('sidebar hover action overlaps metadata')
          }
        }
        for (const popup of document.querySelectorAll('[data-slot="popover-popup"]')) {
          const box = popup.getBoundingClientRect()
          if (box.top < 0 || box.bottom > innerHeight + 1 || box.left < 0 || box.right > innerWidth + 1) {
            faults.push('popup extends outside the viewport: ' + JSON.stringify(box.toJSON()))
          }
        }
        for (const item of document.querySelectorAll('[role="menuitem"]')) {
          if (!visible(item)) continue
          let opacity = 1
          for (let node = item; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
          if (opacity < 0.99) faults.push('invisible menu item: ' + item.textContent.slice(0, 80))
          // A DOM-visible, opaque item can still sit outside a zero-height
          // popup and be clipped away. Check the painted/hit-tested center.
          const rect = item.getBoundingClientRect()
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
          const popup = item.closest('[data-slot="popover-popup"]')
          if (popup) {
            const box = popup.getBoundingClientRect()
            const contentX = x - box.left + popup.scrollLeft, contentY = y - box.top + popup.scrollTop
            if (box.height < Math.min(rect.height, 24)
              || contentY < 0 || contentY > popup.scrollHeight
              || contentX < 0 || contentX > popup.scrollWidth) {
              faults.push('menu item clipped outside popup: ' + item.textContent.slice(0, 80))
            } else if (y >= box.top && y <= box.bottom && x >= box.left && x <= box.right
              && !item.contains(document.elementFromPoint(x, y))) {
              faults.push('menu item cannot receive a pointer: ' + item.textContent.slice(0, 80)
                + ' ' + JSON.stringify({ x, y, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 160),
                  popup: box.toJSON(), viewport: { width: innerWidth, height: innerHeight } }))
            }
          }
        }
        return faults
      })()`)
      if (faults.length) throw new Error(name + ': ' + faults.join('; '))
    }
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
        const hits = all.filter((e) => {
          if (!((e.textContent ?? '').trim().startsWith(wanted) || e.getAttribute('aria-label') === wanted)) return false
          if (e.closest('[aria-hidden="true"], [inert]')) return false
          const rect = e.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && e.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
        })
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
  /**
   * The flow the staged repository offers, written where the app reads them.
   *
   * Seated on agents the rig invented and models they declare, so the dry run
   * in the picture is a real dry run of a real file rather than a mock-up —
   * and so the audit has nothing of anybody's to refuse.
   */
  const FLOW = `name: Fix and review
description: One fixer, three reviewers, and the merge stays yours.

inputs:
  work:
    label: What to fix

roles:
  fixer:
    kind: agent
    seat: codex=gpt-5.6-sol
    permission: publish
    outcomes: [published, cannot]
    order: |
      Make the change, run the tests, and open a pull request for it.
  reviewer:
    kind: agent
    seat: cursor=gemini-3.8-flash
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

  const stageFlow = () => {
    mkdirSync(join(REPO, '.harnessdesk', 'flows'), { recursive: true })
    writeFileSync(join(REPO, '.harnessdesk', 'flows', 'fix-and-review.yml'), FLOW)
  }

  let roomId = null
  const stageRoom = async () => {
    if (roomId) return roomId
    const keys = []
    // The fake Codex app-server deliberately reports `/w` as its transcript
    // cwd. That is useful adapter coverage, but a real room correctly refuses
    // a conversation outside its project. Use four of the camera rig's ACP
    // agents for room scenes while the native run reserves Codex for the
    // conversation and integrated-terminal checks.
    const roomRuntimes = process.env['HD_SHOTS_NATIVE_CODEX'] === '1'
      ? ['claude-code', 'cursor', 'gemini-cli', 'copilot']
      : ['codex', 'claude-code', 'cursor', 'gemini-cli']
    for (const runtime of roomRuntimes) {
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
    // Scene changes must dismiss floating menus as well as full-screen pages.
    // Otherwise the expanded account menu survives into the hover photographs.
    await cdp.eval(`document.dispatchEvent(new CustomEvent('hd:dismiss-overlays', { detail: { returnFocus: true } })); true`)
    await sleep(200)
    for (let remaining = 0; remaining < 4; remaining += 1) {
      if (!await click('Back to app')) break
    }
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
    conversation: { leaveOverlay: true, expect: 'Worked for', run: async () => {
      const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
      await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
      // Long enough for the scripted turn to reach its summary.
      await sleep(6500)
      // The native UI-system run uses the repository's fake Codex app-server,
      // whose representative turn pauses at a real approval. Answer it through
      // the same store verb as the Approvals surface so the scene reaches the
      // completed-turn state the camera is meant to inspect.
      if (process.env['HD_SHOTS_NATIVE_CODEX'] === '1') {
        await answerApprovals(cdp)
        await sleep(1800)
      }
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

    /** The rebuilt settings patterns, reached through the same store request features use. */
    settings: { leaveOverlay: true, expect: 'Appearance', run: async () => {
      await cdp.eval(`${STORE}.askSettings('appearance'); true`)
      await sleep(1400)
    } },

    /** The repository pane: a real graph over real git objects. */
    git: { leaveOverlay: true, expect: 'History', run: async () => {
      await cdp.eval(`${STORE}.openGitHistory(${q(REPO)}); true`)
      await sleep(2200)
    } },

    /** CodeMirror behind the canonical editor theme bridge. */
    editor: { leaveOverlay: true, expect: 'package.json', run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await cdp.eval(`${STORE}.openFile(${q(join(REPO, 'package.json'))}); true`)
      await sleep(2200)
    } },

    /** xterm behind the canonical terminal option bridge. */
    terminal: { leaveOverlay: true, run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      // Use the system's plain POSIX shell rather than the runner's configured
      // interactive shell. The latter may print a personal prompt from a real
      // dotfile; `/bin/sh -i` still exercises the process and xterm bridges
      // while keeping the evidence deterministic and publishable.
      await cdp.eval(
        `(async () => { await ${STORE}.openTerminal({ command: ['/bin/sh', '-i'] }); return true })()`,
        120_000,
      )
      await sleep(2200)
      const opened = await cdp.eval(
        `JSON.stringify(${STORE}.getSnapshot().workbench).includes('"kind":"terminal"')`,
      )
      if (!opened) {
        const diagnostic = await cdp.json(`(() => {
          const snapshot = ${STORE}.getSnapshot()
          return {
            activeRuntime: snapshot.activeRuntime,
            runtimes: snapshot.runtimes.map((runtime) => ({ id: runtime.id, health: runtime.health })),
            notices: snapshot.notices.map((notice) => notice.message),
            workbench: snapshot.workbench,
          }
        })()`)
        throw new Error(`the terminal view did not enter the native workbench: ${JSON.stringify(diagnostic)}`)
      }
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

    /**
     * Choosing a flow when a room is started, and what the dry run says it
     * would do before anything is opened.
     *
     * The report is the point of the picture: a flow opens several agents on
     * somebody's repository and keeps them working, and this is the moment —
     * before the button — when that is still a decision. So the frame wants
     * the seats, the permissions and the trace on screen together.
     */
    flow: { expect: 'Run a flow in it', run: async () => {
      stageFlow()
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await sleep(1200)
      if (!(await click('New'))) throw new Error('no New button in the title bar')
      await sleep(700)
      if (!(await click('A room'))) throw new Error('no "A room" door in the dialog')
      await sleep(700)
      await cdp.eval(`(() => {
        const input = document.querySelector('input[aria-label="Room name"]')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'Checkout hardening')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const select = document.querySelector('select[aria-label="Flow"]')
        if (!select) return false
        const option = [...select.options].find((one) => one.value.endsWith('fix-and-review.yml'))
        if (!option) return false
        const pick = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        pick.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      // The dry run is a round trip to the host, and it draws when it answers.
      await sleep(2500)
      /* The flow's own input, filled — an empty field photographs as a form
         nobody has used, and the whole point is what the run is *for*. */
      await cdp.eval(`(() => {
        const labels = [...document.querySelectorAll('label')]
        const label = labels.find((one) => one.textContent.trim() === 'What to fix')
        const input = label && document.getElementById(label.getAttribute('for'))
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'Retry the checkout call on a 502')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(900)
      /* And the report ends on a whole sentence. The dialog scrolls, so the
         default view clips the cost note mid-word — which reads as a bug in
         the layout rather than as a scroll position. */
      await cdp.eval(`(() => {
        const seats = [...document.querySelectorAll('h4')].find((one) => /It opens \\d+ agent/.test(one.textContent ?? ''))
        const box = seats?.closest('[class*="naming"]')?.parentElement
        const scroller = box && [...document.querySelectorAll('*')].find((one) => one.scrollHeight > one.clientHeight + 20 && one.contains(seats))
        if (scroller) scroller.scrollTop = scroller.scrollHeight
        return Boolean(scroller)
      })()`)
      await sleep(700)
    } },

    /**
     * A flow running: the board with every card addressed to a role, the
     * fixer's answer on its card, and a round of three reviewers open.
     *
     * Driven through the host's own verbs, so the rounds in the picture were
     * opened by the engine rather than arranged for it.
     */
    'flow-board': { leaveOverlay: true, expect: 'reviewer', run: async () => {
      stageFlow()
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await sleep(1200)
      const room = await cdp.eval(`${STORE}.createRoom(${q(REPO)}, 'Checkout hardening')`, 60_000)
      const source = await cdp.eval(`${STORE}.readFlow(${q(REPO)}, '.harnessdesk/flows/fix-and-review.yml')`, 60_000)
      await cdp.eval(
        `${STORE}.startFlow(${q(room)}, ${q(source)}, { path: '.harnessdesk/flows/fix-and-review.yml', vars: { work: 'Retry the checkout call on a 502' } })`,
        180_000,
      )
      await sleep(2500)
      /* The fixer answers, and the engine opens the review round itself — the
         person's verb over a card, which is the board's own referee rule. */
      await cdp.eval(
        `${STORE}.teamIntent(${q(room)}, 1, 'done', undefined, 'published', 'Opened #482 on fix/checkout-retry-502.')`,
        60_000,
      ).catch(() => {})
      await sleep(2000)
      /* The board beside the room, which is how a flow is actually watched:
         the channel narrates what the engine did — the fix answered
         `published`, then three reviewer cards added — and the board shows the
         round those words produced, each card wearing the role it is
         addressed to. */
      await cdp.eval(`${STORE}.openTeamBoard(${q(room)}); true`)
      await sleep(2400)
    } },

    /** The browser pane — a real `<webview>`, driven by the agent's tools. */
    browser: { leaveOverlay: true, run: async () => {
      const fixture = join(WORK, 'browser-fixture.html')
      writeFileSync(fixture, `<!doctype html>
<meta charset="utf-8">
<title>HarnessDesk browser fixture</title>
<style>body{font:16px system-ui;margin:4rem;color:#253047;background:#f7f9fc}h1{font-size:2rem}</style>
<h1>Storefront preview</h1><p>A deterministic local page inside the production Electron webview.</p>`)
      const url = pathToFileURL(fixture).href
      await cdp.eval(`${STORE}.openBrowser(${q(url)}); true`)
      let title = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        title = await cdp.eval(`document.querySelector('webview')?.getTitle?.() ?? ''`).catch(() => '')
        if (title === 'HarnessDesk browser fixture') break
        await sleep(100)
      }
      const opened = await cdp.eval(
        `JSON.stringify(${STORE}.getSnapshot().workbench).includes('"kind":"browser"')`,
      )
      if (!opened || title !== 'HarnessDesk browser fixture') {
        throw new Error(`the inline browser did not load its local fixture (title ${q(title)})`)
      }
    } },
  }

  // The review sweep records every Settings destination, including the rich
  // rows that a single Appearance frame cannot exercise.
  for (const section of ['profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive', 'agents', 'models', 'skills', 'library', 'plugins', 'permissions', 'browser']) {
    SCENES[`settings-${section}`] = { leaveOverlay: true, run: async () => {
      await cdp.eval(`${STORE}.askSettings(${q(section)}); true`)
      await sleep(1200)
      if (!await cdp.eval(`Boolean(document.querySelector(':is(section, [role="dialog"])[aria-label="Settings"]')) && !document.querySelector(':is(section, [role="dialog"])[aria-label="Dashboard"]')`)) {
        throw new Error('Settings did not become the visible window for ' + section)
      }
      if (section === 'agents') {
        // Keep an account in the frame so header and nested-row containment
        // are both exercised, not just the collapsed list's card outlines.
        await cdp.eval(`document.querySelector('button[aria-label^="Show the accounts under"]')?.click(); true`)
        await sleep(250)
      }
    } }
  }
  SCENES['composer-menu'] = { leaveOverlay: true, run: async () => {
    await SCENES.conversation.run()
    const opened = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find(e => /model and reasoning/i.test(e.title))
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!opened) throw new Error('composer model trigger missing: ' + await cdp.eval(`JSON.stringify([...document.querySelectorAll('button')].map(e => e.title).filter(Boolean))`))
    await sleep(600)
  } }
  SCENES['composer-agent-menu'] = { leaveOverlay: true, run: async () => {
    await SCENES.conversation.run()
    const opened = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find(e => /^(This conversation is with|Which agent starts this conversation)/.test(e.title))
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!opened) throw new Error('composer agent trigger missing')
    await sleep(700)
  } }
  SCENES['sidebar-menu'] = { leaveOverlay: true, run: async () => {
    const opened = await cdp.eval(`(() => {
      const button = document.querySelector('button[class*="accountRow"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!opened) throw new Error('sidebar account trigger missing')
    await sleep(700)
  } }
  SCENES['sidebar-accounts'] = { leaveOverlay: true, run: async () => {
    const triggerOpen = await cdp.eval(`document.querySelector('button[class*="accountRow"]')?.getAttribute('aria-expanded') === 'true'`)
    if (!triggerOpen) await SCENES['sidebar-menu'].run()
    const expanded = await cdp.eval(`(() => {
      const row = document.querySelector('[role="menuitem"][aria-expanded="false"]')
      if (!row) return false
      row.click()
      return true
    })()`)
    if (!expanded) throw new Error('sidebar account disclosure missing')
    await sleep(700)
  } }
  // The ordinary desk has no worktree/deleted-folder marks. Supply invented
  // history facts through the rig's wire seam so hover screenshots exercise
  // the crowded right rail rather than an empty row that could not regress.
  const stageSidebarMarks = async () => {
    await SCENES.desk.run()
    await cdp.eval(`(() => {
      const store = ${STORE}, root = ${q(REPO)}
      if (!store.__shotsSidebarMarks) {
        const real = store.transport.request.bind(store.transport)
        store.transport.request = async (method, params) => {
          const result = await real(method, params)
          if (method !== 'session/list') return result
          return { ...result, data: result.data.map((row, index) => row.cwd !== root || index > 1 ? row : {
            ...row, cwd: root + '/.worktrees/sidebar-' + index,
            repo: { root, worktree: true }, git: { branch: 'fix/sidebar-' + index }, folderGone: index === 1,
          }) }
        }
        store.__shotsSidebarMarks = true
      }
      store.setListPrefs({ pinned: [root] })
      return store.loadHistory({ reset: true })
    })()`)
    await sleep(700)
  }
  const hover = async (selector) => {
    // Hover-only actions have no box until their row is entered.
    const rowPoint = await cdp.json(`(() => {
      const node = document.querySelector(${q(selector)})?.closest('[class*="groupHead"], [class*="rowWrap"]')
      if (!node) throw new Error('missing hover row')
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rowPoint })
    await sleep(100)
    const point = await cdp.json(`(() => {
      const node = document.querySelector(${q(selector)})
      if (!node) throw new Error('missing hover target')
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await sleep(250)
  }
  SCENES['workspace-hover'] = { leaveOverlay: true, hover: '[class*="groupHead"] button[aria-haspopup="menu"]', run: async () => {
    await stageSidebarMarks()
    await hover('[class*="groupHead"] button[aria-haspopup="menu"]')
  } }
  SCENES['session-hover'] = { leaveOverlay: true, hover: '[class*="rowWrap"]:has([class*="rowGone"]) button[aria-haspopup="menu"]', run: async () => {
    await stageSidebarMarks()
    const selector = '[class*="rowWrap"]:has([class*="rowGone"]) button[aria-haspopup="menu"]'
    await hover(selector)
  } }
  SCENES['settings-extensions'] = { expect: 'MCP servers', run: async () => {
    await cdp.eval(`${STORE}.askSettings('extensions'); true`)
    await sleep(1200)
  } }

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
      if (!scene.hover) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH - 1, y: HEIGHT - 1 })
      if (scene.hover) {
        await hover(scene.hover)
        if (!await cdp.eval(`document.querySelector(${q(scene.hover)})?.matches(':hover')`)) {
          throw new Error(name + ': pointer did not hover the target: ' + await cdp.eval(`(() => {
            const node = document.querySelector(${q(scene.hover)}), r = node.getBoundingClientRect()
            return JSON.stringify({ rect: r.toJSON(), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className, pointer: getComputedStyle(node).pointerEvents, hovered: [...document.querySelectorAll(':hover')].map(node => node.className), scale: visualViewport.scale })
          })()`))
        }
      }
      await shoot(`${name}-${theme}`, scene.expect ?? null)
    }
  }
  if (has('interactive')) {
    say('Isolated app ready for native interaction. Press Return here to close it.')
    await new Promise(resolve => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
} finally {
  await closeDesk(desk).catch(() => {})
}
