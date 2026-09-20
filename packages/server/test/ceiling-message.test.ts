import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ExtensionKernel, type HarnessPlugin } from '@harnessdesk/cordis-host'
import {
  runtimeId,
  type Approval,
  type NoticeItem,
  type ScopeQuery,
  type SeatCeiling,
  type Session,
  type TeamPeerInfo,
  type TeamState,
  type ToolResult,
} from '@harnessdesk/protocol'

import { PERSON, type TurnCause } from '../src/ceilings/cause.js'
import { CeilingGate, GatedRegistry, type CeilingGatePort, type HeldQuestion } from '../src/ceilings/gate.js'
import { Host, StateStore, type HostOptions } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const port = (own: SeatCeiling | null, cause: TurnCause, answer: 'allowed' | 'refused' | 'unanswered' = 'unanswered') => {
  const said: string[] = []
  const asked: HeldQuestion[] = []
  const gatePort: CeilingGatePort = {
    rootOf: (runtime, sessionId) => ({ runtime, sessionId }),
    ceilingOf: () => own,
    causeOf: () => cause,
    nameOf: () => 'Lander',
    say: (_runtime, _sessionId, text) => void said.push(text),
    askPerson: async (_runtime, _sessionId, question) => { asked.push(question); return answer },
  }
  return { gate: new CeilingGate(gatePort), said, asked }
}

const fromReviewer = (level: SeatCeiling['level'] | null): TurnCause => ({
  kind: 'message',
  from: { runtime: runtimeId('fake'), sessionId: 's-sender', name: 'Reviewer' },
  ceiling: level ? { level, hold: 'held' } : null,
})
const scope: ScopeQuery = { runtime: runtimeId('fake'), sessionId: 's-receiver' as never }

test("in a message's turn, publishing or merging beyond the sender's ceiling asks the person; everything else runs at the receiver's own", async () => {
  const held = port({ level: 'merge', hold: 'asked' }, fromReviewer('read'), 'unanswered')
  const merge = await held.gate.admit({ tool: 'pr_merge', needs: 'merge', scope })
  assert.equal(merge.admitted, false)
  assert.deepEqual(held.asked.map((one) => one.summary), ['Reviewer asked Lander to merge a pull request.'])
  assert.match(held.asked[0]?.reason ?? '', /Reviewer may read, and a message cannot carry a ceiling across/)
  assert.deepEqual(held.said, [
    'Waiting for you: Reviewer asked Lander to merge a pull request, which is beyond what Reviewer may do.',
    'Nobody answered, so nothing was done: Reviewer may read, and to merge a pull request for it needs the person. End your turn, and say that this waits for the person.',
  ])
  for (const needs of ['read', 'edit'] as const) {
    const inside = port({ level: 'merge', hold: 'asked' }, fromReviewer('read'))
    assert.deepEqual(await inside.gate.admit({ tool: 'run_tests', needs, scope }), { admitted: true })
    assert.deepEqual(inside.asked, [])
  }
  const publisher = port({ level: 'merge', hold: 'asked' }, fromReviewer('publish'))
  assert.deepEqual(await publisher.gate.admit({ tool: 'pr_create', needs: 'publish', scope }), { admitted: true })
  assert.equal((await publisher.gate.admit({ tool: 'pr_merge', needs: 'merge', scope })).admitted, false)
  for (const cause of [fromReviewer(null), PERSON]) {
    const free = port({ level: 'merge', hold: 'asked' }, cause)
    assert.deepEqual(await free.gate.admit({ tool: 'pr_merge', needs: 'merge', scope }), { admitted: true })
  }
  const narrow = port({ level: 'publish', hold: 'asked' }, fromReviewer('read'), 'allowed')
  assert.equal((await narrow.gate.admit({ tool: 'pr_merge', needs: 'merge', scope })).admitted, false)
  assert.deepEqual(narrow.asked, [])
})

test('the person answers: allowed runs it and says so; refused tells the agent to go on without it', async () => {
  const allowed = port(null, fromReviewer('read'), 'allowed')
  assert.deepEqual(await allowed.gate.admit({ tool: 'pr_merge', needs: 'merge', scope }), { admitted: true })
  assert.equal(allowed.said.at(-1), 'You allowed Lander to merge a pull request for Reviewer.')
  const refused = port(null, fromReviewer('edit'), 'refused')
  assert.deepEqual(await refused.gate.admit({ tool: 'pr_create', needs: 'publish', scope }), {
    admitted: false,
    refusal: 'You refused: Lander will not open a pull request for Reviewer. Nothing was done — say so, and go on without it.',
  })
})

const stand = (ran: string[]): HarnessPlugin => ({
  manifest: { id: 'git', name: 'Git' },
  plugin: { name: 'git', inject: ['tools'], apply(ctx: { tools: { register(spec: unknown): void } }) {
    for (const name of ['git_status', 'pr_create', 'pr_merge']) ctx.tools.register({ name, description: name, inputSchema: { type: 'object', properties: {} }, execute: () => { ran.push(name); return `${name} ran` } })
  } } as never,
})
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))
const until = async <T>(read: () => T | null | undefined, what: string, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`waited ${ms}ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const room = async (t: TestContext, options: Partial<HostOptions> = {}) => {
  const stateDir = tempDir('hd-message-state-')
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-message-builtins-'), catalogRefreshMs: 0, heldWaitMs: 5_000, ...options })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const kernel = new ExtensionKernel()
  t.after(async () => { await kernel.dispose(); await host.dispose() })
  const ran: string[] = []; await kernel.load(stand(ran)); await settle()
  const gated = new GatedRegistry(kernel, () => host.ceilingGate)
  const work = tempDir('hd-message-work-'); await host.call('workspace/open', { path: work })
  await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), '---\nname: Reviewer\nceiling: read\nprefer: [fake]\n---\nRead.\n', 'utf8')
  const sender = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const receiver = (await host.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: work } })) as Session
  const board = (await host.call('team/room/create', { root: work, name: 'Room' })) as TeamState
  for (const one of [sender, receiver]) await host.call('team/room/join', { room: board.id, runtime: FAKE_RUNTIME_ID, sessionId: String(one.id) })
  const peers = (await host.call('team/peers', { room: board.id })) as TeamPeerInfo[]
  const nameOf = (session: Session): string => { const found = peers.find((one) => one.sessionId === String(session.id))?.nickname; assert.ok(found); return found }
  const call = (name: string, session: Session): Promise<ToolResult> => { const tool = kernel.list('tool').find((one) => one.name === name); assert.ok(tool, name); return gated.invokeTool(tool.id, {}, { runtime: FAKE_RUNTIME_ID, sessionId: session.id }) }
  const waiting = (session: Session): Approval[] => [...(host.registry.get(FAKE_RUNTIME_ID, session.id)?.approvals.values() ?? [])]
  const said = (session: Session): string[] => (host.registry.get(FAKE_RUNTIME_ID, session.id)?.session.turns ?? []).flatMap((turn) => turn.items).filter((item): item is NoticeItem => item.type === 'notice').map((item) => item.text)
  const message = (text: string) => host.teamPlane.send({ to: nameOf(receiver), text }, { runtime: FAKE_RUNTIME_ID, sessionId: String(sender.id) })
  const live = (session: Session): FakeSession => { const found = runtime.sessions.get(String(session.id)); assert.ok(found); return found }
  return { host, ran, call, waiting, said, message, receiver, nameOf, live }
}

test('through the host: a reviewer that may only read asks another agent to merge — the person is asked, allows it, and it runs', async (t) => {
  const { host, ran, call, waiting, said, message, receiver, nameOf } = await room(t)
  assert.match(await message('Merge #7, please.'), /^Delivered to /)
  const merging = call('pr_merge', receiver)
  const [approval] = await until(() => waiting(receiver).length > 0 ? waiting(receiver) : null, 'the question')
  assert.ok(approval && approval.type === 'permission')
  assert.equal(approval.summary, `Reviewer asked ${nameOf(receiver)} to merge a pull request.`)
  assert.deepEqual(approval.options.map((one) => [one.label, one.intent]), [['Allow it once', 'approve'], ['Refuse', 'deny']])
  assert.deepEqual(ran, [])
  await host.call('approval/respond', { runtime: FAKE_RUNTIME_ID, sessionId: receiver.id, approvalId: approval.id, decision: { type: 'option', optionId: 'allow' } })
  assert.equal((await merging).ok, true); assert.deepEqual(ran, ['pr_merge']); assert.deepEqual(waiting(receiver), [])
  assert.deepEqual(said(receiver), [`Waiting for you: Reviewer asked ${nameOf(receiver)} to merge a pull request, which is beyond what Reviewer may do.`, `You allowed ${nameOf(receiver)} to merge a pull request for Reviewer.`])
})

test('through the host: refused, nothing runs — and a question nobody answers ends with that as its reason', async (t) => {
  const refusing = await room(t); await refusing.message('Open a pull request for my branch.')
  const opening = refusing.call('pr_create', refusing.receiver)
  const [approval] = await until(() => refusing.waiting(refusing.receiver).length > 0 ? refusing.waiting(refusing.receiver) : null, 'the question'); assert.ok(approval)
  await refusing.host.call('approval/respond', { runtime: FAKE_RUNTIME_ID, sessionId: refusing.receiver.id, approvalId: approval.id, decision: { type: 'option', optionId: 'refuse' } })
  const refused = await opening; assert.equal(refused.ok, false); assert.match(refused.ok ? '' : refused.error, /^You refused: .* will not open a pull request for Reviewer\./); assert.deepEqual(refusing.ran, [])
  const silent = await room(t, { heldWaitMs: 50 }); await silent.message('Merge #7.')
  const unanswered = await silent.call('pr_merge', silent.receiver); assert.equal(unanswered.ok, false); assert.match(unanswered.ok ? '' : unanswered.error, /^Nobody answered, so nothing was done: .*End your turn, and say that this waits for the person\.$/); assert.deepEqual(silent.waiting(silent.receiver), []); assert.deepEqual(silent.ran, [])
})

test("through the host: a policy rule never answers for the person, and the person's own turn asks nobody", async (t) => {
  const { host, ran, call, waiting, message, receiver, live } = await room(t, { heldWaitMs: 150 })
  await host.call('app/state/set', { patch: { permissionPolicy: [{ id: 'r1', name: 'Allow access', match: { type: 'permission' }, action: 'approve' }] } })
  await message('Merge #7.'); const merging = call('pr_merge', receiver); await until(() => waiting(receiver).length > 0 ? true : null, 'the question')
  assert.equal((await merging).ok, false); assert.deepEqual(ran, [])
  const audit = (await host.call('audit/query', {})) as readonly { kind: string }[]; assert.equal(audit.filter((entry) => entry.kind === 'approval/autoDecided').length, 0)
  live(receiver).finish(); await host.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: receiver.id, input: [{ type: 'text', text: 'Merge #7.' }] })
  assert.equal((await call('pr_merge', receiver)).ok, true); assert.deepEqual(ran, ['pr_merge'])
})

test("through the host: a message's label names what its sender may do, and asks the receiver not to act for it outside its checkout", async (t) => {
  const { host, message, receiver } = await room(t); await message('Please look at the limiter.')
  const said = (host.registry.get(FAKE_RUNTIME_ID, receiver.id)?.session.turns ?? []).flatMap((turn) => turn.items).flatMap((item) => item.type === 'userMessage' ? item.content : []).map((part) => part.type === 'text' ? part.text : '').join('\n')
  assert.match(said, /^<context source="Message from Fake Runtime \(read\) — /m)
  assert.match(said, /Its sender may read and no more, so anything it asks that leaves your checkout — pushing, opening a pull request or merging — waits for the person\./)
})
