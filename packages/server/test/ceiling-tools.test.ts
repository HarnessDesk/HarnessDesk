import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ExtensionKernel, type HarnessPlugin } from '@harnessdesk/cordis-host'
import { builtinPlugins } from '@harnessdesk/plugins'
import {
  itemId,
  runtimeId,
  sessionId,
  turnId,
  type FlowRun,
  type NoticeItem,
  type PluginInstance,
  type PluginPermissions,
  type ScopeQuery,
  type Session,
  type TeamState,
  type ToolResult,
} from '@harnessdesk/protocol'

import { PERSON } from '../src/ceilings/cause.js'
import { CeilingGate, GatedRegistry, refusalOf } from '../src/ceilings/gate.js'
import { DESK_TOOLS, EMBARGOED_TOOLS, toolCeiling } from '../src/ceilings/tools.js'
import { invokeForBridge } from '../src/tool-gateway.js'
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
  return { host, runtime, ran, call, agent, said, work, gated }
}

const scopeOf = (session: Session): ScopeQuery => ({ runtime: runtimeId(String(session.runtime)), sessionId: session.id })

test('through the host: a publish seat that asks the desk to merge is refused by the desk, the tool never runs, and the transcript says so', async (t) => {
  const { host, ran, call, agent, said, work } = await desk(t)
  await agent('releaser', 'ceiling: publish')
  const seat = (await host.call('agent/seat', { id: 'releaser', cwd: work, permission: 'publish' })) as Session
  const merged = await call('pr_merge', scopeOf(seat))
  assert.deepEqual(merged, { ok: false, error: 'Merge refused: this seat may publish, not merge — merging a pull request needs a seat that may merge.' })
  assert.deepEqual(ran, [])
  assert.equal(said(seat).at(-1), 'Merge refused: this seat may publish, not merge — merging a pull request needs a seat that may merge.')
  assert.equal((await call('pr_create', scopeOf(seat))).ok, true)
  assert.equal((await call('git_status', scopeOf(seat))).ok, true)
  assert.deepEqual(ran, ['pr_create', 'git_status'])
})

test('through the host: a read seat may read and speak, and may not publish', async (t) => {
  const { host, ran, call, agent, said, work } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal((await call('pr_create', scopeOf(seat))).ok, false)
  assert.equal(said(seat).at(-1), 'Publish refused: this seat may read, not publish — opening a pull request needs a seat that may publish.')
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
  const room = await host.teamPlane.createRoom(work, 'Gate room')
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

test("through the host: a sub-agent reaching the desk through its parent's bridge is held to the parent's ceiling", async (t) => {
  const { host, ran, agent, said, work, gated } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const callers = new Map([['token-of-the-seat', { runtime: String(seat.runtime), sessionId: String(seat.id) }]])
  const child = await invokeForBridge(gated, callers, { namespace: 'git', name: 'pr_create', args: {}, caller: 'token-of-the-seat' })
  assert.equal(child.ok, false)
  assert.deepEqual(ran, [], 'the desk refused before the tool ran')
  assert.equal(said(seat).at(-1), 'Publish refused: this seat may read, not publish — opening a pull request needs a seat that may publish.')
  assert.equal((await invokeForBridge(gated, callers, { namespace: 'git', name: 'pr_create', args: {}, caller: 'forgotten' })).ok, true)
  assert.deepEqual(ran, ['pr_create'])
})

test('through the host: a sub-agent the runtime reports with a conversation of its own is held to the seat that spawned it', async (t) => {
  const { host, runtime, ran, call, agent, said, work } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const turn = host.registry.get(FAKE_RUNTIME_ID, seat.id)?.session.turns.at(-1)
  assert.ok(turn, 'the standing order started a turn')
  runtime.emit({
    type: 'item/completed',
    sessionId: seat.id,
    turnId: turnId(String(turn.id)),
    item: {
      id: itemId('spawn-1'),
      type: 'subagent',
      action: 'spawn',
      status: 'completed',
      members: [{ sessionId: 'child-1' }],
    },
  })
  const fromChild = await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: sessionId('child-1') })
  assert.equal(fromChild.ok, false)
  assert.deepEqual(ran, [])
  assert.equal(said(seat).at(-1), 'Publish refused: this seat may read, not publish — opening a pull request needs a seat that may publish.', 'said where the ceiling is held')
  assert.equal((await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: sessionId('stranger') })).ok, true)
})

test('through the host: a delegated chain beyond the correlation bound cannot publish', async (t) => {
  const { host, runtime, ran, call, agent, work } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const turn = host.registry.get(FAKE_RUNTIME_ID, seat.id)?.session.turns.at(-1)
  assert.ok(turn, 'the standing order started a turn')
  let parent = String(seat.id)
  for (let depth = 0; depth < 9; depth += 1) {
    const child = `deep-child-${depth}`
    runtime.emit({
      type: 'item/completed', sessionId: sessionId(parent), turnId: turnId(String(turn.id)),
      item: { id: itemId(`spawn-deep-${depth}`), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: child }] },
    })
    parent = child
  }
  const escaped = await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: sessionId(parent) })
  assert.equal(escaped.ok, false)
  assert.equal((await call('git_status', { runtime: FAKE_RUNTIME_ID, sessionId: sessionId(parent) })).ok, true)
  assert.deepEqual(ran, ['git_status'], 'a deeply delegated child keeps its root scope')
})

test('through the host: an evicted delegated association cannot publish', async (t) => {
  const { host, runtime, ran, call, agent, work } = await desk(t)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const turn = host.registry.get(FAKE_RUNTIME_ID, seat.id)?.session.turns.at(-1)
  assert.ok(turn, 'the standing order started a turn')
  for (let index = 0; index <= 2000; index += 1) {
    runtime.emit({
      type: 'item/completed', sessionId: seat.id, turnId: turnId(String(turn.id)),
      item: { id: itemId(`spawn-evicted-${index}`), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: `evicted-child-${index}` }] },
    })
  }
  const escaped = await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: sessionId('evicted-child-0') })
  assert.equal(escaped.ok, false)
  assert.deepEqual(ran, [], 'an evicted delegated association must not become unscoped')
})

test('through the host: cross-runtime eviction keeps the evicted root unresolved for publish and merge', async (t) => {
  const { host, runtime, ran, call, agent, work } = await desk(t)
  const otherRuntimeId = runtimeId('other-fake')
  const other = new FakeRuntime({ id: otherRuntimeId })
  host.register(other)
  await agent('reviewer', 'ceiling: read')
  const seat = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const turn = host.registry.get(FAKE_RUNTIME_ID, seat.id)?.session.turns.at(-1)
  assert.ok(turn, 'the standing order started a turn')
  runtime.emit({
    type: 'item/completed', sessionId: seat.id, turnId: turnId(String(turn.id)),
    item: { id: itemId('spawn-cross-runtime-evicted'), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: 'cross-runtime-evicted-child' }] },
  })
  for (let index = 0; index < 2000; index += 1) {
    other.emit({
      type: 'item/completed', sessionId: sessionId('other-root'), turnId: turnId('other-turn'),
      item: { id: itemId(`spawn-other-${index}`), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: `other-child-${index}` }] },
    })
  }
  const scope = { runtime: FAKE_RUNTIME_ID, sessionId: sessionId('cross-runtime-evicted-child') }
  for (const tool of ['pr_create', 'pr_merge']) {
    assert.equal((await call(tool, scope)).ok, false, `${tool} cannot become unscoped after another runtime evicts its root`)
  }
  assert.deepEqual(ran, [], 'the lost root cannot reach either protected tool')
})

test('through the host: a restarted runtime must freshly report a delegated child before it can publish or merge', async (t) => {
  const { host, runtime, ran, call, agent, work } = await desk(t)
  await agent('releaser', 'ceiling: merge')
  const root = (await host.call('agent/seat', { id: 'releaser', cwd: work, permission: 'merge' })) as Session
  const turn = host.registry.get(FAKE_RUNTIME_ID, root.id)?.session.turns.at(-1)
  assert.ok(turn, 'the merge-capable root started its standing order')
  const child = sessionId('restart-child')
  runtime.emit({
    type: 'item/completed', sessionId: root.id, turnId: turnId(String(turn.id)),
    item: { id: itemId('spawn-before-restart'), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: String(child) }] },
  })
  assert.equal((await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: child })).ok, true)
  assert.equal((await call('pr_merge', { runtime: FAKE_RUNTIME_ID, sessionId: child })).ok, true)
  ran.length = 0

  runtime.setHealth({ state: 'starting' })
  runtime.setHealth({ state: 'ready' })

  for (const tool of ['pr_create', 'pr_merge']) {
    assert.equal(
      (await call(tool, { runtime: FAKE_RUNTIME_ID, sessionId: child })).ok,
      false,
      `${tool} cannot reuse a child-to-root correlation from before the restart`,
    )
  }
  assert.deepEqual(ran, [], 'stale correlations refuse before either protected tool runs')

  const freshRoot = (await host.call('agent/seat', { id: 'releaser', cwd: work, permission: 'merge' })) as Session
  const freshTurn = host.registry.get(FAKE_RUNTIME_ID, freshRoot.id)?.session.turns.at(-1)
  assert.ok(freshTurn, 'the runtime reopened a merge-capable root')
  runtime.emit({
    type: 'item/completed', sessionId: freshRoot.id, turnId: turnId(String(freshTurn.id)),
    item: { id: itemId('spawn-after-restart'), type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: String(child) }] },
  })
  assert.equal((await call('pr_create', { runtime: FAKE_RUNTIME_ID, sessionId: child })).ok, true)
  assert.equal((await call('pr_merge', { runtime: FAKE_RUNTIME_ID, sessionId: child })).ok, true)
  assert.deepEqual(ran, ['pr_create', 'pr_merge'], 'a freshly reported child regains its rooted authority')
})

/*
 * Phase 7, named addition: the blind-round embargo is a second check beside
 * the ceiling, on every desk path that posts to a forge — the caller's own
 * call and a call it delegated, whose root is the blind reviewer.
 */
test('a blind reviewer, or anything it delegated to, cannot post however high its ceiling', async (t) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const ran: string[] = []
  await kernel.load({
    manifest: { id: 'git', name: 'Git' },
    plugin: {
      name: 'git', inject: ['tools'],
      apply(ctx: { tools: { register(spec: unknown): void } }) {
        for (const name of ['pr_view', 'pr_review', 'pr_comment', 'issue_comment']) {
          ctx.tools.register({
            name, description: name, inputSchema: { type: 'object', properties: {} },
            execute: () => { ran.push(name); return `${name} ran` },
          })
        }
      },
    } as never,
  })
  await settle()
  assert.deepEqual(EMBARGOED_TOOLS['git'], ['pr_review', 'pr_comment', 'issue_comment'])
  const blind = new Set(['beta\u0000root'])
  const said: string[] = []
  const gate = new CeilingGate({
    rootOf: (runtime, id) => (id === 'child' ? { runtime: 'beta', sessionId: 'root' } : { runtime, sessionId: id }),
    ceilingOf: () => ({ level: 'merge', hold: 'held' }),
    causeOf: () => PERSON,
    nameOf: () => 'the reviewer',
    say: (_runtime, _id, text) => { said.push(text) },
    askPerson: async () => 'refused',
    embargoOf: (runtime, id) => (blind.has(`${runtime}\u0000${id}`) ? 'Refused: this Seat is reviewing in a blind round that has not closed.' : null),
  })
  const gated = new GatedRegistry(kernel, () => gate)
  const call = (name: string, id: string) => {
    const tool = kernel.list('tool').find((one) => one.name === name)
    assert.ok(tool, name)
    return gated.invokeTool(tool.id, {}, { runtime: runtimeId('beta'), sessionId: sessionId(id) })
  }
  for (const name of ['pr_review', 'pr_comment', 'issue_comment']) {
    for (const id of ['root', 'child']) {
      const refused = await call(name, id)
      assert.equal(refused.ok, false, `${name} from ${id}`)
      assert.match(refused.ok ? '' : refused.error, /blind round/)
    }
  }
  assert.deepEqual(ran, [], 'no posting tool ran')
  assert.equal((await call('pr_view', 'child')).ok, true, 'reading is never embargoed')
  blind.clear()
  assert.equal((await call('pr_review', 'child')).ok, true, 'once the round closed, the same call goes through')
  assert.deepEqual(ran, ['pr_view', 'pr_review'])
  assert.ok(said.every((line) => /blind round/.test(line)))
})
