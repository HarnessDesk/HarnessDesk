import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FindingOverride } from '@harnessdesk/protocol'

import { findingsRig, SHA2, type FindingsRig } from './fixtures/findings-rig.js'

/*
 * A round close is processed outside its run's queue: it reads the ledger,
 * the facts and the subjects, then records what it decided. A person may
 * decide something about the same run while it reads. The close owns only
 * what it counts — the closed rounds, the idle count, the progress seen, the
 * stop, and its own review series' close — and merges those onto the run as
 * it stands when the write runs, never onto the copy it read first.
 */

/** Holds the next close of `f`'s run inside its processing, after it read the run. */
const holdNextClose = (f: FindingsRig): { readonly inside: Promise<void>; release(): void } => {
  const original = f.port.flows.facts!
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let paused!: () => void
  const inside = new Promise<void>((resolve) => { paused = resolve })
  let once = false
  f.port.flows.facts = async (goal) => {
    if (!once) {
      once = true
      paused()
      await gate
    }
    return original(goal)
  }
  return { inside, release: () => { f.port.flows.facts = original; release() } }
}

test('a person override recorded while a round close is processing survives the close', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  await f.plane.raise({ intent: review!.id, candidate: candidate.id, request: 'r1', title: 'T', body: 'B', category: 'ordinary', blocking: true }, f.scope('seat-2'))
  await f.finishReviews('request-changes')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  const hold = holdNextClose(f)
  const finishing = f.finishFixer()
  await hold.inside
  const override: FindingOverride = { by: 'person', run: f.run, round: 3, at: SHA2, findings: [], reason: 'merge anyway', decidedAt: 1 }
  await f.rig.flows.recordOverride(f.run, override)
  await f.rig.flows.recordDecisionStamp(f.run, 'stamp-1', 'key-1')
  hold.release()
  await finishing
  const state = f.rig.executions.stored(f.run)!.findings!
  assert.deepEqual(state.overrides, [override], 'the override the person recorded mid-close is kept')
  assert.deepEqual(state.lastDecision, { stamp: 'stamp-1', key: 'key-1' }, 'the decision stamp is kept')
  assert.ok(state.closedRounds.includes(3), 'and the close was still counted')
})

/*
 * Stopped for a person at one round while another is still open — how a
 * flow with parallel rounds reaches it — the person admits an exception and
 * authorizes one more round while the other round's close is being read.
 */
test('an exception decision and an extra round decided during a close survive it, and the close applies its series to the current one', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  const raised = await f.plane.raise({ intent: review!.id, candidate: candidate.id, request: 'r1', title: 'T', body: 'B', category: 'security', blocking: true }, f.scope('seat-2'))
  await f.rig.flows.flush()
  // On disk, as a parallel round's close would leave it: stopped after round 1, one exception pending.
  const file = join(f.rig.dir, 'flows-v2', `${encodeURIComponent(f.run)}.json`)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  stored.findings = {
    ...stored.findings,
    stopped: { round: 1, reason: 'Review the new regression or security finding before continuing.' },
    series: [{ id: 'elsewhere@/other', role: 'elsewhere', checkout: { cwd: '/other', branch: null }, reviewedAt: null, reviewRounds: [1], initial: [], exceptions: [], pending: [raised.id] }],
  }
  await writeFile(file, JSON.stringify(stored))
  await f.restart()
  const hold = holdNextClose(f)
  const finishing = f.finishReviews('request-changes')
  await hold.inside
  await f.rig.flows.recordExceptionDecision(f.run, [raised.id], true)
  await f.rig.flows.authorizeExtraRound(f.run, 1, 'one more')
  hold.release()
  await finishing
  const state = f.rig.executions.stored(f.run)!.findings!
  const elsewhere = state.series.find((one) => one.id === 'elsewhere@/other')!
  assert.deepEqual(elsewhere.exceptions, [raised.id], 'the admitted exception is kept')
  assert.deepEqual(elsewhere.pending, [], 'and is no longer pending')
  assert.equal(state.extraRound?.after, 1, 'the authorized round is kept')
  assert.equal(state.extraRound?.reason, 'one more')
  const reviewed = state.series.find((one) => one.id === 'reviewer@/repo')
  assert.ok(reviewed?.reviewRounds.includes(2), 'the close applied its own series close onto the current series')
  assert.ok(state.closedRounds.includes(2))
})

test('an authorized extra round clears the stop it answers, and the run goes on', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [first] = f.cards('reviewer')
  const c1 = await f.candidate(first!.id, 'seat-2')
  await f.plane.raise({ intent: first!.id, candidate: c1.id, request: 'r1', title: 'Baseline', body: 'B', category: 'ordinary', blocking: true }, f.scope('seat-2'))
  await f.finishReviews('request-changes')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  await f.finishFixer()
  const [, , again] = f.cards('reviewer')
  const holder = [...f.rig.seats.values()].find((seat) => seat.session.sessionId === again!.claim?.sessionId)!
  const c2 = await f.candidate(again!.id, String(holder.id))
  await f.plane.raise({ intent: again!.id, candidate: c2.id, request: 'r2', title: 'New hole', body: 'B', category: 'security', blocking: true }, f.scope(String(holder.id)))
  await f.finishReviews('request-changes')
  const stopped = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.ok(stopped, 'a new security claim stops the run for a person')
  assert.equal((await f.plane.runView(f.run)).reason, stopped!.reason)
  await f.rig.flows.authorizeExtraRound(f.run, stopped!.round, 'look at it next round')
  await f.rig.flows.flush()
  const after = f.rig.executions.stored(f.run)!
  assert.equal(after.findings!.stopped, null, 'the stop the person answered is cleared')
  assert.equal(after.findings!.extraRound?.after, stopped!.round, 'and the one round it authorized is recorded')
  assert.notEqual((await f.plane.runView(f.run)).reason, stopped!.reason, 'no stop banner during the authorized round')
  assert.equal(f.cards('fixer').filter((one) => one.state === 'claimed').length, 1, 'the next round opened')
  // A duplicate of the same authorization, before or after the round opened, spends nothing more.
  await f.rig.flows.authorizeExtraRound(f.run, stopped!.round, 'look at it next round')
  await f.rig.flows.flush()
  assert.equal(f.cards('fixer').filter((one) => one.state === 'claimed').length, 1)
})
