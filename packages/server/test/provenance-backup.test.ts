import assert from 'node:assert/strict'
import { mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { exportProvenance, importProvenance, ProvenanceBackups } from '../src/provenance/backup.js'
import { JOURNAL_BYTE_LIMIT, ProvenanceJournal } from '../src/provenance/journal.js'
import { tempDir } from './scratch.js'
import { EvidenceStore } from '../src/evidence/store.js'

const setup = () => {
  const folder = tempDir('provenance-backup-')
  const journals = new Map<string, ProvenanceJournal>()
  return {
    projects: async () => [...journals.keys()],
    journal: (project: string) => {
      let journal = journals.get(project)
      if (!journal) {
        journal = new ProvenanceJournal(join(folder, String(journals.size), 'provenance.ndjson'))
        journals.set(project, journal)
      }
      return journal
    },
  }
}

test('backup round-trips ranges as restored history and leaves cursors and preferences behind', async () => {
  const from = setup()
  const journal = from.journal('/work/project')
  await journal.append('range', {
    id: 'range-1', from: 'a'.repeat(40), to: 'b'.repeat(40), commits: ['b'.repeat(40)],
    patch: { stable: 'c'.repeat(40), exact: 'd'.repeat(40), files: ['one'] },
    seats: ['seat-1'], ambiguous: false, at: 10,
  })
  await journal.append('cursor', { id: 'part', type: 'part', bytes: '{}' })
  const backup = await exportProvenance(from)
  assert.deepEqual(Object.keys(backup).sort(), ['projects', 'version'])
  assert.equal(backup.projects[0]?.entries.length, 1)
  const to = setup()
  assert.deepEqual(await importProvenance(to, backup, 20), { restored: 1, duplicate: 0, refused: 0 })
  assert.deepEqual(await importProvenance(to, backup, 30), { restored: 0, duplicate: 1, refused: 0 })
  const read = await to.journal('/work/project').read()
  assert.deepEqual(read.entries.map((entry) => entry.kind), ['range'])
  assert.equal((read.entries[0]?.value as { restoredAt: number }).restoredAt, 20)
})

test('restores refuse live cursors, invalid projects, wrong versions and oversized records', async () => {
  const port = setup()
  const raw = { version: 1, projects: [{ project: '/work/project', entries: [
    { kind: 'cursor', value: { id: 'part', type: 'part', bytes: '{}' } },
    { kind: 'gap', value: { id: 'bad', reason: 'x'.repeat(70000), from: null, to: 1 } },
  ] }, { project: '../outside', entries: [] }] }
  assert.deepEqual(await importProvenance(port, raw), { restored: 0, duplicate: 0, refused: 3 })
  assert.equal((await importProvenance(port, { ...raw, version: 2 })).refused, 1)
  assert.equal((await importProvenance(port, { version: 1, projects: Array(101).fill({}) })).refused, 1)
  assert.equal((await importProvenance(port, { version: 1, projects: [], padding: 'x'.repeat(10 * 1024 * 1024) })).refused, 1)
  assert.deepEqual(await importProvenance(port, undefined), { restored: 0, duplicate: 0, refused: 0 })
})

test('a local observation wins over an imported observation with the same identity', async () => {
  const port = setup()
  const value = { id: 'local', reason: 'history-gap', from: null, to: 1 }
  await port.journal('/work/project').append('gap', value)
  assert.deepEqual(await importProvenance(port, { version: 1, projects: [{
    project: '/work/project', entries: [{ kind: 'gap', value }],
  }] }), { restored: 0, duplicate: 1, refused: 0 })
  assert.deepEqual((await port.journal('/work/project').read()).entries[0]?.value, value)
})


test('the host backup owner serializes imports and preserves project discovery after restart', async () => {
  const folder = tempDir('provenance-backup-owner-')
  const store = new EvidenceStore(folder)
  const owner = new ProvenanceBackups(store)
  const backup = { version: 1, projects: [{ project: '/work/project', entries: [{
    kind: 'gap', value: { id: 'history', reason: 'history-gap', from: null, to: 1 },
  }] }] }
  const reports = await Promise.all([owner.restore(backup), owner.restore(backup)])
  assert.deepEqual(reports.map((report) => report.restored), [1, 0])
  assert.equal(reports[1]?.duplicate, 1)
  await owner.close()
  const reopened = new ProvenanceBackups(store)
  assert.equal((await reopened.backup()).projects[0]?.project, '/work/project')
  await reopened.close()
})


test('backup reports a refused oversized project and still exports healthy projects', async () => {
  const folder = tempDir('provenance-backup-limit-')
  const file = join(folder, 'large.ndjson')
  const handle = await open(file, 'w')
  try { await handle.truncate(JOURNAL_BYTE_LIMIT + 1) } finally { await handle.close() }
  const large = new ProvenanceJournal(file)
  const healthy = new ProvenanceJournal(join(folder, 'healthy.ndjson'))
  const value = { id: 'healthy', reason: 'history-gap', from: null, to: 1 }
  await healthy.append('gap', value)
  const backup = await exportProvenance({
    projects: async () => ['/work/large', '/work/healthy'],
    journal: (project) => project === '/work/large' ? large : healthy,
  })
  assert.deepEqual(backup, {
    version: 1, omittedProjects: [{ project: '/work/large', reason: 'journal-limit-exceeded' }],
    projects: [{ project: '/work/healthy', entries: [{ kind: 'gap', value }] }],
  })
  assert.equal((await stat(file)).size, JOURNAL_BYTE_LIMIT + 1)
})

test('restore refuses oversized project entries and continues with later projects', async () => {
  const folder = tempDir('provenance-restore-limit-')
  const file = join(folder, 'large.ndjson')
  const handle = await open(file, 'w')
  try { await handle.truncate(JOURNAL_BYTE_LIMIT + 1) } finally { await handle.close() }
  const large = new ProvenanceJournal(file)
  const healthy = new ProvenanceJournal(join(folder, 'healthy.ndjson'))
  const entry = { kind: 'gap', value: { id: 'history', reason: 'history-gap', from: null, to: 1 } }
  assert.deepEqual(await importProvenance({
    projects: async () => ['/work/large', '/work/healthy'],
    journal: (project) => project === '/work/large' ? large : healthy,
  }, { version: 1, projects: [
    { project: '/work/large', entries: [entry, entry] },
    { project: '/work/healthy', entries: [entry] },
  ] }), { restored: 1, duplicate: 0, refused: 2 })
  assert.equal((await healthy.read()).entries.length, 1)
  assert.equal((await stat(file)).size, JOURNAL_BYTE_LIMIT + 1)
})

test('entries refused for an oversized project still count toward the restore budget', async () => {
  const folder = tempDir('provenance-restore-count-')
  const file = join(folder, 'large.ndjson')
  await mkdir(folder, { recursive: true })
  const handle = await open(file, 'w')
  try { await handle.truncate(JOURNAL_BYTE_LIMIT + 1) } finally { await handle.close() }
  const large = new ProvenanceJournal(file)
  const healthy = new ProvenanceJournal(join(folder, 'healthy.ndjson'))
  const entry = { kind: 'gap', value: { id: 'history', reason: 'history-gap', from: null, to: 1 } }
  assert.deepEqual(await importProvenance({
    projects: async () => ['/work/large', '/work/healthy'],
    journal: (project) => project === '/work/large' ? large : healthy,
  }, { version: 1, projects: [
    { project: '/work/large', entries: Array(50000).fill(null) },
    { project: '/work/healthy', entries: [entry] },
  ] }), { restored: 0, duplicate: 0, refused: 50001 })
  assert.equal((await healthy.read()).entries.length, 0)
})
