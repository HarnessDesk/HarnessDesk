import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { itemId, sessionId, turnId, type Session } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { TranscriptStore } from '../src/transcripts.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'

const turn = (id: string, text: string) => ({ id: turnId(id), status: 'completed' as const,
  startedAt: 10, completedAt: 20, items: [{ id: itemId(id + '-answer'), type: 'assistantMessage' as const, text }] })

async function rig(t: TestContext, source = true) {
  const dir = await mkdtemp(join(tmpdir(), 'hd-source-reopen-'))
  const path = join(dir, 'source.jsonl')
  await writeFile(path, 'synthetic source')
  const runtime = new FakeRuntime()
  const capabilities = runtime.info.capabilities as { sourceTranscript?: boolean }
  capabilities.sourceTranscript = source
  let reads = 0
  let replay: Session = { id: sessionId('source-session'), runtime: runtime.info.id, cwd: dir,
    createdAt: 1, updatedAt: 20, itemsLoaded: true, status: { type: 'idle' }, turns: [turn('t1', 'original answer')] }
  Object.assign(runtime, { sourceOf: async () => {
    try { const facts = await stat(path); return { path, mtimeMs: facts.mtimeMs, size: facts.size } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  } })
  runtime.readSession = async () => { reads++; return replay }
  const host = new Host({ logger: silent, state: new StateStore(join(dir, 'state.json')),
    builtinAgents: join(dir, 'agents'), libraryHome: join(dir, 'library'), catalogRefreshMs: 0, idleStopMs: 0 })
  host.register(runtime)
  const params = { runtime: runtime.info.id, sessionId: replay.id }
  t.after(async () => { await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  const read = () => host.call('session/read', params)
  const stored = async () => {
    const store = new TranscriptStore(join(dir, 'transcripts'))
    try { return (await store.exportRuntime(runtime.info.id)).map(row => row.data as { turns: Session['turns'] }) } finally { await store.close() }
  }
  return { dir, host, runtime, path, read, reads: () => reads, setReplay: (value: Session) => { replay = value }, stored }
}

test('unchanged source reopens the database copy without an agent read', async t => {
  const r = await rig(t)
  const original = await r.read()
  const cached = await r.read()
  assert.equal(r.reads(), 1)
  assert.deepEqual(cached.turns, original.turns)
  assert.equal('deskCopy' in cached && cached.deskCopy, false)
})

test('changed source is enriched and the reconciled rows replace the old body', async t => {
  const r = await rig(t)
  const original = await r.read()
  await writeFile(r.path, 'synthetic source continued in the CLI')
  r.setReplay({ ...original, updatedAt: 30, turns: [...original.turns, turn('t2', 'new CLI answer')] })
  const refreshed = await r.read()
  assert.equal(r.reads(), 2)
  assert.deepEqual(refreshed.turns.map(turn => turn.id), ['t1', 't2'])
  assert.deepEqual((await r.stored())[0]?.turns, refreshed.turns)
  await r.read()
  assert.equal(r.reads(), 2, 'the refreshed fingerprint is reusable')
})

test('gone source serves the stored transcript with the copy flag', async t => {
  const r = await rig(t)
  const original = await r.read()
  await rm(r.path)
  const recovered = await r.read()
  assert.deepEqual(recovered.turns, original.turns)
  assert.equal('deskCopy' in recovered && recovered.deskCopy, true)
  assert.equal(r.reads(), 1)
})

test('a runtime without the capability still reads the agent on every reopen', async t => {
  const r = await rig(t, false)
  await r.read()
  await r.read()
  assert.equal(r.reads(), 2)
})

for (const kind of ['empty', 'partial', 'rollback'] as const) {
  test(`changed source ${kind} replay persists the enrich history contract`, async t => {
    const r = await rig(t)
    const initial = await r.read()
    r.setReplay({ ...initial, turns: [turn('t1', 'original answer'), turn('t2', 'omitted searchable work')] })
    await writeFile(r.path, 'two synthetic turns')
    const original = await r.read()
    await writeFile(r.path, 'changed synthetic history: ' + kind)
    r.setReplay({ ...original, turns: kind === 'empty' ? [] : kind === 'partial' ? [turn('t3', 'new answer')] : [original.turns[0]!],
      ...(kind === 'partial' ? { partialHistory: true } : {}) })
    const refreshed = await r.read()
    assert.deepEqual(refreshed.turns.map(turn => turn.id), kind === 'partial' ? ['t1', 't2', 't3'] : kind === 'empty' ? ['t1', 't2'] : ['t1'])
    assert.deepEqual((await r.stored())[0]?.turns, refreshed.turns)
    if (kind === 'rollback') {
      const hits = await r.host.call('transcripts/search', { query: 'omitted searchable work' })
      assert.deepEqual(hits, [])
    }
  })
}


test('cold reopen preserves every stored field and source stamp with the agent unavailable', async t => {
  const r = await rig(t)
  const original = await r.read()
  const store = new TranscriptStore(join(r.dir, 'transcripts'))
  const full = { ...original, title: 'Synthetic conversation', preview: 'Opening words', usage: {
    total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
    last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
  }, turns: [{ ...original.turns[0]!, status: 'failed' as const, error: { message: 'Synthetic refusal' }, durationMs: 10,
    diff: 'synthetic diff', plan: [{ step: 'Read the cache', status: 'completed' as const }] }] }
  const insight = [{ turn: 't1', startedAt: 10, endedAt: 20, seat: 'demo-seat', cause: { kind: 'person' as const },
    parent: null, before: null, after: null, generation: '', observedAt: 20, loaded: null }]
  store.record(full, { insight })
  await store.flush()
  const expected = await store.exportAll()
  const stamp = await store.source(full.runtime, full.id)
  await store.close()
  await r.host.dispose()
  const agent = new FakeRuntime()
  Object.assign(agent.info.capabilities, { sourceTranscript: true })
  agent.readSession = async () => { throw new Error('agent unavailable') }
  Object.assign(agent, { sourceOf: async () => { throw new Error('source lookup must be unnecessary') } })
  const cold = new Host({ logger: silent, state: new StateStore(join(r.dir, 'state.json')),
    builtinAgents: join(r.dir, 'agents'), libraryHome: join(r.dir, 'library'), catalogRefreshMs: 0, idleStopMs: 0 })
  cold.register(agent)
  t.after(() => cold.dispose())
  const recovered = await cold.call('session/read', { runtime: full.runtime, sessionId: full.id })
  assert.deepEqual(recovered.turns, full.turns)
  assert.deepEqual(recovered.usage, full.usage)
  assert.equal(recovered.title, full.title)
  assert.equal(recovered.deskCopy, false)
  const reopened = new TranscriptStore(join(r.dir, 'transcripts'))
  try {
    assert.deepEqual(await reopened.exportAll(), expected)
    assert.deepEqual(await reopened.readInsight(full.runtime, full.id), insight)
    assert.deepEqual(await reopened.source(full.runtime, full.id), stamp)
  } finally { await reopened.close() }
})

test('a changed source the agent cannot serve falls back without blessing its new fingerprint', async t => {
  const r = await rig(t)
  const original = await r.read()
  await writeFile(r.path, 'new source that the agent cannot serve')
  let failures = 0
  r.runtime.readSession = async () => { failures++; throw new Error('synthetic read refusal') }
  const recovered = await r.read()
  assert.equal(recovered.deskCopy, true)
  assert.deepEqual(recovered.turns, original.turns)
  await r.read()
  assert.equal(failures, 2, 'a failed refresh must retry the authority next time')
})

test('source append during replay leaves a fingerprint that forces a subsequent refresh', async t => {
  const r = await rig(t)
  const original = await r.read()
  await writeFile(r.path, 'changed before reading')
  let reads = 0
  r.runtime.readSession = async () => {
    reads++
    if (reads === 1) await writeFile(r.path, 'changed again while the agent was reading')
    return original
  }
  await r.read()
  await r.read()
  assert.equal(reads, 2)
})

test('changed lossy replay persists the stored work and original timing', async t => {
  const r = await rig(t)
  const original = await r.read()
  const full = { ...original, turns: [{ ...original.turns[0]!, diff: 'Synthetic diff', plan: [], items: [
    { id: itemId('reason'), type: 'reasoning' as const, summary: ['Synthetic reasoning'], content: [] },
    { id: itemId('command'), type: 'command' as const, command: 'echo synthetic', cwd: original.cwd,
      origin: 'agent' as const, status: 'completed' as const, output: 'Synthetic command output', exitCode: 0, actions: [] },
    ...original.turns[0]!.items,
  ] }] }
  const store = new TranscriptStore(join(r.dir, 'transcripts'))
  try { store.record(full); await store.flush() } finally { await store.close() }
  await writeFile(r.path, 'changed lossy source')
  r.setReplay({ ...original, turns: [{ ...original.turns[0]!, startedAt: 999, completedAt: 1000 }] })
  const merged = await r.read()
  assert.deepEqual(merged.turns, full.turns)
  assert.deepEqual((await r.stored())[0]?.turns, full.turns)
})

test('refresh rollback removes Insight and its queued copy along with omitted work', async t => {
  const r = await rig(t)
  const original = await r.read()
  const two = { ...original, turns: [...original.turns, turn('t2', 'rollback needle')] }
  const contexts = ['t1', 't2'].map(turn => ({ turn, startedAt: 10, endedAt: 20, seat: 'demo-seat',
    cause: { kind: 'person' as const }, parent: null, before: null, after: null, generation: '', observedAt: 20, loaded: null }))
  const store = new TranscriptStore(join(r.dir, 'transcripts'))
  try {
    store.record(two, { insight: contexts }); await store.flush()
    const source = await store.source(two.runtime, two.id)
    await store.refresh(original, source)
    assert.deepEqual(await store.readInsight(two.runtime, two.id), [contexts[0]])
    store.record(original); await store.flush()
    assert.deepEqual(await store.readInsight(two.runtime, two.id), [contexts[0]], 'a later record cannot resurrect the dropped context')
    assert.deepEqual(await store.search('rollback needle'), [])
  } finally { await store.close() }
})


test('a relocated agent source refreshes instead of claiming its record is gone', async t => {
  const r = await rig(t)
  const original = await r.read()
  const relocated = join(r.dir, 'relocated.jsonl')
  const { rename } = await import('node:fs/promises')
  await rename(r.path, relocated)
  Object.assign(r.runtime, { sourceOf: async () => { const facts = await stat(relocated); return { path: relocated, mtimeMs: facts.mtimeMs, size: facts.size } } })
  const reopened = await r.read()
  assert.equal(reopened.deskCopy, false)
  assert.deepEqual(reopened.turns, original.turns)
  assert.equal(r.reads(), 2)
})
