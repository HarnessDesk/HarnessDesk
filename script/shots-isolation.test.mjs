import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentRegistryStore } from '../packages/server/dist/src/agent-registry.js'
import { parseSeating } from '../packages/server/dist/src/agent-seating-file.js'
import { Agents } from '../packages/server/dist/src/agents.js'
import { InstallService } from '../packages/server/dist/src/installs/service.js'
import { readChecks } from '../packages/server/dist/src/evidence/checks-file.js'
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
  for (const agent of configs) {
    assert.equal(service.knowledgeFor(agent), undefined, `${agent.id} must not inherit vendor stores or launch policy`)
    assert.equal(await service.launchFor(agent), null)
    assert.equal(agent.command, 'node')
    assert.deepEqual(agent.args, [join(root, 'script/shots/agent.mjs')])
    const sessions = Object.values(JSON.parse(readFileSync(agent.env.SHOT_STORE, 'utf8')))
    assert.ok(sessions.every(session => session.cwd.startsWith(join(directory, 'work') + '/')))
    const runtime = new AcpRuntime({ ...agent, resolveLaunch: occasion => service.launchFor(agent, occasion) })
    try {
      await runtime.start()
      const listed = await runtime.listSessions()
      assert.deepEqual(listed.data.map(session => session.id).sort(), sessions.map(session => session.sessionId).sort())
      assert.ok(listed.data.every(session => session.cwd.startsWith(join(directory, 'work') + '/')))
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
