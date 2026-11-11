import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { CarryOnChoice, CarryOnIncidentView, CarryOnItem, CarryOnOwner, CarryOnScope, ModelInfo } from '@harnessdesk/protocol'

import { BACKOFF_MS, INCIDENT_LIMIT } from '../src/carry-on/incidents.js'
import { CarryOnService, type CarryOnPorts, type CarryOnRuntime } from '../src/carry-on/service.js'

/** The service of the design's §11.2, over fake ports, a fake clock and a fake timer. */

const HOUR = 60 * 60 * 1000
const LIMIT = { id: 't1', status: 'failed', error: { message: 'You have hit your usage limit.', code: 'credits' } }

interface Rig {
  readonly service: CarryOnService
  readonly file: string
  readonly calls: string[]
  readonly published: { key: string; incident: CarryOnIncidentView | null }[]
  readonly marks: { at: string; item: CarryOnItem }[]
  readonly rules: { scope: CarryOnScope; agent: string; choice: string }[]
  readonly timers: { at: number; run: () => void; cancelled: boolean }[]
  clock: number
  /** Runs every timer due by `clock`. */
  readonly tick: (to: number) => Promise<void>
  readonly reopen: (over?: Partial<CarryOnPorts>) => CarryOnService
}

const runtimes: Record<string, CarryOnRuntime> = {
  codex: { id: 'codex', agent: 'codex', name: 'Codex', account: 'work', sessionStore: '/store', ownSessions: false, gateway: false, signedIn: true, resume: true },
  'codex-2': { id: 'codex-2', agent: 'codex', name: 'Codex', account: 'personal', sessionStore: '/store', ownSessions: false, gateway: false, signedIn: true, resume: true },
  claude: { id: 'claude', agent: 'claude', name: 'Claude Code', sessionStore: null, ownSessions: false, gateway: false, signedIn: true, resume: true },
}

const rig = async (t: TestContext, options: {
  readonly choice?: CarryOnChoice
  readonly from?: CarryOnScope
  readonly owner?: CarryOnOwner
  readonly available?: readonly string[]
  readonly resetsAt?: number | null
  readonly reached?: boolean
  readonly dir?: string
} = {}): Promise<Rig> => {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  if (!options.dir) t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'carry-on', 'incidents.json')
  const state = {
    calls: [] as string[], published: [] as Rig['published'], marks: [] as Rig['marks'], rules: [] as Rig['rules'],
    timers: [] as Rig['timers'], clock: 1_000_000_000,
  }
  const available = options.available ?? ['codex', 'codex-2', 'claude']
  let created = 0
  const ports = (over: Partial<CarryOnPorts> = {}): CarryOnPorts => ({
    file,
    now: () => state.clock,
    schedule: (run, delay) => {
      const timer = { at: state.clock + delay, run, cancelled: false }
      state.timers.push(timer)
      return () => { timer.cancelled = true }
    },
    owner: async () => options.owner ?? 'chat',
    policy: () => ({ choice: options.choice ?? 'switch', from: options.from ?? 'desk', otherAgents: true }),
    describe: id => runtimes[id] ?? null,
    runtimes: () => available,
    rank: () => ({ tier: 1, resetsAt: null }),
    meter: async () => ({ reached: options.reached ?? true, blocked: options.reached ?? true, resetsAt: options.resetsAt === undefined ? null : options.resetsAt }),
    models: async (): Promise<readonly ModelInfo[]> => [],
    modelOf: () => undefined,
    titleOf: () => 'Fix the build',
    busy: () => false,
    footprint: () => 'quiet',
    close: async (runtime, id) => { state.calls.push(`close ${runtime} ${id}`) },
    resume: async (runtime, id) => { state.calls.push(`resume ${runtime} ${id}`); return `handle ${runtime} ${id}` },
    send: async (runtime, id, text) => {
      // Claim before send: whatever is being sent is already on disk.
      const disk = JSON.parse(await readFile(file, 'utf8')) as { records: { state: string }[] }
      state.calls.push(`send ${runtime} ${id} ${text.slice(0, 40)} [${disk.records.map(record => record.state).join(',')}]`)
    },
    create: async runtime => { created += 1; state.calls.push(`create ${runtime}`); return { sessionId: `new-${created}`, handle: `handle ${runtime} new-${created}` } },
    packet: async () => 'packet',
    record: (runtime, id, item) => { state.marks.push({ at: `${runtime} ${id}`, item }); return true },
    publish: (key, incident) => { state.published.push({ key: `${key.runtime} ${key.sessionId}`, incident }) },
    writeRule: async (scope, agent, choice) => { state.rules.push({ scope, agent, choice }) },
    ...over,
  })
  const service = new CarryOnService(ports())
  t.after(() => service.close())
  const out: Rig = Object.assign(state, {
    service, file,
    tick: async (to: number) => {
      state.clock = to
      for (const timer of state.timers.filter(timer => !timer.cancelled && timer.at <= to)) { timer.cancelled = true; timer.run() }
      await out.service.idle()
    },
    reopen: (over: Partial<CarryOnPorts> = {}) => new CarryOnService(ports(over)),
  }) as Rig
  return out
}

const disk = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { version: number; records: Record<string, unknown>[] }

test('the claim is on disk before the continuing message is sent, and the thread moves to the sibling', async t => {
  const r = await rig(t)
  await r.service.ended('codex', 's1', LIMIT)
  assert.deepEqual(r.calls.slice(0, 2), ['close codex s1', 'resume codex-2 s1'])
  assert.match(r.calls[2]!, /^send codex-2 s1 Continue from where you stopped\. \[sending\]$/)
  const [record] = (await disk(r.file)).records
  assert.equal(record!['state'], 'moved')
  assert.equal(record!['runtime'], 'codex-2', 'the incident follows the conversation to the account that holds it')
  assert.equal(r.marks.at(-1)?.item.phase, 'switched')
  assert.equal(r.marks.at(-1)?.at, 'codex-2 s1')
  assert.equal(r.published.at(-1)?.incident?.state, 'moved')
})

test('a second ended event for the same turn opens no second incident', async t => {
  const r = await rig(t, { choice: 'ask' })
  await r.service.ended('codex', 's1', LIMIT)
  await r.service.ended('codex', 's1', LIMIT)
  await r.service.ended('codex', 's1', { ...LIMIT, id: 't2' })
  assert.equal((await disk(r.file)).records.length, 1)
  assert.equal(r.service.list().length, 1)
  assert.equal(r.published.filter(entry => entry.incident?.state === 'asked').length, 1)
})

test('waiting for the reset fires just after it, never before', async t => {
  const r = await rig(t, { choice: 'wait', resetsAt: 1_000_000_000 + HOUR })
  await r.service.ended('codex', 's1', LIMIT)
  assert.equal(r.service.list()[0]?.state, 'waiting-reset')
  assert.equal(r.marks.at(-1)?.item.phase, 'waiting')
  await r.tick(1_000_000_000 + HOUR)
  assert.equal(r.calls.length, 0, 'not at the reset itself')
  await r.tick(1_000_000_000 + HOUR + 1_250)
  assert.deepEqual(r.calls.map(call => call.split(' ').slice(0, 3).join(' ')), ['resume codex s1', 'send codex s1'])
  assert.equal(r.marks.at(-1)?.item.phase, 'resumed')
  assert.equal(r.published.at(-1)?.incident, null)
})

test('a restart while sending asks again and never resends', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const r = await rig(t, { dir })
  // The send never comes back: the host went down mid-send.
  const hung = r.reopen({ send: () => new Promise(() => {}) })
  void hung.ended('codex', 's1', LIMIT)
  // Polled rather than slept: under load the claim can take longer than any fixed pause.
  for (let at = Date.now(); (await disk(r.file).catch(() => ({ version: 0, records: [] as Record<string, unknown>[] }))).records[0]?.['state'] !== 'sending';) {
    assert.ok(Date.now() - at < 10_000, 'the send was never reached')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  hung.close()

  const after = await rig(t, { dir })
  await after.service.restore()
  const [view] = after.service.list()
  assert.equal(view?.state, 'asked')
  assert.match(view?.note ?? '', /may already have been sent/)
  assert.equal(after.calls.length, 0)
})

test('a restart while waiting re-arms the timer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const before = await rig(t, { dir, choice: 'wait', resetsAt: 1_000_000_000 + HOUR })
  await before.service.ended('codex', 's1', LIMIT)
  before.service.close()

  const after = await rig(t, { dir })
  await after.service.restore()
  assert.equal(after.timers.length, 1)
  await after.tick(1_000_000_000 + HOUR + 1_250)
  assert.deepEqual(after.calls.map(call => call.split(' ').slice(0, 3).join(' ')), ['resume codex s1', 'send codex s1'])
})

test('the person’s own message cancels the incident', async t => {
  const r = await rig(t, { choice: 'ask', resetsAt: 1_000_000_000 + HOUR })
  await r.service.ended('codex', 's1', LIMIT)
  assert.equal(r.service.live('codex', 's1'), true)
  await r.service.personSent('codex', 's1')
  assert.equal(r.service.live('codex', 's1'), false)
  assert.equal(r.service.list().length, 0)
  assert.equal(r.published.at(-1)?.incident, null)
  // The fallback at the reset is gone with it.
  await r.tick(1_000_000_000 + 2 * HOUR)
  assert.equal(r.calls.length, 0)
})

test('"Always do this" writes the level the rule was read from', async t => {
  for (const from of ['desk', 'agent'] as const) {
    const r = await rig(t, { choice: 'ask', from })
    await r.service.ended('codex', 's1', LIMIT)
    const [view] = r.service.list()
    assert.equal(view?.alwaysScope, from)
    assert.equal(view?.choices.target?.runtime, 'codex-2')
    await r.service.decide({ incidentId: view!.incidentId, choice: 'switch', always: true })
    assert.deepEqual(r.rules, [{ scope: from, agent: 'codex', choice: 'switch' }])
    assert.ok(r.calls.includes('resume codex-2 s1'))
  }
})

test('an answer to a question that has moved on is refused with the current incident', async t => {
  const r = await rig(t, { choice: 'ask' })
  await r.service.ended('codex', 's1', LIMIT)
  const [view] = r.service.list()
  await assert.rejects(r.service.decide({ incidentId: view!.incidentId, choice: 'switch', target: 'nowhere' as never, always: false }),
    (error: Error & { wireCode?: string; wireData?: { incident: CarryOnIncidentView | null } }) =>
      error.wireCode === 'carryOnStale' && error.wireData?.incident?.state === 'asked')
  await r.service.decide({ incidentId: view!.incidentId, choice: 'stop', always: false })
  await assert.rejects(r.service.decide({ incidentId: view!.incidentId, choice: 'stop', always: false }),
    (error: Error & { wireCode?: string }) => error.wireCode === 'carryOnStale')
  assert.equal(r.marks.at(-1)?.item.phase, 'stopped')
})

test('the ledger keeps at most 64 incidents, oldest first out', async t => {
  const r = await rig(t, { choice: 'stop' })
  for (let at = 0; at < INCIDENT_LIMIT + 3; at += 1) await r.service.ended('codex', `s${at}`, LIMIT)
  const records = (await disk(r.file)).records
  assert.equal(records.length, INCIDENT_LIMIT)
  assert.equal(records[0]!['sessionId'], 's3')
})

test('a Lead chat is the Lead’s: no incident, no card, no marker', async t => {
  const r = await rig(t, { owner: 'lead' })
  await r.service.ended('codex', 's1', LIMIT)
  assert.equal(r.published.length, 0)
  assert.equal(r.marks.length, 0)
  assert.equal(r.calls.length, 0)
  assert.equal(r.service.list().length, 0)
})

test('a throttle backs off on the same account twice, silently, before it becomes a limit', async t => {
  const r = await rig(t, { choice: 'ask', reached: false })
  const throttled = { id: 't1', status: 'failed', error: { message: 'Slow down.', code: 'rateLimit' } }
  await r.service.ended('codex', 's1', throttled)
  assert.equal(r.service.list().length, 0)
  await r.tick(r.clock + BACKOFF_MS[0])
  assert.deepEqual(r.calls.map(call => call.split(' ').slice(0, 3).join(' ')), ['resume codex s1', 'send codex s1'])
  await r.service.ended('codex', 's1', { ...throttled, id: 't2' })
  await r.tick(r.clock + BACKOFF_MS[1])
  assert.equal(r.calls.length, 4)
  assert.equal(r.published.length, 0, 'no card while it is backing off')
  assert.equal(r.marks.length, 0, 'and no marker')
  await r.service.ended('codex', 's1', { ...throttled, id: 't3' })
  assert.equal(r.service.list()[0]?.state, 'asked')
  assert.equal(r.service.list()[0]?.cause, 'rateLimit')
})

test('a handoff creates the new conversation, links both ways and follows its first turn', async t => {
  const r = await rig(t, { available: ['codex', 'claude'] })
  await r.service.ended('codex', 's1', LIMIT)
  assert.deepEqual(r.calls.map(call => call.split(' ').slice(0, 3).join(' ')), ['create claude', 'send claude new-1'])
  assert.deepEqual(r.marks.map(mark => [mark.at, mark.item.phase, mark.item.link?.sessionId]), [['codex s1', 'left', 'new-1'], ['claude new-1', 'arrived', 's1']])
  const view = r.published.at(-1)?.incident
  assert.equal(view?.state, 'moved')
  assert.deepEqual(view?.link, { runtime: 'claude', sessionId: 'new-1' })
  // Its first turn hits a limit too: the same incident tries what is left, and nothing is.
  await r.service.ended('claude', 'new-1', { ...LIMIT, id: 'c1' })
  const records = (await disk(r.file)).records
  assert.equal(records.length, 1, 'one incident, carried into the conversation that holds it')
  assert.equal(records[0]!['runtime'], 'claude')
  assert.equal(records[0]!['state'], 'stopped')
  assert.equal(r.marks.at(-1)?.item.phase, 'exhausted')
})

// ------------------------------------------------------------ review round 1

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let at = 0; at < 200 && !check(); at += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), what)
}
const sends = (r: Rig) => r.calls.filter(call => call.startsWith('send '))

test('a person’s message during the first meter read wins: the old failure opens nothing', async t => {
  const r = await rig(t)
  const meter = deferred<{ reached: boolean; blocked: boolean; resetsAt: number | null }>()
  const service = r.reopen({ meter: () => meter.promise })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await service.personSent('codex', 's1')
  meter.resolve({ reached: true, blocked: true, resetsAt: null })
  await ended
  assert.deepEqual(r.calls, [], 'no close, no resume, no send')
  assert.equal(service.live('codex', 's1'), false)
})

test('a person’s message during the model lookup stops the switch before it touches the thread', async t => {
  const r = await rig(t)
  const models = deferred<readonly ModelInfo[]>()
  let asked = false
  const service = r.reopen({ models: () => { asked = true; return models.promise } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => asked, 'the model lookup')
  const person = service.personSent('codex', 's1')
  models.resolve([])
  await ended; await person
  assert.deepEqual(r.calls, [], 'the person’s message is the continuation')
  assert.equal(service.live('codex', 's1'), false)
})

test('a person’s message during the reset’s resume stops the retry before it sends', async t => {
  const r = await rig(t, { choice: 'wait', resetsAt: 1_000_000_000 + HOUR })
  const resumed = deferred()
  let resuming = false
  const service = r.reopen({ resume: async (runtime, id) => { r.calls.push(`resume ${runtime} ${id}`); resuming = true; await resumed.promise; return `handle ${runtime} ${id}` } })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  r.clock = 1_000_000_000 + HOUR + 1_250
  r.timers.find(timer => !timer.cancelled)!.run()
  await until(() => resuming, 'the resume at the reset')
  const person = service.personSent('codex', 's1')
  resumed.resolve()
  await service.idle(); await person
  assert.deepEqual(sends(r), [], 'no continue behind the person’s message')
  assert.equal(service.live('codex', 's1'), false)
})

test('a repeated completion of the failed turn after the thread moved sends no second continuation', async t => {
  const r = await rig(t)
  await r.service.ended('codex', 's1', LIMIT)
  assert.equal(sends(r).length, 1)
  // The stuck account reports the same failed turn again, after the record moved to its sibling.
  await r.service.ended('codex', 's1', LIMIT)
  assert.equal(sends(r).length, 1, 'the first account’s turn is still fenced')
  const records = (await disk(r.file)).records
  assert.equal(records.length, 1)
  assert.equal(records[0]!['hops'], 1)
})

test('a send left uncertain by a restart waits for an answer, through any later restart, never for the reset', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const reset = 1_000_000_000 + HOUR
  const r = await rig(t, { dir, resetsAt: reset })
  const hung = r.reopen({ send: () => new Promise(() => {}) })
  void hung.ended('codex', 's1', LIMIT)
  await until(() => r.calls.includes('resume codex-2 s1'), 'the switch to reach its send')
  await new Promise(resolve => setTimeout(resolve, 20))
  hung.close()

  for (let restart = 0; restart < 2; restart += 1) {
    const after = await rig(t, { dir })
    await after.service.restore()
    assert.equal(after.service.list()[0]?.state, 'asked')
    assert.equal(after.timers.filter(timer => !timer.cancelled).length, 0, `no timer after restart ${restart + 1}`)
    await after.tick(reset + 2 * HOUR)
    assert.deepEqual(after.calls, [], 'nothing goes out on its own')
    after.service.close()
  }
})

test('an account that ran out after the card offered it is refused as stale, before any rule is written', async t => {
  const r = await rig(t, { choice: 'ask' })
  const ranks: Record<string, { tier: 0 | 1 | 2 | 3; resetsAt: number | null }> = {}
  const service = r.reopen({ rank: id => ranks[id] ?? { tier: 1, resetsAt: null } })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  const [view] = service.list()
  assert.equal(view?.choices.target?.runtime, 'codex-2')
  ranks['codex-2'] = { tier: 3, resetsAt: null }
  await assert.rejects(service.decide({ incidentId: view!.incidentId, choice: 'switch', target: 'codex-2' as never, always: true }),
    (error: Error & { wireCode?: string }) => error.wireCode === 'carryOnStale')
  assert.deepEqual(r.rules, [], 'no rule written')
  assert.deepEqual(r.calls, [], 'nothing moved')
})

// ------------------------------------------------------------ review round 2

test('a person who starts using the sibling while carry-on reopens it keeps it: the cancel never closes their work', async t => {
  const r = await rig(t)
  const resumed = deferred()
  let resuming = false
  const service = r.reopen({ resume: async (runtime, id) => { r.calls.push(`resume ${runtime} ${id}`); resuming = true; await resumed.promise; return `handle ${runtime} ${id}` } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => resuming, 'the sibling’s reopen')
  // The person writes, and goes on in the conversation the sibling now holds.
  // Not awaited here: the person's message queues behind the incident's step, as on the desk.
  const people = [service.personSent('codex', 's1'), service.personSent('codex-2', 's1')]
  resumed.resolve()
  await ended; await Promise.all(people)
  assert.ok(!r.calls.includes('close codex-2 s1'), `the sibling is not closed under the person: ${r.calls.join(' | ')}`)
  assert.deepEqual(sends(r), [])
  const incident = r.published.at(-1)?.incident
  assert.equal(incident?.state, 'stopped')
  assert.match(incident?.note ?? '', /also open on Codex · personal/)
})

test('a sibling nobody touched is still let go when the person’s message wins', async t => {
  const r = await rig(t)
  const resumed = deferred()
  let resuming = false
  const service = r.reopen({ resume: async (runtime, id) => { r.calls.push(`resume ${runtime} ${id}`); resuming = true; await resumed.promise; return `handle ${runtime} ${id}` } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => resuming, 'the sibling’s reopen')
  const person = service.personSent('codex', 's1')
  resumed.resolve()
  await ended; await person
  assert.ok(r.calls.includes('close codex-2 s1'))
  assert.deepEqual(sends(r), [])
})

test('a new conversation the person has started using while it was created is never closed by the cancel', async t => {
  const r = await rig(t, { available: ['codex', 'claude'] })
  const made = deferred<string>()
  let creating = false
  const service = r.reopen({ create: async runtime => { r.calls.push(`create ${runtime}`); creating = true; const sessionId = await made.promise; return { sessionId, handle: `handle ${runtime} ${sessionId}` } } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => creating, 'the new conversation')
  const people = [service.personSent('codex', 's1'), service.personSent('claude', 'new-1')]
  made.resolve('new-1')
  await ended; await Promise.all(people)
  assert.ok(!r.calls.includes('close claude new-1'), `the person’s new conversation stays: ${r.calls.join(' | ')}`)
  assert.deepEqual(sends(r), [])
  const incident = r.published.at(-1)?.incident
  assert.equal(incident?.state, 'stopped')
  assert.equal(String(incident?.link?.sessionId), 'new-1')
})

test('a person’s message while the handoff link is being saved stops the packet', async t => {
  const r = await rig(t, { available: ['codex', 'claude'] })
  let service!: CarryOnService
  service = r.reopen({
    publish: (key, incident) => {
      r.published.push({ key: `${key.runtime} ${key.sessionId}`, incident })
      if (incident?.link) void service.personSent('codex', 's1')
    },
  })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  assert.deepEqual(sends(r), [], `no packet behind the person’s message: ${r.calls.join(' | ')}`)
})

test('a person’s message during the first sending claim stops the move before the source is closed', async t => {
  const r = await rig(t)
  let service!: CarryOnService
  service = r.reopen({
    publish: (key, incident) => {
      r.published.push({ key: `${key.runtime} ${key.sessionId}`, incident })
      if (incident?.state === 'sending') void service.personSent('codex', 's1')
    },
  })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  assert.deepEqual(r.calls, [], 'the source stays open, nothing reopened, nothing sent')
})

test('after a restart left a switch unconfirmed, its target is off the card and the note says where it went', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const r = await rig(t, { dir })
  const hung = r.reopen({ send: () => new Promise(() => {}) })
  void hung.ended('codex', 's1', LIMIT)
  await until(() => r.calls.includes('resume codex-2 s1'), 'the switch to reach its send')
  await new Promise(resolve => setTimeout(resolve, 20))
  hung.close()

  const after = await rig(t, { dir, available: ['codex', 'codex-2'] })
  await after.service.restore()
  const [view] = after.service.list()
  assert.equal(view?.state, 'asked')
  const offered = [view?.choices.target, ...(view?.others ?? [])].filter(Boolean).map(target => String(target!.runtime))
  assert.ok(!offered.includes('codex-2'), `the account it was going to is not offered again: ${offered.join(', ')}`)
  assert.match(view?.note ?? '', /may already have been sent to Codex · personal/)
  await assert.rejects(after.service.decide({ incidentId: view!.incidentId, choice: 'switch', target: 'codex-2' as never, always: false }),
    (error: Error & { wireCode?: string }) => error.wireCode === 'carryOnStale')
  assert.deepEqual(after.calls, [])
})

// ------------------------------------------------------------ review round 3

test('a cancel never closes a sibling handle carry-on cannot prove it attached', async t => {
  const r = await rig(t)
  const resumed = deferred()
  let resuming = false
  // Another opener attached alongside carry-on's resume: the host hands back no handle of carry-on's own.
  const service = r.reopen({ resume: async (runtime, id) => { r.calls.push(`resume ${runtime} ${id}`); resuming = true; await resumed.promise; return null } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => resuming, 'the sibling’s reopen')
  const person = service.personSent('codex', 's1')
  resumed.resolve()
  await ended; await person
  assert.ok(!r.calls.some(call => call.startsWith('close codex-2')), `nothing of the sibling’s is closed: ${r.calls.join(' | ')}`)
})

test('the cancel closes only the handle carry-on attached', async t => {
  const r = await rig(t)
  const closed: string[] = []
  const resumed = deferred()
  let resuming = false
  const service = r.reopen({
    resume: async (runtime, id) => { resuming = true; await resumed.promise; return `handle ${runtime} ${id}` },
    close: async (runtime, id, handle) => { closed.push(`${runtime} ${id} ${handle ?? 'any'}`) },
  })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => resuming, 'the sibling’s reopen')
  const person = service.personSent('codex', 's1')
  resumed.resolve()
  await ended; await person
  assert.deepEqual(closed, ['codex s1 any', 'codex-2 s1 handle codex-2 s1'])
})

/** A send port that dispatches the way the host does: an await, then the person writes, then the effect. */
const dispatching = (r: Rig, service: () => CarryOnService, source = { runtime: 'codex', sessionId: 's1' }) =>
  async (runtime: string, id: string, text: string, _kind: string, stillOurs?: () => boolean) => {
    await new Promise(resolve => setTimeout(resolve, 1))
    void service().personSent(source.runtime, source.sessionId)
    // The host's admission, at its effect boundary.
    if (stillOurs && !stillOurs()) throw new Error('The person’s message went first.')
    r.calls.push(`send ${runtime} ${id} ${text.slice(0, 40)}`)
  }

test('a person who writes inside the host’s dispatch of the same-thread continue wins', async t => {
  const r = await rig(t)
  let service!: CarryOnService
  service = r.reopen({ send: dispatching(r, () => service) })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  await service.idle()
  assert.deepEqual(sends(r), [], 'the continue never left')
  assert.notEqual(r.published.at(-1)?.incident?.state, 'asked', 'and the person is not asked about a failure')
})

test('a person who writes inside the host’s dispatch of the handoff packet wins', async t => {
  const r = await rig(t, { available: ['codex', 'claude'] })
  let service!: CarryOnService
  service = r.reopen({ send: dispatching(r, () => service) })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  await service.idle()
  assert.deepEqual(sends(r), [], 'the packet never left')
  assert.notEqual(r.published.at(-1)?.incident?.state, 'asked')
})

test('a person who writes inside the host’s dispatch of the reset retry wins', async t => {
  const r = await rig(t, { choice: 'wait', resetsAt: 1_000_000_000 + HOUR })
  let service!: CarryOnService
  service = r.reopen({ send: dispatching(r, () => service) })
  t.after(() => service.close())
  await service.ended('codex', 's1', LIMIT)
  r.clock = 1_000_000_000 + HOUR + 1_250
  r.timers.find(timer => !timer.cancelled)!.run()
  await until(() => r.calls.includes('resume codex s1'), 'the retry at the reset')
  await service.idle()
  assert.deepEqual(sends(r), [], 'the retry never left')
  assert.notEqual(r.published.at(-1)?.incident?.state, 'asked')
})

test('a destination left open for the person is recorded in the conversation, with its link, to outlive a reconnect', async t => {
  const r = await rig(t)
  const resumed = deferred()
  let resuming = false
  const service = r.reopen({ resume: async (runtime, id) => { r.calls.push(`resume ${runtime} ${id}`); resuming = true; await resumed.promise; return `handle ${runtime} ${id}` } })
  t.after(() => service.close())
  const ended = service.ended('codex', 's1', LIMIT)
  await until(() => resuming, 'the sibling’s reopen')
  const people = [service.personSent('codex', 's1'), service.personSent('codex-2', 's1')]
  resumed.resolve()
  await ended; await Promise.all(people)
  const stopped = r.marks.find(mark => mark.item.phase === 'stopped')
  assert.ok(stopped, `a stopped marker: ${r.marks.map(mark => mark.item.phase).join(', ')}`)
  assert.equal(stopped.at, 'codex s1', 'in the conversation the person is in')
  assert.deepEqual(stopped.item.link, { runtime: 'codex-2', sessionId: 's1' })
  assert.match(stopped.item.note ?? '', /also open on Codex · personal/)
})
