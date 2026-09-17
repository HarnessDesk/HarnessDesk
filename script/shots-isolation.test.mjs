import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentRegistryStore } from '../packages/server/dist/src/agent-registry.js'
import { InstallService } from '../packages/server/dist/src/installs/service.js'
import { AcpRuntime } from '../packages/adapter-acp/dist/src/runtime.js'
import { RUNTIME_ACCOUNTS } from './shots/accounts.mjs'
import { USAGE, LEDGER } from './shots/usage.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('every capture dismisses only the normal import offer before auditing the frame', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const capture = shoot.slice(shoot.indexOf('const shoot = async'), shoot.indexOf('const setTheme = async'))
  const dismissal = capture.indexOf("dismissStanding({ key: 'import:offer', kind: 'import:offer', lifetime: 'once' })")
  assert.ok(dismissal >= 0, 'the standing banner is not a transient snapshot.notice')
  assert.ok(dismissal < capture.indexOf('await audit(name)'))
  assert.doesNotMatch(capture, /dismissNotices\(/, 'do not discard errors to make a scene look healthy')
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
