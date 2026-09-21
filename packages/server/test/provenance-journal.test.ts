import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureHealth, type HealthInput } from '../src/provenance/health.js'
import { digest, ProvenanceJournal, readCheckpoint, writeCheckpoint } from '../src/provenance/journal.js'
import { ProvenancePreferences } from '../src/provenance/preferences.js'
import { tempDir } from './scratch.js'

const gap = (id = 'gap-1') => ({ id, reason: 'history-gap', from: null, to: 10 })
const checkpoint = () => ({
  generation: 1, refs: [], heads: [], logs: [], frontier: [],
  capturedThrough: 10, scanStartedAt: 9, baseline: [], rangeKeys: [], rangePending: [],
})
const health = (over: Partial<HealthInput> = {}) => captureHealth({
  project: '/work/project', enabled: true, fatal: false, issues: [],
  checkedAt: 10, lastCapturedAt: 9, pending: 0, gaps: 0, revision: 1, ...over,
})

test('serialized observations and chunked checkpoints replay in durable prefix order', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await Promise.all(Array.from({ length: 220 }, (_, n) => journal.append('gap', gap(`gap-${n}`))))
  const value = { ...checkpoint(), rangeKeys: Array.from({ length: 2000 }, (_, n) => digest(n)) }
  await writeCheckpoint(journal, value)
  await journal.append('gap', gap('gap-1'))
  await journal.flush()
  const reopened = await new ProvenanceJournal(file).read()
  assert.equal(reopened.broken, false)
  assert.deepEqual(readCheckpoint(reopened.entries), value)
  assert.equal(reopened.entries.filter((entry) => entry.kind === 'gap').length, 220)
  assert.ok((await fs.readFile(file, 'utf8')).split('\n').every((line) => Buffer.byteLength(line) < 65536))
})

test('a torn tail refuses appends and leaves every original byte in place', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  await new ProvenanceJournal(file).append('gap', gap())
  await fs.appendFile(file, '{"version":1')
  const before = await fs.readFile(file)
  const reopened = new ProvenanceJournal(file)
  assert.equal((await reopened.read()).broken, true)
  await assert.rejects(reopened.append('gap', gap('later')), /provenance-journal-damaged/)
  assert.deepEqual(await fs.readFile(file), before)
})

test('unknown versions and checksum damage stop at the first damaged record', async () => {
  for (const field of ['version', 'checksum']) {
    const file = join(tempDir('journal-'), 'provenance.ndjson')
    const journal = new ProvenanceJournal(file)
    await journal.append('gap', gap())
    await journal.append('gap', gap('second'))
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    const first = JSON.parse(lines[0]!)
    first[field] = field === 'version' ? 2 : 'wrong'
    await fs.writeFile(file, `${JSON.stringify(first)}\n${lines[1]}\n`)
    const read = await new ProvenanceJournal(file).read()
    assert.equal(read.broken, true)
    assert.deepEqual(read.entries, [])
  }
})

test('short writes and sync failures are sticky and never publish an entry', async (t) => {
  const original = fs.open
  for (const failure of ['short', 'sync']) {
    const file = join(tempDir('journal-'), 'provenance.ndjson')
    const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (failure === 'short') t.mock.method(handle, 'write', async () => ({ bytesWritten: 1 }))
      else t.mock.method(handle, 'sync', async () => { throw new Error('injected-sync') })
      return handle
    })
    const journal = new ProvenanceJournal(file)
    await assert.rejects(journal.append('gap', gap()), /short-write|injected-sync/)
    mock.mock.restore()
    assert.deepEqual((await journal.read()).entries, [])
    await assert.rejects(journal.flush(), /short-write|injected-sync/)
    await assert.rejects(journal.append('gap', gap('retry')), /short-write|injected-sync/)
  }
})

test('an incomplete checkpoint attempt is inert and later replay deduplicates observations', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap())
  await journal.append('cursor', { id: 'orphan-part', type: 'part', bytes: '{}' })
  assert.equal(readCheckpoint((await journal.read()).entries), null)
  await assert.rejects(journal.append('cursor', {
    id: 'future', type: 'checkpoint', parts: [99], hash: digest({}),
  }), /provenance-invalid-record/)
  const reopened = new ProvenanceJournal(file)
  await reopened.append('gap', gap())
  await writeCheckpoint(reopened, checkpoint())
  assert.equal((await reopened.read()).entries.filter((entry) => entry.kind === 'gap').length, 1)
  assert.deepEqual(readCheckpoint((await reopened.read()).entries), checkpoint())
})

test('preferences default on, persist off, isolate projects and refuse malformed files', async () => {
  const file = join(tempDir('preferences-'), 'provenance-preferences.json')
  const first = new ProvenancePreferences(file)
  await first.load()
  assert.deepEqual(first.get('/work/one'), { enabled: true, problem: null })
  await first.set('/work/one', false)
  const second = new ProvenancePreferences(file)
  await second.load()
  assert.equal(second.get('/work/one').enabled, false)
  assert.equal(second.get('/work/two').enabled, true)
  assert.throws(() => second.get('../outside'), /provenance-invalid-project/)
  await fs.writeFile(file, '{bad')
  const broken = new ProvenancePreferences(file)
  await broken.load()
  assert.equal(broken.get('/work/one').problem, 'preference-invalid')
  await assert.rejects(broken.set('/work/one', true), /preference-invalid/)
  assert.equal(await fs.readFile(file, 'utf8'), '{bad')
})

test('a failed preference rename retains the published value and removes its own temporary file', async (t) => {
  const dir = tempDir('preferences-')
  const preferences = new ProvenancePreferences(join(dir, 'provenance-preferences.json'))
  await preferences.load()
  const mock = t.mock.method(fs, 'rename', async () => { throw new Error('injected-rename') })
  await assert.rejects(preferences.set('/work/project', false), /injected-rename/)
  assert.equal(preferences.get('/work/project').enabled, true)
  assert.deepEqual(await fs.readdir(dir), [])
  mock.mock.restore()
  await preferences.set('/work/project', false)
  assert.equal(preferences.get('/work/project').enabled, false)
})

test('health keeps off and fatal precedence, fixed copy, and historical gaps', () => {
  assert.equal(health().state, 'healthy')
  assert.equal(health({ pending: 1 }).reason, 'Catching up with this project.')
  assert.equal(health({ enabled: false, fatal: true, pending: 4 }).reason, 'Capture is off on this machine.')
  assert.equal(health({ fatal: true, pending: 4 }).state, 'stopped')
  assert.equal(health({ enabled: false, fatal: true, issues: ['preference-invalid'] }).reason, 'Capture could not save its observations.')
  assert.equal(health({ issues: ['watch-unavailable'] }).state, 'degraded')
  assert.equal(health({ gaps: 1 }).reason, 'Some history was unavailable when capture resumed.')
  assert.equal(health({ issues: ['limit-exceeded'] }).reason, 'Capture reached its background work limit.')
  assert.equal(health({ fatal: true, issues: ['external-metadata'] }).nextStep, 'Open its main checkout, or use a checkout with local metadata.')
  assert.equal(health({ fatal: true, issues: ['folder-unavailable'] }).reason, "This project's folder is unavailable.")
  assert.doesNotMatch(health({ fatal: true, issues: ['/outside/private text'] }).reason, /private/)
})
