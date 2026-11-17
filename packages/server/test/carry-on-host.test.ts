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
  splitContextContent,
  wrapContext,
  type CarryOnIncidentView,
  type CarryOnItem,
  type RuntimeInfo,
  type Session,
} from '@harnessdesk/protocol'

import { CarryOnIncidents, type CarryOnRecord } from '../src/carry-on/incidents.js'
import { TranscriptStore } from '../src/transcripts.js'
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

  // The continue is the host's line, not the person's: it goes out as desk context, enveloped under its own label.
  const CONTINUE = wrapContext(CONTINUE_SOURCE, CONTINUE_TEXT)
  await r.client.until(() => r.sent.some(one => one.runtime === SIBLING && one.text === CONTINUE), 10_000, 'the continue on the sibling')
  assert.ok(!r.sent.some(one => one.text === CONTINUE_TEXT), 'never as a plain line the person seems to have typed')
  assert.deepEqual(order, ['close on the primary', 'resume on the sibling'], 'one live writer per thread')
  assert.equal(r.sibling!.sessions.get(session.id)?.id, session.id, 'the same thread, not a new one')

  const after = (await r.client.call('session/read', { runtime: SIBLING, sessionId: session.id })) as Session
  const switched = markers(after).find(one => one.phase === 'switched')
  assert.ok(switched, 'the marker is part of the conversation')
  assert.equal(switched.mode, 'sameThread')
  assert.equal(switched.to?.account, 'account 2', 'named by its ordinal, never an address')
  assert.equal(switched.link, undefined, 'a same-thread switch has nowhere else to point')
  const asked = after.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage' ? [item] : []))
  const carried = asked.filter(item => splitContextContent(item.content).injections.some(one => one.label === CONTINUE_SOURCE))
  assert.equal(carried.length, 1, `the continue is in the transcript once, as desk context: ${JSON.stringify(asked.map(item => item.content))}`)
  const continued = carried[0]!
  assert.ok(continued.content.every(part => part.type !== 'text' || part.deskContext?.prefixLength === part.text.length), 'all of it the desk’s')
  assert.equal(splitContextContent(continued.content).text, '', 'nothing of it reads as the person’s bubble')

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
      { runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped' },
      { runtime: String(PRIMARY), sessionId: String(id), phase: 'stopped' },
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
  const mock = t.mock.method(CarryOnIncidents.prototype, 'put', async function (this: CarryOnIncidents, record: CarryOnRecord, replaces?: { readonly runtime: string; readonly sessionId: string }) {
    if (record.incidentId === 'retry-incident' && !record.unwritten && inserted.length === 0) {
      inserted = markers(host.registry.get(PRIMARY, id)!.session)
      assert.equal(inserted.length, 2, 'real host inserted both markers before the failed clear')
      resolveFailure()
      throw new Error('injected ledger clear failure')
    }
    return put.call(this, record, replaces)
  })
  const created = await host.call('session/create', { runtime: PRIMARY, options: { cwd: '/w' } }) as Session
  assert.equal(created.id, id)
  await host.call('turn/send', { runtime: PRIMARY, sessionId: id, input: [{ type: 'text', text: 'Hello' }] })
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
  // A turn event makes the pending ledger entries reachable again.
  runtime.sessions.get(id)!.fail('ordinary failure', 'unknown')
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
