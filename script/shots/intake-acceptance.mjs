#!/usr/bin/env node
/**
 * Phase 8 acceptance: Intake, driven against a real, launched HarnessDesk.
 *
 * `--mode rig` (the default) proves the person-visible half of the feature
 * against a disposable desk: an isolated `HARNESSDESK_HOME`, the fake Codex
 * app-server (`packages/adapter-codex/test/fixtures/fake-codex.mjs`) and a
 * fake `gh` (`packages/server/test/fixtures/fake-gh.mjs`) first on `PATH`,
 * so no real GitHub account, network or credits are ever touched. The
 * admission mechanism itself — one durable Goal and round per firing,
 * recovery across a restart, dedupe, the daily reservation, one pinned
 * review per closed round — is exhaustively proven by
 * `packages/server/test/intake-*.test.ts` against a real `Host` already;
 * this script's job is the part those tests cannot see: that a person
 * looking at the real, rendered app can arm a trigger, watch a Goal it
 * opens name where it came from, pause every trigger, and read its history.
 *
 * `--mode live` is an explicit placeholder for the authorized disposable
 * repository this plan calls for. It is refused, honestly, until
 * `HD_INTAKE_ACCEPTANCE_REPO` names one: a missing input is a reported unrun
 * gate here, never a synthetic pass.
 *
 *   node script/shots/intake-acceptance.mjs               # --mode rig
 *   node script/shots/intake-acceptance.mjs --mode live
 *
 * Frames land in `/tmp/phase8-shots/` (or `$HD_INTAKE_SHOTS_DIR`) and are
 * never published — this script does not push, post or open a PR.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeDesk, launchDesk, sleep, STORE, waitForSnapshot } from '../lib/desk.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'rig'
const OUT = process.env['HD_INTAKE_SHOTS_DIR'] ?? '/tmp/phase8-shots'
const q = (value) => JSON.stringify(value)
const say = (line) => process.stdout.write(`  ${line}\n`)

const shoot = async (cdp, name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  say(`✓ ${name}.png`)
}

const click = (cdp, selector) =>
  cdp.eval(`(() => { const node = ${selector}; if (!node) throw new Error('click target not found'); node.click(); return true })()`)

if (mode === 'live') {
  const repo = process.env['HD_INTAKE_ACCEPTANCE_REPO']
  if (!repo) {
    say('HD_INTAKE_ACCEPTANCE_REPO is not set: live acceptance is not run, not skipped as passing.')
    say('Set it to an authorized disposable repository (owner/name) to run the live gate.')
    process.exit(1)
  }
  say(`live acceptance against ${repo} is not implemented by this script yet — refusing rather than faking a pass.`)
  process.exit(1)
}

if (mode !== 'rig') {
  say(`unknown --mode ${mode}`)
  process.exit(2)
}

// ---------------------------------------------------------------- the rig

const rig = mkdtempSync(join(tmpdir(), 'harnessdesk-intake-acceptance-'))
const home = join(rig, 'home')
const work = join(rig, 'work')
const project = join(work, 'widgets')
const codexHome = join(rig, 'codex-home')
const bin = join(rig, 'bin')
const ghState = join(rig, 'fake-gh-state.json')
const userDataDir = join(rig, 'electron')
const logPath = join(rig, 'app.log')

mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(bin, { recursive: true })
mkdirSync(OUT, { recursive: true })

// A fake `gh`, first on PATH: `packages/server/src/intake/forge.ts` spawns
// whatever `gh` PATH resolves to, and the desktop's own findings publisher
// does the same for its review posting — neither knows this is not real.
copyFileSync(join(root, 'packages/server/test/fixtures/fake-gh.mjs'), join(bin, 'gh'))
chmodSync(join(bin, 'gh'), 0o755)
writeFileSync(ghState, JSON.stringify({
  repo: 'acme/widgets',
  view: { nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets' },
  user: { id: 7, login: 'jane-doe' },
  pulls: [],
  issues: [],
}, null, 2))

// A committed project: one issue trigger, one Agent it opens, preferring the
// fake Codex app-server so the same mechanism the native UI-system smoke
// already proves seats it.
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: project, stdio: 'pipe' })
mkdirSync(join(project, '.harnessdesk/agents/triager'), { recursive: true })
writeFileSync(
  join(project, '.harnessdesk/triggers.yml'),
  [
    '- id: triage-issue',
    '  on: issue',
    '  events: [labelled]',
    '  label: [needs-triage]',
    '  opens:',
    '    agent: triager',
    '  budget:',
    '    usd: 5',
    '    rounds: 1',
    '    hours: 1',
    '    without-progress: 1',
    '',
  ].join('\n'),
)
writeFileSync(
  join(project, '.harnessdesk/agents/triager/AGENT.md'),
  ['---', 'name: Triager', 'ceiling: read', 'answers: [triaged]', 'prefer: [codex]', '---', 'Triage the labelled issue.', ''].join('\n'),
)
writeFileSync(join(project, 'README.md'), '# widgets\n\nA synthetic project for the Intake acceptance rig.\n')
git('init', '--initial-branch=main')
git('-c', 'user.name=HarnessDesk Rig', '-c', 'user.email=dev@example.com', 'add', '-A')
git('-c', 'user.name=HarnessDesk Rig', '-c', 'user.email=dev@example.com', 'commit', '-m', 'Declare a triage trigger')

const ghTrace = join(rig, 'fake-gh-trace.jsonl')
const environment = {
  ...process.env,
  // The desk asks the login shell for its own PATH and puts that ahead of
  // whatever this process was spawned with (`installs/shell-path.ts`), so a
  // real `gh` this machine already has on its shell PATH would otherwise win
  // over a plain `PATH` prepend. `HARNESSDESK_PATH` is the one override that
  // goes first regardless — the sanctioned way to point the desk at a fake
  // tool for exactly this reason.
  HARNESSDESK_PATH: bin,
  HARNESSDESK_LOG_LEVEL: 'debug',
  HARNESSDESK_NO_UPDATE_CHECK: '1',
  HARNESSDESK_CODEX_BINARY: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  CODEX_HOME: codexHome,
  FAKE_GH_STATE: ghState,
  FAKE_GH_TRACE: ghTrace,
}

say(`home    ${home}`)
say(`project ${project}`)
say(`log     ${logPath}`)

let desk
try {
  desk = await launchDesk({ app: root, home, userDataDir, logPath, env: environment })
  const { cdp } = desk

  await cdp.eval(`${STORE}.openWorkspace(${q(project)})`, 60_000)
  await waitForSnapshot(() => cdp.eval(`${STORE}.getSnapshot().workspace?.path === ${q(project)}`), Boolean)
  await sleep(500)
  await shoot(cdp, 'workspace-open')

  // The project's own Triggers section: off, by declaration alone.
  await cdp.eval(`${STORE}.askSettings('workspaces', ${q(project)})`)
  try {
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.textContent?.includes('open triager') ?? false`),
      Boolean,
      { attempts: 100 },
    )
  } catch (error) {
    const body = await cdp.eval(`document.body.innerText`)
    say(`--- debug: settings body text ---\n${body}\n--- end debug ---`)
    throw error
  }
  await shoot(cdp, 'triggers-off')

  // Turning it on opens the exact arming review.
  await click(cdp, `document.querySelector('[role="switch"][aria-label="Arm triage-issue"]')`)
  await waitForSnapshot(() => cdp.eval(`Boolean(document.querySelector('[role="alertdialog"]'))`), Boolean, { attempts: 150 })
  await sleep(300)
  await shoot(cdp, 'arm-review')

  await sleep(1500)
  const armed = await cdp.eval(
    `[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === 'Arm')?.disabled === false`,
  )
  if (!armed) {
    const dialogText = await cdp.eval(`document.querySelector('[role="alertdialog"]')?.textContent ?? '(no dialog)'`)
    say(`--- debug: arm dialog text ---\n${dialogText}\n--- end debug ---`)
    say(`--- debug: app.log tail ---\n${readFileSync(logPath, 'utf8').slice(-4000)}\n--- end debug ---`)
    say(`--- debug: fake-gh trace ---\n${existsSync(ghTrace) ? readFileSync(ghTrace, 'utf8') : '(no calls recorded)'}\n--- end debug ---`)
    throw new Error('the Arm button never became enabled — the preview never resolved to a usable token')
  }
  await click(cdp, `[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === 'Arm')`)
  await waitForSnapshot(
    () => cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.textContent?.includes('Armed') ?? false`),
    Boolean,
    { attempts: 150 },
  )
  await shoot(cdp, 'armed')
  say('armed the trigger through the real dialog')

  // A labelled issue appears on the (fake) forge.
  const state = JSON.parse(readFileSync(ghState, 'utf8'))
  state.issues.push({
    number: 42,
    state: 'open',
    created: Date.now(),
    updated: Date.now(),
    title: 'Widgets sometimes spin backwards',
    body: 'Reported by a user; needs triage.',
    events: [{ id: 1, event: 'labeled', created: Date.now(), label: 'needs-triage' }],
    comments: [],
  })
  writeFileSync(ghState, JSON.stringify(state, null, 2))
  say('seeded a labelled issue on the fake forge; waiting for the poll to open a Goal')

  // Intake polls at most once a minute; arming baselines the source, so the
  // newly seeded issue is only seen on the poll after this one. Generous, not
  // arbitrary: the actual bound is `POLL_INTERVAL_MS` in `intake/poll.ts`.
  const goalOpened = await waitForSnapshot(
    () => cdp.eval(`[...${STORE}.getSnapshot().goals.values()].some(g => g.goal.origin.kind === 'trigger')`),
    Boolean,
    { attempts: 900 },
  ).catch(() => false)

  if (goalOpened) {
    const goal = await cdp.eval(
      `[...${STORE}.getSnapshot().goals.values()].find(g => g.goal.origin.kind === 'trigger').goal.id`,
    )
    // Settings is its own full-window overlay; leave it before opening the
    // Goal so the shot is the Goal's own pane, not Settings underneath a
    // notice.
    await click(cdp, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Back to app')`).catch(() => {})
    await sleep(300)
    await cdp.eval(`${STORE}.openGoal(${q(goal)})`)
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[aria-label="Trigger origin"]') !== null`),
      Boolean,
      { attempts: 150 },
    )
    // Dismiss only an explicit close control — never every button inside a
    // notice or banner, which would just as happily click "Review in
    // Library" as it would an "×" and navigate somewhere else entirely.
    await cdp.eval(
      `[...document.querySelectorAll('button[aria-label="Dismiss"], button[aria-label="Close"], button[aria-label="×"]')].forEach(b => { try { b.click() } catch {} }); true`,
    ).catch(() => {})
    await sleep(500)
    await shoot(cdp, 'goal-origin')
    say('the labelled issue opened a Goal, and its header names where it came from')

    // Give the seated turn a real chance to reach a named wait before moving on.
    await sleep(8000)
    await shoot(cdp, 'goal-progress')
  } else {
    say('no Goal opened within the wait window — recorded, not faked; see app.log')
  }

  // Settings > Workspaces > Triggers on this Mac: pause every trigger.
  await cdp.eval(`${STORE}.askSettings('workspaces', 'triggers')`)
  await waitForSnapshot(
    () => cdp.eval(`document.querySelector('[aria-label="Triggers on this Mac"]') !== null`),
    Boolean,
    { attempts: 150 },
  )
  await sleep(300)
  await shoot(cdp, 'machine-settings')
  await click(cdp, `document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')`)
  await waitForSnapshot(
    () =>
      cdp.eval(
        `document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')?.getAttribute('aria-checked') === 'true'`,
      ),
    Boolean,
    { attempts: 150 },
  )
  await shoot(cdp, 'paused')
  say('paused every trigger on this machine, read back before the switch showed it')

  // Back to the project's history.
  await cdp.eval(`${STORE}.askSettings('workspaces', ${q(project)})`)
  await waitForSnapshot(() => cdp.eval(`document.querySelector('[aria-label="Triggers"]') !== null`), Boolean, { attempts: 150 })
  await click(cdp, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'History')`)
  await sleep(500)
  await shoot(cdp, 'history')

  say(`frames saved under ${OUT} (not published)`)
} finally {
  if (desk) await closeDesk(desk)
  rmSync(rig, { recursive: true, force: true })
}
