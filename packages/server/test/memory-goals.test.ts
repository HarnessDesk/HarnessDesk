import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import type { BoardEvidence, GoalCitation, SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalMemorySupport, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { MemoryPlane } from '../src/memory/plane.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)
const git = (root: string, args: string[]) => exec('git', args, { cwd: root })

/**
 * `GoalPlane.cite`/`dependenciesReady` integrated with a real `MemoryPlane`:
 * retention outliving its source Goal and its Git history, the citation-only
 * escape from a missing dependency, and the boundary a restored registration
 * can never cross into authorizing new work.
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

const wrappedDoc = (id: string, root: string, receiptId: string, dependsOn: readonly string[] = []) => ({
  version: 1 as const,
  goal: goal(id, { root, cwd: root, sentence: `Wrapped ${id}`, state: 'wrapped' as const, receipt: receiptId, dependsOn }),
  board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [],
  receipt: {
    version: 1 as const, id: receiptId, goal: id, sentence: `Wrapped ${id}`, wrappedAt: 1,
    summary: 'Reviewed.', cards: [], seats: [] as readonly string[], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  },
  operation: null,
})

const openDoc = (id: string, root: string, dependsOn: readonly string[] = []) => ({
  version: 1 as const,
  goal: goal(id, { root, cwd: root, dependsOn }),
  board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [],
  receipt: null,
  operation: null,
})

const forbidden = async (): Promise<never> => { throw new Error('This test must not seat or close a conversation') }

const rig = async (root: string, delayCapture?: (citation: GoalCitation) => Promise<void>) => {
  const home = tempDir('hd-memory-goals-home-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  const seats: SeatRecord[] = []
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: root, busy: false }),
    claimable: () => true,
    opening: forbidden,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async (): Promise<BoardEvidence> => ({ room: '', stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [],
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    settledFor: async () => {},
    answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: null, dirty: null }),
    changed: () => {},
    activity: () => {},
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    retainLane: forbidden,
    finish: forbidden,
    finishWrap: forbidden,
    wake: () => {},
  }
  const archiveFolder = tempDir('hd-memory-goals-archive-')
  const memoryPlane = new MemoryPlane(archiveFolder, {
    receiptOf: (id) => { try { return store.read(id).receipt } catch { return null } },
    seats: { byId: (id) => seats.find((one) => one.id === id) ?? null },
  })
  const memory: GoalMemorySupport = {
    capture: async (citation) => {
      if (delayCapture) await delayCapture(citation)
      return memoryPlane.capture(citation)
    },
    resolve: (citation) => memoryPlane.resolve(citation),
    register: (index, restored) => memoryPlane.register(index, restored),
    isKnownRestored: (citation) => memoryPlane.isKnownRestored(citation),
    readRaw: (key) => memoryPlane.readRaw(key),
    writeSnapshot: (snapshot) => memoryPlane.writeSnapshot(snapshot),
    isRegistered: (citation, archive) => memoryPlane.isRegistered(citation, archive),
  }
  return { store, seats, port, memoryPlane, archiveFolder, plane: new GoalPlane(store, port, undefined, Date.now, memory) }
}

test('deleted Goal and pruned commit still resolve', async () => {
  const root = await repo('hd-memory-goals-pruned-')
  const at = await commitMemoryFile(root, 'note.md', 'the finding\n')
  const seatA: SeatRecord = seat('seat-a')
  const receipt = {
    version: 1 as const, id: 'receipt-source', goal: 'source', sentence: 'Wrapped source', wrappedAt: 1,
    summary: 'Reviewed.', cards: [], seats: ['seat-a'], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  }
  let sourceDeleted = false
  const memoryPlane = new MemoryPlane(tempDir('hd-memory-goals-pruned-archive-'), {
    receiptOf: (id) => (id === 'source' && !sourceDeleted ? receipt : null),
    seats: { byId: (id) => (id === 'seat-a' ? seatA : null) },
  })
  const citation: GoalCitation = { goal: 'source', receipt: 'receipt-source', project: root, path: '.harnessdesk/memory/note.md', at }
  const archive = await memoryPlane.capture(citation)
  memoryPlane.register({ citations: [{ citation, archive }], satisfiedCitationSources: [{ goal: 'source', receipt: 'receipt-source' }] })

  const before = await memoryPlane.resolve(citation)
  assert.equal(before.state, 'retained')
  if (before.state === 'retained') {
    assert.equal(before.sourceAvailable, true)
    assert.equal(before.revisionAvailable, true)
  }

  // The source Goal is gone (no delete API exists on `GoalStore` at all — a
  // Goal that is simply never findable again *is* what "deleted" looks like
  // from a port's own point of view), and its commit is pruned from the
  // repository entirely.
  sourceDeleted = true
  await rm(join(root, '.git'), { recursive: true, force: true })

  const after = await memoryPlane.resolve(citation)
  assert.equal(after.state, 'retained')
  if (after.state !== 'retained') return
  assert.equal(after.snapshot.text, 'the finding\n', 'the exact retained bytes are unaffected by either loss')
  assert.equal(after.sourceAvailable, false, 'the source Goal is gone')
  assert.equal(after.revisionAvailable, false, 'the commit is gone')
  assert.deepEqual(after.snapshot.seats.map((one) => one.id), ['seat-a'], 'selected Seat history is retained exactly as captured')
  assert.equal(after.restored, false, 'a citation genuinely captured live is never mislabeled restored just because its source later vanished')
})

test('wrap and cite serialize: a wrap that lands while capture is in flight refuses the citation, receipt unchanged', async () => {
  const root = await repo('hd-memory-goals-serialize-')
  const at = await commitMemoryFile(root, 'note.md', 'reviewed\n')

  let entered!: () => void
  let release!: () => void
  const entered_ = new Promise<void>((resolve) => { entered = resolve })
  const paused = new Promise<void>((resolve) => { release = resolve })
  const { store, plane } = await rig(root, async () => { entered(); await paused })

  await store.save(wrappedDoc('source', root, 'receipt-source'), null)
  await store.save(openDoc('target', root), null)
  const citation: GoalCitation = { goal: 'source', receipt: 'receipt-source', project: root, path: '.harnessdesk/memory/note.md', at }

  const pending = plane.cite('target', citation)
  await entered_
  // While retention for this citation is still in flight, the target Goal is
  // wrapped by some other agency entirely — direct store access, exactly the
  // shape a concurrent second desk process or a recovered operation would
  // take, never going through this `GoalPlane`'s own serial queue at all.
  const closedReceipt = wrappedDoc('target', root, 'receipt-target').receipt
  const closed = { ...store.read('target'), receipt: closedReceipt, goal: { ...store.read('target').goal, state: 'wrapped' as const, receipt: 'receipt-target', revision: 1 } }
  await store.save(closed, 0)
  release()

  await assert.rejects(pending, /read-only|finishing/)
  assert.deepEqual(store.read('target').receipt, closedReceipt, 'the receipt the direct wrap produced is exactly what reading it back still shows')
  assert.deepEqual(store.read('target').citations, [], 'the refused citation was never added')
  // The capture that got as far as retention before the refusal is an
  // acceptable orphan — nothing here asserts it is gone, only that it never
  // reached the Goal.
})

test('missing regular dependency stays unfinished: only the citation-created edge can use archive satisfaction', async () => {
  const root = await repo('hd-memory-goals-missing-dep-')
  const at = await commitMemoryFile(root, 'note.md', 'reviewed\n')
  const { store, plane } = await rig(root)

  await store.save(wrappedDoc('cited-source', root, 'receipt-cited'), null)
  await store.save(openDoc('target', root), null)
  const citation: GoalCitation = { goal: 'cited-source', receipt: 'receipt-cited', project: root, path: '.harnessdesk/memory/note.md', at }
  await plane.cite('target', citation)
  assert.deepEqual(store.read('target').goal.dependsOn, ['cited-source'])

  // An explicit dependency naming a Goal no longer in the store at all —
  // `checkedDependencies` refuses this through every ordinary API
  // (`update`, `cite`) that touches `dependsOn`, so the only way this shape
  // exists on disk is a Goal deletion this codebase does not implement yet,
  // or a document written directly. Either way, `dependenciesReady` must
  // treat it exactly the same: still blocked.
  const withGhost = store.read('target')
  await store.save(
    { ...withGhost, goal: { ...withGhost.goal, dependsOn: ['cited-source', 'explicit-ghost'], revision: withGhost.goal.revision + 1 } },
    withGhost.goal.revision,
  )
  assert.equal(plane.dependenciesReady('target'), false, 'an explicit dependency on a Goal that was never cited or wrapped must stay blocked')

  // With only the citation-created edge left, retained history alone unblocks it.
  await store.save({ ...store.read('target'), goal: { ...store.read('target').goal, dependsOn: ['cited-source'], revision: store.read('target').goal.revision + 1 } }, store.read('target').goal.revision)
  assert.equal(plane.dependenciesReady('target'), true, 'the one edge a citation itself created may be satisfied by its retained, non-restored archive')
})

test('restored source cannot authorize work', async () => {
  const root = await repo('hd-memory-goals-restored-')
  const at = await commitMemoryFile(root, 'note.md', 'reviewed\n')
  const { store, plane, memoryPlane, archiveFolder } = await rig(root)

  // The source Goal is not in this store at all — deleted, or never restored
  // alongside it — so the *ordinary* "is it still wrapped" check has nothing
  // to find either; only the citation-created edge is in play here.
  const citation: GoalCitation = { goal: 'restored-source', receipt: 'receipt-restored', project: root, path: '.harnessdesk/memory/note.md', at }
  const elsewhereReceipt = {
    version: 1 as const, id: 'receipt-restored', goal: 'restored-source', sentence: 'Wrapped restored-source', wrappedAt: 1,
    summary: 'Reviewed.', cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  }
  // "Import signed-looking data": bytes retained genuinely (so the archive's
  // own hash-integrity check passes) — captured through a second `MemoryPlane`
  // that points at this desk's *same* archive folder but has its own port,
  // standing in for wherever this snapshot was actually produced, since this
  // desk's own store never held `restored-source` to read a receipt from.
  // Registered on *this* desk only as a restored document would be —
  // never through a live `cite` here.
  const elsewhere = new MemoryPlane(archiveFolder, { receiptOf: (id) => (id === 'restored-source' ? elsewhereReceipt : null), seats: { byId: () => null } })
  const archive = await elsewhere.capture(citation)
  const index = { citations: [{ citation, archive }], satisfiedCitationSources: [{ goal: 'restored-source', receipt: 'receipt-restored' }] }
  memoryPlane.register(index, true)

  const resolution = await memoryPlane.resolve(citation)
  assert.equal(resolution.state, 'retained')
  if (resolution.state === 'retained') assert.equal(resolution.restored, true, 'resolution says restored')

  await store.save({ ...openDoc('target', root, ['restored-source']), memory: index }, null)
  assert.equal(plane.dependenciesReady('target'), false, 'a restored registration can never authorize dispatch, however complete its bytes are')
})

test('plain conversation does not enumerate memory', async (t) => {
  const root = await repo('hd-memory-goals-plain-')
  const { store, plane } = await rig(root)
  await store.save(openDoc('plain', root), null)

  const cp = createRequire(import.meta.url)('node:child_process') as { execFile: typeof execFile }
  const realExecFile = cp.execFile
  let touched = false
  // @ts-expect-error -- test double
  cp.execFile = (...args: unknown[]) => {
    touched = true
    throw new Error('must not shell out to git for an ordinary read')
  }
  syncBuiltinESMExports()
  t.after(() => {
    cp.execFile = realExecFile
    syncBuiltinESMExports()
  })

  await plane.view('plain')
  await plane.refresh('plain')
  assert.equal(plane.dependenciesReady('plain'), true)
  assert.equal(touched, false, 'an ordinary conversation with no citations never shells out to git for memory')
})
