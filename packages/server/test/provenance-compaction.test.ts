import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { exportProvenance, importProvenance } from '../src/provenance/backup.js'
import { captureHealth } from '../src/provenance/health.js'
import { digest, ProvenanceJournal, readCheckpoint, writeCheckpoint } from '../src/provenance/journal.js'
import { reconcileProject, type CommitObservation, type LinkObservation, type RangeObservation, rangeSource } from '../src/provenance/reconcile.js'
import type { GitReader } from '../src/provenance/git.js'
import { tempDir } from './scratch.js'

type CompactJournal = ProvenanceJournal & { compact(force?: boolean): Promise<boolean> }
const journalAt = (file: string) => new ProvenanceJournal(file) as CompactJournal
const checkpoint = (generation = 1) => ({ generation, refs: [], heads: [], logs: [], frontier: [], capturedThrough: 10, scanStartedAt: 10,
  rangeKeys: Array.from({ length: 256 }, (_, i) => `range-${i}-${'a'.repeat(50)}`), rangePending: [], baseline: [] })
const gap = (id: string) => ({ id, reason: 'history-gap', from: null, to: 10 })

test('append returns the durable sequence and checkpoint writing never reads the journal', async (t) => {
  const journal = journalAt(join(tempDir('compact-seq-'), 'provenance.ndjson'))
  assert.equal(await journal.append('gap', gap('first')), 1)
  assert.equal(await journal.append('gap', gap('first')), 1)
  const read = t.mock.method(journal, 'read', async () => { throw new Error('checkpoint-reread') })
  await writeCheckpoint(journal, checkpoint())
  read.mock.restore()
  assert.deepEqual(readCheckpoint((await journal.read()).entries), checkpoint())
})

test('100 changing scans keep storage bounded by live observations and the latest checkpoint', async () => {
  const file = join(tempDir('compact-growth-'), 'provenance.ndjson')
  const journal = journalAt(file)
  await journal.append('gap', gap('kept'))
  await writeCheckpoint(journal, checkpoint())
  const initial = (await fs.stat(file)).size
  for (let n = 2; n <= 100; n += 1) await writeCheckpoint(journal, checkpoint(n))
  assert.ok((await fs.stat(file)).size < 4 * initial)
  await journal.compact(true)
  const read = await new ProvenanceJournal(file).read()
  assert.equal(read.broken, false)
  assert.deepEqual(readCheckpoint(read.entries), checkpoint(100))
  assert.equal(read.entries.filter((entry) => entry.kind === 'gap').length, 1)
})

test('compaction preserves every historical record, decisions, status and backup/restore round trips', async () => {
  const file = join(tempDir('compact-proof-'), 'provenance.ndjson')
  const journal = journalAt(file)
  const sha = 'a'.repeat(40)
  const patch = { stable: 'b'.repeat(40), exact: 'c'.repeat(40), files: ['file'] }
  const commit: CommitObservation = { id: 'commit', sha, tree: sha, parents: ['d'.repeat(40)], firstSeenAt: 10, fingerprintVersion: 1,
    discoveredBy: [], checkoutHints: [], window: { from: null, to: 10 }, patch, files: [{ path: 'file', ...patch }], why: null }
  const link: LinkObservation = { id: 'link', sha, seats: ['seat-a'], sourceIds: ['commit'], evidenceIds: ['fact'], retainedPaths: ['file'], coverage: 'complete', via: 'observed', reason: null, at: 10 }
  const range: RangeObservation = { id: 'range', from: commit.parents[0]!, to: sha, commits: [sha], patch, seats: ['seat-a'], ambiguous: false, at: 10 }
  await journal.append('commit', commit)
  await journal.append('link', link)
  await journal.append('range', range)
  await journal.append('ref', { id: 'ref', ref: 'refs/heads/topic', before: null, after: sha, checkout: null, recordedAt: 10 })
  await journal.append('gap', gap('kept'))
  await journal.append('link', { id: 'restored-link', restoredAt: 20, data: link })
  await writeCheckpoint(journal, checkpoint())
  await writeCheckpoint(journal, checkpoint(2))
  const port = { projects: async () => ['/work/project'], journal: () => journal }
  const before = await journal.read()
  const backup = await exportProvenance(port)
  const decisions = (entries: typeof before.entries) => reconcileProject({
    commits: entries.filter((e) => e.kind === 'commit').map((e) => e.value as CommitObservation),
    sources: entries.filter((e) => e.kind === 'range').map((e) => rangeSource(e.value as RangeObservation, [link])),
    moves: [], priorLinks: [link], now: 30,
  }, {} as GitReader, new AbortController().signal)
  const status = (entries: typeof before.entries) => captureHealth({ project: '/work/project', enabled: true, fatal: false, issues: [], checkedAt: 10, lastCapturedAt: 10,
    pending: (readCheckpoint(entries) as ReturnType<typeof checkpoint>).frontier.length, gaps: entries.filter((e) => e.kind === 'gap').length, revision: 1 })
  await journal.compact(true)
  const after = await journalAt(file).read()
  assert.deepEqual(after.entries.filter((e) => e.kind !== 'cursor').map(({ kind, value }) => ({ kind, value })), before.entries.filter((e) => e.kind !== 'cursor').map(({ kind, value }) => ({ kind, value })))
  assert.deepEqual(await decisions(after.entries), await decisions(before.entries))
  assert.deepEqual(status(after.entries), status(before.entries))
  assert.deepEqual(await exportProvenance(port), backup)
  const target = journalAt(join(tempDir('compact-restore-'), 'provenance.ndjson'))
  const to = { projects: port.projects, journal: () => target }
  assert.deepEqual(await importProvenance(to, backup, 40), { restored: 5, duplicate: 1, refused: 0 })
  const restored = await exportProvenance(to)
  const again = journalAt(join(tempDir('compact-restore-again-'), 'provenance.ndjson'))
  assert.equal((await importProvenance({ projects: port.projects, journal: () => again }, restored, 40)).refused, 0)
  assert.deepEqual(await exportProvenance({ projects: port.projects, journal: () => again }), restored)
})

test('a failure after the compacted file is synced and before rename preserves the original bytes', async (t) => {
  const file = join(tempDir('compact-crash-'), 'provenance.ndjson')
  const journal = journalAt(file)
  await journal.append('gap', gap('kept'))
  await writeCheckpoint(journal, checkpoint())
  await journal.append('cursor', { id: 'orphan', type: 'part', bytes: '{}' })
  const original = await fs.readFile(file)
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('injected-before-rename') })
  await assert.rejects(journal.compact(true), /injected-before-rename/)
  rename.mock.restore()
  assert.deepEqual(await fs.readFile(file), original)
  assert.equal((await journalAt(file).read()).broken, false)
  assert.deepEqual((await fs.readdir(join(file, '..'))).sort(), ['provenance.ndjson'])
  await journal.append('gap', gap('later'))
  await journal.compact(true)
  assert.equal((await journalAt(file).read()).entries.filter((e) => e.kind === 'gap').length, 2)
})

test('automatic compaction failure leaves validated history and backups readable on the same journal', async (t) => {
  const file = join(tempDir('compact-open-retry-'), 'provenance.ndjson')
  const writer = journalAt(file)
  await writer.append('gap', gap('kept'))
  await writeCheckpoint(writer, checkpoint())
  await writer.append('cursor', { id: 'orphan', type: 'part', bytes: '{}' })
  const original = await fs.readFile(file)
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('injected-open-rename') })
  await assert.rejects(journal.read(), /injected-open-rename/)
  rename.mock.restore()
  assert.deepEqual(await fs.readFile(file), original)
  const read = await journal.read()
  assert.equal(read.broken, false)
  assert.deepEqual(readCheckpoint(read.entries), checkpoint())
  assert.deepEqual(await exportProvenance({ projects: async () => ['/work/project'], journal: () => journal }),
    { version: 1, projects: [{ project: '/work/project', entries: [{ kind: 'gap', value: gap('kept') }] }] })
  await journal.append('gap', gap('later'))
  await journal.compact(true)
  const reopened = await journalAt(file).read()
  assert.equal(reopened.broken, false)
  assert.equal(reopened.entries.filter((entry) => entry.kind === 'gap').length, 2)
  assert.deepEqual(readCheckpoint(reopened.entries), checkpoint())
})

for (const retry of ['compact', 'checkpoint']) test(`sparse replay after failed opening compaction supports a ${retry} retry`, async (t) => {
  const file = join(tempDir('compact-sparse-retry-'), 'provenance.ndjson')
  let seq = 0
  const lines: string[] = []
  const append = (kind: string, value: unknown): number => {
    const body = { version: 1, seq: ++seq, kind, value }
    lines.push(JSON.stringify({ ...body, checksum: digest(body) }))
    return seq
  }
  append('gap', gap('kept'))
  for (let generation = 1; generation <= 3; generation += 1) {
    const value = checkpoint(generation)
    const bytes = JSON.stringify(value)
    const hash = digest(value)
    const parts: number[] = []
    for (let offset = 0; offset < bytes.length; offset += 12000) {
      parts.push(append('cursor', { id: digest(['part', hash, offset]), type: 'part', bytes: bytes.slice(offset, offset + 12000) }))
    }
    append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`)
  const original = await fs.readFile(file)
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('injected-sparse-rename') })
  await assert.rejects(journal.read(), /injected-sparse-rename/)
  rename.mock.restore()
  assert.deepEqual(await fs.readFile(file), original)
  const sparse = await journal.read()
  assert.equal(sparse.broken, false)
  assert.ok(sparse.entries.at(-1)!.seq > sparse.entries.length)
  assert.deepEqual(readCheckpoint(sparse.entries), checkpoint(3))
  assert.equal(await journal.append('gap', gap('later')), seq + 1, 'appends follow the durable sequence, not the retained count')
  if (retry === 'compact') assert.equal(await journal.compact(true), true, 'retry must replace the still-uncompacted file')
  else await writeCheckpoint(journal, checkpoint(4))
  const refreshed = await journal.read({ after: sparse.entries.length, generation: sparse.generation })
  assert.ok(refreshed.generation > sparse.generation)
  const reopened = await journalAt(file).read()
  assert.equal(reopened.broken, false)
  assert.equal(reopened.entries.at(-1)!.seq, reopened.entries.length)
  assert.deepEqual(readCheckpoint(reopened.entries), checkpoint(retry === 'compact' ? 3 : 4))
  assert.deepEqual(await exportProvenance({ projects: async () => ['/work/project'], journal: () => journal }),
    { version: 1, projects: [{ project: '/work/project', entries: ['kept', 'later'].map((id) => ({ kind: 'gap', value: gap(id) })) }] })
})


test('concurrent checkpoint writes and compaction cannot renumber parts still being written', async () => {
  const journal = journalAt(join(tempDir('compact-concurrent-'), 'provenance.ndjson'))
  await writeCheckpoint(journal, checkpoint(0))
  const larger = { ...checkpoint(2), rangeKeys: Array.from({ length: 2000 }, (_, n) => `range-${n}-${'b'.repeat(50)}`) }
  await Promise.all([writeCheckpoint(journal, checkpoint(1)), writeCheckpoint(journal, larger)])
  assert.deepEqual(readCheckpoint((await journal.read()).entries), larger)
})

test('opening a legacy journal compacts checkpoints and invalidates incremental reader prefixes', async () => {
  const file = join(tempDir('compact-open-'), 'provenance.ndjson')
  let seq = 0
  const lines: string[] = []
  const append = (kind: string, value: unknown): number => {
    const body = { version: 1, seq: ++seq, kind, value }
    lines.push(JSON.stringify({ ...body, checksum: digest(body) }))
    return seq
  }
  append('gap', gap('kept'))
  for (let n = 1; n <= 30; n += 1) {
    const value = checkpoint(n)
    const bytes = JSON.stringify(value)
    const hash = digest(value)
    const parts = []
    for (let offset = 0; offset < bytes.length; offset += 12000) parts.push(append('cursor', { id: digest(['part', hash, offset]), type: 'part', bytes: bytes.slice(offset, offset + 12000) }))
    append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`)
  const before = (await fs.stat(file)).size
  const journal = new ProvenanceJournal(file, { compactOnOpen: true })
  const first = await journal.read({ copy: 'shallow' })
  assert.equal(first.broken, false)
  assert.deepEqual(readCheckpoint(first.entries), checkpoint(30))
  assert.ok((await fs.stat(file)).size < before / 10)
  assert.ok(first.entries.length < 10)
  await writeCheckpoint(journal, checkpoint(31))
  await writeCheckpoint(journal, checkpoint(32))
  const refreshed = await journal.read({ copy: 'shallow', after: first.entries.length, generation: first.generation })
  assert.ok(refreshed.generation > first.generation)
  assert.equal(refreshed.entries[0]?.kind, 'gap', 'a compacted prefix is reloaded rather than silently skipped')
  assert.deepEqual(readCheckpoint(refreshed.entries), checkpoint(32))
})


test('a yielded journal read keeps one generation when compaction overtakes it', async () => {
  const journal = journalAt(join(tempDir('compact-reader-'), 'provenance.ndjson'))
  await journal.append('gap', gap('kept'))
  await writeCheckpoint(journal, checkpoint(1))
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>((resolve) => { entered = resolve })
  const hold = new Promise<void>((resolve) => { release = resolve })
  const before = await journal.read({ copy: 'shallow' })
  let first = true
  const reading = journal.read({ copy: 'shallow', slices: { items: 1, yield: async () => {
    if (first) { first = false; entered(); await hold }
  } } })
  await paused
  try {
    await writeCheckpoint(journal, checkpoint(2))
    await writeCheckpoint(journal, checkpoint(3))
    await journal.compact(true)
  } finally { release() }
  const snapshot = await reading
  assert.equal(snapshot.generation, before.generation)
  assert.deepEqual(snapshot.entries, before.entries)
  assert.deepEqual(readCheckpoint(snapshot.entries), checkpoint(1))
  assert.deepEqual(readCheckpoint((await journal.read()).entries), checkpoint(3))
})
