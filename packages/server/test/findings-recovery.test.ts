import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RaiseFindingInput } from '@harnessdesk/protocol'

import { findingsRig } from './fixtures/findings-rig.js'

/*
 * Durable before it answers, and one meaning per request: a finding command
 * resolves only after its record is synced, a retry after a lost answer —
 * or after a restart — finds the same record rather than writing a second,
 * and the same request with other content is refused with the original kept.
 */

const raiseInput = (intent: number, candidate: string, over: Partial<RaiseFindingInput> = {}): RaiseFindingInput => ({
  intent, candidate, request: 'raise-1', title: 'The retry loop never ends', body: 'Every status retries forever.',
  category: 'ordinary', blocking: true, ...over,
})

/** A promise and the hands that settle it. */
const gate = (): { promise: Promise<void>; open: () => void; fail: (error: Error) => void } => {
  let open!: () => void
  let fail!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject })
  // Refused before anything awaits it is still a refusal, not an unhandled one.
  promise.catch(() => {})
  return { promise, open, fail }
}

test('append response waits for sync', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  const held = gate()
  const reached = gate()
  f.appendHook = async () => { reached.open(); await held.promise }
  let settled = false
  const command = f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2')).finally(() => { settled = true })
  await reached.promise
  // The append has started and has not synced: nothing has answered.
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'the command waits for its append')
  held.open()
  const view = await command
  assert.equal(view.lifecycle.state, 'open')
  // A refused append is a refused command: never a success, and nothing on the disk.
  const refusing = gate()
  f.appendHook = async () => { await refusing.promise }
  const refused = f.plane.raise(raiseInput(review!.id, candidate.id, { request: 'raise-2', title: 'Another' }), f.scope('seat-2'))
  refusing.fail(new Error('the disk is full'))
  await assert.rejects(refused, /the disk is full/)
  assert.equal((await f.records()).length, 1)
})

test('retry returns one raise after lost response', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  // The record reaches the disk, then the run's journal refuses the write that says so: the caller hears a failure.
  let failNext = false
  f.appendHook = async () => { failNext = true }
  f.rig.files.failOnce = (run) => failNext && Object.values(run.findingOps ?? {}).some((entry) => entry.state === 'finished')
  await assert.rejects(f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2')), /journal write failed/)
  f.appendHook = null
  const first = await f.records()
  assert.equal(first.length, 1, 'the record itself is durable')
  // The desk restarts; the caller retries the same request.
  await f.restart()
  const retried = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  const after = await f.records()
  assert.equal(after.length, 1, 'one raise, never two')
  assert.equal(retried.id, first[0]!.fact.kind === 'finding' ? first[0]!.fact.id : null, 'the same finding id')
  assert.deepEqual(retried.evidence, [first[0]!.id], 'the same event id')
})

test('a command the desk stopped inside is settled with a reason on restart, and its retry keeps the minted ids', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  // The process dies after the journal says "prepared" and before the record is appended: nothing more is written.
  f.appendHook = async () => { f.rig.files.dead = true; throw new Error('the process stopped mid-append') }
  await assert.rejects(f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2')), /stopped mid-append/)
  f.appendHook = null
  assert.equal((await f.records()).length, 0)
  const journaled = Object.values(f.rig.executions.stored(f.run)!.findingOps ?? {})
  assert.equal(journaled.length, 1)
  assert.equal(journaled[0]!.state, 'prepared', 'the journal still says it was under way')
  await f.restart()
  // Recovery does not act for a caller who is not there: it stops the command with a reason, and appends nothing.
  const settled = Object.values(f.rig.executions.stored(f.run)!.findingOps ?? {})
  assert.equal(settled[0]!.state, 'abandoned')
  assert.match(settled[0]!.reason ?? '', /stopped before this finding was saved/)
  assert.equal((await f.records()).length, 0)
  await f.plane.recover()
  assert.equal((await f.records()).length, 0, 'a second recovery changes nothing')
  // The caller retries the same request: the record the journal minted is the one appended, once.
  const retried = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  const records = await f.records()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.id, journaled[0]!.record.id, 'with the id minted before the stop')
  assert.deepEqual(retried.evidence, [journaled[0]!.record.id])
})

test('different replay content refuses', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  const original = await f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2'))
  await assert.rejects(
    f.plane.raise(raiseInput(review!.id, candidate.id, { body: 'Something else entirely.' }), f.scope('seat-2')),
    /already used for different content/,
  )
  const records = await f.records()
  assert.equal(records.length, 1)
  assert.equal((await f.view(original.id)).body, 'Every status retries forever.', 'the first claim is kept as written')
  // The identical request is the same event.
  const again = await f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2'))
  assert.equal(again.id, original.id)
  assert.equal((await f.records()).length, 1)
})
