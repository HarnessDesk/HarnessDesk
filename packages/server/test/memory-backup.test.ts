import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import type { GoalCitation, GoalReceipt, MemoryBackup, SeatAttachmentsRecord, SeatRecord } from '@harnessdesk/protocol'

import { AttachmentsPlane, type AttachmentsPlanePort } from '../src/attachments/plane.js'
import { exportMemory, importMemory, type MemoryBackupPort } from '../src/memory/backup.js'
import { MemoryPlane } from '../src/memory/plane.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)
const git = (root: string, args: string[]) => exec('git', args, { cwd: root })

/**
 * `exportMemory`/`importMemory` against real `MemoryPlane` and
 * `AttachmentsPlane` instances — the two subsystems Task 6's own sidecar
 * spans — never against a live `Host`. Neither test rig ever offers a
 * transport, a trust store or a gateway: the port surface above proves that
 * nothing here can reach any of those, and the assertions below prove
 * nothing needed to.
 */

const repo = async (prefix: string): Promise<string> => {
  const root = tempDir(prefix)
  await git(root, ['init', '-q'])
  await mkdir(join(root, '.harnessdesk', 'memory'), { recursive: true })
  return root
}

const commitMemoryFile = async (root: string, name: string, text: string): Promise<string> => {
  await writeFile(join(root, '.harnessdesk', 'memory', name), text)
  await git(root, ['add', '.'])
  await git(root, ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', name])
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
}

const receipt = (goal: string, id: string, seats: readonly string[] = []): GoalReceipt => ({
  version: 1, id, goal, sentence: `Wrapped ${goal}`, wrappedAt: 1, summary: 'Reviewed.',
  cards: [], seats, evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
})

const seatRecord = (id: string): SeatRecord =>
  ({
    id, agent: null, role: null, board: null, seatLabel: 'Agent', passedOver: [],
    standing: { kind: 'ceiling', level: 'edit' }, ceiling: null,
    checkout: { project: '/work', cwd: '/work', branch: 'main', head: null },
    session: { runtime: 'one', sessionId: 'sid' }, openedAt: 1, closed: null, restored: null,
  }) as unknown as SeatRecord

const attachmentsPlane = (folder: string): AttachmentsPlane => {
  const forbidden = (): never => { throw new Error('this fixture must never reach trust, resolution or the gateway') }
  const port: AttachmentsPlanePort = {
    resolve: forbidden,
    permits: forbidden,
    support: forbidden,
    suppressUnapproved: forbidden,
  }
  return new AttachmentsPlane(folder, port)
}

/** One valid, minimal Seat attachment epoch — `attachmentRecordOf`'s own shape, no more. */
const attachmentEpoch = (seat: string, epoch: number): SeatAttachmentsRecord => ({
  version: 1, seat: seat as SeatAttachmentsRecord['seat'], agentDigest: 'a'.repeat(64), runtime: 'one', build: '1.0.0',
  epoch, observedAt: 1, skillsMode: 'allowlist', mcpMode: 'runtime-defaults',
  declarations: [{ kind: 'skill', name: 'review', identity: null, problem: 'Review this content before loading it.' }],
  results: [], restored: false,
})

const portOf = (
  memory: MemoryPlane,
  attachments: AttachmentsPlane,
  documents: { goal: string; memory: import('@harnessdesk/protocol').GoalMemoryIndex }[],
  goalIds: ReadonlySet<string>,
): MemoryBackupPort => ({
  documents: () => documents,
  readObject: (key) => memory.readRaw(key),
  writeObject: (snapshot) => memory.writeSnapshot(snapshot),
  registerRestoredMemory: (goal, index) => {
    if (!goalIds.has(goal)) return false
    memory.register(index, true)
    return true
  },
  isRegistered: (citation, archive) => memory.isRegistered(citation, archive),
  attachmentHistory: () => attachments.attachmentHistory(),
  appendAttachment: (record) => attachments.appendRestored(record),
})

test('history round trip starts nothing: exact bytes retained, restored markers set, zero transport/trust calls', async () => {
  const root = await repo('hd-memory-backup-repo-')
  const at = await commitMemoryFile(root, 'decisions.md', 'We chose the flat file.\n')
  const citation: GoalCitation = { goal: 'source', receipt: 'r1', project: root, path: '.harnessdesk/memory/decisions.md', at }
  const seat = seatRecord('seat-1')

  const fromMemory = new MemoryPlane(tempDir('hd-memory-backup-from-archive-'), {
    receiptOf: (id) => (id === 'source' ? receipt('source', 'r1', [seat.id]) : null),
    seats: { byId: (id) => (id === seat.id ? seat : null) },
  })
  const archive = await fromMemory.capture(citation)
  const index = { citations: [{ citation, archive }], satisfiedCitationSources: [{ goal: 'source', receipt: 'r1' }] }
  fromMemory.register(index)

  const fromAttachments = attachmentsPlane(tempDir('hd-memory-backup-from-attachments-'))
  await fromAttachments.appendRestored(attachmentEpoch('seat-1', 0))
  await fromAttachments.appendRestored(attachmentEpoch('seat-1', 1))

  const backup = await exportMemory(portOf(fromMemory, fromAttachments, [{ goal: 'target', memory: index }], new Set(['target'])))
  assert.deepEqual(backup.objects.map((one) => one.key), [archive])
  assert.equal(backup.objects[0]?.snapshot.text, 'We chose the flat file.\n')
  assert.equal(backup.attachments.length, 2)
  assert.equal(backup.indexes.length, 1)

  const toMemory = new MemoryPlane(tempDir('hd-memory-backup-to-archive-'), {
    receiptOf: () => null, // the source Goal genuinely does not exist on this desk — retention must not need it
    seats: { byId: () => null },
  })
  const toAttachments = attachmentsPlane(tempDir('hd-memory-backup-to-attachments-'))
  const report = await importMemory(
    portOf(toMemory, toAttachments, [], new Set(['target'])),
    backup,
  )
  assert.deepEqual(report, { restored: 4, alreadyHere: 0, refused: 0, failed: 0 }) // 1 object + 1 index + 2 attachment epochs

  const resolved = await toMemory.resolve(citation)
  assert.equal(resolved.state, 'retained')
  assert.equal(resolved.state === 'retained' && resolved.snapshot.text, 'We chose the flat file.\n')
  assert.equal(resolved.state === 'retained' && resolved.restored, true)
  assert.equal(resolved.state === 'retained' && resolved.sourceAvailable, false) // this desk never had "source" as a Goal at all

  const history = await toAttachments.attachmentHistory()
  assert.deepEqual(history.map((one) => [one.epoch, one.restored]), [[0, true], [1, true]])

  // A second import of the same backup is pure duplication, never a second write.
  const again = await importMemory(portOf(toMemory, toAttachments, [], new Set(['target'])), backup)
  assert.deepEqual(again, { restored: 0, alreadyHere: 4, refused: 0, failed: 0 })
})

test('one damaged object does not abort valid history: bad digest, excess size and orphan index followed by valid entry', async () => {
  const root = await repo('hd-memory-backup-mixed-repo-')
  const at = await commitMemoryFile(root, 'good.md', 'kept\n')
  const citation: GoalCitation = { goal: 'source', receipt: 'r1', project: root, path: '.harnessdesk/memory/good.md', at }
  const goodMemory = new MemoryPlane(tempDir('hd-memory-backup-mixed-source-'), {
    receiptOf: (id) => (id === 'source' ? receipt('source', 'r1') : null),
    seats: { byId: () => null },
  })
  const goodKey = await goodMemory.capture(citation)
  const goodSnapshot = (await goodMemory.readRaw(goodKey))!

  const oversized = { ...JSON.parse(goodSnapshot), text: 'x'.repeat(10 * 1024 * 1024) }

  const raw: unknown = {
    version: 1,
    objects: [
      { key: 'f'.repeat(64), snapshot: JSON.parse(goodSnapshot) }, // bad digest: does not hash to this key
      { key: 'e'.repeat(64), snapshot: oversized }, // excess size, whatever its declared key
      { key: goodKey, snapshot: JSON.parse(goodSnapshot) }, // valid
    ],
    indexes: [
      // orphan: names an archive key nothing in this backup (or locally) ever writes
      { goal: 'orphaned-goal', memory: { citations: [{ citation: { ...citation, goal: 'ghost' }, archive: 'a'.repeat(64) }], satisfiedCitationSources: [] } },
      { goal: 'target', memory: { citations: [{ citation, archive: goodKey }], satisfiedCitationSources: [{ goal: 'source', receipt: 'r1' }] } },
    ],
    attachments: [],
  }

  const toMemory = new MemoryPlane(tempDir('hd-memory-backup-mixed-dest-'), {
    receiptOf: () => null,
    seats: { byId: () => null },
  })
  const toAttachments = attachmentsPlane(tempDir('hd-memory-backup-mixed-dest-attachments-'))
  const report = await importMemory(portOf(toMemory, toAttachments, [], new Set(['target', 'orphaned-goal'])), raw as MemoryBackup)

  // objects: 1 restored (good), 2 refused (bad digest, oversized)
  // indexes: orphan's own citation is refused, leaving it with nothing to register (no restore/refuse charged for the index itself);
  //          target's index registers successfully.
  assert.equal(report.restored, 2) // the good object + the target index
  assert.equal(report.refused, 3) // bad digest + oversized object + the orphan citation link
  assert.equal(report.failed, 0)

  const resolved = await toMemory.resolve(citation)
  assert.equal(resolved.state, 'retained')
  assert.equal(resolved.state === 'retained' && resolved.snapshot.text, 'kept\n')
})

test('an unimportable payload is refused as one entry, never partially applied', async () => {
  const memory = new MemoryPlane(tempDir('hd-memory-backup-invalid-'), { receiptOf: () => null, seats: { byId: () => null } })
  const attachments = attachmentsPlane(tempDir('hd-memory-backup-invalid-attachments-'))
  const port = portOf(memory, attachments, [], new Set())
  assert.deepEqual(await importMemory(port, undefined), { restored: 0, alreadyHere: 0, refused: 0, failed: 0 })
  assert.deepEqual(await importMemory(port, { version: 2, objects: [], indexes: [], attachments: [] }), { restored: 0, alreadyHere: 0, refused: 1, failed: 0 })
  assert.deepEqual(await importMemory(port, { version: 1, objects: 'nope', indexes: [], attachments: [] }), { restored: 0, alreadyHere: 0, refused: 1, failed: 0 })
})

test('a hostile index cannot knock out a live citation: a link whose archive does not carry its citation is refused, and a restored registration never conflicts with a live one', async () => {
  const root = await repo('hd-memory-backup-hostile-')
  const at = await commitMemoryFile(root, 'decisions.md', 'We chose the flat file.\n')
  const other = await commitMemoryFile(root, 'other.md', 'Something else.\n')
  const live: GoalCitation = { goal: 'source', receipt: 'r1', project: root, path: '.harnessdesk/memory/decisions.md', at }
  const decoy: GoalCitation = { goal: 'source', receipt: 'r1', project: root, path: '.harnessdesk/memory/other.md', at: other }
  const plane = new MemoryPlane(tempDir('hd-memory-backup-hostile-archive-'), {
    receiptOf: (id) => (id === 'source' ? receipt('source', 'r1') : null),
    seats: { byId: () => null },
  })
  const liveKey = await plane.capture(live)
  plane.register({ citations: [{ citation: live, archive: liveKey }], satisfiedCitationSources: [{ goal: 'source', receipt: 'r1' }] })
  const decoyKey = await plane.capture(decoy) // a real, valid object — for a different citation
  const decoySnapshot = JSON.parse((await plane.readRaw(decoyKey))!)

  const backup: MemoryBackup = {
    version: 1,
    objects: [{ key: decoyKey, snapshot: decoySnapshot }],
    // The index claims the *live* citation lives in the decoy's archive.
    indexes: [{ goal: 'target', memory: { citations: [{ citation: live, archive: decoyKey }], satisfiedCitationSources: [] } }],
    attachments: [],
  }
  const report = await importMemory(portOf(plane, attachmentsPlane(tempDir('hd-memory-backup-hostile-att-')), [], new Set(['target'])), backup)
  assert.equal(report.refused, 1, 'the link whose archive does not carry its citation is refused')
  assert.equal(plane.isKnownRestored(live), false, 'the live citation is still live')
  const resolved = await plane.resolve(live)
  assert.equal(resolved.state, 'retained', 'and still resolves to its own retained bytes')
  if (resolved.state === 'retained') assert.equal(resolved.snapshot.text, 'We chose the flat file.\n')

  // And at the plane itself: a restored registration of a live tuple under
  // another archive is ignored — it neither replaces nor poisons it.
  plane.register({ citations: [{ citation: live, archive: '2'.repeat(64) }], satisfiedCitationSources: [] }, true)
  assert.equal(plane.isKnownRestored(live), false)
  assert.equal((await plane.resolve(live)).state, 'retained')
})
