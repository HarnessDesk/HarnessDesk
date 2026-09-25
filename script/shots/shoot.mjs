#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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
 *   node script/shots/shoot.mjs --scene session-hover --reduced-motion
 *                                                 # as a reader who asked for less motion sees it
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { answerApprovals, closeDesk, deskInUse, dismissNotices, launchDesk, makeRoom, seat, sleep, splitKey, STORE, waitForSnapshot } from '../lib/desk.mjs'
import { RUNTIME_ACCOUNTS as ACCOUNTS, ANONYMOUS, VOUCHED } from './accounts.mjs'
import { TILDIFY, USER, refuseUnpublishable } from './audit.mjs'
import { CAST, CONVERSATIONS, REPOS, rigRuntimeId } from './cast.mjs'
import { HOME, WORK, SHOT_ENV } from './config.mjs'
import { runScene } from './scene.mjs'
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
const PROVENANCE_SHOTS = (() => {
  const file = join(HOME, 'provenance-shots.json')
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
})()

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
  env: SHOT_ENV,
})
const { cdp } = desk
const q = (value) => JSON.stringify(value)

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false })
  /* app.css answers `prefers-reduced-motion` with a rule of its own, and the
     media query reads the system setting, which is this machine's rather than
     the take's. Emulated here, for the window alone. */
  if (has('reduced-motion')) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    say('motion reduced')
  }
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
            generatedAt: 1, home: '/home/user', runtimes: ${q(['codex', rigRuntimeId('claude-code')])}, gaps: [],
            locations: ${q(['codex', rigRuntimeId('claude-code')])}.map(runtime => ({ runtime, kind: 'skill', path: '/home/user/.agents/skills', scope: 'user', scanned: true, exists: true, readOnly: true })),
            entries: ['Accessibility audit', 'Review changes', 'Run project tests', 'Write release notes', 'Inspect workspace'].map((name, index) => ({
              kind: 'skill', name: name.toLowerCase().replaceAll(' ', '-'), title: name,
              description: 'Inspect the workspace and report actionable findings with reproducible checks and clear evidence.',
              copies: [{ path: '/home/user/.agents/skills/demo-' + index, scope: 'user', readBy: ${q(['codex', rigRuntimeId('claude-code')])}, hollow: false, digest: 'demo', readOnly: true }],
              reach: ${q(['codex', rigRuntimeId('claude-code')])}.map(runtime => ({ runtime, state: 'reaches', basis: 'scanned' })),
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
  const audit = (name) => refuseUnpublishable(cdp, {
    name, user: USER, vouched: VOUCHED,
    roots: REPOS.map(repo => join(WORK, repo.dir)),
    nativeCodex: process.env['HD_SHOTS_NATIVE_CODEX'] === '1',
  })

  /** Hide this machine's home, the one substitution a frame is allowed. */
  const tildify = async () => {
    await cdp.eval(TILDIFY(homedir()))
    // Native verification repositories may live in a unique temporary root.
    // Normalize that synthetic path too so concurrency-safe random suffixes
    // never become public screenshot content.
    await cdp.eval(TILDIFY(WORK))
    await sleep(150)
  }

  const shoot = async (name, expect = null, verify = null) => {
    // This is a normal first-run offer, not a transient snapshot.notice.
    // Dismiss it through the same persisted policy as "Not now"; leave error
    // notices alone, because an error is evidence that a scene is not ready.
    await cdp.eval(`${STORE}.dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' }); true`)
    await waitForSnapshot(
      () => cdp.eval(`document.body.innerText.includes('Your other agents have skills and servers this machine could share')`),
      shown => !shown,
    )
    await verify?.()
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
      metrics.provenance = { runtimeIds: Object.fromEntries(CAST.map(agent => [agent.id, rigRuntimeId(agent.id)])), nativeCodex: process.env['HD_SHOTS_NATIVE_CODEX'] === '1' }
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

  /**
   * Click by what it says, not by where it is — a coordinate is one build's
   * layout.
   *
   * It waits for what it is looking for rather than assuming the sleep before
   * it was long enough. Every scene reaches a control through a fixed pause,
   * and a fixed pause is a bet: the flow scene lost it once, failing on the
   * dialog's second door 700ms after opening the dialog and finding it on the
   * next run with nothing changed. Waiting turns each of those pauses into a
   * floor rather than a wager, and costs nothing on a take that was going to
   * pass anyway.
   */
  const click = async (text, within = null, { wait = 4000 } = {}) => {
    const find = () => cdp.json(
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
        /* The smallest match: once a word is on screen twice the outer one is
           usually a container that happens to contain the row you wanted. */
        const el = hits.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
        if (!el) return false
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
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hit })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...hit, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...hit, button: 'left', clickCount: 1 })
    }
    await sleep(1400)
    return Boolean(hit)
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
    seat: ${process.env['HD_SHOTS_NATIVE_CODEX'] === '1' ? `${rigRuntimeId('claude-code')}=opus` : 'codex=gpt-5.6-sol'}
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
      ? ['claude-code', 'gemini-cli', 'copilot', 'antigravity']
      : ['codex', 'claude-code', 'gemini-cli', 'copilot']
    for (const runtime of roomRuntimes) {
      keys.push(await seat(cdp, { work: REPO, runtime: rigRuntimeId(runtime), picks: {} }))
    }
    roomId = await makeRoom(cdp, { work: REPO, name: 'Checkout hardening', members: keys.map(splitKey) })

    /* Work on the board and words in the chat, through the host's own verbs.
       An empty room photographs as "Nothing said yet" beside "Nothing on the
       board", which is an accurate picture of a room nobody has used and a
       useless one of the feature. `store.transport` is public, so these are
       the same calls the interface makes when a person types them. */
    const ask = (method, params) => cdp.eval(`${STORE}.transport.request(${q(method)}, ${q(params)})`, 60_000).catch(() => {})
    for (const job of BOARD) await ask('team/add', { room: roomId, title: job.title, detail: job.detail })

    /* The work first, then the chatter — the order it happens in, and the only
       order that photographs as one.

       An agent can be asked one thing at a time, so a post to the room and a
       prompt into the same conversation in the same breath is two prompts in
       flight: one is refused now, and before the adapter refused it the room
       showed the two answers spliced into one message. Asking first and
       talking over the work also leaves each seat's opening message as what
       it was asked, which is the line the sidebar reads.

       All four work, not two: four agents on one piece of work is the thing a
       room is for, and two idle columns read as two agents that failed to
       start. */
    for (const key of keys) {
      await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000).catch(() => {})
    }
    /* Queued by the room, one per member per turn: every seat is working by
       now, and the board's own queue drains each post as a turn ends. */
    for (const line of CHATTER) await ask('team/post', { room: roomId, text: line })
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
    ...(PROVENANCE_SHOTS.length === 2 ? {
      'provenance-history': {
        leaveOverlay: true, expect: 'Associated Seat', run: async () => {
          const fixture = PROVENANCE_SHOTS[0]
          await waitForSnapshot(
            () => cdp.eval(`${STORE}.readProvenance(${q(fixture.project)}, [${q(fixture.sha)}])`),
            (value) => value?.commits?.[0]?.seats?.some((one) => one.id === fixture.seat),
          )
          await cdp.eval(`${STORE}.openGitHistory(${q(fixture.project)}); true`)
          await waitForSnapshot(
            () => cdp.eval(`Array.from(document.querySelectorAll('[role="option"]')).some(node => node.textContent.includes(${q(fixture.name)}))`),
            Boolean,
          )
          await cdp.eval(`(() => {
            const row = Array.from(document.querySelectorAll('[role="option"]')).find(node => node.textContent.includes(${q(fixture.name)}))
            if (!row) return false
            if (row.getAttribute('aria-selected') !== 'true') row.click()
            return true
          })()`)
        },
      },
      'provenance-seat': {
        leaveOverlay: true, expect: 'Seat record', run: async () => {
          await SCENES['provenance-history'].run()
          try {
            await waitForSnapshot(
              () => cdp.eval(`Boolean([...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Seat record'))`),
              Boolean,
            )
          } catch (error) {
            const fixture = PROVENANCE_SHOTS[0]
            const observed = await cdp.json(`${STORE}.readProvenance(${q(fixture.project)}, [${q(fixture.sha)}])`).catch(() => null)
            const visible = await cdp.json(`({ text: document.body.innerText.includes('Provenance'), buttons: [...document.querySelectorAll('button')].map(node => node.textContent).filter(Boolean) })`).catch(() => null)
            throw new Error(`${error instanceof Error ? error.message : String(error)}; provenance=${JSON.stringify(observed)} visible=${JSON.stringify(visible)}`)
          }
          await cdp.eval(`(() => {
            const action = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Seat record')
            action?.scrollIntoView({ block: 'center' })
            for (let parent = action?.parentElement; parent; parent = parent.parentElement) {
              if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) { parent.scrollTop = parent.scrollHeight; break }
            }
            return true
          })()`)
          await sleep(200)
          const actionState = await cdp.json(`(() => {
            const action = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Seat record')
            if (!action) return { buttons: [...document.querySelectorAll('button')].map(node => node.textContent) }
            const rect = action.getBoundingClientRect()
            return { buttons: [action.textContent], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.textContent ?? null }
          })()`)
          if (!actionState?.x || !actionState?.y || actionState.hit !== 'Seat record') throw new Error(`The history selection has no pointer-reachable Seat record action: ${JSON.stringify(actionState)}`)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: actionState.x, y: actionState.y })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: actionState.x, y: actionState.y, button: 'left', clickCount: 1 })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: actionState.x, y: actionState.y, button: 'left', clickCount: 1 })
          await waitForSnapshot(() => cdp.eval(`document.querySelector('[role="dialog"]')?.textContent.includes('Contributor 1')`), Boolean)
        },
      },
      'provenance-project': {
        leaveOverlay: true, expect: 'Capture on this machine', run: async () => {
          await cdp.eval(`${STORE}.askSettings('workspaces', ${q(PROVENANCE_SHOTS[0].project)}); true`)
          await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Capture on this machine')`), Boolean)
        },
      },
      'provenance-stopped': {
        leaveOverlay: true, expect: 'Capture stopped', run: async () => {
          await cdp.eval(`${STORE}.setCapture(${q(PROVENANCE_SHOTS[0].project)}, false)`, 60_000)
          await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('Capture stopped')`), Boolean)
        },
        finish: async () => { await cdp.eval(`${STORE}.setCapture(${q(PROVENANCE_SHOTS[0].project)}, true)`, 60_000) },
      },
    } : {}),

    /** The desk itself: twelve agents, three projects, work in the sidebar. */
    desk: { expect: 'Workspaces', run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await sleep(1500)
    } },

    /** One conversation, mid-work: reasoning, a plan and tool calls. */
    conversation: { leaveOverlay: true, expect: 'Worked for', run: async () => {
      // Native Codex remains available for the terminal smoke. Its adapter
      // fixture plays every turn in /w, so the camera conversation uses ACP
      // and the real staged repository instead.
      const runtime = process.env['HD_SHOTS_NATIVE_CODEX'] === '1' ? rigRuntimeId('claude-code') : 'codex'
      const key = await seat(cdp, { work: REPO, runtime, picks: {} })
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

    /**
     * One agent whose figures are another sign-in's: Antigravity, scoped from
     * the rail. The card is headed by that sign-in and keeps the agent's own
     * chip; the rail row beside it stays the agent's, with nothing measured.
     */
    /* Waits for the page's own sentence, not only the card's heading: the
       sentence is what said "Antigravity's own numbers" over another sign-in's
       figures until review round 1 of #769. */
    'dashboard-antigravity': { expect: "Its plan figures are the agy CLI sign-in's", run: async () => {
      if (!(await click('Dashboard'))) throw new Error('no Dashboard row in the sidebar')
      await sleep(1600)
      if (!(await click('Antigravity'))) throw new Error('no Antigravity row in the Dashboard rail')
      await sleep(1200)
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
      const path = join(REPO, 'package.json')
      const content = readFileSync(path, 'utf8')
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      if (process.env['HD_SHOTS_NATIVE_CODEX'] === '1') {
        await cdp.eval(`${STORE}.selectRuntime('codex')`, 60_000)
        // fake-codex serves an in-memory filesystem, not host disk. Copy only
        // the rig-authored file through its ordinary save/read protocol.
        const saved = await cdp.json(`${STORE}.transport.request('file/save', ${q({ runtime: 'codex', path, content, expectedHash: '' })})`)
        if (!saved?.saved) throw new Error('editor: the synthetic file was not seeded into fake Codex')
      }
      await cdp.eval(`${STORE}.openFile(${q(path)}); true`)
    }, verify: async () => {
      const path = join(REPO, 'package.json')
      const expected = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
      // A tab title passed while the pane held an error. Verify the actual
      // CodeMirror document, in each theme, before allowing a frame to leave.
      await waitForSnapshot(() => cdp.eval(`(() => {
        const editor = [...document.querySelectorAll('.cm-content')].find(node => node.getAttribute('aria-label') === ${q(path)})
        const text = editor?.textContent
        if (!text || !editor.getBoundingClientRect().height) return null
        try { return JSON.stringify(JSON.parse(text)) } catch { return null }
      })()`), content => content === expected)
    } },

    /** xterm behind the canonical terminal option bridge. */
    terminal: { leaveOverlay: true, run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      if (process.env['HD_SHOTS_NATIVE_CODEX'] === '1') await cdp.eval(`${STORE}.selectRuntime('codex')`, 60_000)
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
    room: { leaveOverlay: true, expect: 'Agents', run: async () => {
      await stageRoom()
      await cdp.eval(`${STORE}.openTeamRoom(${q(roomId)}); true`)
      await sleep(2200)
    } },

    /**
     * Creating a Goal through the visible New dialog controls.
     */
    flow: { expect: 'Checkout hardening', run: async () => {
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      await sleep(1200)
      if (!(await click('New'))) throw new Error('no New button in the title bar')
      await sleep(700)
      await pressKey('Tab')
      await pressKey('Enter')
      await waitForSnapshot(() => cdp.eval(`document.querySelector('input[aria-label="What finishes this?"]') !== null`), Boolean)
      if (!(await fill('What finishes this?', 'Checkout hardening'))) throw new Error('no Goal sentence field')
      if (!(await click('Create Goal'))) throw new Error('no Create Goal button')
      await sleep(2500)
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
      const room = await cdp.eval(`${STORE}.createGoal({ root: ${q(REPO)}, sentence: 'Checkout hardening' }).then((view) => view.goal.id)`, 60_000)
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
  for (const section of ['profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive', 'runtimes', 'models', 'skills', 'library', 'plugins', 'permissions', 'browser']) {
    SCENES[`settings-${section}`] = { leaveOverlay: true, run: async () => {
      await cdp.eval(`${STORE}.askSettings(${q(section)}); true`)
      await sleep(1200)
      if (!await cdp.eval(`Boolean(document.querySelector(':is(section, [role="dialog"])[aria-label="Settings"]')) && !document.querySelector(':is(section, [role="dialog"])[aria-label="Dashboard"]')`)) {
        throw new Error('Settings did not become the visible window for ' + section)
      }
      if (section === 'runtimes') {
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
  /*
    The composer's reasoning flyout, reached the two ways a person reaches it.
    Only the built-in Codex adapter, on its fixture, offers reasoning levels —
    the rig's ACP cast declares models and modes and nothing to think with —
    so these run in the native-Codex rig (HD_SHOTS_NATIVE_CODEX=1).

    The pointer scene walks a real path, in short steps a frame apart: from
    where a hand rests on the row, sideways out of it at the row's own height
    — which the flyout always spans, and where Base UI keeps no clock on the
    way across — then along the flyout to its first level. (A diagonal spends
    its middle over the menu's other rows, where Base UI closes a flyout the
    pointer has not reached within 40ms, so a slow machine would lose it.) The
    flyout is the subject, so the pointer stays where it ended rather than
    being parked in the corner for the frame (keepPointer). The keyboard scene
    opens the menu with Enter, walks down to the row and steps in with →.
  */
  const MODEL_TRIGGER = `[...document.querySelectorAll('button')].find(e => /model and reasoning/i.test(e.title))`
  const REASONING_ROW = `[...document.querySelectorAll('[role="menuitem"]')].find(e => /^Reasoning effort/.test(e.textContent ?? ''))`
  const FIRST_LEVEL = `document.querySelector('[data-slot="dropdown-menu-sub-content"] [role="menuitemradio"]')`
  const box = (expression) => cdp.json(`(() => {
    const node = ${expression}
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  const glide = async (from, to) => {
    const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 8))
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps
      const y = from.y + ((to.y - from.y) * step) / steps
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(8)
    }
  }
  const pressKey = async (key, { shift = false } = {}) => {
    const code = { Tab: 9, Enter: 13, ArrowDown: 40, ArrowRight: 39, ContextMenu: 93 }[key]
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 }
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    if (key === 'Enter') await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(250)
  }
  const stageCodexComposer = async () => {
    if (process.env['HD_SHOTS_NATIVE_CODEX'] !== '1') {
      throw new Error('this scene needs HD_SHOTS_NATIVE_CODEX=1: only the built-in Codex adapter, on its fixture, offers reasoning levels and a build to update')
    }
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    await cdp.eval(`${STORE}.selectRuntime('codex')`, 60_000)
    await waitForSnapshot(() => box(MODEL_TRIGGER), Boolean)
    await sleep(800)
  }
  SCENES['composer-reasoning'] = { leaveOverlay: true, keepPointer: true, expect: 'How hard the model thinks', run: async () => {
    await stageCodexComposer()
    const trigger = await box(MODEL_TRIGGER)
    const at = { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
    await waitForSnapshot(() => box(REASONING_ROW), Boolean)
    await sleep(400)
    const row = await box(REASONING_ROW)
    const rest = { x: row.x + row.width - 40, y: row.y + row.height / 2 }
    await glide({ x: rest.x, y: rest.y - 30 }, rest)
    await waitForSnapshot(() => cdp.eval(`${REASONING_ROW}?.hasAttribute('data-popup-open') ?? false`), Boolean)
    await sleep(300)
    const level = await box(FIRST_LEVEL)
    const flyout = await box(`document.querySelector('[data-slot="dropdown-menu-sub-content"]')`)
    const inside = { x: Math.min(Math.max(rest.x, flyout.x + 24), flyout.x + flyout.width - 24), y: rest.y }
    await glide(rest, inside)
    await glide(inside, { x: level.x + 40, y: level.y + level.height / 2 })
    await sleep(300)
    if (!await cdp.eval(`Boolean(${FIRST_LEVEL}?.matches(':hover'))`)) {
      throw new Error('composer-reasoning: the pointer did not reach the flyout')
    }
  } }
  SCENES['composer-reasoning-keys'] = { leaveOverlay: true, expect: 'How hard the model thinks', run: async () => {
    await stageCodexComposer()
    await cdp.eval(`${MODEL_TRIGGER}.focus(); true`)
    await pressKey('Enter')
    await waitForSnapshot(() => box(REASONING_ROW), Boolean)
    for (let step = 0; step < 12 && !await cdp.eval(`${REASONING_ROW} === document.activeElement`); step += 1) {
      await pressKey('ArrowDown')
    }
    await pressKey('ArrowRight')
    await waitForSnapshot(() => cdp.eval(`${FIRST_LEVEL} === document.activeElement`), Boolean)
  } }
  /*
    Tab and Shift+Tab leave a menu. From a row of the model menu, Tab closes
    it and moves on to what follows the trigger, and Shift+Tab closes it back
    onto the trigger; a session's context menu, opened with the context-menu
    key, gives the focus back to its row on Tab. Each scene checks only that
    its key left from a row, so it photographs any build: where the focus
    went is the frame's to show, by its ring, and the specs' to assert
    (e2e/ui-system/menu-tab.spec.ts). The scene says where it went in its own
    log line as well, because the ring is missing from a frame for the very
    reason the frame is taken; and one that cannot stage its row names what
    it was waiting for.
  */
  const reach = async (scene, what, read) => {
    try {
      await waitForSnapshot(read, Boolean)
    } catch {
      throw new Error(`${scene}: never reached ${what}`)
    }
  }
  const focusLine = () => cdp.eval(`(() => {
    const held = document.activeElement
    if (!held || held === document.body) return 'the page'
    const name = (held.getAttribute('aria-label') ?? held.getAttribute('title') ?? held.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    return held.tagName.toLowerCase() + (name ? ' “' + name + '”' : '')
      + (held.hasAttribute('data-base-ui-focus-guard') ? ' — an invisible focus guard' : '')
      + (held.closest('[role="menu"]') ? ' — in a menu that is still open' : '')
      + (held.matches(':focus-visible') ? '' : ' — no focus ring')
  })()`)
  /* What a menu does on its way out — and a context menu on its way in —
     waits for frames, which a window the rig cannot see (behind another, on
     another space) is not given: measured `visibilityState` hidden, no
     animation frame in 300ms, the focus still on the session row after the
     key, and a Popover not yet gone from under the focus it will give back.
     A capture draws one. */
  const drawFrames = async (count) => {
    for (let frame = 0; frame < count; frame += 1) {
      await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } })
      await sleep(16)
    }
  }
  const onModelRow = async (scene) => {
    await stageCodexComposer()
    // A task in the composer turns its send button on, and that button is
    // the stop after the trigger: Tab from the menu lands beside it, where
    // its ring can be seen. (Empty, the trigger is the window's last stop.)
    if (!await cdp.eval(`document.querySelector('textarea')?.value ?? ''`)) {
      await cdp.eval(`document.querySelector('textarea').focus(); true`)
      await cdp.send('Input.insertText', { text: 'Retry the checkout call on a 502' })
    }
    await cdp.eval(`${MODEL_TRIGGER}.focus(); true`)
    await pressKey('Enter')
    await reach(scene, 'the model menu', () => box(REASONING_ROW))
    await pressKey('ArrowDown')
    await reach(scene, 'a row of the model menu', () => cdp.eval(`/^menuitem/.test(document.activeElement?.getAttribute('role') ?? '')`))
  }
  SCENES['composer-model-tab'] = { leaveOverlay: true, run: async () => {
    await onModelRow('composer-model-tab')
    await pressKey('Tab')
    await drawFrames(30)
    say(`Tab from a row: the focus is on ${await focusLine()}`)
  } }
  SCENES['composer-model-shift-tab'] = { leaveOverlay: true, run: async () => {
    await onModelRow('composer-model-shift-tab')
    await pressKey('Tab', { shift: true })
    await drawFrames(30)
    say(`Shift+Tab from a row: the focus is on ${await focusLine()}`)
  } }
  const SESSION_ROW = `document.querySelector('[class*="rowWrap"] [data-slot="button"][data-variant="navigation"]')`
  SCENES['session-menu-tab'] = { leaveOverlay: true, run: async () => {
    await SCENES.desk.run()
    await reach('session-menu-tab', 'a session row in the sidebar', () => cdp.eval(`Boolean(${SESSION_ROW})`))
    await cdp.eval(`${SESSION_ROW}.focus(); true`)
    await pressKey('ContextMenu')
    await reach('session-menu-tab', 'a row of the context menu', async () => {
      await drawFrames(1)
      return cdp.eval(`document.activeElement?.getAttribute('role') === 'menuitem'`)
    })
    await pressKey('Tab')
    await drawFrames(30)
    say(`Tab from a row of the context menu: the focus is on ${await focusLine()}`)
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
  /**
   * "Review uncommitted changes", on the native Codex adapter over its
   * fixture, which plays a review notification for notification as Codex
   * 0.155.0 does and answers the deprecated detached delivery as 0.155.0
   * does. The camera cast's `codex` row is an ACP stand-in that reviews
   * nothing, so these need HD_SHOTS_NATIVE_CODEX=1.
   *
   * The same scenes photograph a build from before the change: point
   * HD_SHOTS_APP at a checkout of it, and the click is answered as it used to
   * be. FAKE_CODEX_REVIEW_MS holds the review open for a frame of it working.
   */
  let reviewed = null
  const stageReview = async () => {
    if (process.env['HD_SHOTS_NATIVE_CODEX'] !== '1') throw new Error('the review scenes need HD_SHOTS_NATIVE_CODEX=1')
    // One conversation for both scenes, put back on screen for the second.
    if (reviewed) {
      await cdp.eval(`${STORE}.openSession(${q(splitKey(reviewed).sessionId)}, { runtime: 'codex' })`, 60_000)
      await sleep(900)
      return reviewed
    }
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    await cdp.eval(`${STORE}.selectRuntime('codex')`, 60_000)
    const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
    await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
    // The fixture's turn asks before it lists the folder, and ends once answered.
    await waitForSnapshot(() => cdp.eval(`${STORE}.getSnapshot().approvals.length`), (pending) => pending > 0)
    await answerApprovals(cdp)
    await waitForSnapshot(
      () => cdp.eval(`${STORE}.getSnapshot().sessions.get(${q(key)})?.turns.at(-1)?.status ?? null`),
      (status) => status === 'completed',
    )
    // The fixture reports its own bookkeeping as warnings; none of it is the app's.
    await dismissNotices(cdp)
    await sleep(600)
    reviewed = key
    return key
  }
  /**
   * The fixture's echoes of what it was asked — `TOOLS_DECLARED …`,
   * `REVIEW …` — which exist for its tests and arrive as warnings. Only
   * those: a toast the app raised is what these frames are about.
   */
  const dismissFixtureEchoes = () => cdp.eval(`(() => {
    const store = ${STORE}
    for (const notice of store.getSnapshot().notices ?? []) {
      if (/^(TOOLS_DECLARED|REVIEW) /.test(notice.message)) store.dismissNotice(notice.id)
    }
    return true
  })()`)
  /**
   * A person's click: trusted mouse events at the middle of the element, the
   * events a pointer sends — where `click` calls the element's own `click()`.
   * Found by a selector, or by the text it starts with.
   */
  const press = async ({ selector = null, text = null }, { wait = 4000 } = {}) => {
    const locate = () => cdp.json(`(() => {
      const wanted = ${q(text)}
      const all = ${selector ? `[...document.querySelectorAll(${q(selector)})]` : `[...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].filter((e) => (e.textContent ?? '').trim().startsWith(wanted) || e.getAttribute('aria-label') === wanted)`}
      const shown = all.filter((e) => {
        if (e.closest('[aria-hidden="true"], [inert]')) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      })
      // A selector names its element: the first one, in document order. Text
      // is matched by the smallest element carrying it, as \`click\` does.
      const el = ${selector ? 'shown[0]' : 'shown.sort((a, b) => (a.textContent ?? \'\').length - (b.textContent ?? \'\').length)[0]'}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    let point = await locate()
    for (let waited = 0; !point && waited < wait; waited += 200) {
      await sleep(200)
      point = await locate()
    }
    if (!point) return false
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await sleep(900)
    return true
  }
  const openGitMenu = async () => {
    if (!(await press({ selector: 'header button[title*=" — "]' }))) throw new Error('no git control in the conversation header')
  }
  /**
   * What the store holds once the item is chosen, checked beside the frame:
   * the conversation it was chosen in exactly as it was, and — on this
   * build — the review's own conversation, named for it, on screen, holding
   * the review. A build from before the change is checked for the opposite.
   */
  const reviewState = () => cdp.json(`(() => {
    const s = ${STORE}.getSnapshot()
    const original = s.sessions.get(${q(reviewed)})
    const side = s.activeSessionKey !== ${q(reviewed)} ? s.sessions.get(s.activeSessionKey) : null
    const said = (turn) => turn.items.map((item) => item.type === 'review' ? 'review ' + item.phase : item.type)
    return {
      original: original ? original.turns.map((turn) => ({ status: turn.status, items: said(turn) })) : null,
      side: side ? { title: side.title ?? null, turns: side.turns.map((turn) => ({ status: turn.status, items: said(turn) })) } : null,
      notices: (s.notices ?? []).map((notice) => notice.level + ': ' + notice.message),
    }
  })()`)
  let untouched = null
  const checkReview = (settled) => async () => {
    const state = await reviewState()
    say(`store  ${JSON.stringify(state)}`)
    if (JSON.stringify(state.original) !== untouched) throw new Error('the conversation the review was asked from changed')
    if (process.env['HD_SHOTS_REVIEW_EXPECT']) {
      if (state.side) throw new Error('a build from before the change opened a conversation for the review')
      return
    }
    if (state.side?.title !== 'Review of uncommitted changes') throw new Error('the review did not open a conversation of its own')
    const [turn] = state.side.turns
    if (state.side.turns.length !== 1 || turn.items[0] !== 'review entered' || !settled.includes(turn.status)) {
      throw new Error(`the review's conversation does not hold one review turn that is ${settled.join(' or ')}`)
    }
    if (state.notices.some((notice) => /deprecat|detached|review\/start/.test(notice))) throw new Error('a toast still names the wire')
  }
  /** The menu, with the item on it. */
  SCENES['review-menu'] = { leaveOverlay: true, expect: 'Review uncommitted changes', run: async () => {
    await stageReview()
    await openGitMenu()
  } }
  /**
   * What choosing it does: the review in a conversation of its own, and what
   * it found — or, held open by FAKE_CODEX_REVIEW_MS, the review working.
   * HD_SHOTS_REVIEW_EXPECT names what a build from before the change shows
   * instead.
   */
  SCENES.review = {
    leaveOverlay: true,
    expect: process.env['HD_SHOTS_REVIEW_EXPECT'] ?? 'Review of uncommitted changes',
    run: async () => {
      await stageReview()
      untouched = JSON.stringify((await reviewState()).original)
      await openGitMenu()
      if (!(await press({ text: 'Review uncommitted changes' }))) throw new Error('no "Review uncommitted changes" in the git menu')
      await sleep(1500)
      await dismissFixtureEchoes()
      // Unfolded, as the conversation scene is: the review's steps are the point.
      await click('Worked', null, { wait: 1500 })
    },
    verify: checkReview(['completed', 'inProgress']),
  }
  /**
   * Stopped halfway, which is Codex's own check to pass: the stop has to name
   * the reviewer's turn, which the desk never shows. Needs the review held
   * open (FAKE_CODEX_REVIEW_MS) long enough to be stopped.
   */
  SCENES['review-stopped'] = {
    leaveOverlay: true,
    expect: 'Review was interrupted',
    run: async () => {
      await SCENES.review.run()
      if (!(await press({ text: 'Stop' }))) throw new Error('no Stop button while the review runs — is FAKE_CODEX_REVIEW_MS set?')
      await sleep(1200)
    },
    verify: checkReview(['interrupted']),
  }

  /**
   * A command waiting on its answer, on the native Codex adapter over its
   * fixture, whose first turn asks before it lists the folder.
   *
   * What a frame cannot say is whether the answers take a pointer, and that
   * went unseen for two days: the dialog's own scrim was painted over its
   * buttons, so a click on Allow, Allow for this session or Deny landed on
   * `dialog-overlay` while the digit keys answered everything. jsdom does no
   * hit-testing and this rig answered approvals through the store, so nothing
   * could see it. These scenes ask the window. HD_SHOTS_APPROVAL_EXPECT=covered
   * names what a build from before the fix shows instead: the same read, with
   * every answer under the scrim.
   */
  const askApproval = async () => {
    if (process.env['HD_SHOTS_NATIVE_CODEX'] !== '1') throw new Error('the approval scenes need HD_SHOTS_NATIVE_CODEX=1: only the built-in Codex adapter, on its fixture, asks')
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    await cdp.eval(`${STORE}.selectRuntime('codex')`, 60_000)
    const key = await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
    await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
    await waitForSnapshot(() => cdp.eval(`${STORE}.getSnapshot().approvals.filter((entry) => entry.key === ${q(key)}).length`), (pending) => pending > 0)
    // The store holds the ask a commit before the dialog is drawn.
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[data-slot="approval-dialog-scope"] [role="dialog"] button') !== null`),
      Boolean,
    )
    // The fixture's own bookkeeping arrives as a warning over the pane.
    await sleep(600)
    await dismissFixtureEchoes()
    return key
  }
  /** What a pointer at the middle of each answer would land on. */
  const approvalAnswers = () => cdp.json(`(() => {
    const dialog = document.querySelector('[data-slot="approval-dialog-scope"] [role="dialog"]')
    return [...(dialog?.querySelectorAll('button') ?? [])].map((button) => {
      const box = button.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      const shortcut = button.querySelector('[class*="shortcut"]')
      return {
        answer: [...button.childNodes].filter((node) => node !== shortcut).map((node) => node.textContent).join('').trim(),
        reachable: button.contains(hit),
        lands: hit?.getAttribute('data-slot') ?? hit?.tagName.toLowerCase() ?? null,
      }
    })
  })()`)
  const checkAnswers = async () => {
    const answers = await approvalAnswers()
    say(`answers ${answers.map((one) => `${one.answer} → ${one.lands}`).join(' · ')}`)
    // Codex offers three: accept, accept for the session, decline.
    if (answers.length !== 3) throw new Error(`the approval offers ${answers.length} answers, not Allow, Allow for this session and Deny`)
    if (process.env['HD_SHOTS_APPROVAL_EXPECT'] === 'covered') {
      if (answers.some((one) => one.reachable)) throw new Error('a build from before the fix let a pointer reach an answer')
      return
    }
    const covered = answers.filter((one) => !one.reachable)
    if (covered.length) throw new Error(`a pointer cannot reach ${covered.map((one) => `${one.answer} (it lands on ${one.lands})`).join(', ')}`)
  }
  /** The dialog waiting, with every answer under a pointer. */
  SCENES.approval = {
    leaveOverlay: true,
    expect: 'Run this command?',
    run: async () => { await askApproval() },
    verify: checkAnswers,
  }
  /**
   * And answered the way a person answers it: a trusted click at the middle
   * of Deny. The store is read beside the frame — the question gone, the turn
   * over — because a click that reached the scrim leaves the question where
   * it was.
   */
  SCENES['approval-denied'] = {
    leaveOverlay: true,
    expect: 'ls -la',
    run: async () => {
      const key = await askApproval()
      if (!(await press({ text: 'Deny' }))) throw new Error('no Deny under a pointer: something is painted over the answers')
      await waitForSnapshot(() => cdp.eval(`${STORE}.getSnapshot().approvals.filter((entry) => entry.key === ${q(key)}).length`), (pending) => pending === 0)
      await waitForSnapshot(
        () => cdp.eval(`${STORE}.getSnapshot().sessions.get(${q(key)})?.turns.at(-1)?.status ?? null`),
        (status) => status === 'completed',
      )
      await dismissNotices(cdp)
      // Unfolded, as the conversation scene is: the step that was refused is the point.
      await click('Worked', null, { wait: 1500 })
    },
  }

  /**
   * The model menu's footer when the build it names is behind a published one,
   * and after "Refresh models" has moved Codex onto that build. The footer once
   * kept its notice — "Codex 0.155.0 is available" under "Codex 0.155.0" —
   * because the notice was measured once, before the move.
   *
   * The fixture is upgraded the way a person upgrades Codex under an open
   * app: the file FAKE_CODEX_VERSION_FILE names is written with the newest
   * published release, which the app's own notice names, and the next check
   * finds it. Needs HD_SHOTS_NATIVE_CODEX=1, and the npm registry to answer:
   * without a notice to start from the scene stops rather than photograph
   * nothing. HD_SHOTS_UPDATE_EXPECT=stale is what a build from before the
   * change shows after the refresh: the notice still there.
   */
  const codexFooter = () => cdp.json(`(() => {
    const codex = ${STORE}.getSnapshot().runtimes.find((runtime) => runtime.id === 'codex')
    const lines = document.body.innerText.split('\\n').filter((line) => /^Codex \\d/.test(line) || / is available\\./.test(line))
    return { version: codex?.version ?? null, notice: codex?.update?.version ?? null, footer: lines, page: document.visibilityState }
  })()`)
  const MODEL_CONTROL = 'button[title$="odel and reasoning"]'
  /**
   * Open is what the control says, with the menu's rows on the page. The rows
   * alone are not enough: a menu that has been closed stays in the page until
   * its exit transition ends, and a window nobody can see — behind others, on
   * another desktop — runs no transitions, so it stays as long as that lasts.
   */
  const menuOpen = () => cdp.eval(`(() => {
    const control = document.querySelector(${q(MODEL_CONTROL)})
    const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) => /^Refresh models/.test(e.textContent ?? ''))
    return control?.getAttribute('aria-expanded') === 'true' && Boolean(row)
  })()`)
  const openModelMenu = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await menuOpen())) {
        if (!(await press({ selector: MODEL_CONTROL }))) throw new Error('composer model trigger missing')
        await waitForSnapshot(menuOpen, Boolean)
      }
      await sleep(500)
      if (await menuOpen()) return
    }
    throw new Error(`the model menu would not stay open (the page is ${await cdp.eval('document.visibilityState')})`)
  }
  /**
   * "Refresh models", pointed at when the row can be. In a window nobody can
   * see the menu's open transition never ends, and until it does the menu
   * takes no pointer — the row is on the page and cannot be hit — so the
   * click is the row's own then. What is photographed is the same either way.
   */
  const refreshModels = async () => {
    if (await press({ text: 'Refresh models' }, { wait: 1500 })) return
    const clicked = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) => /^Refresh models/.test(e.textContent ?? ''))
      if (!row) return false
      row.click()
      return true
    })()`)
    if (!clicked) throw new Error('no "Refresh models" in the model menu')
    await sleep(900)
  }
  let behind = null
  let installed = null
  const stageUpdateNotice = async () => {
    if (behind) return behind
    await stageCodexComposer()
    // The check answers a beat after the runtime is up, and asks the registry.
    behind = await waitForSnapshot(codexFooter, (state) => state.notice !== null, { attempts: 300 }).catch((error) => {
      throw new Error(`no update notice to start from — does the npm registry answer? ${error.message}`)
    })
    return behind
  }
  SCENES['model-menu-update'] = {
    leaveOverlay: true,
    expect: ' is available.',
    run: async () => {
      await stageUpdateNotice()
      await openModelMenu()
    },
    verify: async () => {
      const state = await codexFooter()
      say(`footer ${JSON.stringify(state)}`)
      if (state.footer.length < 2) throw new Error('the footer does not name the build and the newer one')
    },
  }
  SCENES['model-menu-updated'] = {
    leaveOverlay: true,
    expect: 'models checked',
    run: async () => {
      const { notice: latest } = await stageUpdateNotice()
      installed = latest
      writeFileSync(SHOT_ENV.FAKE_CODEX_VERSION_FILE, `${latest}\n`)
      await openModelMenu()
      await refreshModels()
      await waitForSnapshot(codexFooter, (state) => state.version?.includes(latest), { attempts: 300 })
      // A beat for the notice to be measured against the build it is on now.
      await sleep(1500)
      // The refresh closes the menu; it is opened again onto the footer, which
      // has to be on screen — an empty footer would prove nothing about the notice.
      await openModelMenu()
      await waitForSnapshot(codexFooter, (state) => state.footer.some((line) => line.startsWith(`Codex ${latest}`)), { attempts: 100 })
    },
    verify: async () => {
      const state = await codexFooter()
      say(`footer ${JSON.stringify(state)}`)
      if (process.env['HD_SHOTS_UPDATE_EXPECT'] === 'stale') {
        if (state.notice === null) throw new Error('a build from before the change was expected to keep its notice')
        return
      }
      if (!state.footer.some((line) => line.startsWith(`Codex ${installed}`))) {
        throw new Error(`the footer does not name the build it is on: ${JSON.stringify(state)}`)
      }
      if (state.notice !== null || state.footer.some((line) => / is available\./.test(line))) {
        throw new Error('the footer still says a newer build is available, under the build it names')
      }
    },
  }

  SCENES['settings-extensions'] = { expect: 'MCP servers', run: async () => {
    await cdp.eval(`${STORE}.askSettings('extensions'); true`)
    await sleep(1200)
  } }

  /**
   * One agent's own page, headed by the detail head: mark, name, build, the
   * agent's tagline, and the action that makes it the default.
   *
   * The list frame above it cannot show this head, and the head is where a
   * blurb and a row of actions compete for one line — so the narrow takes of
   * this scene are the ones that say whether the sentence is still readable.
   */
  SCENES['settings-agent-detail'] = { leaveOverlay: true, expect: 'Registration', run: async () => {
    await cdp.eval(`${STORE}.askSettings('agents'); true`)
    await sleep(1200)
    /* A trusted press, at the row's own mark: the name is a `RowButton`, whose
       click handler sits above the element the class names, so a synthetic
       `click()` on that element opens nothing and the take reads as a scene
       that never navigated. */
    const spot = await cdp.json(`(() => {
      const heads = [...document.querySelectorAll('[class*="headOpen"]')]
      const row = heads.find((node) => /Cursor/.test(node.textContent ?? ''))
      if (!row) return false
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    if (!spot) throw new Error('no agent row to open in Settings › Agents')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...spot })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...spot, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...spot, button: 'left', clickCount: 1 })
    await sleep(1200)
    if (!await cdp.eval(`Boolean(document.querySelector('[class*="detailHead"]'))`)) {
      throw new Error('the agent page did not draw its detail head')
    }
  } }

  /* ------------------------------------ when an agent's own history is wrong */

  /**
   * Three scenes for what the desk says when an agent's history cannot be
   * trusted. None of them writes the sentence itself: each flips a file beside
   * the agent's store, which `agent.mjs` reads on every listing, so the frame
   * is the real adapter and host answering a real error. A scene puts the file
   * back in `finish`, so the next scene, and the next take, start whole.
   *
   * The first two leave a banner on screen, so each is shot in a take of its
   * own: an error stays until it is put away, and would ride along in the
   * frame of whatever is shot after it.
   */
  const storeOf = (agent) => join(HOME, 'stores', `${agent}.json`)
  const switchFile = (agent, suffix) => storeOf(agent).replace(/\.json$/, `.${suffix}`)

  /**
   * A sidebar row whose agent has since stopped listing it, clicked. The app
   * will not reopen a conversation in a folder nobody vouched for, and says
   * which conversation, and why.
   */
  let forgotten = null
  SCENES['resume-refused'] = {
    leaveOverlay: true,
    expect: 'so the folder it worked in is not known',
    run: async () => {
      await SCENES.desk.run()
      const title = 'Pin the flaky inventory test'
      await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes(${q(title)})`), Boolean)
      // History cleared in another window: the sidebar still has the row, the agent no longer does.
      forgotten = readFileSync(storeOf('claude-code'), 'utf8')
      const rows = JSON.parse(forgotten)
      delete rows['claude-code-1']
      writeFileSync(storeOf('claude-code'), JSON.stringify(rows, null, 1))
      if (!(await click(title))) throw new Error(`no "${title}" row in the sidebar`)
    },
    finish: () => {
      if (forgotten) writeFileSync(storeOf('claude-code'), forgotten)
      forgotten = null
    },
  }

  /**
   * The agent the sidebar is listing cannot answer. The sidebar keeps the
   * history it had and says why, where it used to show only what was open.
   */
  const listAgain = async () => {
    await cdp.eval(`${STORE}.loadHistory({ reset: true })`, 60_000)
    await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('could not list its conversations')`), Boolean, { attempts: 60 })
  }
  SCENES['history-list-failed'] = {
    expect: 'could not list its conversations',
    run: async () => {
      await SCENES.desk.run()
      await cdp.eval(`${STORE}.selectRuntime(${q(rigRuntimeId('claude-code'))})`, 60_000)
      writeFileSync(switchFile('claude-code', 'list-fails'), '')
      await listAgain()
    },
    // A warning fades on its own; each theme's frame asks again if it has.
    verify: async () => {
      if (!(await cdp.eval(`document.body.innerText.includes('could not list its conversations')`))) await listAgain()
    },
    finish: () => rmSync(switchFile('claude-code', 'list-fails'), { force: true }),
  }

  /**
   * A turn the agent could not run. The reason stands in the conversation as
   * the same alert every other failed action uses.
   */
  SCENES['turn-failed'] = {
    leaveOverlay: true,
    expect: 'owned by another process',
    run: async () => {
      writeFileSync(switchFile('claude-code', 'prompt-fails'), '')
      const key = await seat(cdp, { work: REPO, runtime: rigRuntimeId('claude-code'), picks: {} })
      await cdp.eval(`${STORE}.send([{ type: 'text', text: 'Retry the checkout call on a 502' }], ${q(key)})`, 60_000)
      await waitForSnapshot(() => cdp.eval(`document.body.innerText.includes('owned by another process')`), Boolean, { attempts: 60 })
      // The same reason also arrives as a toast, over the question it answers.
      await dismissNotices(cdp).catch(() => {})
    },
    finish: () => rmSync(switchFile('claude-code', 'prompt-fails'), { force: true }),
  }

  /**
   * Every agent answering one row a page, as ACP allows. The sidebar lists
   * whole what an agent has; taken against a build from before the change, it
   * lists the first page of each and nothing after it.
   */
  SCENES['history-paged'] = {
    expect: 'Make the webhook receiver',
    run: async () => {
      for (const agent of CAST) writeFileSync(switchFile(agent.id, 'page'), '1')
      await SCENES.desk.run()
      await cdp.eval(`${STORE}.loadHistory({ reset: true })`, 60_000)
      await sleep(1500)
    },
    verify: async () => {
      say(`conversations listed: ${await cdp.eval(`${STORE}.getSnapshot().history.length`)} of ${Object.values(CONVERSATIONS).flat().length}`)
    },
    finish: () => {
      for (const agent of CAST) rmSync(switchFile(agent.id, 'page'), { force: true })
    },
  }

  /* ------------------------------------------------------------ Agents */

  const PROJECT_AGENT = join(REPO, '.harnessdesk', 'agents', 'code-reviewer', 'AGENT.md')

  /** What an earlier Agent scene may have left up: the refusal sheet, a dialog, the palette. */
  const clearAgentScenes = async () => {
    await cdp.eval(`${STORE}.dismissSeatRefusal(); true`)
    for (let n = 0; n < 2; n += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(150)
    }
  }

  /** The storefront open, and its roster and seats read, before a surface draws them. */
  const openStorefront = async () => {
    await clearAgentScenes()
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    await cdp.eval(`${STORE}.loadAgents()`, 120_000)
    await sleep(900)
  }

  /** Types into an input found by its label, the way the flow scene fills its dialog. */
  const fill = (label, value) => cdp.eval(`(() => {
    const tag = [...document.querySelectorAll('label')].find((one) => one.textContent.trim() === ${q(label)})
    const input = (tag && document.getElementById(tag.getAttribute('for'))) || document.querySelector('[aria-label=' + JSON.stringify(${q(label)}) + ']')
    if (!input) return false
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${q(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  Object.assign(SCENES, {
    /** The top-level Agents window: three sections and the project's reviewer shadowing the one that ships. */
    'settings-agents': { leaveOverlay: true, expect: 'Shadowed by the one in storefront', run: async () => {
      await openStorefront()
      if (!(await click('Agents'))) throw new Error('no Agents row in the sidebar')
      await sleep(1400)
    } },

    /** An Agent's page: its file, its ceiling, its own seats muted, and this Mac's. */
    'agent-page': { leaveOverlay: true, expect: 'On this Mac', run: async () => {
      await openStorefront()
      if (!(await click('Agents'))) throw new Error('no Agents row in the sidebar')
      if (!(await click('Code reviewer', '[role="dialog"][aria-label="Agents"]'))) throw new Error('no Code reviewer in the Agents window')
      await sleep(1400)
    } },

    /** Workspaces › a project: its own Agents, and the folder they are read from. */
    'project-page': { leaveOverlay: true, expect: 'Its own, read from', run: async () => {
      await openStorefront()
      await cdp.eval(`${STORE}.askSettings('workspaces', ${q(REPO)}); true`)
      await sleep(1400)
    } },

    /** The new-session dialog: Agents first, and the one that cannot be seated greyed with why. */
    'new-session-agents': { leaveOverlay: true, expect: 'Windsurf is signed out', run: async () => {
      await openStorefront()
      if (!(await click('New'))) throw new Error('no New button in the title bar')
      await sleep(1200)
      if (!(await cdp.eval(`document.body.innerText.includes('As an Agent')`))) throw new Error('the dialog lists no Agents')
    } },

    /** Command palette, through the sidebar's magnifier: an Agent to start as. */
    'palette-agents': { leaveOverlay: true, expect: 'Start as Code reviewer', run: async () => {
      await openStorefront()
      if (!(await click('Search everything'))) throw new Error('no search in the sidebar')
      await sleep(600)
      await cdp.eval(`(() => {
        const input = document.querySelector('[role="dialog"] input')
        if (!input) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Start as')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(900)
    } },

    /** Start as Code reviewer: headed by it, and its name card names the seat and the one passed over. */
    'conversation-agent-card': {
      leaveOverlay: true,
      expect: 'Seated on Claude · Opus',
      // CDP's pointer can land on the seven-pixel glyph while Chromium reports
      // only the row as hovered at a 2x device scale. Open the same card by
      // keyboard focus on its padded trigger, then require the real portal and
      // its contents. The component deliberately supports that path too.
      keepPointer: true,
      run: async () => {
        await openStorefront()
        const key = await cdp.eval(`${STORE}.startAsAgent('code-reviewer')`, 180_000)
        if (!key) throw new Error('Code reviewer was not seated: ' + await cdp.eval(`JSON.stringify(${STORE}.getSnapshot().seatRefusal)`))
        await sleep(6500)
        const headed = await cdp.eval(`[...document.querySelectorAll('header [class*="title"]')].some((one) => (one.textContent ?? '').startsWith('Code reviewer'))`)
        if (!headed) throw new Error('the conversation is not headed Code reviewer')
        writeFileSync(PROJECT_AGENT, `${readFileSync(PROJECT_AGENT, 'utf8')}\nRead docs/checkout.md before the diff.\n`)
        await sleep(2500)
        const opened = await cdp.eval(`(() => {
          const trigger = document.querySelector('button[data-active] [class*="statusTarget"]')
          if (!trigger) return false
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }))
          trigger.focus()
          return true
        })()`)
        if (!opened) throw new Error('the active conversation has no name-card trigger')
        await waitForSnapshot(
          () => cdp.eval(`document.querySelector('[data-slot="agent-card"]')?.textContent ?? ''`),
          (text) => text.includes('Seated on Claude · Opus'),
        )
      },
      verify: async () => {
        await waitForSnapshot(
          () => cdp.eval(`document.querySelector('[data-slot="agent-card"]')?.textContent ?? ''`),
          (text) => text.includes('Passed over Windsurf') && text.includes('The brief has changed since this started.'),
        )
      },
    },

    /** The refusal sheet: every seat, its reason and its fix — and nothing opened. */
    'refusal-sheet': { leaveOverlay: true, expect: 'Nothing was opened.', run: async () => {
      await openStorefront()
      const before = await cdp.eval(`${STORE}.getSnapshot().sessions.size`)
      const key = await cdp.eval(`${STORE}.startAsAgent('release-checker')`, 180_000)
      await sleep(1200)
      const after = await cdp.eval(`${STORE}.getSnapshot().sessions.size`)
      if (key !== null || after !== before) throw new Error(`a refused seating opened something (${before} → ${after})`)
      const listed = await cdp.eval(`${STORE}.getSnapshot().seatRefusal?.candidates.length ?? 0`)
      if (listed !== 2) throw new Error(`the sheet lists ${listed} candidates, not both`)
      if (!(await cdp.eval(`document.body.innerText.includes('Sign in to Windsurf')`))) {
        throw new Error('the signed-out candidate offers no Sign in')
      }
    } },

    /** Save as an Agent…, from a conversation's menu, with its name typed. */
    'save-as-agent': { leaveOverlay: true, expect: 'Save and open the brief', run: async () => {
      await openStorefront()
      await seat(cdp, { work: REPO, runtime: 'codex', picks: {} })
      await sleep(1500)
      if (!(await click('Conversation'))) throw new Error('no conversation menu')
      if (!(await click('Save as an Agent…'))) throw new Error('no Save as an Agent… in its menu')
      if (!(await fill('Name', 'Checkout reviewer'))) throw new Error('no Name field')
      await fill('What it is for', 'Reads checkout changes against the storefront’s rules.')
      await sleep(700)
    } },

    /** A room's +: the project's Agents first, each with the seat it would take there. */
    'add-member-agents': { leaveOverlay: true, expect: 'Who joins', run: async () => {
      await clearAgentScenes()
      await stageRoom()
      await cdp.eval(`${STORE}.openTeamRoom(${q(roomId)}); true`)
      await sleep(1500)
      if (!(await click('Add an agent to the room'))) throw new Error('no + on the room’s roster')
      await sleep(1800)
    } },
  })
  /**
   * Seating a conversation as an Agent: its brief is a real turn, but it must
   * never appear as if a person had typed it — no bubble, no title drawn from
   * it. `agent/seat` has no button yet, so this calls it the way `editor`
   * calls `file/save`: straight through `store.transport`, which is a public
   * field and exercises the real transcript and title the same as a click
   * would once one exists.
   */
  const AGENT_HOME = join(HOME, 'agents', 'reviewer')
  let agentKey = null
  SCENES['agent'] = {
    leaveOverlay: true,
    expect: 'Reviewer',
    run: async () => {
      mkdirSync(AGENT_HOME, { recursive: true })
      writeFileSync(
        join(AGENT_HOME, 'AGENT.md'),
        [
          '---',
          'name: Reviewer',
          'permission: read',
          'prefer: [codex]',
          '---',
          'Review the diff for correctness. Say one short sentence about what you would check first, then stop.',
        ].join('\n'),
      )
      await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
      const session = await cdp.json(`${STORE}.transport.request('agent/seat', ${q({ id: 'reviewer', cwd: REPO })})`, 60_000)
      // `sessionKey`'s own format (`packages/protocol/src/ids.ts`): runtime, a NUL, the id.
      agentKey = `${session.runtime}\u0000${session.id}`
      await cdp.eval(`${STORE}.openSession(${q(String(session.id))}, ${q({ runtime: session.runtime })})`, 60_000)
      await sleep(4000)
    },
    verify: async () => {
      // The very defect this scene exists to prove absent, checked the same
      // way the fix's own test does: the brief's turn item must never be a
      // `userMessage` — read as something the person said — whatever text
      // happens to be on screen. (A `notice` row legitimately still shows the
      // brief's own words, dimmed, which is why this does not just grep the
      // page for them.)
      const items = await cdp.json(`(${STORE}.getSnapshot().sessions.get(${q(agentKey)})?.turns ?? []).flatMap(t => t.items).map(i => i.type)`)
      if (!Array.isArray(items) || items.length === 0) throw new Error('agent: no turn items were read back for the seated conversation')
      if (items.includes('userMessage')) throw new Error(`agent: the brief was recorded as userMessage — ${JSON.stringify(items)}`)
      if (!items.includes('notice')) throw new Error(`agent: no notice item carries the brief — ${JSON.stringify(items)}`)
    },
    finish: () => {
      agentKey = null
      rmSync(AGENT_HOME, { recursive: true, force: true })
    },
  }

  /* ---------------------------------------------------------- evidence */

  let evidenceRoom = null
  const stageEvidence = async () => {
    if (evidenceRoom) return evidenceRoom
    await cdp.eval(`${STORE}.openWorkspace(${q(REPO)})`, 120_000)
    evidenceRoom = await makeRoom(cdp, { work: REPO, name: 'Release checks', members: [] })
    await cdp.eval(`${STORE}.teamAdd(${q(evidenceRoom)}, { title: 'Retry the checkout call on a 502' })`, 60_000)
    await cdp.eval(`${STORE}.teamIntent(${q(evidenceRoom)}, 1, 'done')`, 60_000)
    await cdp.eval(`${STORE}.openTeamBoard(${q(evidenceRoom)}); true`)
    await sleep(1500)
    return evidenceRoom
  }

  const runVerify = async () => {
    if (!(await press({ selector: 'button[aria-label="What to do with #1"]' }, { wait: 600 }))) {
      throw new Error('card #1 has no menu')
    }
    if (!(await click('Run verify', '[role="menu"]'))) throw new Error('card #1 offers no Run verify')
  }

  const cardOne = () =>
    cdp.json(`(() => {
      const card = [...document.querySelectorAll('[data-slot="board-card"]')]
        .find((one) => (one.textContent ?? '').includes('Retry the checkout call on a 502'))
      return {
        text: card?.textContent ?? '',
        column: card?.closest('[data-slot="board-column"]')?.querySelector('h3')?.textContent ?? null,
      }
    })()`)

  const cardSays = (matches) => waitForSnapshot(cardOne, matches, { attempts: 600 })

  SCENES['evidence-ask'] = {
    leaveOverlay: true,
    expect: 'Run verify on this Mac for the first time?',
    run: async () => {
      await stageEvidence()
      await runVerify()
    },
    verify: async () => {
      const shown = await cdp.eval(`document.querySelector('[role="alertdialog"] pre')?.textContent ?? ''`)
      if (shown !== 'node --test') throw new Error(`the question shows ${q(shown)}, not the command verbatim`)
      const said = await cdp.eval(`document.querySelector('[role="alertdialog"]')?.textContent ?? ''`)
      if (!said.includes('It runs with your full authority, as it would in your terminal')) {
        throw new Error('the question does not say what running it means')
      }
      if ((await cardOne()).text.includes('verify ✓')) throw new Error('verify ran before anyone answered')
    },
  }

  const armed = () =>
    waitForSnapshot(
      () =>
        cdp.eval(
          `[...document.querySelectorAll('[role="alertdialog"] button')].some((one) => one.textContent?.trim() === 'Run verify' && !one.disabled)`,
        ),
      Boolean,
      { attempts: 50 },
    )

  SCENES['evidence-fresh'] = {
    expect: 'verify ✓ @',
    run: async () => {
      await armed()
      if (!(await click('Run verify', '[role="alertdialog"]'))) throw new Error('the question has no Run verify')
      await cardSays(
        (card) => card.column === 'Ready' && /verify ✓ @[0-9a-f]{7}/.test(card.text) && !card.text.includes('since'),
      )
    },
  }

  SCENES['evidence-observed'] = {
    expect: 'What the desk observed on #1',
    run: async () => {
      if (!(await press({ selector: 'button[aria-label^="What the desk observed on #1"]' }, { wait: 600 }))) {
        throw new Error('card #1 carries no evidence row')
      }
    },
    verify: async () => {
      const text = await cdp.eval(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
      for (const words of ['Fresh: nothing has landed on its branch since.', 'node --test', 'It exited 0.']) {
        if (!text.includes(words)) throw new Error(`the dialog does not say ${q(words)}`)
      }
    },
  }

  SCENES['evidence-stale'] = {
    expect: '1 commit since',
    run: async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      execFileSync('git', ['-C', REPO, 'commit', '--allow-empty', '-q', '-m', 'Log the retry count'], { stdio: 'pipe' })
      await cdp.eval(`${STORE}.loadBoardEvidence(${q(evidenceRoom)})`, 60_000)
      await cardSays(
        (card) =>
          card.column === 'Needs you' &&
          card.text.includes('verify out of date') &&
          card.text.includes('1 commit since'),
      )
    },
  }

  SCENES['evidence-refreshed'] = {
    expect: 'verify ✓ @',
    run: async () => {
      await runVerify()
      await sleep(400)
      if (await cdp.eval(`Boolean(document.querySelector('[role="alertdialog"]'))`)) {
        throw new Error('a command this Mac has approved asked again')
      }
      await cardSays((card) => card.column === 'Ready' && /verify ✓ @[0-9a-f]{7}/.test(card.text))
    },
  }

  SCENES['evidence-unavailable'] = {
    expect: 'Evidence unavailable',
    run: async () => {
      await stageEvidence()
      await cdp.eval(`(async () => {
        const store = ${STORE}
        const room = ${q(evidenceRoom)}
        const snapshot = store.getSnapshot()
        snapshot.boardEvidence.delete(room)
        snapshot.boardEvidenceFailed.delete(room)
        const request = store.transport.request.bind(store.transport)
        store.transport.request = async (method, params) => {
          if (method === 'evidence/board') throw new Error('synthetic unavailable evidence')
          return request(method, params)
        }
        await store.loadBoardEvidence(room)
        return true
      })()`)
      await waitForSnapshot(
        () => cdp.eval(`document.body.innerText.includes('Evidence unavailable')`),
        Boolean,
      )
    },
    verify: async () => {
      const card = await cardOne()
      const text = await cdp.eval(`document.body.innerText`)
      if (card.text) {
        throw new Error('Facts must be hidden until the first evidence read succeeds')
      }
      if (text.includes('nothing checked')) {
        throw new Error('an unavailable evidence read was presented as nothing checked')
      }
    },
  }

  const seatRecordSays = async () => {
    const text = await cdp.eval(`document.querySelector('[aria-label="Seat record"]')?.textContent ?? ''`)
    for (const words of ['Code reviewer', 'In storefront', 'Read · asked']) {
      if (!text.includes(words)) throw new Error(`the Seat record does not say ${q(words)}: ${q(text)}`)
    }
  }

  SCENES['seat-record'] = {
    leaveOverlay: true,
    expect: 'Seat record',
    run: async () => {
      await openStorefront()
      const key = await cdp.eval(`${STORE}.startAsAgent('code-reviewer')`, 180_000)
      if (!key) throw new Error('Code reviewer was not seated')
      writeFileSync(join(HOME, 'seat-record-scene.json'), `${JSON.stringify({ key })}\n`)
      await cdp.eval(`${STORE}.openDetailsTab('agents'); true`)
      await sleep(2500)
    },
    verify: seatRecordSays,
  }

  SCENES['project-checks'] = {
    leaveOverlay: true,
    expect: 'node --test',
    run: async () => {
      await cdp.eval(`${STORE}.askSettings('workspaces', ${q(REPO)}); true`)
      await sleep(1500)
    },
    verify: async () => {
      const text = await cdp.eval(`document.querySelector('section[aria-label="Checks"]')?.textContent ?? ''`)
      if (!text.includes('Approved on this Mac')) {
        throw new Error(`the project's checks do not say verify was approved here: ${q(text)}`)
      }
    },
  }

  SCENES['seat-record-restarted'] = {
    leaveOverlay: true,
    expect: 'Seat record',
    run: async () => {
      const { key } = JSON.parse(readFileSync(join(HOME, 'seat-record-scene.json'), 'utf8'))
      const { runtime, sessionId } = splitKey(key)
      await openStorefront()
      const record = await cdp.json(`${STORE}.seatRecord(${q(runtime)}, ${q(sessionId)})`, 60_000)
      if (record?.agent?.id !== 'code-reviewer') {
        throw new Error(`no Seat record for Code reviewer after the restart: ${q(record)}`)
      }
      await cdp.eval(`${STORE}.openSession(${q(sessionId)}, { runtime: ${q(runtime)} })`, 120_000)
      await cdp.eval(`${STORE}.openDetailsTab('agents'); true`)
      await sleep(2500)
    },
    verify: seatRecordSays,
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
    await runScene(scene, {
      leaveOverlay,
      themes: THEMES,
      photograph: async (theme) => {
        await setTheme(theme)
        if (!scene.hover && !scene.keepPointer) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH - 1, y: HEIGHT - 1 })
        if (scene.hover) {
          await hover(scene.hover)
          if (!await cdp.eval(`document.querySelector(${q(scene.hover)})?.matches(':hover')`)) {
            throw new Error(name + ': pointer did not hover the target: ' + await cdp.eval(`(() => {
              const node = document.querySelector(${q(scene.hover)}), r = node.getBoundingClientRect()
              return JSON.stringify({ rect: r.toJSON(), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className, pointer: getComputedStyle(node).pointerEvents, hovered: [...document.querySelectorAll(':hover')].map(node => node.className), scale: visualViewport.scale })
            })()`))
          }
        }
        await shoot(`${name}-${theme}`, scene.expect ?? null, scene.verify ?? null)
      },
    })
  }
  if (has('interactive')) {
    say('Isolated app ready for native interaction. Press Return here to close it.')
    await new Promise(resolve => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
} finally {
  await closeDesk(desk).catch(() => {})
}
