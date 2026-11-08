import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureHealth, type HealthInput } from '../src/provenance/health.js'
import { digest, ProvenanceJournal, readCheckpoint, writeCheckpoint, type JournalEntry } from '../src/provenance/journal.js'
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

test('a corrupt oversized journal is broken rather than reported as a storage budget refusal', async () => {
  const file = join(tempDir('journal-size-'), 'provenance.ndjson')
  await new ProvenanceJournal(file).append('gap', gap())
  const prefix = await fs.readFile(file)
  const handle = await fs.open(file, 'r+')
  try { await handle.truncate(64 * 1024 * 1024 + 1) } finally { await handle.close() }
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  assert.equal((await journal.read()).broken, true)
  await assert.rejects(journal.append('gap', gap('later')), /provenance-journal-damaged/)
  await assert.rejects(journal.compact(true), /provenance-journal-damaged/)
  assert.equal((await fs.stat(file)).size, 64 * 1024 * 1024 + 1)
  const reader = await fs.open(file, 'r')
  try {
    const bytes = Buffer.alloc(prefix.length)
    await reader.read(bytes, 0, bytes.length, 0)
    assert.deepEqual(bytes, prefix)
  } finally { await reader.close() }
})

test('a loaded journal refuses an externally changed file without latching a storage failure', async () => {
  const file = join(tempDir('journal-growth-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap())
  const originalSize = (await fs.stat(file)).size
  const handle = await fs.open(file, 'r+')
  try { await handle.truncate(64 * 1024 * 1024) } finally { await handle.close() }
  await assert.rejects(journal.append('gap', gap('later')), { name: 'ProvenanceJournalChangedError', message: 'provenance-journal-changed' })
  assert.equal((await fs.stat(file)).size, 64 * 1024 * 1024)
  assert.equal((await journal.read({ copy: 'shallow' })).entries.length, 1)
  assert.equal(await journal.compact(true), false)
  assert.equal((await fs.stat(file)).size, 64 * 1024 * 1024)
  await fs.truncate(file, originalSize)
  await journal.append('gap', gap('recovered'))
  assert.equal((await journal.read()).entries.length, 2, 'a size refusal does not latch an I/O failure')
})

test('oversized cursor history compacts in a bounded pass and retains the latest checkpoint', async () => {
  const file = join(tempDir('journal-stream-compact-'), 'provenance.ndjson')
  const values: { kind: JournalEntry['kind']; value: unknown }[] = [
    { kind: 'gap', value: gap('preserved') },
    ...Array.from({ length: 6000 }, (_, at) => ({ kind: 'cursor' as const, value: { id: `old-${at}`, type: 'part', bytes: 'x'.repeat(12000) } })),
    { kind: 'cursor', value: { id: 'live-part', type: 'part', bytes: JSON.stringify(checkpoint()) } },
    { kind: 'cursor', value: { id: 'live-manifest', type: 'checkpoint', parts: [6002], hash: digest(checkpoint()) } },
  ]
  const handle = await fs.open(file, 'w')
  try {
    for (let at = 0; at < values.length; at++) {
      const body = { version: 1, seq: at + 1, ...values[at]! }
      await handle.write(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
    }
  } finally { await handle.close() }
  assert.ok((await fs.stat(file)).size > 64 * 1024 * 1024)
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  const read = await journal.read()
  assert.equal(read.broken, false)
  assert.equal(read.entries.length, 3)
  assert.deepEqual(readCheckpoint(read.entries), checkpoint())
  assert.deepEqual(read.entries[0]?.value, gap('preserved'))
  assert.ok((await fs.stat(file)).size < 4096)
})

test('an append near the budget does not rewrite cursors when the incoming record fits', async () => {
  const file = join(tempDir('journal-append-compact-'), 'provenance.ndjson')
  const handle = await fs.open(file, 'w')
  let size = 0
  let seq = 0
  try {
    while (size < 64 * 1024 * 1024 - 512 * 1024) {
      const body = { version: 1, seq: ++seq, kind: 'cursor', value: { id: `orphan-${seq}`, type: 'part', bytes: 'x'.repeat(12000) } }
      const bytes = `${JSON.stringify({ ...body, checksum: digest(body) })}\n`
      await handle.write(bytes)
      size += Buffer.byteLength(bytes)
    }
  } finally { await handle.close() }
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap('near-limit'))
  assert.ok((await fs.stat(file)).size > size, 'fitting records keep the existing durable prefix')
  assert.equal((await journal.read()).entries.length, seq + 1)
})

test('oversized recovery measures historical bytes with the compacted sequence envelope', async () => {
  const file = join(tempDir('journal-sequence-budget-'), 'provenance.ndjson')
  const handle = await fs.open(file, 'w')
  let seq = 0
  const line = (kind: JournalEntry['kind'], value: unknown, sequence = ++seq) => {
    const body = { version: 1, seq: sequence, kind, value }
    return `${JSON.stringify({ ...body, checksum: digest(body) })}\n`
  }
  const target = 64 * 1024 * 1024 + 500
  try {
    for (let at = 0; at < 2000; at++) await handle.write(line('cursor', { id: `old-${at}`, type: 'part', bytes: '{}' }))
    for (let at = 0; at < 1200; at++) {
      const value = {
        id: `range-${at}`, from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [],
        patch: { stable: '', exact: '', files: [] }, seats: [...Array<string>(13).fill('x'.repeat(4096)), ''], ambiguous: false, at: 1,
      }
      const sequence = ++seq
      const wanted = Math.floor(target / 1200) + (at < target % 1200 ? 1 : 0)
      const padding = wanted - Buffer.byteLength(line('range', value, sequence))
      assert.ok(padding > 0 && padding <= 4096)
      value.seats[13] = 'x'.repeat(padding)
      const bytes = line('range', value, sequence)
      assert.equal(Buffer.byteLength(bytes), wanted)
      await handle.write(bytes)
    }
  } finally { await handle.close() }
  const read = await new ProvenanceJournal(file).read({ copy: 'shallow' })
  assert.equal(read.broken, false)
  assert.equal(read.entries.length, 1200)
  assert.ok(read.entries.every((entry) => entry.kind === 'range'))
  assert.equal((await fs.stat(file)).size, target - 1107, 'renumbering removes the obsolete four-digit sequence overhead')
})

test('a two MiB checkpoint compacts only when its whole incoming transaction needs space', async () => {
  const file = join(tempDir('journal-checkpoint-budget-'), 'provenance.ndjson')
  const handle = await fs.open(file, 'w')
  let size = 0
  let seq = 0
  try {
    while (size < 62.5 * 1024 * 1024) {
      const body = { version: 1, seq: ++seq, kind: 'cursor', value: { id: `orphan-${seq}`, type: 'part', bytes: 'x'.repeat(12000) } }
      const bytes = `${JSON.stringify({ ...body, checksum: digest(body) })}\n`
      await handle.write(bytes)
      size += Buffer.byteLength(bytes)
    }
  } finally { await handle.close() }
  const value = { ...checkpoint(), rangeKeys: Array.from({ length: 512 }, (_, at) => `${at}-${'x'.repeat(4080)}`) }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 - 8192)
  const journal = new ProvenanceJournal(file)
  await writeCheckpoint(journal, value)
  const reopened = await new ProvenanceJournal(file).read()
  assert.equal(reopened.broken, false)
  assert.deepEqual(readCheckpoint(reopened.entries), value)
  assert.ok((await fs.stat(file)).size < 3 * 1024 * 1024)
})

test('a refused checkpoint budget writes no partial transaction and preserves historical bytes', async () => {
  const file = join(tempDir('journal-checkpoint-refused-'), 'provenance.ndjson')
  const handle = await fs.open(file, 'w')
  let size = 0
  let seq = 0
  try {
    while (size < 62.5 * 1024 * 1024) {
      const body = { version: 1, seq: ++seq, kind: 'range', value: {
        id: `range-${seq}`, from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [],
        patch: { stable: '', exact: '', files: [] }, seats: Array(14).fill('x'.repeat(4096)), ambiguous: false, at: 1,
      } }
      const bytes = `${JSON.stringify({ ...body, checksum: digest(body) })}\n`
      await handle.write(bytes)
      size += Buffer.byteLength(bytes)
    }
  } finally { await handle.close() }
  const hash = async () => {
    const value = createHash('sha256')
    for await (const bytes of createReadStream(file)) value.update(bytes)
    return value.digest('hex')
  }
  const original = await hash()
  const value = { ...checkpoint(), rangeKeys: Array.from({ length: 512 }, (_, at) => `${at}-${'x'.repeat(4080)}`) }
  await assert.rejects(writeCheckpoint(new ProvenanceJournal(file), value), /provenance-journal-limit/)
  assert.equal(await hash(), original)
})

for (const refusal of ['historical', 'invalid-checkpoint', 'ENOSPC', 'EACCES', 'changed']) test(`streaming recovery preserves an oversized ${refusal} journal`, async (t) => {
  const file = join(tempDir('journal-recovery-refusal-'), 'provenance.ndjson')
  const handle = await fs.open(file, 'w')
  let size = 0
  let seq = 0
  const write = async (kind: JournalEntry['kind'], value: unknown) => {
    const body = { version: 1, seq: ++seq, kind, value }
    const bytes = `${JSON.stringify({ ...body, checksum: digest(body) })}\n`
    await handle.write(bytes)
    size += Buffer.byteLength(bytes)
  }
  try {
    while (size <= 64 * 1024 * 1024) {
      if (refusal === 'historical') await write('range', {
        id: `range-${seq}`, from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [],
        patch: { stable: '', exact: '', files: [] }, seats: Array(14).fill('x'.repeat(4096)), ambiguous: false, at: 1,
      })
      else await write('cursor', { id: `part-${seq}`, type: 'part', bytes: 'x'.repeat(12000) })
    }
    if (refusal === 'invalid-checkpoint') {
      await write('cursor', { id: 'latest', type: 'checkpoint', parts: [1], hash: digest(checkpoint()) })
    }
  } finally { await handle.close() }
  const hash = async () => {
    const value = createHash('sha256')
    for await (const bytes of createReadStream(file)) value.update(bytes)
    return value.digest('hex')
  }
  const before = await hash()
  const open = fs.open
  let replacements = 0
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes('.compact-')) {
      replacements += 1
      if (refusal === 'ENOSPC' || refusal === 'EACCES') throw Object.assign(new Error(`injected-${refusal}`), { code: refusal })
      if (refusal === 'changed') {
        const body = { version: 1, seq: ++seq, kind: 'gap', value: gap('external') }
        await fs.appendFile(file, `${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
      }
    }
    return open(...args)
  })
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  try {
    if (refusal === 'historical') await assert.rejects(journal.read(), /provenance-journal-limit/)
    else if (refusal === 'changed') {
      await assert.rejects(journal.read(), { name: 'ProvenanceJournalChangedError', message: 'provenance-journal-changed' })
      await assert.rejects(journal.read(), /provenance-journal-changed/, 'an initial replay race is sticky until reload')
    } else assert.equal((await journal.read()).broken, true, 'corruption and I/O failures are storage failures')
  } finally { mock.mock.restore() }
  if (refusal === 'historical') assert.equal(replacements, 0, 'full serialized history overhead refuses before a replacement pass')
  if (refusal === 'changed') {
    const body = { version: 1, seq, kind: 'gap', value: gap('external') }
    const external = Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
    const current = await fs.open(file, 'r+')
    try {
      const suffix = Buffer.alloc(external.length)
      await current.read(suffix, 0, suffix.length, size)
      assert.deepEqual(suffix, external)
      await current.truncate(size)
    } finally { await current.close() }
  }
  assert.equal(await hash(), before)
  assert.deepEqual(await fs.readdir(join(file, '..')), ['provenance.ndjson'])
})

test('compaction preserves an external append made while the replacement is being written', async (t) => {
  const file = join(tempDir('journal-compaction-race-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap('local'))
  await journal.append('cursor', { id: 'orphan', type: 'part', bytes: '{}' })
  const original = await fs.readFile(file)
  const body = { version: 1, seq: 3, kind: 'gap', value: gap('external') }
  const external = Buffer.from(`${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
  const open = fs.open
  let injected = false
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    if (String(args[0]).includes('.compact-') && !injected) {
      injected = true
      await fs.appendFile(file, external)
    }
    return handle
  })
  try {
    await assert.rejects(journal.compact(true), { name: 'ProvenanceJournalChangedError', message: 'provenance-journal-changed' })
  } finally { mock.mock.restore() }
  assert.equal(injected, true)
  assert.deepEqual(await fs.readFile(file), Buffer.concat([original, external]))
  assert.deepEqual(await fs.readdir(join(file, '..')), ['provenance.ndjson'])
  assert.equal((await new ProvenanceJournal(file).read()).entries.length, 3)
})

test('a source change during opening compaction requires a fresh journal rather than exposing a stale replay', async (t) => {
  const file = join(tempDir('journal-open-change-'), 'provenance.ndjson')
  const writer = new ProvenanceJournal(file)
  await writer.append('gap', gap('local'))
  await writer.append('cursor', { id: 'orphan', type: 'part', bytes: '{}' })
  const body = { version: 1, seq: 3, kind: 'gap', value: gap('external') }
  const open = fs.open
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes('.compact-')) await fs.appendFile(file, `${JSON.stringify({ ...body, checksum: digest(body) })}\n`)
    return open(...args)
  })
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  try { await assert.rejects(journal.read(), /provenance-journal-changed/) } finally { mock.mock.restore() }
  await assert.rejects(journal.read(), /provenance-journal-changed/)
  await assert.rejects(journal.append('gap', gap('later')), /provenance-journal-changed/)
  assert.equal((await new ProvenanceJournal(file).read()).entries.length, 3)
})

test('a journal memory limit is reported as stopped capture with preserved history', () => {
  const status = health({ fatal: true, issues: ['journal-limit-exceeded'] })
  assert.equal(status.state, 'stopped')
  assert.equal(status.reason, "This project's saved capture history reached its storage limit.")
  assert.match(status.nextStep, /saved observations were kept/i)
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

test('a shallow journal read snapshots the entry list without cloning its records', async () => {
  const file = join(tempDir('journal-'), 'provenance.ndjson')
  const journal = new ProvenanceJournal(file)
  await journal.append('gap', gap('first'))

  const first = await journal.read({ copy: 'shallow' })
  const second = await journal.read({ copy: 'shallow' })
  assert.notStrictEqual(first.entries, second.entries)
  assert.strictEqual(first.entries[0], second.entries[0])

  await journal.append('gap', gap('second'))
  const later = await journal.read({ copy: 'shallow' })
  assert.equal(first.entries.length, 1, 'an existing list snapshot does not grow')
  assert.equal(later.entries.length, 2)
})

test('the default journal read isolates nested record values', async () => {
  const journal = new ProvenanceJournal(join(tempDir('journal-'), 'provenance.ndjson'))
  await journal.append('gap', { id: 'restored', restoredAt: 1, data: gap('original') })

  const first = await journal.read()
  const nested = first.entries[0]!.value as { data: { id: string } }
  nested.data.id = 'changed-by-caller'

  const later = await journal.read()
  assert.equal((later.entries[0]!.value as { data: { id: string } }).data.id, 'original')
  assert.notStrictEqual(first.entries[0], later.entries[0])
})

test('a shallow read waits for an already queued append', { timeout: 5_000 }, async (t) => {
  const journal = new ProvenanceJournal(join(tempDir('journal-'), 'provenance.ndjson'))
  await journal.append('gap', gap('first'))

  const originalOpen = fs.open
  let releaseWrite!: () => void
  let reachedWrite!: () => void
  const holdWrite = new Promise<void>((resolve) => { releaseWrite = resolve })
  const atWrite = new Promise<void>((resolve) => { reachedWrite = resolve })
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    reachedWrite()
    await holdWrite
    return originalOpen(...args)
  })
  try {
    const append = journal.append('gap', gap('second'))
    await atWrite
    let readDone = false
    const read = journal.read({ copy: 'shallow' }).then((value) => {
      readDone = true
      return value
    })
    await Promise.resolve()
    assert.equal(readDone, false, 'the read cannot finish before the queued write')

    releaseWrite()
    const [snapshot] = await Promise.all([read, append])
    assert.deepEqual(snapshot.entries.map((entry) => (entry.value as { id: string }).id), ['first', 'second'])
    await journal.append('gap', gap('third'))
    assert.equal(snapshot.entries.length, 2, 'later writes do not grow the returned snapshot')
  } finally {
    releaseWrite()
    mock.mock.restore()
  }
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

for (const code of ['ENOSPC', 'EACCES']) test(`a durable append ${code} failure retains its cause and stays a typed storage failure`, async (t) => {
  const file = join(tempDir('journal-append-storage-'), 'provenance.ndjson')
  const original = fs.open
  const cause = Object.assign(new Error(`injected-${code}`), { code })
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[1] === 'a') throw cause
    return original(...args)
  })
  const journal = new ProvenanceJournal(file)
  let failure: unknown
  try {
    await assert.rejects(journal.append('gap', gap()), (error: unknown) => {
      failure = error
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'ProvenanceJournalStorageError')
      assert.equal(error.message, 'provenance-write-failed')
      assert.equal(error.cause, cause)
      return true
    })
  } finally { mock.mock.restore() }
  assert.deepEqual((await journal.read()).entries, [])
  await assert.rejects(journal.flush(), (error: unknown) => error === failure)
  await assert.rejects(journal.append('gap', gap('retry')), (error: unknown) => error === failure)
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
    await assert.rejects(journal.append('gap', gap()), /short-write|provenance-write-failed/)
    mock.mock.restore()
    assert.deepEqual((await journal.read()).entries, [])
    await assert.rejects(journal.flush(), /short-write|provenance-write-failed/)
    await assert.rejects(journal.append('gap', gap('retry')), /short-write|provenance-write-failed/)
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

test('the latest checkpoint is read without reading the ones it superseded, and is still checked', async () => {
  const entries: JournalEntry[] = []
  const memory = {
    append: async (kind: JournalEntry['kind'], value: unknown) => { entries.push({ seq: entries.length + 1, kind, value }); return entries.length },
    read: async () => ({ entries: [...entries], broken: false }),
  } as unknown as ProvenanceJournal
  for (const generation of [1, 2, 3]) await writeCheckpoint(memory, { ...checkpoint(), generation })
  const manifests = entries.filter((entry) => entry.kind === 'cursor' && (entry.value as { type: string }).type === 'checkpoint')
  assert.equal(manifests.length, 3)
  const damage = (manifest: JournalEntry) => {
    entries[manifest.seq - 1] = { ...manifest, value: { ...(manifest.value as object), hash: digest('another checkpoint') } }
  }
  damage(manifests[0]!)
  assert.deepEqual(readCheckpoint(entries), { ...checkpoint(), generation: 3 }, 'a manifest that was superseded is not read, so its damage is not found')
  damage(manifests[2]!)
  assert.throws(() => readCheckpoint(entries), /provenance-invalid-checkpoint/, 'the one in force is read, and refused when it is damaged')
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

test('health presents historical gaps ahead of skipped local evidence with the existing repair guidance', () => {
  const combinations = [
    { gaps: 1, issues: ['evidence-skipped'] },
    { gaps: 0, issues: ['history-gap', 'evidence-skipped'] },
    { gaps: 0, issues: ['evidence-skipped', 'history-gap'] },
  ]
  for (const combination of combinations) {
    const value = health(combination)
    assert.equal(value.state, 'degraded')
    assert.equal(value.reason, 'Some history was unavailable when capture resumed.')
    assert.equal(value.nextStep, 'Retry if the repository has been repaired; those changes may stay unattributed.')
    assert.equal(value.enabled, true)
    assert.equal(value.gaps, combination.gaps)
  }
})
