import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  HANDOFF_PREFIX,
  runtimeId,
  type CarryOnIncidentView,
  type CarryOnItem,
  type RuntimeInfo,
  type Session,
} from '@harnessdesk/protocol'

import { CONTINUE_TEXT } from '../src/carry-on/decide.js'
import { Host, StateStore, serve } from '../src/index.js'
import { MOVE_TEXT_CHARS } from '../src/lead/chats.js'
import { FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, silent } from './fixtures/harness.js'

/**
 * The design's §11.4, through the real host: a usage limit on one account
 * carries the conversation on — on a sibling over the same thread, or to
 * another agent with a handoff — and the person's answer is checked, not
 * trusted. Seat cases are piece D.
 */

const PRIMARY = runtimeId('fake')
const SIBLING = runtimeId('fake-2')
const OTHER = runtimeId('other')
const STORE = '/home/agent/sessions'

interface Rig {
  readonly host: Host
  readonly client: Client
  readonly primary: FakeRuntime
  readonly sibling: FakeRuntime | null
  readonly other: FakeRuntime
  readonly sent: { runtime: string; session: string; text: string }[]
  readonly stateDir: string
}

/** One agent with two accounts over one store (unless `sibling` is off), and a second agent. */
const rig = async (t: TestContext, options: { readonly sibling?: boolean } = {}): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  const primary = new FakeRuntime({ id: PRIMARY, accountLabel: 'work', sessionStore: STORE })
  const sibling = options.sibling === false ? null : new FakeRuntime({ id: SIBLING, name: 'Fake Runtime', accountLabel: 'personal', sessionStore: STORE })
  const other = new FakeRuntime({ id: OTHER, name: 'Other Agent', accountLabel: 'Jane Doe' })
  // Two accounts of one agent are what the account wiring says they are.
  const accounts = {
    canAdd: () => false,
    slotOf: (info: RuntimeInfo) => String(info.id).startsWith('fake')
      ? { agent: PRIMARY, home: null, removable: info.id !== PRIMARY }
      : null,
    add: async () => { throw new Error('unused') },
    remove: async () => { throw new Error('unused') },
  }
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9', accounts } as never)
  for (const runtime of [primary, sibling, other]) if (runtime) host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  t.after(async () => {
    await client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const sent: Rig['sent'] = []
  for (const runtime of [primary, sibling, other]) if (runtime) {
    runtime.onSend = (session, text) => { sent.push({ runtime: String(runtime.info.id), session: String(session.id), text }) }
  }
  return { host, client, primary, sibling, other, sent, stateDir }
}

const prefer = (r: Rig, onLimit: 'ask' | 'switch', otherAgents = true) =>
  r.client.call('app/state/set', { patch: { carryOn: { onLimit, otherAgents } } })

/** A conversation on the primary whose one turn hits the account's limit. */
const stuck = async (r: Rig, text = 'Fix the failing build on main.'): Promise<Session> => {
  const session = (await r.client.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })) as Session
  await r.client.call('turn/send', { runtime: PRIMARY, sessionId: session.id, input: [{ type: 'text', text }] })
  await r.client.until(() => r.sent.some(one => one.session === String(session.id)), 5_000, 'the first turn to start')
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')
  return session
}

const changes = (r: Rig): CarryOnIncidentView[] => r.client.notifications.flatMap(message =>
  'method' in message && message.method === 'carryOn/changed' ? [(message.params as { incident: CarryOnIncidentView }).incident] : [])

const markers = (session: Session): CarryOnItem[] =>
  session.turns.flatMap(turn => turn.items.filter((item): item is CarryOnItem => item.type === 'carryOn'))

test('a sibling over the same store takes the thread over: the stuck account lets go first, then it continues', async t => {
  const r = await rig(t)
  await prefer(r, 'switch')
  const order: string[] = []
  // The fixture's sessions all call themselves 'fake'; a real second account's call themselves by its own id.
  const own = <T extends { runtime: unknown }>(value: T): T => ({ ...value, runtime: SIBLING })
  const read = r.sibling!.readSession.bind(r.sibling!)
  r.sibling!.readSession = async id => own(await read(id))
  const resume = r.sibling!.resumeSession.bind(r.sibling!)
  r.sibling!.resumeSession = async (id, options) => {
    order.push('resume on the sibling')
    const handle = await resume(id, options) as FakeSession
    const snapshot = handle.snapshot.bind(handle)
    Object.defineProperty(handle, 'runtime', { get: () => SIBLING })
    handle.snapshot = () => own(snapshot())
    return handle
  }
  const session = await stuck(r)
  const closeA = r.primary.sessions.get(session.id)!
  const close = closeA.close.bind(closeA)
  closeA.close = async () => { order.push('close on the primary'); return close() }

  await r.client.until(() => r.sent.some(one => one.runtime === SIBLING && one.text === CONTINUE_TEXT), 10_000, 'the continue on the sibling')
  assert.deepEqual(order, ['close on the primary', 'resume on the sibling'], 'one live writer per thread')
  assert.equal(r.sibling!.sessions.get(session.id)?.id, session.id, 'the same thread, not a new one')

  const after = (await r.client.call('session/read', { runtime: SIBLING, sessionId: session.id })) as Session
  const switched = markers(after).find(one => one.phase === 'switched')
  assert.ok(switched, 'the marker is part of the conversation')
  assert.equal(switched.mode, 'sameThread')
  assert.equal(switched.to?.account, 'account 2', 'named by its ordinal, never an address')
  assert.equal(switched.link, undefined, 'a same-thread switch has nowhere else to point')

  await r.client.until(() => changes(r).some(one => one.state === 'moved'), 5_000, 'the moved incident')
  const incident = changes(r).findLast(one => one.state === 'moved')!
  assert.equal(incident.runtime, SIBLING, 'the incident follows the conversation')
  assert.deepEqual(((await r.client.call('carryOn/list', {})) as { incidents: CarryOnIncidentView[] }).incidents, [], 'and nothing is left to answer')
})

test('another agent is handed the conversation in one capped packet, with a link each way', async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const session = await stuck(r, `Fix the failing build on main.\n${'detail '.repeat(20_000)}`)

  await r.client.until(() => r.sent.some(one => one.runtime === OTHER), 10_000, 'the handoff on the other agent')
  const first = r.sent.find(one => one.runtime === OTHER)!
  assert.ok(first.text.includes(HANDOFF_PREFIX), 'the first message is the handoff packet')
  assert.ok(first.text.length <= MOVE_TEXT_CHARS, `the packet is capped (${first.text.length})`)
  assert.match(first.text, /Fix the failing build on main\./)
  assert.doesNotMatch(first.text, new RegExp(String(session.id)), 'no host pointer reaches the agent')
  const opened = (await r.client.call('session/read', { runtime: OTHER, sessionId: first.session as never })) as Session
  const message = opened.turns[0]?.items.find(item => item.type === 'userMessage')
  const part = message?.type === 'userMessage' ? message.content[0] : undefined
  assert.ok(part?.type === 'text')
  assert.equal(part.deskContext?.prefixLength, part.text.length, 'the packet is the desk’s, not words the person typed')

  await r.client.until(() => changes(r).some(one => one.state === 'moved'), 5_000, 'the moved incident')
  const moved = changes(r).findLast(one => one.state === 'moved')!
  assert.equal(moved.mode, 'handoff')
  assert.equal(moved.link?.runtime, OTHER)
  assert.equal(String(moved.link?.sessionId), first.session)

  const left = markers((await r.client.call('session/read', { runtime: PRIMARY, sessionId: session.id })) as Session)
  assert.deepEqual(left.find(one => one.phase === 'left')?.link, { runtime: OTHER, sessionId: first.session }, 'the old one points to the new')
  const arrived = markers((await r.client.call('session/read', { runtime: OTHER, sessionId: first.session as never })) as Session)
  assert.deepEqual(arrived.find(one => one.phase === 'arrived')?.link, { runtime: PRIMARY, sessionId: session.id }, 'and the new one points back')
})

test('an answer naming a target that is no longer offered is refused as stale, and nothing moves', async t => {
  const r = await rig(t)
  await prefer(r, 'ask')
  await stuck(r)
  await r.client.until(() => changes(r).some(one => one.state === 'asked'), 10_000, 'the question')
  const asked = changes(r).find(one => one.state === 'asked')!
  assert.equal(asked.choices.target?.runtime, SIBLING, 'the card offers the sibling')

  const refused = await r.client
    .call('carryOn/decide', { incidentId: asked.incidentId, choice: 'switch', target: runtimeId('nobody'), always: false })
    .then(() => null, (error: unknown) => error as Error & { code?: string })
  assert.equal(refused?.code, 'carryOnStale')
  assert.equal(r.sent.filter(one => one.runtime === SIBLING).length, 0)

  // The real answer still lands, once; a second is stale.
  const stopped = (await r.client.call('carryOn/decide', { incidentId: asked.incidentId, choice: 'stop', always: false })) as { incident: CarryOnIncidentView }
  assert.equal(stopped.incident.state, 'stopped')
  const again = await r.client
    .call('carryOn/decide', { incidentId: asked.incidentId, choice: 'stop', always: false })
    .then(() => null, (error: unknown) => error as Error & { code?: string })
  assert.equal(again?.code, 'carryOnStale')
})

test('a malformed answer never reaches the host', async t => {
  const r = await rig(t)
  const bad = await r.client
    .call('carryOn/decide', { incidentId: 'x', choice: 'later', always: false } as never)
    .then(() => null, (error: unknown) => error as Error & { code?: string })
  assert.ok(bad, 'an unknown choice is refused')
  assert.notEqual(bad.code, 'carryOnStale', 'by the validator, before the service sees it')
})

// ------------------------------------------------------------ review round 3

/** A conversation on the primary that has started its first turn; the caller fails it. */
const started = async (r: Rig, text = 'Fix the failing build on main.'): Promise<Session> => {
  const session = (await r.client.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })) as Session
  await r.client.call('turn/send', { runtime: PRIMARY, sessionId: session.id, input: [{ type: 'text', text }] })
  await r.client.until(() => r.sent.some(one => one.session === String(session.id)), 5_000, 'the first turn to start')
  return session
}

const person = (r: Rig, session: Session) =>
  void r.host.call('turn/send', { runtime: PRIMARY, sessionId: session.id, input: [{ type: 'text', text: 'I will take it from here.' }] }).catch(() => {})

test('a person who writes while the host dispatches the handoff packet wins: the packet never reaches the agent', async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const session = await started(r)
  // The moment the packet's dispatch looks the new conversation up — the link saved, carry-on's own last check passed —
  // the person writes, on the next microtask: inside the dispatch, before its effect boundary.
  const linked = () => {
    try {
      const disk = JSON.parse(readFileSync(join(r.stateDir, 'carry-on', 'incidents.json'), 'utf8')) as { records: { link?: unknown }[] }
      return disk.records.some(record => record.link !== undefined)
    } catch { return false }
  }
  const get = r.host.registry.get.bind(r.host.registry)
  let fired = false
  r.host.registry.get = ((runtime, id) => {
    if (!fired && String(runtime) === OTHER && linked()) { fired = true; queueMicrotask(() => person(r, session)) }
    return get(runtime, id)
  }) as typeof r.host.registry.get
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await r.client.until(() => fired && (changes(r).at(-1) === null || changes(r).some(one => one?.state === 'moved')), 10_000, 'carry-on to settle')
  assert.deepEqual(r.sent.filter(one => one.runtime === OTHER), [], 'no packet behind the person’s message')
  assert.equal(changes(r).at(-1), null, 'carry-on stood down')
  const left = markers((await r.client.call('session/read', { runtime: PRIMARY, sessionId: session.id })) as Session)
  assert.deepEqual(left.map(one => one.phase), [], 'and the conversation never says it left')
})

test('a cancel never closes the sibling when another opener attached alongside carry-on’s reopen', async t => {
  const r = await rig(t)
  await prefer(r, 'switch')
  const own = <T extends { runtime: unknown }>(value: T): T => ({ ...value, runtime: SIBLING })
  const read = r.sibling!.readSession.bind(r.sibling!)
  r.sibling!.readSession = async id => own(await read(id))
  const resume = r.sibling!.resumeSession.bind(r.sibling!)
  let session!: Session
  let calls = 0
  r.sibling!.resumeSession = async (id, options) => {
    calls += 1
    const first = calls === 1
    const handle = await resume(id, options) as FakeSession
    const snapshot = handle.snapshot.bind(handle)
    Object.defineProperty(handle, 'runtime', { get: () => SIBLING, configurable: true })
    handle.snapshot = () => own(snapshot())
    if (first) {
      // While carry-on's reopen is in flight: the person writes, and another window opens the same thread there.
      person(r, session)
      // A second opener gets a handle of its own (the fixture would otherwise hand back the same one).
      r.sibling!.sessions.delete(id)
      await r.host.call('session/resume', { runtime: SIBLING, sessionId: id })
    }
    return handle
  }
  session = await started(r)
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await r.client.until(() => calls >= 2 && changes(r).at(-1) === null, 10_000, 'carry-on to stand down')
  assert.ok(r.host.registry.get(SIBLING, session.id)?.live, 'the other opener’s handle stays open')
  assert.deepEqual(r.sent.filter(one => one.runtime === SIBLING), [])
})

// ------------------------------------------------------------ review round 4

test('a cancel never closes the sibling when another opener was handed the very same handle alongside carry-on’s reopen', async t => {
  const r = await rig(t)
  await prefer(r, 'switch')
  const own = <T extends { runtime: unknown }>(value: T): T => ({ ...value, runtime: SIBLING })
  const read = r.sibling!.readSession.bind(r.sibling!)
  r.sibling!.readSession = async id => own(await read(id))
  const resume = r.sibling!.resumeSession.bind(r.sibling!)
  let session!: Session
  let calls = 0
  r.sibling!.resumeSession = async (id, options) => {
    calls += 1
    const first = calls === 1
    const handle = await resume(id, options) as FakeSession
    if (first) {
      const snapshot = handle.snapshot.bind(handle)
      Object.defineProperty(handle, 'runtime', { get: () => SIBLING, configurable: true })
      handle.snapshot = () => own(snapshot())
      // While carry-on's reopen is in flight: the person writes, and another window opens the same thread there —
      // and the adapter hands it the handle it already holds, so the record sees one attachment, not two.
      person(r, session)
      await r.host.call('session/resume', { runtime: SIBLING, sessionId: id })
    }
    return handle
  }
  session = await started(r)
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await r.client.until(() => calls >= 2 && changes(r).at(-1) === null, 10_000, 'carry-on to stand down')
  const shared = r.sibling!.sessions.get(session.id)
  assert.ok(shared, 'the shared handle is still the adapter’s')
  assert.equal(r.host.registry.get(SIBLING, session.id)?.live, shared, 'and still open for the other window')
  assert.deepEqual(r.sent.filter(one => one.runtime === SIBLING), [])
})

test('a cancel never closes a handle that replaced the one carry-on’s create attached', async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const session = await started(r)
  // The fixture's sessions all call themselves 'fake'; the other agent's call themselves by its own id.
  const own = <T extends { runtime: unknown }>(value: T): T => ({ ...value, runtime: OTHER })
  const read = r.other.readSession.bind(r.other)
  r.other.readSession = async id => own(await read(id))
  const emit = r.other.emit.bind(r.other)
  r.other.emit = event => emit(event.type === 'session/started' ? { ...event, session: own(event.session) } : event)
  const resume = r.other.resumeSession.bind(r.other)
  r.other.resumeSession = async (id, options) => {
    const handle = await resume(id, options) as FakeSession
    const snapshot = handle.snapshot.bind(handle)
    Object.defineProperty(handle, 'runtime', { get: () => OTHER, configurable: true })
    handle.snapshot = () => own(snapshot())
    return handle
  }
  // Right after the creation attaches its handle, before the create returns, another window reopens the new
  // conversation on a handle of its own; then the person writes.
  const capabilities = r.other.info.capabilities as { pluginTools: boolean }
  capabilities.pluginTools = true
  let replacement: FakeSession | undefined
  let racing = false
  ;(r.other as unknown as { pluginToolsAvailableAt: (cwd: string) => Promise<boolean> }).pluginToolsAvailableAt = async () => {
    if (racing) return true
    racing = true
    const [id] = [...r.other.sessions.keys()]
    r.other.sessions.delete(id!)
    await r.host.call('session/resume', { runtime: OTHER, sessionId: id! as Session['id'] })
    replacement = r.other.sessions.get(id!)
    person(r, session)
    return true
  }
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await r.client.until(() => !!replacement && changes(r).at(-1) === null, 10_000, 'carry-on to stand down')
  assert.ok(replacement)
  assert.equal(r.host.registry.get(OTHER, replacement.id)?.live, replacement, 'the other window’s handle stays open')
  assert.deepEqual(r.sent.filter(one => one.runtime === OTHER), [], 'and the packet never went')
})

// ------------------------------------------------------------ review round 5

test('a cancel never closes a created conversation another window opened between its announcement and its attachment', async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const session = await started(r)
  // The fixture's sessions all call themselves 'fake'; the other agent's call themselves by its own id.
  const own = <T extends { runtime: unknown }>(value: T): T => ({ ...value, runtime: OTHER })
  const read = r.other.readSession.bind(r.other)
  r.other.readSession = async id => own(await read(id))
  const emit = r.other.emit.bind(r.other)
  r.other.emit = event => emit(event.type === 'session/started' ? { ...event, session: own(event.session) } : event)
  // The runtime announces the new conversation; before the create returns, another window resumes it and is handed
  // the very handle the creation holds; then carry-on attaches it, and the person writes.
  const create = r.other.createSession.bind(r.other)
  let created: FakeSession | undefined
  r.other.createSession = async options => {
    const handle = await create(options) as FakeSession
    const snapshot = handle.snapshot.bind(handle)
    Object.defineProperty(handle, 'runtime', { get: () => OTHER, configurable: true })
    handle.snapshot = () => own(snapshot())
    await r.host.call('session/resume', { runtime: OTHER, sessionId: handle.id })
    created = handle
    person(r, session)
    return handle
  }
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await r.client.until(() => !!created && changes(r).at(-1) === null, 10_000, 'carry-on to stand down')
  assert.ok(created)
  assert.equal(r.other.sessions.get(created.id), created, 'the shared handle is still the adapter’s')
  assert.equal(r.host.registry.get(OTHER, created.id)?.live, created, 'and still open for the other window')
  assert.deepEqual(r.sent.filter(one => one.runtime === OTHER), [], 'and the packet never went')
})
