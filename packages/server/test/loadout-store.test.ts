import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeId, sessionId, type RuntimeLoadout } from '@harnessdesk/protocol'
import { LoadoutStore, LoadoutRecorder } from '../src/loadouts.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { rm } from 'node:fs/promises'

const unknown = (part: string) => ({ reported: false as const, reason: `This agent does not report its ${part}.` })
const report = (name = 'review', path: string | null = null): RuntimeLoadout => ({
  approximate: false, source: 'fake',
  skills: { reported: true, more: 0, items: [{ name, group: null, origin: 'repo', path, enabled: true, tokens: null, count: null }] },
  mcp: { reported: true, more: 0, items: [] }, memory: unknown('memory files'), agents: unknown('agents'),
})
async function setup(t: { after(fn: () => unknown): void }) {
  const folder = await mkdtemp(join(tmpdir(), 'hd-loadout-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const store = new LoadoutStore(join(folder, 'loadouts'))
  return { folder, store }
}

test('retains the first and newest 19 epochs, deduplicates and reads them after restart with owner-only permissions', async t => {
  const { folder, store } = await setup(t)
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => report(String(n)) })
  const recorder = new LoadoutRecorder(store, { home: folder, log: () => {} })
  t.after(() => recorder.close())
  let n = 0
  for (; n < 25; n++) { recorder.observe(runtime, sessionId('demo'), folder, () => null); await recorder.flush() }
  n--
  recorder.observe(runtime, sessionId('demo'), folder, () => null)
  await recorder.flush()
  const epochs = await new LoadoutStore(join(folder, 'loadouts')).history(runtimeId('fake'), sessionId('demo'))
  assert.deepEqual(epochs.map(epoch => epoch.epoch), [0, ...Array.from({ length: 19 }, (_, i) => i + 6)])
  assert.equal((await stat(join(folder, 'loadouts/fake/demo.ndjson'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(folder, 'loadouts/fake'))).mode & 0o777, 0o700)
  const text = await readFile(join(folder, 'loadouts/fake/demo.ndjson'), 'utf8')
  assert.doesNotMatch(text, /"path":/)
})

test('digests only reported admitted files, includes skill resources and invalidates their metadata cache', async t => {
  const { folder, store } = await setup(t)
  const skill = join(folder, '.agents/skills/review')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# Review\n')
  await writeFile(join(skill, 'helper.txt'), 'one')
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => report('review', skill) })
  const recorder = new LoadoutRecorder(store, { home: folder, log: () => {} })
  t.after(() => recorder.close())
  const observe = async () => { recorder.observe(runtime, sessionId('demo'), folder, () => null); await recorder.flush(); return (await store.history(runtimeId('fake'), sessionId('demo'))).at(-1)! }
  const first = await observe()
  assert.equal(first.skills.reported && first.skills.items[0]!.digest?.length, 64)
  assert.equal(first.skills.reported && first.skills.items[0]!.pathLabel, '~/.agents/skills/review')
  await writeFile(join(skill, 'helper.txt'), 'two')
  const next = await observe()
  assert.notDeepEqual(first.skills, next.skills)
  await symlink(join(folder, 'private'), join(skill, 'outside'))
  await writeFile(join(folder, 'private'), 'never carried')
  assert.deepEqual((await observe()).skills, next.skills, 'bundle links are skipped exactly as in the write path')
  runtime.loadout = async () => report('review', join(skill, 'outside'))
  const outside = await observe()
  assert.equal(outside.skills.reported && outside.skills.items[0]!.digest, null)
  runtime.loadout = async () => report('review')
  const named = await observe()
  assert.equal(named.skills.reported && named.skills.items[0]!.digest, null, 'never finds a Library copy by name')
})

test('caps parts at 500 and only retries not-ready parts once after the first completed turn', async t => {
  const { folder, store } = await setup(t)
  let reads = 0
  const runtime = Object.assign(new FakeRuntime(), { loadout: async (): Promise<RuntimeLoadout> => {
    reads++
    if (reads === 1) return { ...report(), skills: { reported: false, reason: 'No response yet.', notReady: true } }
    return { ...report(), skills: { reported: true, more: 3, items: Array.from({ length: 510 }, (_, i) => ({ ...report().skills, name: `skill-${i}`, group: null, origin: null, path: null, enabled: null, tokens: null, count: null })) } }
  } })
  const recorder = new LoadoutRecorder(store, { home: folder, log: () => {} })
  t.after(() => recorder.close())
  recorder.observe(runtime, sessionId('demo'), folder, () => null)
  await recorder.flush()
  recorder.turnCompleted(runtimeId('fake'), sessionId('demo'))
  await recorder.flush()
  recorder.turnCompleted(runtimeId('fake'), sessionId('demo'))
  await recorder.flush()
  assert.equal(reads, 2)
  const epochs = await store.history(runtimeId('fake'), sessionId('demo'))
  const skills = epochs.at(-1)!.skills
  assert.equal(skills.reported && skills.items.length, 500)
  assert.equal(skills.reported && skills.more, 13)
})

test('a hung answer has a deadline, never holds open, and deletion fences late responses', async t => {
  const { folder, store } = await setup(t)
  let resolve!: (answer: RuntimeLoadout) => void
  const runtime = Object.assign(new FakeRuntime(), { loadout: () => new Promise<RuntimeLoadout>(done => { resolve = done }) })
  const recorder = new LoadoutRecorder(store, { home: folder, timeoutMs: 20, log: () => {} })
  t.after(() => recorder.close())
  assert.equal(recorder.observe(runtime, sessionId('demo'), folder, () => null), undefined)
  await recorder.flush()
  assert.equal((await store.history(runtimeId('fake'), sessionId('demo')))[0]!.skills.reported, false)
  await recorder.forget(runtimeId('fake'), sessionId('demo'))
  resolve(report())
  await recorder.flush()
  assert.deepEqual(await store.history(runtimeId('fake'), sessionId('demo')), [])
})

test('the record digest budget stops at 300 items or 64 MB and never trusts adapter digests', async t => {
  const { folder, store } = await setup(t)
  const memory = join(folder, 'MEMORY.md')
  await writeFile(memory, 'observed memory')
  const item = { name: 'memory', group: 'User', origin: 'user', path: memory, tokens: 42, count: null, enabled: null, digest: 'untrusted' }
  const runtime = Object.assign(new FakeRuntime(), { loadout: async (): Promise<RuntimeLoadout> => ({ ...report(), memory: { reported: true, more: 0, items: Array.from({ length: 301 }, (_, i) => ({ ...item, name: `memory-${i}` })) } }) })
  const recorder = new LoadoutRecorder(store, { home: folder, log: () => {} })
  t.after(() => recorder.close())
  recorder.observe(runtime, sessionId('items'), folder, () => null)
  await recorder.flush()
  const items = (await store.history(runtimeId('fake'), sessionId('items')))[0]!.memory
  assert.ok(items.reported)
  assert.equal(items.items.filter(item => item.digest !== null).length, 300)
  assert.ok(items.items.every(item => item.digest !== 'untrusted'))
  const files: typeof item[] = []
  for (let i = 0; i < 4; i++) {
    const path = join(folder, `memory-${i}.md`)
    await writeFile(path, Buffer.alloc(17 * 1024 * 1024, 97 + i))
    files.push({ ...item, path, name: `memory-${i}` })
  }
  runtime.loadout = async () => ({ ...report(), memory: { reported: true, more: 0, items: files } })
  recorder.observe(runtime, sessionId('bytes'), folder, () => null)
  await recorder.flush()
  const bytes = (await store.history(runtimeId('fake'), sessionId('bytes')))[0]!.memory
  assert.ok(bytes.reported)
  assert.equal(bytes.items.filter(item => item.digest !== null).length, 3)
  assert.ok(bytes.items.every(item => item.tokens === 42))
})

test('a first turn completing before the initial answer still causes only one not-ready retry', async t => {
  const { folder, store } = await setup(t)
  let release!: (report: RuntimeLoadout) => void, reads = 0
  const runtime = Object.assign(new FakeRuntime(), { loadout: async () => {
    reads++
    if (reads === 1) return new Promise<RuntimeLoadout>(done => { release = done })
    return report()
  } })
  const recorder = new LoadoutRecorder(store, { home: folder, log: () => {} })
  t.after(() => recorder.close())
  recorder.observe(runtime, sessionId('demo'), folder, () => null)
  await new Promise(resolve => setImmediate(resolve))
  recorder.turnCompleted(runtimeId('fake'), sessionId('demo'))
  release({ ...report(), memory: { reported: false, reason: 'No answer yet.', notReady: true } })
  await recorder.flush()
  assert.equal(reads, 2)
  assert.equal((await store.history(runtimeId('fake'), sessionId('demo'))).length, 2)
})
