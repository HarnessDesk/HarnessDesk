import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentRegistryStore } from '../packages/server/dist/src/agent-registry.js'
import { Host, Logger, StateStore } from '../packages/server/dist/src/index.js'
import { AcpRuntime } from '../packages/adapter-acp/dist/src/runtime.js'
import { CodexRuntime } from '../packages/adapter-codex/dist/src/index.js'

/**
 * #927: a front-door start over the rig this repository actually stages —
 * `seed.mjs`'s own `agents.json`, not a hand-built stand-in for it.
 *
 * Every camera row but one is the same ACP fixture (`agent.mjs`), and ACP
 * gives no reliable ceiling read-back at all — documented in
 * `docs/agent-capabilities.md`, not a gap this fixture could paper over
 * without misrepresenting what the real product does. The one row that can
 * ever hold is `codex`, the reserved id `cast.mjs` frees from the camera cast
 * in native-Codex staging (`HD_SHOTS_NATIVE_CODEX=1`) so the real built-in
 * adapter answers there instead, over the same `fake-codex.mjs` every other
 * adapter-codex test runs. This seeds exactly that way, registers every
 * configured row plus the real `CodexRuntime`, and seats the real shipped
 * `implementer` Agent's own role (`prefer: [claude-code, codex, cursor]`) —
 * `claude-code` and `cursor` are not registered runtime ids here (the rig's
 * own rows are `shots-claude-code`/`shots-cursor`), so `codex` is the one
 * candidate this seating can actually reach, and it must read back held.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_CODEX = join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs')

const SHAPE = [
  'version: 2',
  'name: Build it',
  'roles:',
  '  build: { kind: agent, uses: [implementer], grant: edit }',
  'seed: { role: build, title: Build the change }',
  '',
].join('\n')

test('a front-door start over the rig staged by the real seed.mjs seats the codex row held (#927)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-front-door-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '1' },
    stdio: 'pipe',
  })
  const configs = new AgentRegistryStore(join(home, 'agents.json')).configs()
  assert.ok(configs.length > 0, 'the rig staged at least one camera row')
  assert.ok(!configs.some((agent) => agent.id === 'codex'), 'native-Codex staging frees the reserved id from the camera cast')

  const stateDir = mkdtempSync(join(tmpdir(), 'hd-shots-front-door-state-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const builtinAgents = join(stateDir, 'builtin-agents')
  mkdirSync(join(builtinAgents, 'implementer'), { recursive: true })
  // The real shipped Agent's own frontmatter (packages/server/agents/implementer/AGENT.md).
  writeFileSync(
    join(builtinAgents, 'implementer', 'AGENT.md'),
    '---\nname: Implementer\nceiling: publish\nprefer: [claude-code, codex, cursor]\n---\nBuild the change.\n',
    'utf8',
  )

  const host = new Host({
    logger: new Logger('test', { level: 'error', console: false }),
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents,
    catalogRefreshMs: 0,
  })
  const camera = configs.map((config) => new AcpRuntime(config))
  const codex = new CodexRuntime({ binaryPath: FAKE_CODEX, clientName: 'harnessdesk-shots-test' })
  for (const runtime of camera) host.register(runtime)
  host.register(codex)
  await host.start()
  await Promise.all([...camera.map((runtime) => runtime.start()), codex.start()])
  t.after(async () => {
    await Promise.all([...camera.map((runtime) => runtime.dispose()), codex.dispose()])
    await host.dispose()
  })

  mkdirSync(work, { recursive: true })
  await host.call('workspace/open', { path: work })

  const preview = await host.call('authoring/start/preview', {
    context: { kind: 'project', root: work },
    source: SHAPE,
    vars: {},
  })
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  assert.deepEqual(preview.flow.seats[0]?.plan.ceiling, { level: 'edit', hold: 'held' })

  const run = await host.call('flow/start-goal', {
    root: work,
    source: SHAPE,
    token: preview.flow.token,
    sentence: preview.sentence,
  })
  assert.equal(run.state, 'running', run.reason ?? '')
  const view = await host.call('goal/read', { goal: run.goal })
  assert.equal(view.members.length, 1)
  assert.deepEqual(view.members[0]?.ceiling, { level: 'edit', hold: 'held' })
})

/**
 * #946 review: the `front-door` shots scene seats the Implementer on the
 * native Codex fixture, which starts its own scripted turn the moment it
 * holds the seat — and that fixture reports its own bookkeeping
 * (`TOOLS_DECLARED …`) as a notice over the pane, the same way it does for
 * every other native-Codex scene (`review`, the approval scenes). Every one
 * of those calls `dismissFixtureEchoes()` right before its final capture; a
 * scene that skips it publishes the fixture's own echo instead of the app.
 *
 * A source check, not a live one: the scene drives the real Electron app over
 * CDP, which this suite does not launch (see this file's own header on
 * `shots-front-door.test.mjs`'s scope). What can be checked without a window
 * is that the call is actually there, and after the point the Goal page is
 * confirmed reached rather than before it.
 */
test('the front-door scene dismisses the fixture\'s own echoes before its final capture, the way every native-Codex scene does (#946 review)', () => {
  const shoot = readFileSync(join(root, 'script/shots/shoot.mjs'), 'utf8')
  const sceneStart = shoot.indexOf("'front-door': {")
  assert.notEqual(sceneStart, -1, 'shoot.mjs still has the front-door scene')
  const sceneEnd = shoot.indexOf('\n    } },', sceneStart)
  assert.notEqual(sceneEnd, -1, 'the front-door scene still closes the way every other scene does')
  const scene = shoot.slice(sceneStart, sceneEnd)
  const reachedGoal = scene.indexOf('Ship it once every specialist approves')
  assert.notEqual(reachedGoal, -1, 'the scene still waits for the Goal page sentence')
  const dismissed = scene.indexOf('dismissFixtureEchoes()')
  assert.notEqual(dismissed, -1, 'the front-door scene must call dismissFixtureEchoes() before its capture')
  assert.ok(dismissed > reachedGoal, 'the fixture\'s echoes are dismissed after the Goal page is reached, not before it exists to dismiss them from')
})
