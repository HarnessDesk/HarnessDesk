import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeId } from '@harnessdesk/protocol'

import { AgentDirectory, AgentRegistryStore } from '../src/agent-registry.js'
import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * Backup and restore, proven the only way that counts: everything one host
 * exports comes up on a second, fresh host — the agent registered, the
 * preferences applied, the transcript findable by its words. And restore is
 * additive: nothing local is deleted, nothing local is rolled backwards, and
 * running it twice changes nothing the second time.
 */

const silent = new Logger('test', { level: 'error', console: false })

const hostAt = async (stateDir: string) => {
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    agents: directory,
    catalogRefreshMs: 0,
  })
  return { host, store }
}

/** A stored transcript file, as the store writes them. */
const transcriptFile = (savedAt: number, text: string) =>
  JSON.stringify({
    version: 1,
    runtime: 'my-agent',
    id: 's1',
    savedAt,
    updatedAt: savedAt,
    title: 'A kept conversation',
    preview: text,
    cwd: '/repo',
    turns: [
      {
        id: 't1',
        status: 'completed',
        items: [{ id: 'a', type: 'assistantMessage', text }],
      },
    ],
  })

test('what one host exports, a fresh host restores — and can prove it has', async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), 'hd-backup-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'hd-backup-b-'))
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })

  const a = await hostAt(dirA)
  t.after(() => a.host.dispose())
  a.store.add({ id: 'my-agent', name: 'My Agent', command: 'my-agent' })
  await a.host.call('app/state/set', { patch: { theme: 'dark', draftValues: { 'my-agent': { model: 'large' } } } })
  await mkdir(join(dirA, 'transcripts', 'my-agent'), { recursive: true })
  await writeFile(
    join(dirA, 'transcripts', 'my-agent', 's1.json'),
    transcriptFile(1000, 'the sentence worth finding later'),
  )

  const backup = await a.host.call('backup/export', {})
  assert.equal(backup.kind, 'harnessdesk-backup')
  assert.equal(backup.agents.length, 1)
  assert.equal(backup.transcripts.length, 1)
  assert.equal(backup.preferences['theme'], 'dark')
  // Nothing credential-shaped travels: the file has exactly the three stores.
  assert.deepEqual(
    Object.keys(backup).sort(),
    ['agents', 'exportedAt', 'hostVersion', 'kind', 'preferences', 'transcripts', 'version'],
  )

  const b = await hostAt(dirB)
  t.after(() => b.host.dispose())
  const report = await b.host.call('backup/import', { backup })
  assert.deepEqual(report.agents, { restored: 1, skipped: 0 })
  assert.equal(report.preferences, 2)
  assert.deepEqual(report.transcripts, { restored: 1, skipped: 0 })

  // The proof, on the fresh host's own wire: the agent is a runtime, the
  // preference reads back, and the transcript answers a content search.
  const hello = await b.host.call('host/hello', { clientVersion: 'test' })
  assert.ok(hello.runtimes.some((entry) => entry.id === 'my-agent'))
  const state = await b.host.call('app/state/get', {})
  assert.equal(state['theme'], 'dark')
  const hits = await b.host.call('transcripts/search', { query: 'worth finding' })
  assert.equal(hits.length, 1)
  assert.equal(String(hits[0]?.summary.id), 's1')

  // Restoring the same file again is a no-op, counted as such.
  const again = await b.host.call('backup/import', { backup })
  assert.deepEqual(again.agents, { restored: 0, skipped: 1 })
  assert.deepEqual(again.transcripts, { restored: 0, skipped: 1 })
})

test('a restore never rolls a local transcript backwards', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-c-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())

  await mkdir(join(dir, 'transcripts', 'my-agent'), { recursive: true })
  await writeFile(join(dir, 'transcripts', 'my-agent', 's1.json'), transcriptFile(2000, 'the newer local copy'))

  const report = await host.call('backup/import', {
    backup: {
      kind: 'harnessdesk-backup',
      version: 1,
      exportedAt: 1,
      hostVersion: 'test',
      agents: [],
      preferences: {},
      transcripts: [{ runtime: 'my-agent', id: 's1', data: JSON.parse(transcriptFile(1000, 'the stale backup copy')) }],
    },
  })
  assert.deepEqual(report.transcripts, { restored: 0, skipped: 1 })
  const hits = await host.call('transcripts/search', { query: 'newer local copy' })
  assert.equal(hits.length, 1, 'the local transcript is untouched')
})

test('what is not a backup is refused whole', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-backup-d-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const { host } = await hostAt(dir)
  t.after(() => host.dispose())
  await assert.rejects(
    host.call('backup/import', { backup: { some: 'other json file' } }),
    /not a HarnessDesk backup/,
  )
})
