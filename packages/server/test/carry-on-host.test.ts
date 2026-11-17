import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  HANDOFF_PREFIX,
  runtimeId,
  sessionId,
  turnId,
  itemId,
  splitContextContent,
  wrapContext,
  type CarryOnIncidentView,
  type CarryOnItem,
  type RuntimeInfo,
  type Session,
} from '@harnessdesk/protocol'

import { CarryOnIncidents, type CarryOnRecord } from '../src/carry-on/incidents.js'
import { CarryOnService } from '../src/carry-on/service.js'
import { TranscriptStore } from '../src/transcripts.js'
import { TranscriptDatabase } from '../src/transcript-database.js'
import { CONTINUE_SOURCE, CONTINUE_TEXT } from '../src/carry-on/decide.js'
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
  readonly disposeHost: () => Promise<void>
}

/** One agent with two accounts over one store (unless `sibling` is off), and a second agent. */
const rig = async (t: TestContext, options: { readonly sibling?: boolean } = {}): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  const primary = new FakeRuntime({ id: PRIMARY, accountLabel: 'work', sessionStore: STORE })
  const sibling = options.sibling === false ? null : new FakeRuntime({ id: SIBLING, name: 'Fake Runtime', accountLabel: 'personal', sessionStore: STORE })
  const other = new FakeRuntime({ id: OTHER, name: 'Other Agent', accountLabel: 'Jane Doe' })
  const otherRead = other.readSession.bind(other)
  other.readSession = async id => ({ ...await otherRead(id), runtime: OTHER })
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
  let disposing: Promise<void> | undefined
  const disposeHost = () => disposing ??= host.dispose()
  t.after(async () => {
    await client.close()
    await server.close()
    await disposeHost()
    await rm(stateDir, { recursive: true, force: true })
  })
  const sent: Rig['sent'] = []
  for (const runtime of [primary, sibling, other]) if (runtime) {
    runtime.onSend = (session, text) => { sent.push({ runtime: String(runtime.info.id), session: String(session.id), text }) }
  }
  return { host, client, primary, sibling, other, sent, stateDir, disposeHost }
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
  let shared: Session['turns'] = []
  const resume = r.sibling!.resumeSession.bind(r.sibling!)
  r.sibling!.resumeSession = async (id, options) => {
    order.push('resume on the sibling')
    // The shared history keeps the original turn and has a later unrelated turn.
    r.sibling!.stored.set(String(id), [...shared, { id: turnId('later-existing-turn'), status: 'completed', items: [
      { id: itemId('later-existing-item'), type: 'assistantMessage', text: 'A later unrelated turn.' },
    ] }])
    const handle = await resume(id, options) as FakeSession
    const snapshot = handle.snapshot.bind(handle)
    Object.defineProperty(handle, 'runtime', { get: () => SIBLING })
    handle.snapshot = () => own(snapshot())
    handle.send = async input => {
      const id = turnId('accepted-continuation')
      r.sibling!.emit({ type: 'turn/started', sessionId: handle.id, turn: { id, items: [], status: 'inProgress' } })
      r.sibling!.emit({ type: 'item/started', sessionId: handle.id, turnId: id, item: { id: itemId('continuation-input'), type: 'userMessage', content: input } })
      r.sibling!.onSend?.(handle, input.flatMap(part => part.type === 'text' ? [part.text] : []).join(''))
      return id
    }
    return handle
  }
  const session = await stuck(r)
  const closeA = r.primary.sessions.get(session.id)!
  const close = closeA.close.bind(closeA)
  closeA.close = async () => {
    order.push('close on the primary')
    shared = r.host.registry.get(PRIMARY, session.id)?.session.turns ?? []
    return close()
  }

  // The continue is the host's line, not the person's: it goes out as desk context, enveloped under its own label.
  const CONTINUE = wrapContext(CONTINUE_SOURCE, CONTINUE_TEXT)
  await r.client.until(() => r.sent.some(one => one.runtime === SIBLING && one.text === CONTINUE), 10_000, 'the continue on the sibling')
  assert.ok(!r.sent.some(one => one.text === CONTINUE_TEXT), 'never as a plain line the person seems to have typed')
  assert.deepEqual(order, ['close on the primary', 'resume on the sibling'], 'one live writer per thread')
  assert.equal(r.sibling!.sessions.get(session.id)?.id, session.id, 'the same thread, not a new one')
  r.sibling!.emit({ type: 'turn/completed', sessionId: session.id, turn: { id: turnId('accepted-continuation'), status: 'completed', items: [] } })
  r.sibling!.stored.set(String(session.id), r.host.registry.get(SIBLING, session.id)!.session.turns.map(turn => ({ ...turn, items: turn.items.filter(item => item.type !== 'carryOn') })))

  await r.client.until(() => r.client.events.some(event => event.type === 'item/completed' && event.sessionId === session.id && event.item.type === 'carryOn' && event.item.phase === 'switched'), 10_000, 'the exact-turn switched marker')
  const after = (await r.client.call('session/read', { runtime: SIBLING, sessionId: session.id })) as Session
  const switched = markers(after).find(one => one.phase === 'switched')
  assert.ok(switched, 'the marker is part of the conversation')
  assert.deepEqual(after.turns.filter(turn => turn.items.some(item => item.id === switched.id)).map(turn => turn.id), ['accepted-continuation'], 'the accepted continuation owns the marker despite the unrelated earlier turn')
  assert.equal(switched.mode, 'sameThread')
  assert.equal(switched.to?.account, 'account 2', 'named by its ordinal, never an address')
  assert.equal(switched.link, undefined, 'a same-thread switch has nowhere else to point')
  const asked = after.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage' ? [item] : []))
  const carried = asked.filter(item => splitContextContent(item.content).injections.some(one => one.label === CONTINUE_SOURCE))
  assert.equal(carried.length, 1, `the continue is in the transcript once, as desk context: ${JSON.stringify(asked.map(item => item.content))}`)
  const continued = carried[0]!
  assert.ok(continued.content.every(part => part.type !== 'text' || part.deskContext?.prefixLength === part.text.length), 'all of it the desk’s')
  assert.equal(splitContextContent(continued.content).text, '', 'nothing of it reads as the person’s bubble')

  await r.client.until(() => changes(r).some(one => one?.state === 'moved'), 5_000, 'the moved incident')
  const incident = changes(r).findLast(one => one?.state === 'moved')!
  assert.equal(incident.runtime, SIBLING, 'the incident follows the conversation')
  await r.client.until(() => r.client.notifications.some(message => 'method' in message && message.method === 'carryOn/changed' && message.params.key.runtime === SIBLING && message.params.key.sessionId === session.id && message.params.incident === null), 10_000, 'the switched marker to be durably cleared')
  assert.deepEqual(((await r.client.call('carryOn/list', {})) as { incidents: CarryOnIncidentView[] }).incidents, [], 'and nothing is left to answer')
  r.sibling!.emit({ type: 'turn/started', sessionId: session.id, turn: { id: turnId('unrelated-later-turn'), status: 'inProgress', items: [] } })
  const later = (await r.client.call('session/read', { runtime: SIBLING, sessionId: session.id })) as Session
  assert.ok(later.turns.some(turn => turn.id === 'unrelated-later-turn'))
  assert.deepEqual(later.turns.filter(turn => turn.items.some(item => item.id === switched.id)).map(turn => turn.id), ['accepted-continuation'], 'a later turn does not move the durable marker')
})

test('another agent is handed the conversation in one capped packet, with a link each way', async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const session = await stuck(r, `Fix the failing build on main.\n${'detail '.repeat(20_000)}`)

  await r.client.until(() => r.sent.some(one => one.runtime === OTHER), 10_000, 'the handoff on the other agent')
  const first = r.sent.find(one => one.runtime === OTHER)!
  r.other.sessions.get(sessionId(first.session))!.finish()
  r.other.stored.set(first.session, r.host.registry.get(OTHER, sessionId(first.session))!.session.turns.map(turn => ({ ...turn, items: turn.items.filter(item => item.type !== 'carryOn') })))
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

  await r.client.until(() => r.client.events.some(event => event.type === 'item/completed' && event.sessionId === session.id && event.item.type === 'carryOn' && event.item.phase === 'left'), 10_000, 'the left marker')
  const left = markers((await r.client.call('session/read', { runtime: PRIMARY, sessionId: session.id })) as Session)
  assert.deepEqual(left.find(one => one.phase === 'left')?.link, { runtime: OTHER, sessionId: first.session }, 'the old one points to the new')
  await r.client.until(() => r.client.events.some(event => event.type === 'item/completed' && String(event.sessionId) === first.session && event.item.type === 'carryOn' && event.item.phase === 'arrived'), 10_000, 'the accepted arrival marker')
  await r.client.until(() => r.client.notifications.some(message => 'method' in message && message.method === 'carryOn/changed' && message.params.key.runtime === PRIMARY && message.params.key.sessionId === session.id && message.params.incident === null), 10_000, 'the handoff markers to be durably cleared')
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
  // A runtime without the owned-attempt capability can return distinct handles; retain the legacy ownership control.
  r.sibling!.resumeOwner = undefined as never
  r.sibling!.beginResumeAttempt = undefined as never
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
  let calls = 0, entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
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
      entered()
      await gate
    }
    return handle
  }
  session = await started(r)
  r.primary.sessions.get(session.id)!.fail('You have hit your usage limit.', 'credits')

  await began
  const other = r.host.call('session/resume', { runtime: SIBLING, sessionId: session.id })
  try {
    await r.client.until(() => r.host.registry.opens(SIBLING, session.id).pending === 2, 5_000, 'both callers to hold a lease')
  } finally { release() }
  await other
  await r.client.until(() => changes(r).at(-1) === null, 10_000, 'carry-on to stand down')
  assert.equal(calls, 1, 'both callers joined the same adapter open')
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

test('detached resume waiters fail before the old adapter open settles', async t => {
  const r = await rig(t)
  const session = await started(r)
  const resume = r.primary.resumeSession.bind(r.primary)
  let entered!: () => void, release!: () => void, completed!: () => void
  const began = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { completed = resolve })
  r.primary.resumeSession = async (id, options) => { try { entered(); await held; return await resume(id, options) } finally { completed() } }
  const opening = r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  const outcome = opening.then(() => 'resolved', () => 'refused')
  try {
    await began
    r.host.registry.detachAll(PRIMARY, session.id)
    const settled = await Promise.race([outcome, new Promise<string>(resolve => setImmediate(() => resolve('still waiting')))])
    assert.equal(settled, 'refused', 'detachment rejects the caller without waiting for the adapter')
  } finally { release(); await outcome; await finished }
})

test('a detached pending resume cannot attach later or hold carry-on open', async t => {
  const r = await rig(t)
  const session = await started(r)
  const resume = r.primary.resumeSession.bind(r.primary)
  let entered!: () => void, release!: () => void, completed!: () => void
  const began = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { completed = resolve })
  r.primary.resumeSession = async (id, options) => { try { entered(); await held; return await resume(id, options) } finally { completed() } }
  const opening = r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  try {
    await began
    assert.equal(r.host.registry.opens(PRIMARY, session.id).pending, 1)
    r.host.registry.detachAll(PRIMARY, session.id)
    assert.equal(r.host.registry.opens(PRIMARY, session.id).pending, 0)
  } finally {
    release()
    await opening.catch(() => {}); await finished
  }
  assert.equal(r.host.registry.get(PRIMARY, session.id)?.live, null, 'late resume must not reattach')
})

for (const scopedFirst of [false, true]) test(`${scopedFirst ? 'scoped settings and ordinary resume' : 'ordinary resume and scoped settings'} share one open and publish once`, async t => {
  const r = await rig(t)
  const session = await r.client.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  r.host.registry.detachAll(PRIMARY, session.id)
  const record = r.host.registry.get(PRIMARY, session.id)!, before = record.liveAttaches
  const resume = r.primary.resumeSession.bind(r.primary), originalCount = r.primary.resumes
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  r.primary.resumeSession = async (id, options) => { entered(); await gate; return resume(id, options) }
  const requestOrdinary = () => r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  const requestScoped = () => r.host.call('session/settings', { runtime: PRIMARY, sessionId: session.id, patch: {} })
  let ordinary: ReturnType<typeof requestOrdinary>, scoped: ReturnType<typeof requestScoped>
  if (scopedFirst) { scoped = requestScoped(); await began; ordinary = requestOrdinary() }
  else { ordinary = requestOrdinary(); await began; scoped = requestScoped() }
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.host.registry.opens(PRIMARY, session.id).pending, 2)
  } finally { release() }
  const [resumed] = await Promise.all([ordinary, scoped])
  assert.equal(resumed.id, session.id)
  assert.equal(r.primary.resumes, originalCount + 1)
  assert.equal(record.liveAttaches, before + 1)
  assert.equal(r.host.registry.opens(PRIMARY, session.id).pending, 0)
})

test('detach during pre-open worktree preparation rejects and never starts the adapter', async t => {
  const { SessionWorktrees } = await import('../src/session-worktrees.js')
  const r = await rig(t)
  const session = await r.client.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  const original = SessionWorktrees.prototype.prepare
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(SessionWorktrees.prototype, 'prepare', async function (this: InstanceType<typeof SessionWorktrees>, ...args: Parameters<typeof original>) {
    entered(); await gate; return original.apply(this, args)
  })
  const before = r.primary.resumes
  const opening = r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  const rejected = assert.rejects(opening, /earlier open/)
  try {
    await began
    assert.equal(r.host.registry.opens(PRIMARY, session.id).pending, 1)
    r.host.registry.detachAll(PRIMARY, session.id)
    await rejected
  } finally { release() }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.primary.resumes, before)
})

test('detached option restoration retains picks and does not write later picks', async t => {
  const r = await rig(t)
  const session = await r.client.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  r.host.registry.detachAll(PRIMARY, session.id)
  const record = r.host.registry.get(PRIMARY, session.id)!
  record.restedOptions = { model: 'fake-2', tone: 'cheerful' }
  let entered!: () => void, release!: () => void, finished!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  const resume = r.primary.resumeSession.bind(r.primary), writes: string[] = []
  r.primary.resumeSession = async (id, options) => {
    const live = await resume(id, options), set = live.setOption.bind(live)
    live.setOption = async (key, value) => { writes.push(key); if (writes.length === 1) { entered(); await gate } try { return await set(key, value) } finally { finished() } }
    return live
  }
  const opening = r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  const rejected = assert.rejects(opening, /earlier open/)
  try { await began; r.host.registry.detachAll(PRIMARY, session.id); await rejected }
  finally { release(); await done }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, ['model'])
  assert.deepEqual(record.restedOptions, { model: 'fake-2', tone: 'cheerful' })
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

test('a kept marker survives a failed ledger clear and host restart without duplication', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-retry-'))
  const file = join(stateDir, 'carry-on', 'incidents.json')
  const incidents = new CarryOnIncidents({ file })
  const id = sessionId('fake-session-1')
  await incidents.serial(() => incidents.put({
    incidentId: 'retry-incident', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'old-turn', agent: 'fake', from: { name: 'Fake Runtime' }, resetsAt: null, nextAt: null,
    openedAt: 1, lastAt: 1, tried: [], hops: 0, alwaysScope: 'desk',
    unwritten: [
      { runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake Runtime' }, resetsAt: null } },
      { runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake Runtime' }, resetsAt: null } },
    ],
  }))
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime)
  let disposed = false
  let restarted: Host | undefined
  let store: TranscriptStore | undefined
  t.after(async () => {
    if (store) await store.close()
    if (restarted) await restarted.dispose()
    if (!disposed) await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  let resolveFailure!: () => void
  const failed = new Promise<void>(resolve => { resolveFailure = resolve })
  let inserted: CarryOnItem[] = []
  const put = CarryOnIncidents.prototype.put
  const mock = t.mock.method(CarryOnIncidents.prototype, 'put', async function (this: CarryOnIncidents, record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }, authority?: Parameters<CarryOnIncidents['put']>[2]) {
    if (record.incidentId === 'retry-incident' && !record.unwritten && inserted.length === 0) {
      inserted = markers(host.registry.get(PRIMARY, id)!.session)
      assert.equal(inserted.length, 2, 'real host inserted both markers before the failed clear')
      resolveFailure()
      throw new Error('injected ledger clear failure')
    }
    return put.call(this, record, replaces, authority)
  })
  const created = await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  assert.equal(created.id, id)
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'Hello' }] })
  runtime.sessions.get(id)!.finish()
  await failed
  assert.equal(new Set(inserted.map(item => item.id)).size, 2)
  const original = host.registry.get(PRIMARY, id)!.session
  const replayTurns = original.turns.map(turn => ({ ...turn, items: turn.items.filter(item => item.type !== 'carryOn') }))
  runtime.stored.set(String(id), replayTurns)
  await host.dispose(); disposed = true
  mock.mock.restore()
  store = new TranscriptStore(join(stateDir, 'transcripts'))
  const persisted = await store.recover(PRIMARY, id)
  assert.deepEqual(markers(persisted!).map(item => item.id), inserted.map(item => item.id), 'host disposal flushed both markers to disk')
  await store.close(); store = undefined
  restarted = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  restarted.register(runtime)
  await restarted.start()
  const resumed = await restarted.call('session/resume', { runtime: PRIMARY, sessionId: id }) as Session
  assert.deepEqual(markers(resumed).map(item => item.id), inserted.map(item => item.id), 'resume restores the Host transcript before retry')
  // A completed turn makes the pending ledger entries reachable again.
  await restarted.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'Continue' }] })
  runtime.sessions.get(id)!.finish()
  await untilLedgerCleared(file)
  const after = await restarted.call('session/read', { runtime: PRIMARY, sessionId: id }) as Session
  assert.deepEqual(markers(after).map(item => item.id), inserted.map(item => item.id), 'retry preserves each marker exactly once')
})

const untilLedgerCleared = async (file: string) => {
  const deadline = Date.now() + 10_000
  while (JSON.parse(readFileSync(file, 'utf8')).records[0]?.unwritten) {
    assert.ok(Date.now() < deadline, 'the ledger was not cleared')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('detach during durable transcript recovery does not readmit a stale record', async t => {
  const r = await rig(t)
  const session = await started(r)
  const store = new TranscriptStore(join(r.stateDir, 'transcripts'))
  let durable: Session | null = null
  for (let i = 0; i < 100 && !durable; i++) { durable = await store.recover(PRIMARY, session.id); if (!durable) await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.ok(durable)
  r.host.registry.delete(PRIMARY, session.id)
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const recover = TranscriptStore.prototype.recover
  t.mock.method(TranscriptStore.prototype, 'recover', async function (this: TranscriptStore, runtime: Parameters<TranscriptStore['recover']>[0], id: Parameters<TranscriptStore['recover']>[1]) {
    const kept = await recover.call(this, runtime, id)
    if (runtime === PRIMARY && id === session.id) { entered(); await gate }
    return kept
  })
  const opening = r.host.call('session/resume', { runtime: PRIMARY, sessionId: session.id })
  const refused = assert.rejects(opening)
  try {
    await began
    r.host.registry.detachAll(PRIMARY, session.id)
    await refused
    release()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.host.registry.get(PRIMARY, session.id), undefined, 'a retired recovery cannot re-admit the record')
  } finally { release(); await refused }
})

test('a failed asynchronous Flow re-arm is observed instead of escaping as an unhandled rejection', async t => {
  const { FlowExecutions } = await import('../src/flow-execution.js')
  const r = await rig(t), session = await started(r)
  let entered!: () => void
  const began = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(FlowExecutions.prototype, 'reArm', async () => { entered(); throw new Error('synthetic re-arm failure') })
  await r.host.call('turn/send', { runtime: PRIMARY, sessionId: session.id, input: [{ type: 'text', text: 'Trigger completion' }] })
  r.primary.sessions.get(session.id)!.finish('done')
  await began
  await new Promise(resolve => setImmediate(resolve))
})


test('a real Host retains an anchored old-turn marker through a newer running turn and writes it after idle', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-anchored-host-'))
  const file = join(stateDir, 'carry-on', 'incidents.json')
  const id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({
    incidentId: 'anchored-incident', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake Runtime' }, resetsAt: null, nextAt: null,
    openedAt: 1, lastAt: 1, tried: [], hops: 0, alwaysScope: 'desk',
    unwritten: [{ id: 'anchored-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake Runtime' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  // Gate the actual reachability callback until both real fake-runtime turns exist.
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime)
  await host.start()
  let disposed = false
  t.after(async () => { if (!disposed) await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  const created = await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  assert.equal(created.id, id)
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'second' }] })
  assert.ok(owner)
  await reachable.call(owner, String(PRIMARY), String(id))
  let pending = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }
  assert.equal(pending.records[0]?.unwritten?.[0]?.id, 'anchored-marker', 'the intent remains protected while the provider is active')
  assert.ok(!host.registry.get(PRIMARY, id)!.session.turns.flatMap(turn => turn.items).some(item => item.id === 'anchored-marker'))
  runtime.emit({ type: 'item/delta', sessionId: id, turnId: turnId('fake-turn-2'), itemId: itemId('a-2'), delta: { kind: 'assistantText', text: ' streamed progress' } })
  runtime.sessions.get(id)!.finish('streamed progress')
  await reachable.call(owner, String(PRIMARY), String(id))
  pending = JSON.parse(readFileSync(file, 'utf8')) as typeof pending
  assert.equal(pending.records[0]?.unwritten, undefined, 'only the idle durable acknowledgment clears the intent')
  const turns = host.registry.get(PRIMARY, id)!.session.turns
  const old = turns.find(turn => turn.id === 'fake-turn-1')!, newer = turns.find(turn => turn.id === 'fake-turn-2')!
  assert.ok(old.items.some(item => item.id === 'anchored-marker'), 'the marker belongs to the failed turn')
  assert.ok(!newer.items.some(item => item.id === 'anchored-marker'), 'the newer running turn must not receive it')
  await host.dispose(); disposed = true
  const transcripts = new TranscriptStore(join(stateDir, 'transcripts'))
  try {
    const replay = await transcripts.recover(PRIMARY, id)
    assert.ok(replay?.turns.find(turn => turn.id === 'fake-turn-1')?.items.some(item => item.id === 'anchored-marker'), 'durable replay keeps the marker on t1')
    assert.ok(!replay?.turns.find(turn => turn.id === 'fake-turn-2')?.items.some(item => item.id === 'anchored-marker'), 'durable replay does not move it to t2')
  } finally { await transcripts.close() }
})


test('a marker ID on another turn is a conflict, never a successful anchored insert', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-conflicting-marker-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({
    incidentId: 'conflict', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null,
    openedAt: 1, lastAt: 1, tried: [], hops: 0, alwaysScope: 'desk',
    unwritten: [{ id: 'same-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'second' }] })
  runtime.emit({ type: 'item/completed', sessionId: id, turnId: turnId('fake-turn-2'), item: { id: itemId('same-marker'), type: 'carryOn', phase: 'stopped', cause: 'credits', from: { name: 'Fake' } } })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  await reachable.call(owner, String(PRIMARY), String(id))
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }
  assert.equal(persisted.records[0]?.unwritten?.[0]?.id, 'same-marker', 'the conflicting marker remains pending')
  const turns = host.registry.get(PRIMARY, id)!.session.turns
  assert.ok(!turns.find(turn => turn.id === 'fake-turn-1')!.items.some(item => item.id === 'same-marker'))
})

test('a marker ID with different content on the target turn remains a conflict', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-conflicting-marker-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({
    incidentId: 'conflict', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null,
    openedAt: 1, lastAt: 1, tried: [], hops: 0, alwaysScope: 'desk',
    unwritten: [{ id: 'same-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'second' }] })
  runtime.emit({ type: 'item/completed', sessionId: id, turnId: turnId('fake-turn-1'), item: { id: itemId('same-marker'), type: 'carryOn', phase: 'stopped', cause: 'credits', from: { name: 'Wrong payload' } } })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  await reachable.call(owner, String(PRIMARY), String(id))
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }
  assert.equal(persisted.records[0]?.unwritten?.[0]?.id, 'same-marker', 'the conflicting marker remains pending')
  const turns = host.registry.get(PRIMARY, id)!.session.turns
  assert.equal(turns.find(turn => turn.id === 'fake-turn-1')!.items.filter(item => item.id === 'same-marker').length, 1)
})

test('a pending marker is retained until its exact-turn transcript write is durably acknowledged', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-durable-marker-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({
    incidentId: 'durable', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped', cause: 'credits',
    turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'durable-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped', anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), began = new Promise<'flush'>(resolve => { entered = () => resolve('flush') })
  t.after(async () => { release(); await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  const flush = TranscriptStore.prototype.flushSession
  t.mock.method(TranscriptStore.prototype, 'flushSession', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['flushSession']>) {
    entered(); await gate; return flush.apply(this, args)
  })
  const writing = reachable.call(owner, String(PRIMARY), String(id))
  assert.equal(await Promise.race([began, writing.then(() => 'completed' as const)]), 'flush', 'marker publication must reach a durable-write barrier before ledger clearance')
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }
  assert.equal(persisted.records[0]?.unwritten?.[0]?.id, 'durable-marker', 'pending survives while the write is held')
  release(); await writing
  const saved = new TranscriptStore(join(stateDir, 'transcripts'))
  try {
    const transcript = await saved.recover(PRIMARY, id)
    assert.ok(transcript?.turns.find(turn => turn.id === 'fake-turn-1')?.items.some(item => item.id === 'durable-marker'))
  } finally { await saved.close() }
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: unknown[] }[] }
  assert.equal(after.records[0]?.unwritten, undefined, 'only a confirmed durable copy clears the ledger')
})

test('Host shutdown waits for an in-flight marker write without clearing its pending receipt', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-shutdown-marker-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'shutdown', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'shutdown-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { entered = resolve })
  let disposal: Promise<void> | undefined
  t.after(async () => { release(); if (disposal) await disposal; else await host.dispose(); await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  const flush = TranscriptStore.prototype.flushSession
  t.mock.method(TranscriptStore.prototype, 'flushSession', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['flushSession']>) {
    entered(); await gate; return flush.apply(this, args)
  })
  const writing = reachable.call(owner, String(PRIMARY), String(id)).catch(() => {})
  await began
  disposal = host.dispose()
  const outcome = await Promise.race([disposal.then(() => 'disposed' as const), new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 1_000))])
  assert.equal(outcome, 'held', 'shutdown waits while the actual marker write is gated')
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }).records[0]?.unwritten?.[0]?.id, 'shutdown-marker')
  release()
  await writing
  await disposal
})

test('Host shutdown does not wait for a hung carry-on provider send or let it mutate the ledger later', { timeout: 15_000 }, async t => {
  const r = await rig(t)
  await prefer(r, 'switch')
  let entered!: () => void, release!: () => void, finished!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  t.after(() => release())
  const read = r.sibling!.readSession.bind(r.sibling!)
  r.sibling!.readSession = async id => ({ ...await read(id), runtime: SIBLING })
  const resume = r.sibling!.resumeSession.bind(r.sibling!)
  r.sibling!.resumeSession = async (id, options) => {
    const live = await resume(id, options) as FakeSession
    const snapshot = live.snapshot.bind(live)
    Object.defineProperty(live, 'runtime', { get: () => SIBLING, configurable: true })
    live.snapshot = () => ({ ...snapshot(), runtime: SIBLING })
    const send = live.send.bind(live)
    live.send = async (...args) => { entered(); await gate; try { return await send(...args) } finally { finished() } }
    return live
  }
  const session = await stuck(r)
  await Promise.race([began, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the synthetic provider was not entered')), 5_000))])
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  const before = readFileSync(file)
  const disposing = r.disposeHost()
  try {
    const outcome = await Promise.race([disposing.then(() => 'disposed' as const), new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 5_000))])
    assert.equal(outcome, 'disposed', 'a provider RPC does not hold Host shutdown open')
  } finally { release() }
  await done
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(readFileSync(file), before, 'the late provider result cannot rewrite carry-on state after shutdown')
  assert.ok(session.id)
})

test('a person send waits for an in-flight idle marker acknowledgment before the provider sees it', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-marker-send-fence-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'send-fence', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'send-fence-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  let release!: () => void, entered!: () => void, released = false, sentBeforeRelease = false
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } }), began = new Promise<void>(resolve => { entered = resolve })
  t.after(async () => { release(); await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  const other = await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  assert.ok(owner)
  const flush = TranscriptStore.prototype.flushSession
  t.mock.method(TranscriptStore.prototype, 'flushSession', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['flushSession']>) {
    entered(); await gate; return flush.apply(this, args)
  })
  const writing = reachable.call(owner, String(PRIMARY), String(id))
  await began
  await host.call('turn/send', { runtime: PRIMARY, sessionId: other.id, input: [{ type: 'text', text: 'other conversation' }] })
  runtime.sessions.get(other.id)!.finish()
  runtime.onSend = () => { if (!released) sentBeforeRelease = true }
  const send = host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'new person message' }] })
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  await writing
  await send
  assert.equal(sentBeforeRelease, false, 'provider dispatch does not overtake the durable marker operation')
  runtime.sessions.get(id)!.finish('done')
  await reachable.call(owner, String(PRIMARY), String(id))
  const body = host.registry.get(PRIMARY, id)!.session
  assert.ok(!body.historyPending)
  assert.ok(body.turns.find(turn => turn.id === 'fake-turn-1')?.items.some(item => item.id === 'send-fence-marker'))
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: unknown[] }[] }
  assert.equal(after.records[0]?.unwritten, undefined)
})

test('shutdown prevents a person send waiting on an idle marker acknowledgment', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-marker-send-fence-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'send-fence', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'send-fence-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  let release!: () => void, entered!: () => void, released = false, sentBeforeRelease = false
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } }), began = new Promise<void>(resolve => { entered = resolve })
  let disposal: Promise<void> | undefined
  t.after(async () => { release(); await (disposal ?? host.dispose()); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  const flush = TranscriptStore.prototype.flushSession
  t.mock.method(TranscriptStore.prototype, 'flushSession', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['flushSession']>) {
    entered(); await gate; return flush.apply(this, args)
  })
  const writing = reachable.call(owner, String(PRIMARY), String(id))
  await began
  runtime.onSend = () => { sentBeforeRelease = true }
  const send = host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'new person message' }] })
  await new Promise<void>(resolve => setImmediate(resolve))
  disposal = host.dispose()
  release()
  await writing
  await assert.rejects(send, /conversation changed|closing/i)
  await disposal
  assert.equal(sentBeforeRelease, false, 'shutdown must prevent late provider dispatch')
})

test('a paused queued delivery waits for an in-flight idle marker acknowledgment', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-marker-send-fence-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'send-fence', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'send-fence-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  let release!: () => void, entered!: () => void, released = false, sentBeforeRelease = false
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } }), began = new Promise<void>(resolve => { entered = resolve })
  t.after(async () => { release(); await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  await host.call('turn/queue', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'queued message' }] })
  await runtime.sessions.get(id)!.interrupt()
  assert.ok(owner)
  const flush = TranscriptStore.prototype.flushSession
  t.mock.method(TranscriptStore.prototype, 'flushSession', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['flushSession']>) {
    entered(); await gate; return flush.apply(this, args)
  })
  const writing = reachable.call(owner, String(PRIMARY), String(id))
  await began
  let sent!: () => void
  const delivered = new Promise<void>(resolve => { sent = resolve })
  runtime.onSend = () => { if (!released) sentBeforeRelease = true; sent() }
  const send = host.call('turn/queue/flush', { runtime: PRIMARY, sessionId: id })
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  await writing
  await send
  await delivered
  assert.equal(sentBeforeRelease, false, 'provider dispatch does not overtake the durable marker operation')
  runtime.sessions.get(id)!.finish('done')
  await reachable.call(owner, String(PRIMARY), String(id))
  const body = host.registry.get(PRIMARY, id)!.session
  assert.ok(!body.historyPending)
  assert.ok(body.turns.find(turn => turn.id === 'fake-turn-1')?.items.some(item => item.id === 'send-fence-marker'))
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: unknown[] }[] }
  assert.equal(after.records[0]?.unwritten, undefined)
})


test('a reentrant title update before marker commit proof retains the protected intent', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-idle-title-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'idle-title', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'idle-title-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  let injected = false
  const write = TranscriptDatabase.prototype.write
  t.mock.method(TranscriptDatabase.prototype, 'write', function (this: TranscriptDatabase, ...args: Parameters<TranscriptDatabase['write']>) {
    write.apply(this, args)
    const [body] = args
    if (!injected && body.turns.some(turn => turn.items.some(item => item.id === 'idle-title-marker'))) {
      injected = true
      runtime.emit({ type: 'session/title', sessionId: id, title: 'Provider title update' })
    }
  })
  await reachable.call(owner, String(PRIMARY), String(id))
  assert.ok(injected, 'the update crosses the actual SQLite marker-write boundary')
  await reachable.call(owner, String(PRIMARY), String(id))
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: unknown[] }[] }
  assert.equal(after.records[0]?.unwritten?.length, 1, 'a change before the proof never clears the pending intent')
})

test('an asynchronous idle title update after marker commit leaves history writable', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-idle-title-'))
  const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
  const ledger = new CarryOnIncidents({ file })
  await ledger.serial(() => ledger.put({ incidentId: 'idle-title', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
    cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
    tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'idle-title-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
      anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
  } as unknown as CarryOnRecord))
  const reachable = CarryOnService.prototype.reachable
  let owner: CarryOnService | undefined
  t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
  const runtime = new FakeRuntime({ id: PRIMARY })
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
  host.register(runtime); await host.start()
  t.after(async () => { await host.dispose().catch(() => {}); await rm(stateDir, { recursive: true, force: true }) })
  await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
  runtime.sessions.get(id)!.finish()
  assert.ok(owner)
  let injected = false
  const write = TranscriptDatabase.prototype.write
  t.mock.method(TranscriptDatabase.prototype, 'write', function (this: TranscriptDatabase, ...args: Parameters<TranscriptDatabase['write']>) {
    write.apply(this, args)
    const [body] = args
    if (!injected && body.turns.some(turn => turn.items.some(item => item.id === 'idle-title-marker'))) {
      injected = true
      queueMicrotask(() => runtime.emit({ type: 'session/title', sessionId: id, title: 'Provider title update' }))
    }
  })
  await reachable.call(owner, String(PRIMARY), String(id))
  assert.ok(injected, 'the update crosses the actual SQLite marker-write boundary')
  await reachable.call(owner, String(PRIMARY), String(id))
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: unknown[] }[] }
  assert.equal(after.records[0]?.unwritten, undefined, 'the marker is eventually durably acknowledged')
  const read = await host.call('session/read', { runtime: PRIMARY, sessionId: id }) as Session
  assert.ok(!read.historyPending, 'a routine title update does not strand the conversation in protection')
  assert.ok(read.turns.find(turn => turn.id === 'fake-turn-1')?.items.some(item => item.id === 'idle-title-marker'))
})

for (const failure of ['read failure', 'wrong durable content'] as const) {
  test(`a ${failure} cannot acknowledge a marker`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hd-carry-ack-failure-'))
    const file = join(stateDir, 'carry-on', 'incidents.json'), id = sessionId('fake-session-1')
    const ledger = new CarryOnIncidents({ file })
    await ledger.serial(() => ledger.put({ incidentId: 'failed-ack', runtime: String(PRIMARY), sessionId: String(id), owner: 'chat', state: 'stopped',
      cause: 'credits', turnId: 'fake-turn-1', agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1,
      tried: [], hops: 0, alwaysScope: 'desk', unwritten: [{ id: 'failed-ack-marker', runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped',
        anchor: { kind: 'turn', turnId: 'fake-turn-1' }, snapshot: { cause: 'credits', from: { name: 'Fake' }, resetsAt: null } }],
    } as unknown as CarryOnRecord))
    const reachable = CarryOnService.prototype.reachable
    let owner: CarryOnService | undefined
    t.mock.method(CarryOnService.prototype, 'reachable', function (this: CarryOnService) { owner = this; return Promise.resolve() })
    const runtime = new FakeRuntime({ id: PRIMARY })
    const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9' } as never)
    host.register(runtime); await host.start()
    t.after(async () => { await host.dispose().catch(() => {}); await rm(stateDir, { recursive: true, force: true }) })
    await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } })
    await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'first' }] })
    runtime.sessions.get(id)!.finish()
    assert.ok(owner)
    const recover = TranscriptStore.prototype.recover
    t.mock.method(TranscriptStore.prototype, 'recover', async function (this: TranscriptStore, ...args: Parameters<TranscriptStore['recover']>) {
      if (failure === 'read failure') throw new Error('injected durable read failure')
      const read = await recover.apply(this, args)
      return read && { ...read, turns: read.turns.map(turn => ({ ...turn, items: turn.items.map(item => item.id === 'failed-ack-marker' && item.type === 'carryOn' ? { ...item, from: { name: 'different durable payload' } } : item) })) }
    })
    await reachable.call(owner, String(PRIMARY), String(id))
    const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { id: string }[] }[] }
    assert.equal(after.records[0]?.unwritten?.[0]?.id, 'failed-ack-marker')
  })
}

for (const remove of ['cancel', 'clear'] as const) test(`removing a queued carry-on packet with ${remove} releases its unsent marker intents`, { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  const get = r.host.registry.get.bind(r.host.registry)
  let began = false
  r.host.registry.get = ((runtime, id) => {
    const record = get(runtime, id)
    if (!began && runtime === OTHER && record?.live) {
      try {
        const ledger = JSON.parse(readFileSync(join(r.stateDir, 'carry-on', 'incidents.json'), 'utf8')) as { records: { link?: unknown }[] }
        if (ledger.records.some(one => one.link)) {
          began = true
          void r.other.sessions.get(id)!.send([{ type: 'text', text: 'replacement brief' }])
        }
      } catch { /* The ledger does not exist until the incident is staged. */ }
    }
    return record
  }) as typeof r.host.registry.get
  const source = await stuck(r)
  let target: ReturnType<typeof r.host.registry.get>
  await r.client.until(() => {
    target = r.host.registry.get(OTHER, sessionId('fake-session-1'))
    return !!target?.queue.messages.length && changes(r).some(one => one.state === 'moved')
  }, 10_000, 'queued handoff and settled move')
  assert.ok(target)
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  const before = JSON.parse(readFileSync(file, 'utf8')) as { records: { unwritten?: { prospective?: boolean }[] }[] }
  assert.equal(before.records[0]?.unwritten?.filter(one => one.prospective).length, 2)
  const id = target.queue.messages[0]!.id
  if (remove === 'cancel') await r.client.call('turn/queue/cancel', { runtime: OTHER, sessionId: target.session.id, id })
  else await r.client.call('turn/queue/clear', { runtime: OTHER, sessionId: target.session.id })
  await r.client.until(() => {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { records: { state: string; unwritten?: unknown[]; note?: string }[] }
    return record.records[0]?.state === 'asked' && !record.records[0]?.unwritten?.length && !!record.records[0]?.note?.includes('removed')
  }, 5_000, 'durable cancellation of the exact unsent marker intents')
  assert.ok(!r.sent.some(one => one.runtime === OTHER && one.text.includes(HANDOFF_PREFIX)), 'the cancelled packet never reached the target')
  const record = JSON.parse(readFileSync(file, 'utf8')) as { records: { link?: { runtime: string; sessionId: string } }[] }
  assert.deepEqual(record.records[0]?.link, { runtime: OTHER, sessionId: target.session.id }, 'the already opened conversation remains recorded')
  assert.ok(source.id)
})

for (const outcome of ['completed', 'limit'] as const) test(`a real Host reconciles a continuation ${outcome} event that arrives before its send receipt`, { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false })
  await prefer(r, 'switch')
  let release!: () => void, completed!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const targetCompleted = new Promise<void>(resolve => { completed = resolve })
  t.after(() => release())
  const create = r.other.createSession.bind(r.other)
  r.other.createSession = async options => {
    const live = await create(options) as FakeSession
    await live.send([{ type: 'text', text: 'earlier target turn' }])
    live.finish()
    const send = live.send.bind(live)
    live.send = async (...args) => {
      const turn = await send(...args)
      if (outcome === 'limit') live.fail('You have hit your usage limit.', 'credits')
      else live.finish('continued')
      completed()
      await held
      return turn
    }
    return live
  }
  const source = await stuck(r)
  await targetCompleted
  await r.client.until(() => r.client.events.some(event => event.type === 'turn/completed' && event.sessionId === 'fake-session-1' && event.turn.id === 'fake-turn-2' && event.turn.status === (outcome === 'limit' ? 'failed' : 'completed')),
    10_000, 'target continuation completed before send returned')
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  const before = JSON.parse(readFileSync(file, 'utf8')) as { records: { incidentId: string; state: string; reservation?: unknown }[] }
  assert.equal(before.records[0]?.state, 'sending')
  assert.ok(before.records[0]?.reservation)
  release()
  await r.client.until(() => {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { records: { state: string; watch?: unknown; turnId: string; reservation?: unknown }[] }
    const record = data.records[0]
    return outcome === 'limit' ? record?.state === 'stopped' && record.turnId === 'fake-turn-2' : record?.state === 'moved' && !record.watch && !record.reservation
  }, 10_000, 'exact completion reconciled after receipt')
  const after = JSON.parse(readFileSync(file, 'utf8')) as { records: { incidentId: string }[] }
  assert.equal(after.records[0]?.incidentId, before.records[0]?.incidentId, 'the same incident continues')
  assert.ok(source.id)
})

test('successful queue draining cannot cancel a carry-on receipt after dispatch starts', { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false }); await prefer(r, 'switch')
  const get = r.host.registry.get.bind(r.host.registry)
  let began = false
  r.host.registry.get = ((runtime, id) => {
    const record = get(runtime, id)
    if (!began && runtime === OTHER && record?.live) {
      try {
        const ledger = JSON.parse(readFileSync(join(r.stateDir, 'carry-on', 'incidents.json'), 'utf8')) as { records: { link?: unknown }[] }
        if (ledger.records.some(one => one.link)) { began = true; void r.other.sessions.get(id)!.send([{ type: 'text', text: 'replacement brief' }]) }
      } catch { /* Before the incident is staged. */ }
    }
    return record
  }) as typeof r.host.registry.get
  await stuck(r)
  let target: ReturnType<typeof r.host.registry.get>
  await r.client.until(() => { target = r.host.registry.get(OTHER, sessionId('fake-session-1')); return !!target?.queue.messages.length && changes(r).some(one => one.state === 'moved') }, 10_000, 'queued packet')
  assert.ok(target)
  r.other.sessions.get(target.session.id)!.finish('brief complete')
  await r.client.until(() => r.sent.some(one => one.runtime === OTHER && one.text.includes(HANDOFF_PREFIX)), 10_000, 'packet dispatch')
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  await r.client.until(() => {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { records: { watch?: { turnId?: string } }[] }
    return !!saved.records[0]?.watch?.turnId
  }, 10_000, 'accepted receipt bound')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { records: { state: string; note?: string; watch?: { turnId: string }; unwritten?: { phase: string; anchor?: { turnId?: string } }[] }[] }
  assert.equal(saved.records[0]?.state, 'moved')
  assert.doesNotMatch(saved.records[0]?.note ?? '', /removed before sending/)
  assert.equal(saved.records[0]?.unwritten?.find(one => one.phase === 'arrived')?.anchor?.turnId, saved.records[0]?.watch?.turnId)
})

test('a protected Host transcript makes an early accepted continuation uncertain instead of guessing its outcome', { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false }); await prefer(r, 'switch')
  let release!: () => void, completed!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), targetCompleted = new Promise<void>(resolve => { completed = resolve })
  t.after(() => release())
  const create = r.other.createSession.bind(r.other)
  r.other.createSession = async options => {
    const live = await create(options) as FakeSession, send = live.send.bind(live)
    live.send = async (...args) => { const turn = await send(...args); live.finish('done'); completed(); await held; return turn }
    return live
  }
  await stuck(r); await targetCompleted
  const record = r.host.registry.get(OTHER, sessionId('fake-session-1'))!
  assert.ok(record.live)
  const hasProtected = TranscriptStore.prototype.hasProtectedChanges
  const protectedMock = t.mock.method(TranscriptStore.prototype, 'hasProtectedChanges', function (this: TranscriptStore, runtime: Parameters<TranscriptStore['hasProtectedChanges']>[0], id: Parameters<TranscriptStore['hasProtectedChanges']>[1]) {
    return runtime === OTHER && id === record.session.id ? true : hasProtected.call(this, runtime, id)
  })
  release()
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  try {
    await r.client.until(() => {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { records: { state: string; uncertain?: boolean; unwritten?: unknown[] }[] }
      return saved.records[0]?.state === 'asked' && saved.records[0]?.uncertain === true && !!saved.records[0]?.unwritten?.length
    }, 10_000, 'unavailable completion stays uncertain')
    assert.equal(r.sent.filter(one => one.runtime === OTHER && one.text.includes(HANDOFF_PREFIX)).length, 1)
  } finally { protectedMock.mock.restore() }
})

test('a person rollback during the next model lookup prevents recovery effects', { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false }); await prefer(r, 'switch')
  await stuck(r)
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  await r.client.until(() => {
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as { records: { watch?: { turnId?: string } }[] }
      return !!record.records[0]?.watch?.turnId
    } catch { return false }
  }, 10_000, 'first continuation receipt')
  const nextId = runtimeId('third'), next = new FakeRuntime({ id: nextId, name: 'Third Agent' })
  let entered!: () => void, release!: (value: Awaited<ReturnType<FakeRuntime['listModels']>>) => void
  const began = new Promise<void>(resolve => { entered = resolve }), held = new Promise<Awaited<ReturnType<FakeRuntime['listModels']>>>(resolve => { release = resolve })
  t.after(() => release([]))
  next.listModels = () => { entered(); return held }
  r.host.register(next)
  const targetId = sessionId('fake-session-1'), live = r.other.sessions.get(targetId)!
  ;(live as FakeSession & { rollback: (turns: number) => Promise<void> }).rollback = async () => {}
  live.fail('You have hit your usage limit.', 'credits')
  await began
  const before = JSON.parse(readFileSync(file, 'utf8')) as { records: { reservation?: unknown }[] }
  assert.ok(before.records[0]?.reservation, 'the next action reserved capacity before model lookup')
  await r.host.call('session/rollback', { runtime: OTHER, sessionId: targetId, turns: 1 })
  release([])
  await r.client.until(() => {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { records: { state: string; reservation?: unknown }[] }
    return saved.records[0]?.state === 'cleared' && !saved.records[0]?.reservation
  }, 10_000, 'rollback fenced the pending action')
  assert.equal(next.sessions.size, 0, 'no replacement conversation was created after rollback')
})

for (const replacement of ['different handle', 'same handle, newer open'] as const) test(`an accepted carry-on send on a ${replacement} becomes unconfirmed on the old operation`, { timeout: 15_000 }, async t => {
  const r = await rig(t, { sibling: false }); await prefer(r, 'switch')
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), sent = new Promise<void>(resolve => { reached = resolve })
  t.after(() => release())
  const create = r.other.createSession.bind(r.other)
  r.other.createSession = async options => {
    const live = await create(options) as FakeSession, send = live.send.bind(live)
    live.send = async (...args) => { const turn = await send(...args); reached(); await held; return turn }
    return live
  }
  await stuck(r); await sent
  const id = sessionId('fake-session-1'), original = r.host.registry.get(OTHER, id)?.live
  assert.ok(original, 'the old owner actually dispatched the continuation')
  const file = join(r.stateDir, 'carry-on', 'incidents.json')
  type Row = { incidentId: string; state: string; uncertain?: boolean; reservation?: unknown; note?: string; watch?: { pending?: boolean; turnId?: string }; unwritten?: { id?: string; phase: string; prospective?: boolean; anchor?: { kind: string; turnId?: string }; receipt?: { uncertain?: boolean; operationId: string } }[] }
  const read = () => (JSON.parse(readFileSync(file, 'utf8')) as { records: Row[] }).records[0]!
  const before = read(), marker = before.unwritten?.find(one => one.phase === 'arrived')
  assert.equal(before.state, 'sending'); assert.ok(before.reservation); assert.ok(marker?.prospective && marker.receipt?.operationId)
  const openedBefore = r.host.registry.opens(OTHER, id).opened
  if (replacement === 'different handle') r.other.sessions.delete(id)
  await r.host.call('session/resume', { runtime: OTHER, sessionId: id })
  const current = r.host.registry.get(OTHER, id)?.live
  assert.ok(current); assert.equal(current === original, replacement === 'same handle, newer open')
  assert.ok(r.host.registry.opens(OTHER, id).opened > openedBefore, 'an actual public open changed the lease')
  release()
  await r.client.until(() => { const saved = read(); return (saved.state === 'moved' || saved.state === 'asked') && !saved.reservation }, 5_000, 'old action completed its settlement')
  await r.client.until(() => {
    const saved = read(), pending = saved.unwritten?.find(one => one.id === marker.id)
    return saved.state === 'asked' && saved.uncertain === true && pending?.receipt?.uncertain === true
  }, 5_000, 'old operation visibly unconfirmed after stale acceptance')
  const after = read(), pending = after.unwritten?.find(one => one.id === marker.id)
  assert.equal(after.incidentId, before.incidentId)
  assert.equal(pending?.receipt?.operationId, marker.receipt.operationId)
  assert.equal(pending?.prospective, true, 'the old receipt cannot bind a turn to the replacement owner')
  assert.equal(pending?.anchor?.kind, 'continuation')
  assert.equal(after.watch?.turnId, undefined)
  assert.match(after.note ?? '', /may already have been sent/)
  assert.equal(r.sent.filter(one => one.runtime === OTHER && one.text.includes(HANDOFF_PREFIX)).length, 1, 'the old send was not retried')
})
