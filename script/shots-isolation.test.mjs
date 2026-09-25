import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentRegistryStore } from '../packages/server/dist/src/agent-registry.js'
import { parseSeating } from '../packages/server/dist/src/agent-seating-file.js'
import { Agents } from '../packages/server/dist/src/agents.js'
import { InstallService } from '../packages/server/dist/src/installs/service.js'
import { readChecks } from '../packages/server/dist/src/evidence/checks-file.js'
import { GoalStore } from '../packages/server/dist/src/goals/store.js'
import { AcpRuntime } from '../packages/adapter-acp/dist/src/runtime.js'
import { RUNTIME_ACCOUNTS } from './shots/accounts.mjs'
import { USAGE, LEDGER } from './shots/usage.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('native appearance relaunch keeps the packaged executable selected for the sweep', () => {
  const native = readFileSync(join(root, 'e2e/ui-system/native-smoke.mjs'), 'utf8')
  const relaunch = native.slice(native.indexOf('const desk = await launchDesk({'))
  assert.match(relaunch, /executable: process\.env\['HD_SHOTS_EXECUTABLE'\]/)
})

test('every capture dismisses only the normal import offer before auditing the frame', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const capture = shoot.slice(shoot.indexOf('const shoot = async'), shoot.indexOf('const setTheme = async'))
  const dismissal = capture.indexOf("dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' })")
  assert.ok(dismissal >= 0, 'the standing banner is not a transient snapshot.notice')
  assert.ok(dismissal < capture.indexOf('await audit(name)'))
  assert.doesNotMatch(capture, /dismissNotices\(/, 'do not discard errors to make a scene look healthy')
})

test('the refreshed evidence scene waits for the new check without discarding older history', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const refreshed = shoot.slice(
    shoot.indexOf("SCENES['evidence-refreshed']"),
    shoot.indexOf('const seatRecordSays'),
  )
  assert.match(refreshed, /\/verify ✓ @\[0-9a-f\]\{7\}\//)
  assert.doesNotMatch(refreshed, /!card\.text\.includes\('since'\)/)
})

test('the unavailable evidence scene withholds completed work without replacing facts with an empty answer', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const unavailable = shoot.slice(
    shoot.indexOf("SCENES['evidence-unavailable']"),
    shoot.indexOf('const seatRecordSays'),
  )
  assert.match(unavailable, /boardEvidence\.delete\(room\)/)
  assert.match(unavailable, /const request = store\.transport\.request\.bind\(store\.transport\)/)
  assert.match(unavailable, /method === 'evidence\/board'/)
  assert.match(unavailable, /await store\.loadBoardEvidence\(room\)/)
  assert.match(unavailable, /const card = await cardOne\(\)/)
  assert.match(unavailable, /Facts must be hidden/)
  assert.match(unavailable, /nothing checked/)
})

test('the capture driver reads rig paths without running the staging script', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  assert.doesNotMatch(shoot, /from '\.\/seed\.mjs'/)
  assert.match(shoot, /from '\.\/config\.mjs'/)
})

test('the native editor scene seeds the fake filesystem and requires rendered file contents', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const editor = shoot.slice(shoot.indexOf('editor: {'), shoot.indexOf('terminal: {'))
  assert.match(editor, /selectRuntime\('codex'\)/)
  assert.match(editor, /'file\/save'/, 'the fake Codex filesystem does not read host files')
  assert.match(editor, /readFileSync\(path, 'utf8'\)/)
  assert.match(editor, /waitForSnapshot\(/, 'the tab label does not prove that the file loaded')
  assert.match(editor, /\.cm-content/)
  assert.match(editor, /JSON\.stringify\(JSON\.parse\(text\)\)/, 'the editor must contain the actual seeded JSON')
})

test('every seeded camera agent stays on its scripted process even with real CLIs installed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-isolation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: join(directory, 'work'), HD_SHOTS_NATIVE_CODEX: '0' },
    stdio: 'pipe',
  })
  const store = new AgentRegistryStore(join(home, 'agents.json'))
  let probes = 0
  const service = new InstallService({
    stateDir: home,
    store,
    // A hostile but entirely synthetic machine: a usable real OpenCode is
    // discoverable. Never probe this machine or start an actual vendor CLI.
    locate: {
      env: { PATH: '/opt/demo/bin' }, home: '/home/someone', platform: 'linux',
      exists: path => path === '/opt/demo/bin/opencode',
      realpath: path => path,
      probe: async () => { probes += 1; return '1.18.29' },
    },
  })
  const configs = store.configs()
  assert.equal(configs.length, 12)
  const openCode = configs.find(agent => agent.brand === 'opencode')
  assert.ok(openCode)
  assert.equal(await service.launchFor(openCode), null, 'the row must not be replaced with installed OpenCode')
  // config.mjs resolves `WORK` through any symlink in its own path (macOS's
  // `/var` and `/tmp` are themselves symlinks to `/private/var`/`/private/tmp`
  // — #904), so a seeded conversation's `cwd` carries the resolved prefix even
  // though this test's own `directory` is the as-given, pre-resolution one.
  const work = realpathSync(join(directory, 'work'))
  for (const agent of configs) {
    assert.equal(service.knowledgeFor(agent), undefined, `${agent.id} must not inherit vendor stores or launch policy`)
    assert.equal(await service.launchFor(agent), null)
    assert.equal(agent.command, 'node')
    assert.deepEqual(agent.args, [join(root, 'script/shots/agent.mjs')])
    const sessions = Object.values(JSON.parse(readFileSync(agent.env.SHOT_STORE, 'utf8')))
    assert.ok(sessions.every(session => session.cwd.startsWith(work + '/')))
    const runtime = new AcpRuntime({ ...agent, resolveLaunch: occasion => service.launchFor(agent, occasion) })
    try {
      await runtime.start()
      const listed = await runtime.listSessions()
      assert.deepEqual(listed.data.map(session => session.id).sort(), sessions.map(session => session.sessionId).sort())
      assert.ok(listed.data.every(session => session.cwd.startsWith(work + '/')))
    } finally {
      await runtime.dispose()
    }
  }
  assert.equal(probes, 0, 'the rig must never even inspect installed vendor CLIs')
  const ids = new Set(configs.map(agent => agent.id))
  for (const id of Object.keys(RUNTIME_ACCOUNTS)) assert.ok(ids.has(id), `account mapped to missing runtime ${id}`)
  for (const row of [...USAGE, ...LEDGER.rows, ...LEDGER.daily]) assert.ok(ids.has(row.runtime), `usage mapped to missing runtime ${row.runtime}`)
})

test('a camera conversation created for a scene is listed after the agent restarts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-restart-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
    stdio: 'pipe',
  })
  const config = new AgentRegistryStore(join(home, 'agents.json')).configs()
    .find(agent => agent.id === 'shots-claude-code')
  assert.ok(config)

  const first = new AcpRuntime(config)
  await first.start()
  let created
  try {
    created = await first.createSession({ cwd: join(work, 'storefront') })
  } finally {
    await first.dispose()
  }

  const second = new AcpRuntime(config)
  await second.start()
  try {
    const listed = await second.listSessions()
    assert.ok(listed.data.some(session => session.id === created.id), 'fresh process did not list the scene conversation')
  } finally {
    await second.dispose()
  }
})

test('the staged desk has Agents: a project one shadowing one that ships, one of yours, and this Mac’s seats', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-agents-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
    stdio: 'pipe',
  })
  const roster = new Agents({ user: join(home, 'agents'), builtin: join(root, 'packages/server/agents') })
  const listed = await roster.list(join(work, 'storefront'))
  const byId = new Map(listed.map(one => [one.id, one]))
  assert.equal(byId.get('code-reviewer')?.origin, 'project')
  assert.deepEqual(byId.get('code-reviewer')?.shadows.map(one => one.origin), ['builtin'])
  assert.equal(byId.get('release-checker')?.origin, 'user')
  assert.equal(byId.get('judge')?.origin, 'builtin')
  assert.deepEqual(listed.flatMap(one => one.problems), [], 'every staged Agent parses')

  const seating = parseSeating(readFileSync(join(home, 'seating.json'), 'utf8'))
  assert.deepEqual(seating.problems, [])
  assert.deepEqual(seating.entries.map(one => one.id), ['code-reviewer'])
  // This Mac's seats are the rig's own runtimes: nothing reads through to a CLI installed here.
  const configs = new AgentRegistryStore(join(home, 'agents.json')).configs()
  const ids = new Set(configs.map(one => one.id))
  for (const seat of seating.entries.flatMap(one => one.seats)) assert.ok(ids.has(seat.runtime), seat.runtime)
  // One runtime is signed out where the host asks, and the renderer is told the same.
  assert.ok(configs.find(one => one.id === 'shots-windsurf')?.account?.status, 'Windsurf answers its own sign-in')
  assert.deepEqual(RUNTIME_ACCOUNTS['shots-windsurf']?.accounts, [])
})

test('the storefront names one check and commits it, and every take starts with nothing approved and nothing observed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-evidence-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  seed()
  const storefront = join(work, 'storefront')
  const read = await readChecks(storefront)
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.checks, [{ name: 'verify', run: 'node --test', timeout: 120 }])
  assert.equal(execFileSync('git', ['-C', storefront, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  execFileSync(process.execPath, ['--test'], { cwd: storefront, stdio: 'pipe' })

  mkdirSync(join(home, 'evidence'), { recursive: true })
  writeFileSync(join(home, 'commands-seen.json'), '{}\n')
  writeFileSync(join(home, 'commands-seen.key'), 'key\n')
  writeFileSync(join(home, 'seat-record-scene.json'), '{}\n')
  seed()
  for (const name of ['evidence', 'commands-seen.json', 'commands-seen.key', 'seat-record-scene.json']) {
    assert.equal(existsSync(join(home, name)), false, `${name} survived a seed`)
  }
})

test('each provenance take removes residue and seeds only synthetic local facts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-provenance-shots-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  // A first take marks this custom home as the rig's own; only then does
  // leaving residue behind, and reseeding over it, mean anything.
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' }, stdio: 'pipe',
  })
  for (const path of ['evidence', 'provenance']) {
    mkdirSync(join(home, path), { recursive: true })
    writeFileSync(join(home, path, 'previous-take'), 'must not survive')
  }
  writeFileSync(join(home, 'provenance-preferences.json'), 'must not survive')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0', HD_SHOTS_PROVENANCE: '1' }, stdio: 'pipe',
  })
  assert.equal(existsSync(join(home, 'provenance-preferences.json')), false)
  assert.equal(existsSync(join(home, 'provenance')), false)
  assert.equal(existsSync(join(home, 'evidence', 'previous-take')), false)
  const { EvidenceStore } = await import('../packages/server/dist/src/evidence/store.js')
  const evidence = new EvidenceStore(join(home, 'evidence'))
  const projects = await evidence.projects()
  assert.equal(projects.length, 1)
  const seats = (await evidence.read(projects[0], 'seats')).lines
  const facts = (await evidence.read(projects[0], 'evidence')).lines
  assert.equal(seats.length, 2)
  assert.equal(facts.length, 2)
  assert.deepEqual(seats.map((line) => line.record.agent.name), ['Contributor 1', 'Contributor 2'])
  assert.ok(seats.every((line) => line.record.checkout.project === projects[0]))
  assert.ok(facts.every((line) => line.record.fact.kind === 'diff' && !line.record.restored))
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0', HD_SHOTS_PROVENANCE: '0' }, stdio: 'pipe',
  })
  assert.equal(existsSync(join(home, 'evidence')), false)
})

test('the Intake acceptance rig owns a disposable home and never runs the live gate silently', () => {
  const script = readFileSync(join(root, 'script/shots/intake-acceptance.mjs'), 'utf8')
  // A fresh `mkdtempSync` under the OS temp directory, never the real
  // `$HOME` or `HARNESSDESK_HOME` this machine already uses.
  assert.match(script, /mkdtempSync\(join\(tmpdir\(\), 'harnessdesk-intake-acceptance-'\)\)/)
  assert.doesNotMatch(script, /process\.env\['HOME'\]/)
  // Cleanup runs whether the walkthrough finished or threw.
  const body = script.slice(script.indexOf('let desk'))
  assert.match(body, /finally\s*\{[\s\S]*rmSync\(rig, \{ recursive: true, force: true \}\)/)
  // The live gate is refused, not skipped as green, when its one required
  // input is absent — never a synthetic pass.
  const live = script.slice(script.indexOf("if (mode === 'live')"), script.indexOf("if (mode !== 'rig')"))
  assert.match(live, /HD_INTAKE_ACCEPTANCE_REPO/)
  assert.match(live, /process\.exit\(1\)/)
})

test('reseeding clears a leftover Goal document, closing the leftover sidebar row it caused', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-goal-leak-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  seed()
  const storefront = join(work, 'storefront')

  // What one un-reseeded take of the room, board or flow-board scene leaves
  // behind: a Goal document on disk (`goals/store.ts` writes one file per
  // Goal, plus an `index.json`). Left there, `GoalPlane` re-installs it as a
  // Team projection on every boot (`host.ts`'s `for (const view of await
  // this.#goals.list())`), which is the permanent, agent-less sidebar row —
  // "Working"/"Needs you" with "No agents in here yet". That is the one claim
  // this test makes. A Seat is a separate concern kept under `evidence/`,
  // which this PR does not touch and which was already reset every take
  // before it; a Goal document carries no Seat of its own (the schema
  // forbids a `members` field), so it is deliberately left out here rather
  // than implied as part of what this fix addresses (#909 review, P3-1).
  const goals = new GoalStore(home)
  mkdirSync(join(home, 'goals'), { recursive: true })
  const now = Date.now()
  await goals.save({
    version: 1,
    goal: {
      id: 'stale-room', root: storefront, cwd: storefront, sentence: 'Checkout hardening',
      state: 'open', revision: 0, checkout: 'shared', dependsOn: [],
      createdAt: now, updatedAt: now, origin: { kind: 'person' }, receipt: null,
    },
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  assert.ok(existsSync(join(home, 'goals', 'stale-room.json')), 'the fixture did not actually stage a Goal document')

  // The next take reseeds, exactly as seed.mjs's own doc comment says to do
  // before every one.
  seed()

  assert.equal(existsSync(join(home, 'goals')), false, 'a leftover Goal survived reseeding')
})

test('seed.mjs refuses to seed a non-empty folder it has not marked as its own, leaving it byte-for-byte unchanged', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-guard-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'not-a-rig-home')
  const work = join(directory, 'work')
  mkdirSync(home, { recursive: true })
  // Content that looks like it belongs to a real desk this rig must never
  // touch — an `HD_SHOTS_HOME` pointed at a real `~/.harnessdesk`, or at
  // `$HOME` itself, would otherwise have its registry and state overwritten
  // on a first run that "skipped" cleanup, and its credentials, Goals and
  // worktrees deleted by the very list this PR widened on the very next run,
  // because that first run wrote the marker unconditionally (#909 review,
  // P2-2). Refusing outright, before anything is written, is the only
  // version of "leave it alone" that actually holds.
  const files = {
    'agents.json': '{"real":true}\n',
    'credentials.json': '{"real":true}\n',
    'goals/a-real-goal.json': '{}\n',
    'worktrees/wt/file.ts': 'export {}\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, dirname(path)), { recursive: true })
    writeFileSync(join(home, path), content)
  }

  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })

  // Twice, because the bug this replaces only bit on the second run: the
  // first run "skipped" the deletions but still marked the folder, so the
  // second one trusted it and cleared everything the list now names.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let failure = null
    try {
      seed()
    } catch (error) {
      failure = error
    }
    assert.ok(failure, `run ${attempt} must refuse rather than seed a folder it does not own`)
    assert.notEqual(failure.status, 0, `run ${attempt} must exit non-zero`)
    assert.match(String(failure.stderr), /HD_SHOTS_HOME/, `run ${attempt}'s message must name the flag`)
    assert.match(String(failure.stderr), /\.rig-home\.json/, `run ${attempt}'s message must name the marker`)
  }

  // Byte-for-byte unchanged: nothing this rig did not put there was deleted,
  // and nothing of its own — registry, state or marker — was written either.
  for (const [path, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(home, path), 'utf8'), content, path)
  }
  assert.equal(existsSync(join(home, '.rig-home.json')), false, 'an unowned folder must not be marked')
  assert.equal(existsSync(join(home, 'state.json')), false)
  assert.equal(existsSync(join(home, 'seating.json')), false)
})

test('seed.mjs marks an empty custom home on its first run, and seeds it normally from then on', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-guard-empty-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'fresh-rig-home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })

  seed()
  assert.ok(existsSync(join(home, '.rig-home.json')), 'an empty folder was not marked on its first run')
  assert.ok(existsSync(join(home, 'agents.json')))

  // Residue this rig staged is cleared normally next time, exactly like the
  // default home always was.
  mkdirSync(join(home, 'goals'), { recursive: true })
  writeFileSync(join(home, 'goals', 'stale.json'), '{}\n')
  seed()
  assert.equal(existsSync(join(home, 'goals', 'stale.json')), false)
})

test('the guard no longer trusts the default home outright — the marker check reads the same for both', () => {
  const seed = readFileSync(join(root, 'script/shots/seed.mjs'), 'utf8')
  assert.doesNotMatch(seed, /usingDefaultHome/, 'the default path must earn the same marker/empty proof as an override')
  assert.match(seed, /const rigOwnsHome = empty \|\| existsSync\(MARKER\)/)
})

test('a home that is a symlink is refused before anything reads, writes or deletes through it (P2-2)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-guard-symlink-home-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const elsewhere = join(directory, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, 'keep.txt'), 'must not be touched')
  const link = join(directory, 'home-link')
  symlinkSync(elsewhere, link)
  const work = join(directory, 'work')

  let failure = null
  try {
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: link, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'a symlinked home must refuse rather than seed through the link')
  assert.notEqual(failure.status, 0)
  assert.match(String(failure.stderr), /symlink/)
  // Nothing on the far side of the link, and the link itself, survive untouched.
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'must not be touched')
  assert.ok(lstatSync(link).isSymbolicLink(), 'the link itself must not have been replaced or removed')
  assert.equal(existsSync(join(elsewhere, '.rig-home.json')), false, 'nothing was seeded through the link')
})

test('a residue path swapped for a symlink between two takes refuses the reseed, and nothing outside the home changes (P2-2)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-guard-symlink-residue-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  seed()
  const before = readFileSync(join(home, 'agents.json'), 'utf8')

  // A later take's `goals` — a `RESIDUE` entry — swapped for a link to
  // somewhere with its own file, the way a mistaken tool or a stray `ln -s`
  // could leave it.
  const elsewhere = join(directory, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, 'keep.txt'), 'must not be touched')
  rmSync(join(home, 'goals'), { recursive: true, force: true })
  symlinkSync(elsewhere, join(home, 'goals'))

  let failure = null
  try {
    seed()
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'a symlinked residue entry must refuse the reseed rather than delete through it')
  assert.notEqual(failure.status, 0)
  assert.match(String(failure.stderr), /symlink/)
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'must not be touched')
  assert.ok(lstatSync(join(home, 'goals')).isSymbolicLink(), 'the link itself must survive, unremoved')
  // The refusal is a full pass before any deletion: legitimate residue this
  // rig staged in the first seed is untouched by the aborted second one.
  assert.equal(readFileSync(join(home, 'agents.json'), 'utf8'), before)
})

test('the default rig home and its work folder live under the OS temp directory, never this machine\'s real home', () => {
  // Spawned rather than imported directly: `config.mjs` resolves its defaults
  // at import time, and this repository's own test run always has
  // `HD_SHOTS_HOME`/`HD_SHOTS_WORK` set by whichever suite ran before this
  // one shares the module cache. A fresh process with neither set is the only
  // way to see what a person who has never heard of either variable gets.
  const { HOME, WORK } = JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "import { HOME, WORK } from './script/shots/config.mjs'; process.stdout.write(JSON.stringify({ HOME, WORK }))"],
      { cwd: root, env: { ...process.env, HD_SHOTS_HOME: undefined, HD_SHOTS_WORK: undefined }, stdio: 'pipe', encoding: 'utf8' },
    ),
  )
  const home = homedir()
  assert.ok(HOME.startsWith(realpathSync(tmpdir())), `HOME (${HOME}) is not under the OS temp directory`)
  assert.ok(WORK.startsWith(realpathSync(tmpdir())), `WORK (${WORK}) is not under the OS temp directory`)
  assert.equal(HOME.startsWith(home), false, `HOME (${HOME}) is under this machine's real home`)
  assert.equal(WORK.startsWith(home), false, `WORK (${WORK}) is under this machine's real home`)
  // `WORK` is nested one level inside `HOME`, under a "person" folder — the
  // folder `shoot.mjs`/`gif.mjs` shorten to `~` so a frame still reads
  // `~/work/storefront` (`config.mjs`'s own doc comment).
  assert.ok(WORK.startsWith(`${HOME}/`), `WORK (${WORK}) is not nested inside HOME (${HOME})`)
  assert.equal(dirname(WORK), join(HOME, 'person'))
})

test('the capture drivers shorten the work folder\'s parent, never `WORK` itself, so a frame still reads ~/work/…', () => {
  for (const file of ['script/shots/shoot.mjs', 'script/shots/gif.mjs']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.match(source, /TILDIFY\(dirname\(WORK\)\)/, `${file} does not shorten WORK's parent folder`)
    assert.doesNotMatch(source, /TILDIFY\(WORK\)/, `${file} still shortens WORK itself, which would drop the "work" segment`)
  }
})

test('the browser scene serves its page over loopback HTTP, never as a file:// URL', () => {
  // A `file://` URL always carries a filesystem path, and the address bar is
  // a React-controlled input that can write that path back mid-take even
  // after `TILDIFY` has run — so the fix is to never hand it a path at all.
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const body = shoot.slice(shoot.indexOf("browser: { leaveOverlay: true"), shoot.indexOf('// The review sweep'))
  assert.match(body, /const browseDir = join\(WORK, 'browse'\)/, 'the served folder must live under WORK')
  assert.match(body, /startStaticServer\(browseDir\)/)
  assert.match(body, /\$\{browserServer\.url\}\/index\.html/)
  assert.doesNotMatch(body, /pathToFileURL/, 'the browser scene must not open a file:// URL')
  assert.doesNotMatch(body, /homedir\(\)/, 'the browser scene must never build its page from the real home')
  assert.match(shoot, /import \{ startStaticServer \} from '\.\/static-server\.mjs'/)
})

test('reseeding clears a leftover browser-pane layout, closing the leak an earlier browser take left in state.json', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-layout-leak-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const seed = () =>
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
      env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '0' },
      stdio: 'pipe',
    })
  seed()

  // What a running app persists after a `browser` scene docks its pane
  // (`packages/ui/src/state/store.ts`'s `#keepWorkbench`, into
  // `preferences.layouts` — `packages/server/src/state.ts`): the tab's own
  // URL, carrying a path this rig must never publish.
  writeFileSync(
    join(home, 'state.json'),
    JSON.stringify({
      version: 1,
      installId: 'shots',
      workspaces: [],
      preferences: {
        layouts: {
          [join(work, 'storefront')]: {
            main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: null } }, focused: 'p1', expanded: null },
            right: {
              root: {
                kind: 'stack',
                id: 's1',
                views: [{
                  id: 'm1',
                  view: {
                    kind: 'browser',
                    tabs: [{ id: 't1', url: 'file:///Users/someone/work/browse', title: 'browse' }],
                    active: 't1',
                    driven: 't1',
                  },
                }],
              },
              collapsed: false,
            },
          },
        },
      },
    }),
  )

  // The next take reseeds, exactly as seed.mjs's own doc comment says to do
  // before every one.
  seed()

  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(state.preferences, {}, 'a leftover panel/dock layout survived reseeding')
  assert.doesNotMatch(readFileSync(join(home, 'state.json'), 'utf8'), /\/Users\/someone\/work\/browse/)
})

/** Runs a one-liner against `config.mjs`'s exports, for a fixture home. */
const runAgainstConfig = (expression, { home, work }) =>
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', expression],
    { cwd: root, env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work }, stdio: 'pipe', encoding: 'utf8' },
  )

test('both drivers refuse to launch on a home nothing has seeded, naming seed.mjs (P2-3)', () => {
  // Common after a reboot clears the OS temp directory the new default lives
  // under: not a corrupted rig, just one that has never been staged, or was
  // staged and then emptied by the OS rather than by `--clean`.
  for (const file of ['script/shots/shoot.mjs', 'script/shots/gif.mjs']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.match(source, /requireSeeded\(\)/, `${file} must ask before it launches anything`)
    assert.ok(
      source.indexOf('requireSeeded()') < source.indexOf('await launchDesk('),
      `${file} must ask before launching, not after`,
    )
  }
  // seed.mjs is the one script allowed onto an unseeded home — asking would
  // make seeding a home for the first time impossible.
  assert.doesNotMatch(readFileSync(join(root, 'script/shots/seed.mjs'), 'utf8'), /requireSeeded/)
})

test('requireSeeded refuses a home missing its marker or its agents.json, naming seed.mjs (P2-3)', async t => {
  for (const missing of ['marker', 'agents.json']) {
    const directory = mkdtempSync(join(tmpdir(), 'hd-shots-unseeded-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const home = join(directory, 'home')
    mkdirSync(home, { recursive: true })
    if (missing !== 'marker') writeFileSync(join(home, '.rig-home.json'), '{}\n')
    if (missing !== 'agents.json') writeFileSync(join(home, 'agents.json'), '{}\n')

    let failure = null
    try {
      runAgainstConfig(
        "import { requireSeeded } from './script/shots/config.mjs'; requireSeeded(); process.stdout.write('reached')",
        { home, work: join(directory, 'work') },
      )
    } catch (error) {
      failure = error
    }
    assert.ok(failure, `missing ${missing} must refuse`)
    assert.notEqual(failure.status, 0)
    assert.match(String(failure.stderr), /seed\.mjs/, `the refusal must name seed.mjs (missing ${missing})`)
    assert.match(String(failure.stderr), /has not been seeded/)
  }
})

test('requireSeeded lets a properly seeded home through untouched (P2-3)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-seeded-'))
  try {
    const home = join(directory, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.rig-home.json'), '{}\n')
    writeFileSync(join(home, 'agents.json'), '{}\n')
    const out = runAgainstConfig(
      "import { requireSeeded } from './script/shots/config.mjs'; requireSeeded(); process.stdout.write('reached')",
      { home, work: join(directory, 'work') },
    )
    assert.equal(out, 'reached')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('importing config.mjs for a fresh default-shaped home does not poison it for the seed that follows', () => {
  // A real regression this fix introduced and then closed: `WORK`'s default
  // nests inside `HOME` (`config.mjs`), and eagerly creating that nested
  // `person/work` scaffold on every import — including a `shoot.mjs` run
  // that goes on to refuse via `requireSeeded` — left a non-empty, unmarked
  // `HOME` behind. The very next `seed.mjs`, on the very same home, then hit
  // its own #909 guard and refused to seed a folder it had itself just
  // created nothing real in. `WORK`'s default must resolve to the right
  // string without `mkdir`-ing anything, so a `HOME` nobody has seeded yet
  // stays genuinely empty until `seed.mjs` says otherwise.
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-work-scaffold-'))
  try {
    const home = join(directory, 'home')
    // No HD_SHOTS_WORK: this is exactly the shape the real default takes,
    // just rooted somewhere this test controls instead of the shared tmpdir.
    const env = { ...process.env, HD_SHOTS_HOME: home }
    delete env['HD_SHOTS_WORK']
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "import './script/shots/config.mjs'"],
      { cwd: root, env, stdio: 'pipe' },
    )
    assert.ok(existsSync(home), 'importing config.mjs must still create HOME itself')
    assert.deepEqual(readdirSync(home), [], 'HOME must stay empty until something actually seeds it')

    // And the seed that follows succeeds, rather than refusing a home it now
    // sees as non-empty and unmarked.
    execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], { env, stdio: 'pipe' })
    assert.ok(existsSync(join(home, '.rig-home.json')), 'the reseed must have been allowed to mark and stage this home')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
