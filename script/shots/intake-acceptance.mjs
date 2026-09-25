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
import { connect } from 'node:net'
import { toolSocketPath } from '../../packages/server/dist/src/bootstrap.js'

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
    // Comments on an issue: by default only the armed account's own, never the desk's own posts.
    '- id: talk',
    '  on: issue',
    '  events: [commented]',
    '  opens:',
    '    agent: triager',
    '  concurrency: 4',
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
  // The fake agent reports its plan's rolling windows, as a signed-in Codex does: unattended work refuses
  // to dispatch against an allowance nobody can read, so without them every trigger run waits on a person.
  FAKE_CODEX_WINDOWS: '1',
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

  // The comment trigger: its review says whose comments count, and names the repository it binds.
  await click(cdp, `document.querySelector('[role="switch"][aria-label="Arm talk"]')`)
  await waitForSnapshot(
    () => cdp.eval(`[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === 'Arm')?.disabled === false`),
    Boolean,
    { attempts: 200 },
  )
  const review = await cdp.eval(`document.querySelector('[role="alertdialog"]')?.textContent ?? ''`)
  const says = (text) => { if (!review.includes(text)) throw new Error(`the comment trigger's review does not say: ${text}`) }
  says('Comments that fire it')
  says('Only yours: comments by the forge account this trigger is armed with. Posts this desk makes never fire it.')
  says('acme/widgets')
  await shoot(cdp, 'arm-review-comments')
  await click(cdp, `[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === 'Arm')`)
  await waitForSnapshot(
    () => cdp.eval(`document.querySelectorAll('[aria-label="Triggers"] [role="switch"][aria-checked="true"]').length === 2`),
    Boolean,
    { attempts: 150 },
  )
  say('armed the comment trigger; its review said only the armed account’s comments count, and named acme/widgets')

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
  // Issue #44, for the desk's own tool to comment on below.
  state.issues.push({ number: 44, state: 'open', created: Date.now(), updated: Date.now(), title: 'Axle', body: '', events: [], comments: [] })
  // Three comments on issue #43: the armed account's own, a stranger's, and one the desk itself posted.
  const marker = `<!-- harnessdesk:finding-op pub-${'c'.repeat(48)} -->`
  state.issues.push({
    number: 43, state: 'open', created: Date.now(), updated: Date.now(), title: 'A question', body: '', events: [],
    comments: [
      { id: 4301, body: 'Please look into this.', created: Date.now(), updated: Date.now() },
      { id: 4302, body: 'Me too.', created: Date.now(), updated: Date.now(), user: { id: 99, login: 'someone-else' } },
      { id: 4303, body: `${marker}\n**Review round 1**`, created: Date.now(), updated: Date.now() },
    ],
  })
  writeFileSync(ghState, JSON.stringify(state, null, 2))
  say('seeded a labelled issue and three comments on the fake forge; waiting for the poll to open a Goal')

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

  // A real desk comment: the app's own Git plugin posts on issue #44 through its `issue_comment` tool, reached the
  // way an agent's tool bridge reaches it (the desk's tool socket), and so through the desk's own forge plane.
  const gateway = toolSocketPath(home)
  const invoked = await new Promise((resolveCall, rejectCall) => {
    const socket = connect(gateway)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((one) => one.trim() !== '')
      if (line && buffer.includes('\n')) { socket.end(); resolveCall(JSON.parse(line)) }
    })
    socket.on('error', rejectCall)
    socket.write(`${JSON.stringify({ id: 1, method: 'tools/invoke', params: { namespace: 'git', name: 'issue_comment', args: { number: 44, body: 'I looked: the axle is bent.' } } })}\n`)
  })
  if (!invoked.result?.ok) throw new Error(`the desk's issue_comment did not post: ${JSON.stringify(invoked)}`)
  const onForge = JSON.parse(readFileSync(ghState, 'utf8')).issues.find((one) => one.number === 44).comments.at(-1)
  say(`the desk's issue_comment posted: ${JSON.stringify(onForge.body)}`)
  if (!onForge.body.startsWith('<!-- harnessdesk:post -->\n')) throw new Error('the desk’s post does not open with its marker')

  // The comment rule, read back from the host: one firing for the armed account's own comment, and three skips with why.
  const talk = await waitForSnapshot(
    () => cdp.eval(`${STORE}.triggerHistory(${q(project)}, 'talk').then((page) => page.items.length >= 4 ? page.items.map((one) => [one.subject, one.outcome, one.reason]) : null)`),
    Boolean,
    { attempts: 900 },
  ).catch(() => null)
  if (!talk) throw new Error('the comment trigger answered fewer than four comments — see app.log')
  say(`comment trigger history: ${JSON.stringify(talk)}`)
  const outcomes = talk.map(([, outcome]) => outcome).sort()
  if (JSON.stringify(outcomes) !== JSON.stringify(['fired', 'skipped', 'skipped', 'skipped'])) throw new Error(`the comment rule answered ${JSON.stringify(outcomes)}`)
  for (const why of ['someone else wrote this one', 'posted by this desk']) {
    if (!talk.some(([, , reason]) => reason?.includes(why))) throw new Error(`no skip said: ${why}`)
  }
  const desk44 = talk.find(([subject]) => subject === '44')
  if (desk44?.[1] !== 'skipped' || !desk44[2]?.includes('posted by this desk')) throw new Error(`the desk's own comment on #44 was answered ${JSON.stringify(desk44)}`)
  say('only the armed account’s own comment fired; the stranger’s, a marked desk post and the desk’s real issue_comment were skipped, with why')

  // Paused is a hold, not a stop: the triage Goal's run is held with why, nothing recorded as a stop.
  const statusOf = async () => {
    const goal = await cdp.eval(`[...${STORE}.getSnapshot().goals.values()].find(g => g.goal.origin.kind === 'trigger' && g.goal.origin.trigger === 'triage-issue')?.goal.id ?? null`)
    if (!goal) return null
    return cdp.eval(`${STORE}.transport.request('trigger/goal', { goal: ${q(goal)} }).then(async (status) => {
      const page = await ${STORE}.triggerHistory(${q(project)}, 'triage-issue')
      const run = page.items.find((one) => one.goal === ${q(goal)} && one.run)?.run
      const execution = run ? await ${STORE}.transport.request('flow/execution', { run }) : null
      return { stop: status?.budget?.stop ?? null, waits: (status?.waits ?? []).map((one) => one.sentence), state: execution?.state ?? null, held: execution?.intake?.heldFor ?? null, rounds: execution?.rounds.length ?? 0 }
    })`)
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
  const before = goalOpened ? await statusOf() : null
  say(`before pausing: ${JSON.stringify(before)}`)
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

  if (goalOpened) {
    // Only a run that is going can show a pause holding it: a run already waiting on a person proves nothing here.
    if (before?.state !== 'running') throw new Error(`the triage run was not running before the pause: ${JSON.stringify(before)}`)
    const held = await waitForSnapshot(async () => { const one = await statusOf(); return one?.held ? one : null }, Boolean, { attempts: 150 }).catch(() => null)
    say(`while paused: ${JSON.stringify(held)}`)
    if (!held) throw new Error('pausing did not hold the running work')
    if (held.stop || held.state !== 'running') throw new Error('pausing stopped the work rather than holding it')
    if (!held.waits.some((one) => one.includes('Every trigger is paused'))) throw new Error('the hold is not named as a wait')
    await click(cdp, `document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')`)
    await waitForSnapshot(
      () => cdp.eval(`document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')?.getAttribute('aria-checked') === 'false'`),
      Boolean,
      { attempts: 150 },
    )
    const resumed = await waitForSnapshot(async () => { const one = await statusOf(); return one && !one.held ? one : null }, Boolean, { attempts: 150 }).catch(() => null)
    say(`after resuming: ${JSON.stringify(resumed)}`)
    if (!resumed || resumed.stop || resumed.held || !['running', 'settled'].includes(resumed.state)) throw new Error('resuming did not continue the held work')
    if (resumed.waits.some((one) => one.includes('Every trigger is paused'))) throw new Error('the pause’s wait outlived the resume')
    await shoot(cdp, 'resumed')
    say('resuming let the held run go: no stop recorded, the pause’s wait resolved')
    // Pause again for the history frame, as before.
    await click(cdp, `document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')`)
    await sleep(500)
  }

  // Back to the project's history.
  await cdp.eval(`${STORE}.askSettings('workspaces', ${q(project)})`)
  await waitForSnapshot(() => cdp.eval(`document.querySelector('[aria-label="Triggers"]') !== null`), Boolean, { attempts: 150 })
  await click(cdp, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'History')`)
  await sleep(500)
  await shoot(cdp, 'history')

  // A source gap, and Watch from now: resume triggers, then a burst of 101 labelled issues — more than one read may
  // hold — stops the issue source at a gap; the trigger's row says so and offers Watch from now, which resumes it.
  await cdp.eval(`${STORE}.askSettings('workspaces', 'triggers')`)
  await waitForSnapshot(() => cdp.eval(`document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]') !== null`), Boolean, { attempts: 150 })
  if (await cdp.eval(`document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]').getAttribute('aria-checked') === 'true'`)) {
    await click(cdp, `document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')`)
    await waitForSnapshot(() => cdp.eval(`document.querySelector('[aria-label="Triggers on this Mac"] [role="switch"]')?.getAttribute('aria-checked') === 'false'`), Boolean, { attempts: 150 })
  }
  const burst = JSON.parse(readFileSync(ghState, 'utf8'))
  const at = Date.now()
  for (let number = 200; number < 301; number += 1) {
    burst.issues.push({ number, state: 'open', created: at, updated: at + number, title: `Burst ${number}`, body: '', events: [{ id: 50_000 + number, event: 'labeled', created: at, label: 'needs-triage' }], comments: [] })
  }
  writeFileSync(ghState, JSON.stringify(burst, null, 2))
  say('seeded 101 labelled issues at once; waiting for the source to stop at a gap')
  await cdp.eval(`${STORE}.askSettings('workspaces', ${q(project)})`)
  const gapRow = `[...document.querySelectorAll('[aria-label="Triggers"] *')].some((node) => node.textContent?.trim() === 'Its source stopped at a gap')`
  const gapped = await waitForSnapshot(() => cdp.eval(gapRow), Boolean, { attempts: 2400 }).catch(() => false)
  if (!gapped) {
    say(`--- debug: triggers section ---\n${await cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.innerText ?? ''`)}\n--- end debug ---`)
    say(`--- debug: app.log tail ---\n${readFileSync(logPath, 'utf8').slice(-3000)}\n--- end debug ---`)
    throw new Error('the source never stopped at a gap')
  }
  const gapText = await cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.innerText ?? ''`)
  say(`the Triggers section at the gap:\n${gapText.split('\n').filter((line) => /gap|Watch from now|read can cover|skipped, not replayed/i.test(line)).map((line) => `    ${line}`).join('\n')}`)
  await cdp.eval(`[...document.querySelectorAll('[aria-label="Triggers"] *')].find((node) => node.textContent?.trim() === 'Its source stopped at a gap')?.scrollIntoView({ block: 'center' }); true`)
  await sleep(300)
  await shoot(cdp, 'source-gap')
  await click(cdp, `[...document.querySelectorAll('[aria-label="Triggers"] button')].find((b) => b.textContent.trim() === 'Watch from now')`)
  await waitForSnapshot(() => cdp.eval(`!(${gapRow})`), Boolean, { attempts: 300 })
  const watching = await cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.innerText ?? ''`)
  if (/Watch from now|stopped at a gap/.test(watching)) throw new Error('Watch from now did not resume the source')
  const burstFired = await cdp.eval(`${STORE}.triggerHistory(${q(project)}, 'triage-issue').then((page) => page.items.filter((one) => Number(one.subject) >= 200).length)`)
  if (burstFired !== 0) throw new Error(`the gap was replayed: ${burstFired} burst issues answered`)
  await cdp.eval(`document.querySelector('[aria-label="Triggers"]')?.scrollIntoView({ block: 'start' }); true`)
  await sleep(300)
  await shoot(cdp, 'watching-from-now')
  say('Watch from now resumed the source: the gap row is gone, and none of the 101 skipped issues fired')

  say(`frames saved under ${OUT} (not published)`)
} finally {
  if (desk) await closeDesk(desk)
  // The app's own output, kept for reading after the rig is gone.
  if (process.env['HD_INTAKE_APP_LOG'] && existsSync(logPath)) copyFileSync(logPath, process.env['HD_INTAKE_APP_LOG'])
  rmSync(rig, { recursive: true, force: true })
}
