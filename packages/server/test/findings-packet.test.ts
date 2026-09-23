import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FindingSeries, FindingView } from '@harnessdesk/protocol'

import { DELTA_REFUSED, repairPacket } from '../src/findings/packet.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { findingsRig, SHA2, SHA3 } from './fixtures/findings-rig.js'

/*
 * A later review round is handed the review contract, the exact delta between
 * the revision the last review judged and the head now, and only the findings
 * still in question — never a transcript, never a resolved finding's body.
 * Read from a real repository through git's argument vector, bounded, with
 * replacements and external diff drivers off; what it cannot read in full it
 * refuses before a reviewer is seated.
 */

const series = (cwd: string, reviewedAt: string): FindingSeries => ({
  id: `reviewer@${cwd}`, role: 'reviewer', checkout: { cwd, branch: 'main' }, reviewedAt, reviewRounds: [2], initial: [], exceptions: [], pending: [],
})

const finding = (id: string, over: Partial<FindingView> = {}): FindingView => ({
  id, origin: { goal: 'goal-1', run: 'run-1', round: 2, card: 3, seat: 'seat-2', at: 'a'.repeat(40) }, ownerGoal: 'goal-1',
  title: `Title of ${id}`, body: `Body of ${id}`, category: 'ordinary', blocking: true, related: null, anchor: null,
  lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [`raise-${id}`], posted: [], restored: false, problem: null,
  ...over,
})

test('round two gets delta not transcript', async () => {
  const repo = await makeRepo('hd-findings-packet-')
  await writeFile(join(repo.dir, 'retry.ts'), 'export const retries = Infinity\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'base')
  const base = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'retry.ts'), 'export const retries = 3\n')
  await repo.git('commit', '-q', '-am', 'bound the retries')
  const fix = await repo.git('rev-parse', 'HEAD')
  const claimed = finding('finding-claimed', { lifecycle: { state: 'repaired', confirmed: false, repairs: [fix] }, sequence: 2 })
  const open = finding('finding-open')
  const resolved = finding('finding-resolved', { lifecycle: { state: 'withdrawn', confirmed: true, repairs: [] }, sequence: 2 })
  const packet = await repairPacket({
    run: 'run-1', round: 4, series: series(repo.dir, base), to: fix,
    findings: [claimed, open, resolved], evidence: ['check-fact-1', 'against-requirement'],
  })
  assert.equal(packet.from, base, 'from the revision the last review judged')
  assert.equal(packet.to, fix)
  assert.deepEqual(packet.claimed, ['finding-claimed'], 'claimed repairs lead')
  assert.deepEqual(packet.unresolved, ['finding-claimed', 'finding-open'])
  assert.deepEqual(packet.findings.map((one) => one.id), ['finding-claimed', 'finding-open'], 'a resolved finding is not handed over')
  assert.match(packet.diff, /-export const retries = Infinity/)
  assert.match(packet.diff, /\+export const retries = 3/)
  assert.doesNotMatch(packet.diff, /README/, 'only the interval, not the history before it')
  assert.deepEqual(packet.evidence, ['check-fact-1', 'against-requirement'], 'the contract being reviewed is kept')
  assert.equal(packet.warning, null)
})

test('rewritten missing dirty and oversize subjects refuse or disclose', async () => {
  const repo = await makeRepo('hd-findings-packet-')
  const first = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'a.txt'), 'one\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'reviewed')
  const reviewed = await repo.git('rev-parse', 'HEAD')
  // History rewritten: the head is no longer a descendant of what was reviewed.
  await repo.git('reset', '-q', '--hard', first)
  await writeFile(join(repo.dir, 'a.txt'), 'two\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'rewritten')
  const rewritten = await repo.git('rev-parse', 'HEAD')
  const disclosed = await repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, reviewed), to: rewritten, findings: [], evidence: [] })
  assert.match(disclosed.warning ?? '', /History changed/)
  assert.match(disclosed.diff, /-one/)
  assert.match(disclosed.diff, /\+two/)

  // A base object the repository no longer has.
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, 'e'.repeat(40)), to: rewritten, findings: [], evidence: [] }), { message: DELTA_REFUSED })
  // Not a full object id at all: never run as a revision expression.
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, 'HEAD~1'), to: rewritten, findings: [], evidence: [] }), { message: DELTA_REFUSED })
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, first), to: '--output=/tmp/x', findings: [], evidence: [] }), { message: DELTA_REFUSED })
  // A dirty head.
  await writeFile(join(repo.dir, 'a.txt'), 'uncommitted\n')
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, first), to: rewritten, findings: [], evidence: [] }), { message: DELTA_REFUSED })
  await repo.git('checkout', '-q', '--', 'a.txt')
  // A delta above 1 MiB.
  await writeFile(join(repo.dir, 'big.txt'), `${'x'.repeat(80)}\n`.repeat(14_000))
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'big')
  const big = await repo.git('rev-parse', 'HEAD')
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, rewritten), to: big, findings: [], evidence: [] }), { message: DELTA_REFUSED })
  // More unresolved findings than one packet may carry: refused, never truncated.
  const many = Array.from({ length: 201 }, (_value, index) => finding(`finding-${index}`))
  await assert.rejects(repairPacket({ run: 'run-1', round: 4, series: series(repo.dir, rewritten), to: rewritten, findings: many, evidence: [] }), /Split this review/)
})

test('a later review round is handed its packet, pinned, and is not seated when the delta cannot be read', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  const raised = await f.plane.raise({
    intent: review!.id, candidate: candidate.id, request: 'raise-1', title: 'Unbounded retry', body: 'It retries forever.', category: 'ordinary', blocking: true,
  }, f.scope('seat-2'))
  await f.finishReviews('request-changes')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  await f.plane.repair({ intent: f.cards('fixer')[1]!.id, finding: raised.id, request: 'repair-1', expected: 1, note: 'Bounded.' }, f.scope('seat-4'))
  await f.finishFixer()
  // Round four's reviewers: each order carries the packet, leading with the claimed repair.
  const order = (f.rig.orderTexts.get('seat-5') ?? []).join('\n')
  assert.match(order, /This review continues an earlier one of reviewer@\/repo/)
  assert.match(order, new RegExp(`Repairs claimed since the last review: ${raised.id}`))
  assert.match(order, /\+scripted after/)
  assert.doesNotMatch((f.rig.orderTexts.get('seat-2') ?? []).join('\n'), /continues an earlier one/, 'the first review reads the change whole')
  const stored = f.rig.executions.stored(f.run)!
  assert.deepEqual(stored.reviewPackets?.['4']?.pinned, [{ cwd: '/repo', at: SHA2 }])
  // The subject moves after the packet was pinned: a verdict on the new head is not what the review was handed.
  f.rig.heads.set('/repo', { at: SHA3, dirty: false })
  const moved = await f.candidate(f.cards('reviewer')[2]!.id, 'seat-5')
  await assert.rejects(
    f.plane.decide({ intent: f.cards('reviewer')[2]!.id, candidate: moved.id, finding: raised.id, request: 'd-1', expected: 2, state: 'repaired', note: 'ok' }, f.scope('seat-5')),
    /moved since this review was handed its packet/,
  )
})

test('a later review round whose delta cannot be read stops before anything is seated', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  await f.finishReviews('request-changes')
  f.packetRefusal = DELTA_REFUSED
  const seated = f.rig.seats.size
  await f.finishFixer()
  const stored = f.rig.executions.stored(f.run)!
  assert.equal(stored.state, 'stalled')
  assert.equal(stored.reason, DELTA_REFUSED)
  assert.equal(f.rig.seats.size, seated, 'no reviewer Seat opened')
})
