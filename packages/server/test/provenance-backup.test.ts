import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { exportProvenance, importProvenance, ProvenanceBackups } from '../src/provenance/backup.js'
import { ProvenanceJournal, ProvenanceJournalChangedError, ProvenanceJournalLimitError } from '../src/provenance/journal.js'
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

const refusedJournal = (error: Error = new ProvenanceJournalLimitError()) => {
  const journal = new ProvenanceJournal('unused.ndjson')
  journal.read = async () => { throw error }
  return journal
}

const historicalEntry = (id: string, reason = 'history-gap') => ({
  kind: 'gap' as const, value: { id, reason, from: null, to: 1 },
})

const journalWithEntries = (entries: readonly ReturnType<typeof historicalEntry>[]) => {
  const journal = new ProvenanceJournal('unused.ndjson')
  journal.read = async () => ({
    entries: entries.map((entry, seq) => ({ seq: seq + 1, ...entry })), broken: false, generation: 0,
  })
  return journal
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
  const large = refusedJournal()
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
})

test('restore refuses oversized project entries and continues with later projects', async () => {
  const folder = tempDir('provenance-restore-limit-')
  const large = refusedJournal()
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
})

test('entries refused for an oversized project leave the restore budget for later healthy projects', async () => {
  const folder = tempDir('provenance-restore-count-')
  const large = refusedJournal()
  const healthy = new ProvenanceJournal(join(folder, 'healthy.ndjson'))
  const entry = { kind: 'gap', value: { id: 'history', reason: 'history-gap', from: null, to: 1 } }
  assert.deepEqual(await importProvenance({
    projects: async () => ['/work/large', '/work/healthy'],
    journal: (project) => project === '/work/large' ? large : healthy,
  }, { version: 1, projects: [
    { project: '/work/large', entries: Array(50000).fill(null) },
    { project: '/work/healthy', entries: [entry] },
  ] }), { restored: 1, duplicate: 0, refused: 50000 })
  assert.equal((await healthy.read()).entries.length, 1)
})

test('backup and restore propagate changed-journal errors without classifying them as size refusals', async () => {
  const error = new ProvenanceJournalChangedError()
  const journal = refusedJournal(error)
  const port = { projects: async () => ['/work/project'], journal: () => journal }
  await assert.rejects(exportProvenance(port), cause => cause === error)
  await assert.rejects(importProvenance(port, { version: 1, projects: [{
    project: '/work/project', entries: [historicalEntry('history')],
  }] }), cause => cause === error)
})

test('backup serializes each historical observation once while accounting for its byte budget', async t => {
  const journals = new Map(Array.from({ length: 6 }, (_, index) => [
    `/work/project-${index}`, journalWithEntries([historicalEntry(`linear-${index}`)]),
  ]))
  const stringify = JSON.stringify
  let observations = 0
  const serializations = t.mock.method(JSON, 'stringify', (value: unknown) => {
    const serialized = stringify(value)
    observations += serialized?.match(/"id":"linear-\d+"/g)?.length ?? 0
    return serialized
  })
  const backup = await exportProvenance({
    projects: async () => [...journals.keys()], journal: project => journals.get(project)!,
  })
  serializations.mock.restore()
  assert.equal(backup.projects.length, 6)
  assert.equal(observations, 6)
})

test('backup byte budget includes wrapper punctuation and omitted projects exactly', async () => {
  const limit = 10 * 1024 * 1024
  for (const omitted of [false, true]) for (const extraByte of [0, 1]) {
    const entries = Array.from({ length: 2600 }, (_, index) => historicalEntry(`boundary-${index}`, '界"\\'))
    const project = '/work/healthy-界-"\\'
    const nextProject = '/work/healthy-next-界-"\\'
    const excluded = '/work/omitted-界-"\\'
    const nextExcluded = '/work/omitted-next-界-"\\'
    const expected = {
      version: 1 as const,
      projects: [{ project, entries: entries.slice(0, 1300) }, { project: nextProject, entries: entries.slice(1300) }],
      ...(omitted ? { omittedProjects: [excluded, nextExcluded].map(root => ({
        project: root, reason: 'journal-limit-exceeded' as const,
      })) } : {}),
    }
    let padding = limit + extraByte - Buffer.byteLength(JSON.stringify(expected))
    for (const entry of entries) {
      const length = Math.min(padding, 4096 - entry.value.reason.length)
      entry.value.reason += 'x'.repeat(length)
      padding -= length
    }
    assert.equal(padding, 0)
    assert.equal(Buffer.byteLength(JSON.stringify(expected)), limit + extraByte)
    const healthy = new Map(expected.projects.map(saved => [saved.project, journalWithEntries(saved.entries)]))
    const refused = refusedJournal()
    const port = {
      projects: async () => omitted ? [project, excluded, nextProject, nextExcluded] : [project, nextProject],
      journal: (root: string) => healthy.get(root) ?? refused,
    }
    if (extraByte) await assert.rejects(exportProvenance(port), /provenance-backup-limit/)
    else assert.deepEqual(await exportProvenance(port), expected)
  }
})

test('backup preserves the combined project bound and the observation bound', async () => {
  const healthy = journalWithEntries([historicalEntry('history')])
  const refused = refusedJournal()
  const projects = Array.from({ length: 100 }, (_, index) => `/work/${index}`)
  const port = {
    projects: async () => projects,
    journal: (project: string) => Number(project.slice('/work/'.length)) % 2 ? refused : healthy,
  }
  const backup = await exportProvenance(port)
  assert.equal(backup.projects.length, 50)
  assert.equal(backup.omittedProjects?.length, 50)
  projects.push('/work/100')
  await assert.rejects(exportProvenance(port), /provenance-backup-limit/)

  const entries = Array.from({ length: 50000 }, (_, index) => historicalEntry(`row-${index}`, 'gap'))
  const large = journalWithEntries(entries)
  const rows = { projects: async () => ['/work/history'], journal: () => large }
  assert.equal((await exportProvenance(rows)).projects[0]?.entries.length, 50000)
  entries.push(historicalEntry('row-50000', 'gap'))
  await assert.rejects(exportProvenance(rows), /provenance-backup-limit/)
})


for (const failure of ['limit', 'changed']) test(`restore stops retrying a project after an append ${failure} refusal`, async (t) => {
  const folder = tempDir('provenance-restore-append-refusal-')
  const refused = new ProvenanceJournal(join(folder, 'refused.ndjson'))
  const healthy = new ProvenanceJournal(join(folder, 'healthy.ndjson'))
  let attempts = 0
  t.mock.method(refused, 'append', async () => {
    attempts += 1
    throw failure === 'limit' ? new ProvenanceJournalLimitError() : new ProvenanceJournalChangedError()
  })
  const entry = historicalEntry('restored')
  const report = await importProvenance({
    projects: async () => ['/work/refused', '/work/healthy'],
    journal: project => project === '/work/refused' ? refused : healthy,
  }, { version: 1, projects: [
    { project: '/work/refused', entries: Array(50000).fill(entry) },
    { project: '/work/healthy', entries: [entry] },
  ] })
  assert.deepEqual(report, { restored: 1, duplicate: 0, refused: 50000 })
  assert.equal(attempts, 1, 'a journal-wide refusal skips the remaining project records')
  assert.equal((await healthy.read()).entries.length, 1)
})
