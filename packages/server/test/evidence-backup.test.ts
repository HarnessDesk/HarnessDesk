import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { BackupFile, BackupReport, EvidenceRecord, SeatRecord, Session } from '@harnessdesk/protocol'

import { EvidencePlane, RESTORE_LINE_LIMIT, RESTORE_PROJECT_LIMIT } from '../src/evidence/plane.js'
import type { SeatOpening } from '../src/evidence/records.js'
import { canonical } from '../src/evidence/revision.js'
import { CommandsSeen, incarnationOf, SEEN_FILE } from '../src/evidence/seen.js'
import { EvidenceMergeError, EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * General › Backup carries what the desk observed and every Seat it kept, and a
 * restore adds them the way it adds everything else — except that here, what
 * this desk wrote always wins. A restored record is history: marked as such,
 * never able to close or stand in for a Seat this desk kept, and never a fact
 * the desk observed. One bad record never stops the rest, and every record is
 * read by the same rule the store reads with. A backup never carries what a
 * person approved on this machine.
 */

const fact = (id: string, at: string, cwd: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id,
  fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, at, dirty: false, tail: '' },
  card: { board: 'room-1', id: 1 },
  checkout: { cwd, branch: 'main' },
  seat: null,
  round: null,
  observedAt: 1,
  posted: null,
  ...over,
})

/** A whole Seat opening, as a store holds it, kept under `project`. */
const opening = (id: string, project: string, over: Partial<SeatOpening> = {}): SeatOpening => ({
  id,
  agent: { id: 'scout', name: 'Scout', origin: 'user' },
  briefDigest: 'digest-1',
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: project, project, branch: 'main', head: 'a'.repeat(40) },
  session: { runtime: 'fake', sessionId: `session-${id}` },
  board: null,
  role: null,
  openedAt: 1,
  ...over,
})

/** A backup holding only evidence. */
const backupOf = (evidence: NonNullable<BackupFile['evidence']>): BackupFile => ({
  kind: 'harnessdesk-backup',
  version: 1,
  exportedAt: 1,
  hostVersion: '9.9.9',
  agents: [],
  preferences: {},
  transcripts: [],
  evidence,
})

const ids = (lines: readonly { type: string; record?: { id: string } }[]): string[] =>
  lines.flatMap((line) => (line.record ? [line.record.id] : []))

test('a backup carries every Seat and every fact, and a restore on another desk adds them once, as history', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-a-'), repo })
  await writeAgent(a.stateDir)
  const session = (await a.host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const seat = (await a.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  await new EvidenceStore(join(a.stateDir, 'evidence')).append(project, 'evidence', [
    { type: 'evidence', record: fact('fact-1', await repo.git('rev-parse', 'HEAD'), repo.dir) },
  ])

  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.deepEqual(
    backup.evidence?.map((one) => [one.project, one.seats.length, one.facts.length, one.unreadable]),
    [[project, 1, 1, 0]],
  )

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-b-'), repo })
  const report = (await b.host.call('backup/import', { backup })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 0, refused: 0, failed: 0 })
  const restored = (await b.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.ok(restored.restored && Number.isFinite(restored.restored.at), 'marked as brought by a backup')
  assert.deepEqual({ ...restored, restored: null }, { ...seat, restored: null }, 'and otherwise the record, whole')
  const facts = (await new EvidenceStore(join(b.stateDir, 'evidence')).read(project, 'evidence')).lines
  assert.deepEqual(ids(facts), ['fact-1'])
  assert.ok(facts[0]?.type === 'evidence' && facts[0].record.restored, 'a fact from a backup was not observed here')

  const again = (await b.host.call('backup/import', { backup })) as BackupReport
  assert.deepEqual(again.evidence, { restored: 0, duplicate: 2, refused: 0, failed: 0 }, 'twice is the same as once')
})

test('a Seat a backup brought never says which Agent a conversation on this desk is', async (t) => {
  const repo = await makeRepo()
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-dress-a-'), repo })
  await writeAgent(a.stateDir)
  const session = (await a.host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const backup = (await a.host.call('backup/export', {})) as BackupFile

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-dress-b-'), repo })
  await b.host.call('backup/import', { backup })
  // The record is there, as history…
  const record = (await b.host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.ok(record.restored)
  // …and the same conversation, opened here, is a plain one: this desk never seated it.
  const opened = (await b.host.call('session/resume', { runtime: session.runtime, sessionId: session.id })) as Session
  assert.equal(opened.settings?.agent, undefined)
  assert.equal(b.host.registry.get(session.runtime, session.id)?.seatedAs ?? null, null)
})

test('an export says how many lines it could not read, and so left out', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-unreadable-'), repo })
  const store = new EvidenceStore(join(a.stateDir, 'evidence'))
  await store.append(project, 'evidence', [{ type: 'evidence', record: fact('fact-1', await repo.git('rev-parse', 'HEAD'), repo.dir) }])
  await appendFile(join(store.folderOf(project), 'evidence.ndjson'), '{"v":2,"type":"evidence","record":{"id":"from-later"}}\n')
  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.deepEqual(backup.evidence?.map((one) => [one.facts.length, one.unreadable]), [[1, 1]])
})

test('one bad record never stops the rest: what cannot be read here, or claims another project, is refused and counted', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-evidence-'), repo })
  const good = { v: 1, type: 'evidence', record: fact('good', at, repo.dir) }
  const report = (await host.call('backup/import', {
    backup: backupOf([
      {
        project,
        seats: [
          // Whole, and readable — but kept under another project than the one it is restored into.
          { v: 1, type: 'seat', record: opening('elsewhere', '/somewhere/else') },
          { v: 1, type: 'seat', record: opening('here', project) },
        ],
        facts: [
          good,
          { v: 1, type: 'evidence', record: { ...fact('bad', at, repo.dir), fact: { kind: 'check', at: 'HEAD' } } },
          'not a line',
          // A Seat filed with the facts: the store would never read it there, so a restore never writes it there.
          { v: 1, type: 'seat', record: opening('misfiled', project) },
        ],
      },
      { project: 'relative/path', seats: [], facts: [good] },
    ]),
  })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 0, refused: 5, failed: 0 })
  const store = new EvidenceStore(join(stateDir, 'evidence'))
  assert.deepEqual(ids((await store.read(project, 'evidence')).lines), ['good'])
  assert.deepEqual(ids((await store.read(project, 'seats')).lines), ['here'])
})

test('a backup can never close, replace or outrank a Seat this desk kept', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-trust-'), repo })
  await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session
  const kept = (await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  const { closed: _closed, ...keptOpening } = kept

  const report = (await host.call('backup/import', {
    backup: backupOf([
      {
        project,
        seats: [
          // A closing for the Seat this desk kept, carried beside a copy of its opening.
          { v: 1, type: 'seat', record: keptOpening },
          { v: 1, type: 'seat-closed', closing: { seat: kept.id, at: 5, why: 'deleted' } },
          // A second Seat for the same conversation, said to be opened later, as another Agent.
          {
            v: 1,
            type: 'seat',
            record: opening('forged', project, {
              agent: { id: 'mallory', name: 'Mallory', origin: 'user' },
              session: kept.session,
              openedAt: kept.openedAt + 1_000,
            }),
          },
          // A Seat for a conversation this desk never kept, closed beside its own opening: history, admitted.
          { v: 1, type: 'seat', record: opening('theirs', project) },
          { v: 1, type: 'seat-closed', closing: { seat: 'theirs', at: 9, why: 'deleted' } },
        ],
        facts: [],
      },
    ]),
  })) as BackupReport
  assert.deepEqual(report.evidence, { restored: 2, duplicate: 1, refused: 2, failed: 0 })
  assert.deepEqual(
    await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) }),
    kept,
    'still open, and still the Agent this desk seated',
  )
  assert.equal(host.registry.get(session.runtime, session.id)?.seatedAs?.agent, 'scout')
  const theirs = (await host.call('evidence/seat', { runtime: 'fake', sessionId: 'session-theirs' })) as SeatRecord
  assert.deepEqual([theirs.closed, Boolean(theirs.restored)], [{ at: 9, why: 'deleted' }, true])
})

test('two restores at once add each record once', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-race-'), repo })
  const facts = Array.from({ length: 20 }, (_, n) => ({ v: 1, type: 'evidence', record: fact(`fact-${n}`, at, repo.dir) }))
  const backup = backupOf([{ project, seats: [{ v: 1, type: 'seat', record: opening('one', project) }], facts }])
  const [first, second] = (await Promise.all([
    host.call('backup/import', { backup }),
    host.call('backup/import', { backup }),
  ])) as BackupReport[]
  assert.equal(first!.evidence.restored + second!.evidence.restored, 21)
  assert.equal(first!.evidence.duplicate + second!.evidence.duplicate, 21)
  const store = new EvidenceStore(join(stateDir, 'evidence'))
  assert.equal((await store.read(project, 'evidence')).lines.length, 20)
  assert.equal((await store.read(project, 'seats')).lines.length, 1)
})

test('a partial merge reports its durable prefix as restored and only the unwritten suffix as failed', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const stateDir = tempDir('hd-backup-partial-')
  const plane = new EvidencePlane(
    { dir: join(stateDir, 'evidence'), seenFile: join(stateDir, SEEN_FILE), now: () => 10 },
    { board: () => null, cwdOf: () => null, push: () => {}, log: () => {} },
  )
  const first = { v: 1, type: 'evidence', record: fact('first', at, repo.dir) }
  const second = { v: 1, type: 'evidence', record: fact('second', at, repo.dir) }
  const backup = [{ project, seats: [], facts: [first, second] }]

  const merge = plane.store.merge.bind(plane.store)
  let injected = false
  plane.store.merge = async (into, file, lines, admit) => {
    if (!injected && file === 'evidence') {
      injected = true
      await plane.store.append(into, file, [lines[0]!])
      throw new EvidenceMergeError(new Error('injected write failure'), {
        added: 1,
        duplicate: 0,
        refused: 0,
        failed: lines.length - 1,
      })
    }
    return merge(into, file, lines, admit)
  }

  assert.deepEqual(await plane.restore(backup), { restored: 1, duplicate: 0, refused: 0, failed: 1 })
  assert.deepEqual(await plane.restore(backup), { restored: 1, duplicate: 1, refused: 0, failed: 0 })
  assert.deepEqual(ids((await plane.store.read(project, 'evidence')).lines), ['first', 'second'])
})

test('a restore reads no more than its limits: projects past the first ones, and lines past the budget, are refused', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const { host, stateDir } = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-limits-'), repo })
  const good = (id: string) => ({ v: 1, type: 'evidence', record: fact(id, at, repo.dir) })
  // Projects: every one past the limit is refused, whatever it holds, and no folder is made for it.
  const crowd = Array.from({ length: RESTORE_PROJECT_LIMIT }, (_, n) => ({ project: `/nowhere/${n}`, seats: [], facts: [] }))
  const past = (await host.call('backup/import', {
    backup: backupOf([...crowd, { project, seats: [], facts: [good('late')] }]),
  })) as BackupReport
  assert.deepEqual(past.evidence, { restored: 0, duplicate: 0, refused: 1, failed: 0 })
  assert.deepEqual(await new EvidenceStore(join(stateDir, 'evidence')).projects(), [])

  // Lines: each counts against the budget whether or not it can be read.
  const junk = Array.from({ length: RESTORE_LINE_LIMIT }, () => 'x')
  const over = (await host.call('backup/import', {
    backup: backupOf([{ project, seats: [], facts: [...junk, good('last')] }]),
  })) as BackupReport
  assert.deepEqual(over.evidence, { restored: 0, duplicate: 0, refused: RESTORE_LINE_LIMIT + 1, failed: 0 })
})

test('what a person approved on this machine never travels in a backup, and a backup cannot say it was approved', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const scope = { project, incarnation: await incarnationOf(project), digest: 'b'.repeat(40) }
  const a = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-seen-a-'), repo })
  await new CommandsSeen(join(a.stateDir, SEEN_FILE)).approve(scope, { name: 'verify', run: 'pnpm verify' })
  const backup = (await a.host.call('backup/export', {})) as BackupFile
  assert.equal(JSON.stringify(backup).includes('pnpm verify'), false, 'the command a person approved is not in it')

  const b = await evidenceDesk(t, {}, { stateDir: tempDir('hd-backup-seen-b-'), repo })
  const forged = { ...backup, preferences: { ...backup.preferences, commandsSeen: [{ project, name: 'verify', run: 'pnpm verify', at: 1 }] } }
  await b.host.call('backup/import', { backup: forged })
  assert.equal(await new CommandsSeen(join(b.stateDir, SEEN_FILE)).approved(scope, { name: 'verify', run: 'pnpm verify' }), false)
})
