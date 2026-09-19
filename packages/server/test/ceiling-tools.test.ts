import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ExtensionKernel, type HarnessPlugin } from '@harnessdesk/cordis-host'
import { builtinPlugins } from '@harnessdesk/plugins'
import {
  runtimeId,
  sessionId,
  type FlowRun,
  type NoticeItem,
  type PluginInstance,
  type PluginPermissions,
  type ScopeQuery,
  type Session,
  type TeamState,
  type ToolResult,
} from '@harnessdesk/protocol'

import { GatedRegistry, refusalOf } from '../src/ceilings/gate.js'
import { DESK_TOOLS, toolCeiling } from '../src/ceilings/tools.js'
import { Host, StateStore } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

test('every tool the desk ships has its line, and a tool it did not place, or did not ship, is never read as harmless', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  for (const plugin of builtinPlugins) await kernel.load(plugin)
  await settle()
  const plugins = kernel.plugins()
  const tools = kernel.list('tool')
  assert.ok(tools.length > 40)
  for (const tool of tools) {
    const plugin = plugins.find((one) => one.instanceId === tool.owner)
    assert.ok(plugin, tool.name)
    const placed = DESK_TOOLS[plugin.identity.id]?.[tool.name]
    assert.ok(placed, `${plugin.identity.id}/${tool.name} ships with the desk and has no line in DESK_TOOLS`)
    assert.equal(toolCeiling(tool, plugin), placed)
  }
  assert.deepEqual(
    ['pr_review', 'pr_comment', 'pr_create', 'pr_update', 'pr_merge'].map((name) => DESK_TOOLS['git']?.[name]),
    ['read', 'read', 'publish', 'publish', 'merge'],
  )
  const git = plugins.find((one) => one.identity.id === 'git')
  assert.equal(toolCeiling({ name: 'pr_rewrite' }, git), 'merge')
  assert.equal(toolCeiling({ name: 'git_status' }, undefined), 'merge')
})

test("a plugin the desk did not ship is placed by what it was granted — and borrows nothing from the desk's own names", () => {
  const installed = (permissions: Partial<PluginPermissions>): PluginInstance => ({
    instanceId: 'installed#1',
    identity: { id: 'git', name: 'Look-alike', source: { kind: 'local' as const, path: '/somewhere' } },
    state: 'active', revision: 1,
    permissions: {
      workspace: { read: true, write: false }, shell: false, network: { hosts: [] }, agents: { invoke: false },
      ui: { contribute: false }, secrets: [], browser: false, ios: false, android: false, editor: false,
      team: false, forge: false, ...permissions,
    },
    injects: [], provides: [], contributions: [], enabled: true,
  }) as unknown as PluginInstance
  assert.equal(toolCeiling({ name: 'pr_view' }, installed({})), 'read')
  assert.equal(toolCeiling({ name: 'x' }, installed({ workspace: { read: true, write: true } })), 'edit')
  assert.equal(toolCeiling({ name: 'x' }, installed({ editor: true })), 'edit')
  assert.equal(toolCeiling({ name: 'x' }, installed({ shell: true })), 'merge')
  assert.equal(toolCeiling({ name: 'x' }, installed({ forge: true })), 'merge')
  assert.equal(toolCeiling({ name: 'x' }, installed({ network: { hosts: ['example.com'] } })), 'merge')
  assert.equal(toolCeiling({ name: 'x' }, installed({ agents: { invoke: true } })), 'merge')
})

test('a refusal is a sentence that says what the seat may do, never a tool name', () => {
  assert.equal(
    refusalOf('pr_merge', 'merge', 'publish'),
    'Merge refused: this seat may publish, not merge — merging a pull request needs a seat that may merge.',
  )
  assert.equal(
    refusalOf('pr_create', 'publish', 'read'),
    'Publish refused: this seat may read, not publish — opening a pull request needs a seat that may publish.',
  )
  assert.equal(refusalOf('some_tool', 'edit', 'read'), 'Edit refused: this seat may read, not edit.')
})

const stand = (ran: string[]): HarnessPlugin => ({
  manifest: { id: 'git', name: 'Git' },
  plugin: {
    name: 'git', inject: ['tools'],
    apply(ctx: { tools: { register(spec: unknown): void } }) {
      for (const name of ['git_status', 'pr_create', 'pr_merge']) {
        ctx.tools.register({
          name, description: name, inputSchema: { type: 'object', properties: {} },
          execute: () => { ran.push(name); return `${name} ran` },
        })
      }
    },
  } as never,
})

const desk = async (t: TestContext) => {
  const stateDir = tempDir('hd-gate-state-')
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-gate-builtins-'), catalogRefreshMs: 0 })
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const kernel = new ExtensionKernel()
  t.after(async () => { await kernel.dispose(); await host.dispose() })
  const ran: string[] = []
  await kernel.load(stand(ran))
  await settle()
  const gated = new GatedRegistry(kernel, () => host.ceilingGate)
  const work = tempDir('hd-gate-work-')
  await host.call('workspace/open', { path: work })
  const call = async (name: string, scope: ScopeQuery): Promise<ToolResult> => {
    const tool = kernel.list('tool').find((one) => one.name === name)
    assert.ok(tool, name)
    return gated.invokeTool(tool.id, {}, scope)
  }
  const agent = async (id: string, ceilingLine: string): Promise<void> => {
    await mkdir(join(stateDir, 'agents', id), { recursive: true })
    await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), `---\nname: ${id}\n${ceilingLine}\nprefer: [fake]\n---\nWork.\n`, 'utf8')
  }
  const said = (session: Session): string[] =>
    (host.registry.get(FAKE_RUNTIME_ID, session.id)?.session.turns ?? [])
      .flatMap((turn) => turn.items)
      .filter((item): item is NoticeItem => item.type === 'notice')
      .map((item) => item.text)
  return { host, ran, call, agent, said, work }
}

const scopeOf = (session: Session): ScopeQuery => ({ runtime: runtimeId(String(session.runtime)), sessionId: session.id })

test('through the host: a publish seat that asks the desk to merge is refused by the desk, the tool never runs, and the transcript says so', async (t) => {
  const { host, ran, call, agent, said, work } = await desk(t)
  await agent('releaser', 'ceiling: publish')
  const seat = (await host.call('agent/seat', { id: 'releaser', cwd: work, permission: 'publish' })) as Session
  const merged = await call('pr_merge', scopeOf(seat))
  assert.deepEqual(merged, { ok: false, error: 'Merge refused: this seat may publish, not merge — merging a pull request needs a seat that may merge.' })
  assert.deepEqual(ran, [])
  assert.deepEqual(said(seat), ['Merge refused: this seat may publish, not merge — merging a pull request needs a seat that may merge.'])
  assert.equal((await call('pr_create', scopeOf(seat))).ok, true)
  assert.equal((await call('git_status', scopeOf(seat))).ok, true)
  assert.deepEqual(ran, ['pr_create', 'git_status'])
})

test('through the host: a read seat may read and speak, and may not publish', async (t) => {
  const { host, ran, call, agent, said, work } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal((await call('pr_create', scopeOf(seat))).ok, false)
  assert.deepEqual(said(seat), ['Publish refused: this seat may read, not publish — opening a pull request needs a seat that may publish.'])
  assert.equal((await call('git_status', scopeOf(seat))).ok, true)
  assert.deepEqual(ran, ['git_status'])
})

test('through the host: a plain conversation, and a call no conversation can be named for, are what they always were', async (t) => {
  const { host, ran, call } = await desk(t)
  const plain = (await host.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  assert.equal((await call('pr_merge', scopeOf(plain))).ok, true)
  assert.equal((await call('pr_merge', {})).ok, true)
  assert.deepEqual(ran, ['pr_merge', 'pr_merge'])
})

test("through the host: a flow's seat is held to its role's permission — read, which is edit — and refused a pull request", async (t) => {
  const { host, ran, call, work } = await desk(t)
  const room = (await host.call('team/room/create', { root: work, name: 'Gate room' })) as TeamState
  const source = `
name: Gate check
roles:
  worker:
    kind: agent
    seat: fake
    permission: read
    outcomes: [done]
    order: Do the one thing.
seed:
  role: worker
  title: The one thing
`
  const run = (await host.call('flow/start', { room: room.id, source })) as FlowRun
  const [seat] = run.seats
  assert.ok(seat)
  const scope = { runtime: runtimeId(seat.runtime), sessionId: sessionId(seat.sessionId) }
  assert.equal((await call('pr_create', scope)).ok, false)
  assert.equal((await call('git_status', scope)).ok, true)
  await host.call('flow/stop', { run: run.id })
  assert.equal((await call('pr_create', scope)).ok, true)
  assert.deepEqual(ran, ['git_status', 'pr_create'])
})
