import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionId } from '@harnessdesk/protocol'
import type { ConversationLoadouts, HostMethodName, Session, RuntimeLoadout } from '@harnessdesk/protocol'
import { start, stop, halt, Client } from './fixtures/harness.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

const readMethod = 'session/loadout' as HostMethodName
const absent = (what: string) => ({ reported: false, reason: `This agent does not report its ${what}.` })
const answer = () => ({ approximate: false, source: 'scripted agent', skills: { reported: true, items: [{ name: 'review', group: null, origin: 'repo', path: null, tokens: null, count: null, enabled: true }], more: 0 }, mcp: { reported: true, items: [], more: 0 }, memory: absent('memory files'), agents: absent('agents') })
type Readback = ConversationLoadouts
async function recorded(client: Client, id: string, count = 1): Promise<Readback> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const value = await client.call(readMethod, { session: id, runtime: 'fake' }) as Readback
    if (value.epochs.length === count) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('loadout was not recorded')
}

test('asked and answered: create records skills without inventing memory; equal resume dedupes, changed resume appends', async t => {
  let result = answer()
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => result })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  const first = await recorded(client, session.id)
  assert.equal(first.seat, null)
  assert.equal(first.epochs[0]!.skills.reported, true)
  assert.ok(first.epochs[0]!.skills.reported)
  assert.deepEqual(first.epochs[0]!.skills.items.map(item => item.name), ['review'])
  assert.equal(first.epochs[0]!.memory.reported, false)
  await client.call('session/close', { runtime: 'fake', sessionId: session.id })
  await client.call('session/resume', { runtime: 'fake', sessionId: session.id })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal((await recorded(client, session.id)).epochs.length, 1)
  result = { ...answer(), skills: { ...answer().skills, items: [] } }
  await client.call('session/close', { runtime: 'fake', sessionId: session.id })
  await client.call('session/resume', { runtime: 'fake', sessionId: session.id })
  const changed = await recorded(client, session.id, 2)
  assert.deepEqual(changed.epochs.map(epoch => epoch.epoch), [0, 1])
})

test('not able to be asked: an ordinary conversation still opens and records not reported', async t => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  const value = await recorded(client, session.id)
  assert.deepEqual(value.epochs[0]!.skills, absent('skills'))
  assert.equal(value.epochs[0]!.memory.reported, false)
  await assert.rejects(client.call(readMethod, { session: 'unknown' }), { code: 'notFound' })
})

test('asked and failed: the agent failure is recorded and open is unchanged', async t => {
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => { throw new Error('Catalogue unavailable.') } })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  assert.deepEqual((await recorded(client, session.id)).epochs[0]!.skills, { reported: false, reason: 'Catalogue unavailable.' })
})

test('fork and automatic reopen each record a fresh observation and deletion removes only that conversation', async t => {
  let name = 'initial'
  const runtime = Object.assign(new FakeRuntime({ capabilities: { deleteHistory: 'trash' } }), { loadout: async () => ({ ...answer(), source: name, skills: { ...answer().skills, items: [{ ...answer().skills.items[0]!, name }] } }) })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const original = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  await recorded(client, original.id)
  const fork = await client.call('session/fork', { runtime: 'fake', sessionId: original.id }) as Session
  assert.equal((await recorded(client, fork.id)).epochs[0]!.skills.reported, true)
  name = 'reopened'
  runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() => harness.host.registry.get(original.runtime, original.id)?.live === null)
  runtime.setHealth({ state: 'ready' })
  await client.call('turn/send', { runtime: 'fake', sessionId: original.id, input: [{ type: 'text', text: 'Continue' }] })
  const opened = await recorded(client, original.id, 2)
  assert.ok(opened.epochs[1]!.skills.reported)
  assert.equal(opened.epochs[1]!.skills.items[0]!.name, 'reopened')
  runtime.sessions.get(original.id)!.finish()
  await client.until(() => client.events.some(event => event.type === 'turn/completed'))
  await client.call('session/delete', { runtime: 'fake', sessionId: fork.id })
  await assert.rejects(client.call(readMethod, { session: fork.id, runtime: 'fake' }), { code: 'notFound' })
  assert.equal((await recorded(client, original.id, 2)).epochs.length, 2)
})

test('loadout ids held by two runtimes require a runtime and name both choices', async t => {
  const harness = await start()
  t.after(() => stop(harness))
  const second = new FakeRuntime({ id: 'other' as never })
  harness.host.register(second)
  await second.start()
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const a = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  // The fake issues the same opaque first id for each account.
  const b = await client.call('session/create', { runtime: 'other', options: { cwd: '/home/jane/project' } }) as Session
  assert.equal(a.id, b.id)
  await assert.rejects(client.call(readMethod, { session: a.id }), error => (error as { code?: string }).code === 'ambiguous' && /fake/.test(String(error)) && /other/.test(String(error)))
  assert.equal((await client.call(readMethod, { session: a.id, runtime: 'other' }) as ConversationLoadouts).runtime, 'other')
})

test('opening does not wait for a loadout read and a first completed turn retries a not-ready report once', async t => {
  let release!: (value: RuntimeLoadout) => void
  let reads = 0
  const runtime = Object.assign(new FakeRuntime(), { loadout: async (): Promise<RuntimeLoadout> => {
    reads++
    return reads === 1 ? new Promise(done => { release = done }) : answer() as RuntimeLoadout
  } })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  assert.equal(reads, 1)
  assert.deepEqual((await client.call('session/loadout', { session: session.id, runtime: 'fake' }) as ConversationLoadouts).epochs, [])
  release({ ...answer(), skills: { reported: false, reason: 'No first response yet.', notReady: true } } as RuntimeLoadout)
  assert.equal((await recorded(client, session.id)).epochs[0]!.skills.reported, false)
  await client.call('turn/send', { runtime: 'fake', sessionId: session.id, input: [{ type: 'text', text: 'Hello' }] })
  runtime.sessions.get(session.id)!.finish()
  const next = await recorded(client, session.id, 2)
  assert.equal(next.epochs[1]!.skills.reported, true)
  assert.equal(reads, 2)
})

test('recorded loadouts survive a host restart and read without asking the replacement runtime', async t => {
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => answer() })
  const first = await start({}, undefined, runtime)
  const client = await Client.connect(first.server)
  const session = await client.call('session/create', { runtime: 'fake', options: { cwd: '/home/jane/project' } }) as Session
  const before = await recorded(client, session.id)
  client.close()
  await halt(first)
  let asked = false
  const replacement = Object.assign(new FakeRuntime(), { loadout: async () => { asked = true; return answer() } })
  const next = await start({}, first.stateDir, replacement)
  t.after(() => stop(next))
  const reader = await Client.connect(next.server)
  t.after(() => reader.close())
  assert.deepEqual(await reader.call('session/loadout', { session: session.id }), before)
  assert.equal(asked, false)
})

test('ordinary history resume records once without waiting, then dedupes or appends on a new handle', async t => {
  let release!: (value: RuntimeLoadout) => void
  let reads = 0
  let result = answer()
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => {
    reads++
    return reads === 1 ? new Promise<RuntimeLoadout>(done => { release = done }) : result
  } })
  const id = sessionId('history-only')
  runtime.minted.set(id, '/home/jane/project')
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('session/resume', { runtime: 'fake', sessionId: id })
  assert.equal(reads, 1, 'the ordinary resume must start an observation without awaiting it')
  release(result as RuntimeLoadout)
  await recorded(client, id)
  await client.call('session/resume', { runtime: 'fake', sessionId: id })
  assert.equal(reads, 1, 'returning the same live handle must not observe twice')
  await client.call('session/close', { runtime: 'fake', sessionId: id })
  await client.call('session/resume', { runtime: 'fake', sessionId: id })
  await client.until(() => reads === 2)
  assert.equal((await recorded(client, id)).epochs.length, 1)
  result = { ...answer(), skills: { ...answer().skills, items: [] } }
  await client.call('session/close', { runtime: 'fake', sessionId: id })
  await client.call('session/resume', { runtime: 'fake', sessionId: id })
  assert.equal((await recorded(client, id, 2)).epochs[1]!.skills.reported, true)
})
