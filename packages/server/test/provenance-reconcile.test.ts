import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { admitProject, gitReader, type ReflogMove } from '../src/provenance/git.js'
import type { Source } from '../src/provenance/model.js'
import {
  captureRange, factSource, rangeCandidates, rangeSource, reconcileProject, relatedEvidence,
  type CommitObservation, type LinkObservation,
} from '../src/provenance/reconcile.js'
import { makeRepo, type Repo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal
const seat = (repo: Repo, id: string): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fixture' },
  seatLabel: `Recorded ${id}`,
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: repo.dir, project: repo.dir, branch: 'topic', head: null },
  session: { runtime: 'fixture', sessionId: `original-session-${id}` },
  board: null,
  role: null,
  openedAt: 1,
  closed: null,
})
const diff = (repo: Repo, from: string, to: string, id = 'fact-a', owner = 'seat-a'): EvidenceRecord => ({
  id,
  seat: owner,
  checkout: { cwd: repo.dir, branch: 'topic' },
  observedAt: 10,
  card: { board: 'board', id: 1 },
  fact: { kind: 'diff', files: 1, added: 1, removed: 0, from, to },
})
const move = (before: string, after: string): ReflogMove => ({
  id: `move-${before}-${after}`,
  ref: 'refs/heads/topic',
  checkout: null,
  before,
  after,
  recordedAt: null,
})
const setup = async (t: TestContext) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'base\nseat a\n' }, 'first')
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const git = gitReader(handle)
  t.after(() => git.close())
  let time = 20
  const observe = async (sha: string): Promise<CommitObservation> => {
    const object = await git.commit(sha, signal())
    assert.ok(object)
    const from = object.parents[0] ?? null
    return {
      id: `commit-${sha}`, sha, tree: object.tree, parents: object.parents,
      firstSeenAt: time++, fingerprintVersion: 1,
      discoveredBy: [], checkoutHints: [repo.dir], window: { from: null, to: 30 },
      patch: await git.patch(from, sha, signal()),
      files: await git.files(from, sha, signal()), why: null,
    }
  }
  const a = await observe(first)
  const seats = [seat(repo, 'seat-a'), seat(repo, 'seat-b')]
  const records = [diff(repo, base, first)]
  const source = factSource(repo.dir, repo.dir, base, first, a.patch!, seats, records)
  assert.ok(source)
  const reconcile = (commits: readonly CommitObservation[], sources: readonly Source[],
    moves: readonly ReflogMove[] = [], priorLinks: readonly LinkObservation[] = []) =>
    reconcileProject({ commits, sources, moves, priorLinks, now: 50 }, git, signal())
  return { repo, git, base, first, a, observe, source, seats, records, reconcile }
}

test('message amend and rebase retain the original Seat and evidence without refreshing checks', async (t) => {
  const f = await setup(t)
  const amended = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'message only')
  const b = await f.observe(amended)
  const upstream = await f.repo.commitTree(f.base, { upstream: 'unrelated\n' }, 'upstream')
  const rebased = await f.repo.commitTree(upstream, { one: 'base\nseat a\n' }, 'rebased')
  const c = await f.observe(rebased)
  const check: EvidenceRecord = {
    id: 'old-check', observedAt: 11, seat: 'seat-a',
    fact: { kind: 'ci', at: f.first, checks: [] },
  }
  const evidence = [...f.records, check]
  const before = JSON.stringify(evidence)
  const links = await f.reconcile([f.a, b, c], [f.source], [move(f.first, amended), move(amended, rebased)])
  assert.deepEqual(links.map((link) => link.seats), [['seat-a'], ['seat-a'], ['seat-a']])
  assert.equal(links[0]?.via, 'observed')
  assert.equal(links[1]?.via, 'patch')
  assert.equal(links[2]?.coverage, 'complete')
  assert.ok(links[2]?.sourceIds.includes(f.a.id))
  const detail = relatedEvidence(links[2]!, f.seats, evidence)
  assert.deepEqual(detail.seats[0]?.session, { runtime: 'fixture', sessionId: 'original-session-seat-a' })
  assert.deepEqual(detail.evidenceIds, ['fact-a'])
  assert.deepEqual(detail.cards, [{ board: 'board', id: 1 }])
  assert.equal(JSON.stringify(evidence), before)
})

test('a content amend retains only exact files and a later local fact completes it', async (t) => {
  const f = await setup(t)
  const sha = await f.repo.commitTree(f.base, { one: 'base\nseat a\n', two: 'unknown\n' }, 'content amend')
  const amended = await f.observe(sha)
  const movements = [move(f.first, sha)]
  const initial = await f.reconcile([f.a, amended], [f.source], movements)
  const partial = initial.find((link) => link.sha === sha)!
  assert.equal(partial.coverage, 'partial', 'the unresolved file must keep coverage partial')
  assert.equal(partial.reason, 'changed-patch')
  assert.deepEqual(partial.retainedPaths, ['one'])
  assert.deepEqual(partial.seats, ['seat-a'])
  const record = diff(f.repo, f.base, sha, 'fact-amend')
  const source = factSource(f.repo.dir, f.repo.dir, f.base, sha, amended.patch!, f.seats, [record])!
  const final = await f.reconcile([f.a, amended], [f.source, source], movements, initial)
  const complete = final.find((link) => link.sha === sha)!
  assert.equal(complete.coverage, 'complete')
  assert.notEqual(complete.id, partial.id)
  assert.equal(partial.coverage, 'partial')
})

test('same file with changed whitespace and an unrelated equal patch do not become rewrites', async (t) => {
  const f = await setup(t)
  const whitespace = await f.repo.commitTree(f.base, { one: 'base\nseat  a\n' }, 'whitespace')
  const changed = await f.observe(whitespace)
  const independent = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'independent branch')
  const same = await f.observe(independent)
  const result = await f.reconcile([f.a, changed, same], [f.source], [move(f.first, whitespace)])
  assert.equal(result.find((link) => link.sha === whitespace)?.reason, 'changed-patch')
  assert.equal(result.find((link) => link.sha === independent)?.reason, 'ambiguous-patch')
})

test('new competing and known source-less candidates withdraw a previous unique link', async (t) => {
  const f = await setup(t)
  const rewritten = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'rewrite')
  const target = await f.observe(rewritten)
  const movements = [move(f.first, rewritten)]
  const original = await f.reconcile([f.a, target], [f.source], movements)
  const other = factSource(f.repo.dir, f.repo.dir, f.base, f.first, f.a.patch!, f.seats,
    [diff(f.repo, f.base, f.first, 'fact-b', 'seat-b')])!
  const result = await f.reconcile([f.a, target], [f.source, other], movements, original)
  assert.equal(result.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
  assert.equal(original.find((link) => link.sha === rewritten)?.coverage, 'complete')
  const unscoped: Source = { id: 'unknown-origin', seats: ['seat-b'], patch: f.a.patch! }
  const unscopedResult = await f.reconcile([f.a, target], [f.source, unscoped], movements)
  assert.equal(unscopedResult.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
  const unknownSha = await f.repo.git('commit-tree', f.a.tree, '-p', f.base, '-m', 'unknown source')
  const unknown = await f.observe(unknownSha)
  const unknownResult = await f.reconcile([f.a, target, unknown], [f.source], movements)
  assert.equal(unknownResult.find((link) => link.sha === rewritten)?.reason, 'ambiguous-patch')
})

test('a persisted disjoint squash range survives deleted branches and missing source objects', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { two: 'seat b\n' }, 'second')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const original = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], original, f.git, signal(), 40)
  assert.equal(range.ambiguous, false)
  assert.deepEqual(range.seats, ['seat-a', 'seat-b'])
  const squash = await f.repo.git('commit-tree', b.tree, '-p', f.base, '-m', 'squash')
  const s = await f.observe(squash)
  const saved = JSON.parse(JSON.stringify(range)) as typeof range
  const source = rangeSource(saved, original)
  await f.repo.git('update-ref', 'refs/heads/topic', second)
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  await f.git.close()
  await rename(join(f.repo.dir, '.git/objects', f.first.slice(0, 2), f.first.slice(2)),
    join(f.repo.stateDir, 'old-object'))
  const reopened = gitReader(await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir]))
  t.after(() => reopened.close())
  assert.equal(await reopened.commit(f.first, signal()), null)
  const result = await reconcileProject({
    commits: [f.a, b, s], sources: [f.source, sourceB, source], priorLinks: original,
    moves: [move(second, squash)], now: 60,
  }, reopened, signal())
  const link = result.find((value) => value.sha === squash)!
  assert.deepEqual(link.seats, ['seat-a', 'seat-b'])
  assert.equal(link.via, 'squash')
  assert.deepEqual(link.evidenceIds, ['fact-a', 'fact-b'])
  assert.equal(relatedEvidence(link, f.seats, f.records).seats[0]?.session.sessionId, 'original-session-seat-a')
  await assert.rejects(captureRange(f.base, [f.a, b], original, reopened, signal(), 70), /missing-object/)
})

test('overlapping owners, reverted files, incomplete chains and missing sources refuse ranges', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { one: 'base\nseat a\nseat b\n' }, 'overlap')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const links = await f.reconcile([f.a, b], [f.source, sourceB])
  const overlap = await captureRange(f.base, [f.a, b], links, f.git, signal(), 40)
  assert.equal(overlap.ambiguous, true, 'two Seats touching one file cannot seed a squash')
  const reverted = await f.repo.commitTree(f.first, { one: 'base\n', two: 'seat b\n' }, 'revert one')
  const c = await f.observe(reverted)
  const sourceC = factSource(f.repo.dir, f.repo.dir, f.first, reverted, c.patch!, f.seats,
    [diff(f.repo, f.first, reverted, 'fact-c', 'seat-b')])!
  const revertLinks = await f.reconcile([f.a, c], [f.source, sourceC])
  assert.equal((await captureRange(f.base, [f.a, c], revertLinks, f.git, signal(), 40)).ambiguous, true)
  await assert.rejects(captureRange(f.base, [b, f.a], links, f.git, signal(), 40), /history-gap/)
  assert.equal((await captureRange(f.base, [f.a, b], [], f.git, signal(), 40)).ambiguous, true)
  await assert.rejects(captureRange(f.base, Array.from({ length: 65 }, () => f.a), links, f.git, signal(), 40), /limit-exceeded/)
})

test('one Seat can make repeated surviving changes to the same file', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { one: 'base\nseat a\nmore from a\n' }, 'more')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b')])!
  const links = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], links, f.git, signal(), 40)
  assert.equal(range.ambiguous, false)
  assert.deepEqual(range.seats, ['seat-a'])
})

test('empty, missing, restored and unsupported merge observations keep specific reasons', async (t) => {
  const f = await setup(t)
  const emptySha = await f.repo.commitTree(f.first, {}, 'empty')
  const empty = await f.observe(emptySha)
  const other = await f.repo.commitTree(f.base, { other: 'other\n' }, 'other')
  const merged = await f.repo.git('commit-tree', f.a.tree, '-p', f.first, '-p', other, '-m', 'merge')
  const merge = await f.observe(merged)
  const missing = { ...f.a, id: 'missing', sha: 'f'.repeat(40), patch: null, why: 'missing-object' }
  const imported = { ...f.source, proof: { ...f.source.proof, restored: true } }
  const result = await f.reconcile([f.a, empty, merge, missing], [imported])
  assert.equal(result.find((link) => link.sha === f.first)?.reason, 'restored-history')
  assert.equal(result.find((link) => link.sha === emptySha)?.reason, 'empty-change')
  assert.equal(result.find((link) => link.sha === merged)?.reason, 'unsupported-merge')
  assert.equal(result.find((link) => link.sha === missing.sha)?.reason, 'missing-object')
})

test('deterministic link IDs deduplicate retries and retain missing historical Seats as unavailable', async (t) => {
  const f = await setup(t)
  const first = await f.reconcile([f.a], [f.source])
  assert.deepEqual(await f.reconcile([f.a], [f.source], [], first), [])
  const withdrawn: LinkObservation = {
    ...first[0]!, id: 'withdrawn', coverage: 'none', seats: [],
    reason: 'history-gap', via: null, at: 55,
  }
  const again = await f.reconcile([f.a], [f.source], [], [...first, withdrawn])
  assert.equal(again.length, 1)
  assert.equal(again[0]?.coverage, 'complete')
  assert.notEqual(again[0]?.id, first[0]?.id)
  const detail = relatedEvidence(first[0]!, [], f.records)
  assert.deepEqual(detail.missingSeats, ['seat-a'])
  assert.deepEqual(detail.cards, [{ board: 'board', id: 1 }])
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(reconcileProject({ commits: [f.a], sources: [f.source], moves: [], priorLinks: [], now: 50 },
    f.git, aborted.signal), /capture-aborted/)
})


test('amending a multi-Seat squash removes the Seat whose entire file contribution disappeared', async (t) => {
  const f = await setup(t)
  const second = await f.repo.commitTree(f.first, { two: 'seat b\n' }, 'second')
  const b = await f.observe(second)
  const sourceB = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'fact-b', 'seat-b')])!
  const originals = await f.reconcile([f.a, b], [f.source, sourceB])
  const range = await captureRange(f.base, [f.a, b], originals, f.git, signal(), 40)
  const rangeProof = rangeSource(range, originals)
  const squash = await f.repo.git('commit-tree', b.tree, '-p', f.base, '-m', 'squash')
  const s = await f.observe(squash)
  const amended = await f.repo.commitTree(f.base, { one: 'base\nseat a\n', other: 'unknown\n' }, 'amend squash')
  const c = await f.observe(amended)
  const result = await f.reconcile([f.a, b, s, c], [f.source, sourceB, rangeProof], [
    move(second, squash), move(squash, amended),
  ], originals)
  const retained = result.find((link) => link.sha === amended)!
  assert.deepEqual(retained.seats, ['seat-a'])
  assert.deepEqual(retained.evidenceIds, ['fact-a'])
  assert.equal(retained.coverage, 'partial')
  const rival = factSource(f.repo.dir, f.repo.dir, f.first, second, b.patch!, f.seats,
    [diff(f.repo, f.first, second, 'rival', 'seat-a')])!
  const withdrawn = await f.reconcile([f.a, b, s], [f.source, sourceB, rangeProof, rival],
    [move(second, squash)], originals)
  assert.equal(withdrawn.find((link) => link.sha === squash)?.reason, 'ambiguous-patch')
})

test('range discovery offers at most 256 contiguous ranges and retains the remainder', () => {
  const commits: CommitObservation[] = Array.from({ length: 30 }, (_, n) => ({
    id: `commit-${n}`, sha: `sha-${n}`, tree: `tree-${n}`,
    parents: [n === 0 ? 'base' : `sha-${n - 1}`], firstSeenAt: n,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [],
    window: { from: null, to: n }, patch: null, files: [], why: null,
  }))
  const candidates = rangeCandidates(commits, new Set())
  assert.equal(candidates.ready.length, 256)
  assert.equal(candidates.pending.length, 179)
  const next = rangeCandidates(commits, new Set(candidates.ready.map((range) => range.key)))
  assert.equal(next.ready.length, 179)
  assert.deepEqual(next.pending, [])
  assert.ok(candidates.ready.every((range) => range.commits.length >= 2 && range.commits.length <= 64))
  const limited = rangeCandidates(Array.from({ length: 65 }, (_, n) => ({
    ...commits[0]!, id: `long-${n}`, sha: `long-${n}`,
    parents: [n === 0 ? 'base' : `long-${n - 1}`],
  })), new Set())
  assert.ok(limited.pending.includes('limit:long-64'))
})
