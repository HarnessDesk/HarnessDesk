import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import type { AgentRuntime } from '@harnessdesk/protocol'

import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { seatOptionsProblem } from '../src/seat-options.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const source = (seat: string) => `
version: 2
name: Compare
roles:
  competitor:
    kind: agent
    uses: writer
    seats: [${seat}, ${seat}]
    isolate: true
    grant: edit
seed: { role: competitor, title: Compare the change }
rules: []
`

const rig = async (t: TestContext, kind: 'codex' | 'acp') => {
  const base = tempDir('hd-flow-options-')
  const root = join(base, 'project')
  const stateDir = join(base, 'state')
  await mkdir(root)
  await mkdir(join(stateDir, 'agents', 'writer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'writer', 'AGENT.md'), '---\nname: Writer\nceiling: edit\nanswers: [done]\n---\nCompare the change.\n')
  const runtime: AgentRuntime = kind === 'codex'
    ? new CodexRuntime({ binaryPath: fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url)), clientName: 'harnessdesk-test' })
    : new AcpRuntime({ id: 'claude-code', name: 'Claude', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/seat-options-acp.mjs', import.meta.url))], toolServer: { name: 'harnessdesk', command: process.execPath, args: ['--version'], env: {} } })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: join(base, 'builtins'), catalogRefreshMs: 0 })
  host.register(runtime)
  t.after(() => host.dispose())
  await host.start()
  await host.call('workspace/open', { path: root })
  return { host, root, runtime }
}

for (const [kind, seat, reason] of [
  ['codex', 'codex=gpt-5.5/xhigh', /effort/i],
  ['codex', 'codex=gpt-5.5+thinking', /thinking/i],
  ['acp', 'claude-code=haiku/xhigh', /Haiku 4.5 has no effort levels/i],
  ['acp', 'claude-code=haiku+thinking', /thinking/i],
] as const) {
  test(`${kind}: preview refuses ${seat} and start creates no run, Goal, lane or card`, async (t) => {
    const { host, root } = await rig(t, kind)
    const text = source(seat)
    const preview = await host.call('flow/preview', { root, source: text })
    assert.equal(preview.token, null, JSON.stringify(preview.problems))
    assert.ok(preview.problems.some((problem) => problem.at.startsWith('roles.competitor') && reason.test(problem.text)), JSON.stringify(preview.problems))
    for (const index of [0, 1]) assert.ok(preview.problems.some((problem) => problem.at === `roles.competitor.seat[${index}]` && reason.test(problem.text)), 'each competitor has its own problem')
    await assert.rejects(host.call('flow/start-goal', { root, source: text, token: preview.token ?? 'not-authorized', sentence: 'Compare' }))
    assert.deepEqual(await host.call('flow/executions', {}), [])
    assert.deepEqual(await host.call('goal/list', { root }), [])
    assert.deepEqual(await host.call('lane/list', {}), [])
    assert.deepEqual(await host.call('team/rooms', { root }), [])
  })
}

test('an unread catalogue is a problem even for +thinking with no named model', async (t) => {
  const { host, root, runtime } = await rig(t, 'acp')
  runtime.knownModels = async () => null
  const preview = await host.call('flow/preview', { root, source: source('claude-code+thinking') })
  assert.equal(preview.token, null)
  assert.match(preview.problems[0]?.text ?? '', /model catalogue could not be read/)
  assert.deepEqual(await host.call('lane/list', {}), [])
})

test('start rechecks the runtime controls before creating a Run or lane', async (t) => {
  const { host, root, runtime } = await rig(t, 'codex')
  const text = source('codex=gpt-5.5/high')
  const preview = await host.call('flow/preview', { root, source: text })
  assert.ok(preview.token)
  runtime.defaultSessionOptions = async () => { throw new Error('session options are no longer readable') }
  await assert.rejects(host.call('flow/start-goal', { root, source: text, token: preview.token, sentence: 'Compare' }), /changed/)
  assert.deepEqual(await host.call('flow/executions', {}), [])
  assert.deepEqual(await host.call('goal/list', { root }), [])
  assert.deepEqual(await host.call('lane/list', {}), [])
})

test('a bare effort uses the default model after another preview changed the ACP probe', async (t) => {
  const { host, root } = await rig(t, 'acp')
  assert.ok((await host.call('flow/preview', { root, source: source('claude-code=opus/high') })).token)
  const preview = await host.call('flow/preview', { root, source: source('claude-code/high') })
  assert.equal(preview.token, null)
  assert.match(preview.problems[0]?.text ?? '', /Haiku 4.5 has no effort levels/)
})

test('idle cached controls cannot authorize a different model', async (t) => {
  const { host, root, runtime } = await rig(t, 'acp')
  assert.ok((await host.call('flow/preview', { root, source: source('claude-code=opus/high') })).token)
  assert.equal(await runtime.stopForIdle?.(), true)
  const text = source('claude-code=haiku/high')
  const preview = await host.call('flow/preview', { root, source: text })
  assert.equal(preview.token, null)
  assert.match(preview.problems[0]?.text ?? '', /session options.*idle/)
  await assert.rejects(host.call('flow/start-goal', { root, source: text, token: preview.token ?? 'not-authorized', sentence: 'Compare' }))
  assert.deepEqual(await host.call('flow/executions', {}), [])
  assert.deepEqual(await host.call('goal/list', { root }), [])
  assert.deepEqual(await host.call('lane/list', {}), [])
})

test('a bare effort honors the project model instead of overriding it with the catalogue default', async (t) => {
  const { host, root, runtime } = await rig(t, 'codex')
  const read = runtime.defaultSessionOptions!.bind(runtime)
  // A project pins a model with only Low effort. Preserve the real adapter's
  // option mapping; emulate only the project configuration readback.
  runtime.defaultSessionOptions = async (cwd, values) => {
    const options = await read(cwd, values)
    return values?.['model'] ? options : options.map((option) => option.id === 'effort' && option.type === 'select'
      ? { ...option, currentValue: 'low', choices: option.choices.filter((choice) => choice.value === 'low') }
      : option)
  }
  const preview = await host.call('flow/preview', { root, source: source('codex/high') })
  assert.equal(preview.token, null)
  assert.match(preview.problems[0]?.text ?? '', /"high" is not one of the values Reasoning effort offers/)
  assert.deepEqual(await host.call('goal/list', { root }), [])
  assert.deepEqual(await host.call('lane/list', {}), [])
})

test('a runtime that never answers the option read leaves a bounded problem', async (t) => {
  const { runtime, root } = await rig(t, 'acp')
  runtime.defaultSessionOptions = () => new Promise(() => {})
  assert.match(await seatOptionsProblem(runtime, { runtime: 'claude-code', model: 'opus', effort: 'high' }, root, 10) ?? '', /session options could not be read within 10 ms/)
})

for (const [kind, seat] of [['codex', 'codex=gpt-5.5/high'], ['acp', 'claude-code=opus/high']] as const) {
  test(`${kind}: supported model and effort still receive a start token`, async (t) => {
    const { host, root } = await rig(t, kind)
    const preview = await host.call('flow/preview', { root, source: source(seat) })
    assert.ok(preview.token, JSON.stringify(preview.problems))
    assert.equal(preview.problems.filter((problem) => problem.level === 'error').length, 0)
  })
}
