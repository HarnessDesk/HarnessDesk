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

/*
 * Issue #1051: a run that stopped purely because it used up its round
 * budget — no pending exception, no design problem, nothing left open — is
 * exactly as decidable as one a finding stopped. This goes through
 * `decideRun`, the method `finding/decide` actually calls, rather than the
 * engine directly, so it proves the whole path a person's "Authorise
 * another round" button reaches.
 */
test('a round-ceiling stall, clean of any finding, is answered through finding/decide and the run goes on', async (t) => {
  const f = await findingsRig(t)
  const file = join(f.rig.dir, 'flows-v2', `${encodeURIComponent(f.run)}.json`)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  // A budget of two rounds: the fixer's seed round, then one review round — the ceiling a debate that never quite finishes would hit.
  stored.findings = { ...stored.findings, budget: { ...stored.findings.budget, rounds: 2 } }
  await writeFile(file, JSON.stringify(stored))
  await f.restart()
  await f.finishFixer()
  await f.finishReviews('request-changes')
  const stopped = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.deepEqual(
    stopped,
    { round: 2, reason: 'Round 2 ended with 0 open findings. To let it continue, open Findings and choose Authorise another round.', ceiling: true,
      budget: { which: 'rounds', used: 2 } },
    'the round budget stops the run, not a finding it raised, and names the exact way past it',
  )
  assert.equal(f.cards('fixer').filter((one) => one.state === 'claimed').length, 0, 'the repair round the reviewer asked for did not open past the budget')
  const view = await f.plane.runView(f.run)
  assert.equal(view.reason, stopped!.reason, 'the run view carries the same ceiling reason, and the same way forward, a person reads')
  assert.equal(view.ceilingStop, true, 'a round-budget stop reads as the round ceiling, the one a count can answer')
  await f.plane.decideRun({ goal: f.goal, run: f.run, round: stopped!.round, stamp: view.stamp, action: { kind: 'another-round' }, reason: 'let it reach acceptance' })
  await f.rig.flows.flush()
  const after = f.rig.executions.stored(f.run)!
  assert.equal(after.findings!.stopped, null, 'the ceiling stop is cleared once a person answers it')
  assert.equal(after.findings!.extraRound?.after, stopped!.round, 'and the one round it authorized is recorded')
  assert.equal(after.state, 'running', 'the run resumes rather than staying stalled at its budget')
  assert.equal(f.cards('fixer').filter((one) => one.state === 'claimed').length, 1, 'the repair round the reviewer asked for opened past the exhausted budget')
})

/*
 * Issue #1083: "Authorise another round" let exactly one round through, so a
 * converging loop against a real budget needed a click per round. A count
 * widens the ceiling by that many rounds at once, survives a restart before
 * any of them are spent, and omitting it still means exactly one, as before.
 */
test('authorising several rounds lets exactly that many close before the ceiling stops it again, and omitting the count still means one', async (t) => {
  const f = await findingsRig(t)
  const file = join(f.rig.dir, 'flows-v2', `${encodeURIComponent(f.run)}.json`)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  stored.findings = { ...stored.findings, budget: { ...stored.findings.budget, rounds: 2 } }
  await writeFile(file, JSON.stringify(stored))
  await f.restart()
  await f.finishFixer()
  await f.finishReviews('request-changes')
  const stopped = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.equal(stopped!.round, 2, 'the two-round budget stops the run at round 2, as in the single-round case')

  await f.rig.flows.authorizeExtraRound(f.run, stopped!.round, 'let the loop converge', 3)
  await f.rig.flows.flush()
  const authorized = f.rig.executions.stored(f.run)!.findings!
  assert.equal(authorized.stopped, null, 'no stop while any of the three authorized rounds are still to run')
  assert.equal(authorized.extraRound?.count, 3, 'the count is kept with the authorization')

  // A restart before any of the three authorized rounds are spent keeps the whole authorization, not just the first round.
  await f.restart()
  assert.equal(f.rig.executions.stored(f.run)!.findings!.extraRound?.count, 3, 'the count survives a restart')

  // Round 3 (fixer, the repair the round-2 reviewer asked for): one of three spent, no stop yet.
  await f.finishFixer()
  assert.equal(f.rig.executions.stored(f.run)!.findings!.stopped, null, 'one of three authorized rounds spent')
  // Round 4 (reviewer): two of three spent, no stop yet.
  await f.finishReviews('request-changes')
  assert.equal(f.rig.executions.stored(f.run)!.findings!.stopped, null, 'two of three authorized rounds spent')
  // Round 5 (fixer): the third and last authorized round closes, and the widened ceiling (2 + 3) stops it again.
  await f.finishFixer()
  const secondStop = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.ok(secondStop, 'the ceiling stops the run again once all three authorized rounds are spent')
  assert.equal(secondStop!.round, 5)
  assert.match(secondStop!.reason, /reached its limit of 5 rounds/)
  assert.match(secondStop!.reason, /Authorise another round/)

  // Omitting the count authorizes exactly one round, exactly as it always has.
  await f.rig.flows.authorizeExtraRound(f.run, secondStop!.round, 'one more try')
  await f.rig.flows.flush()
  assert.equal(f.rig.executions.stored(f.run)!.findings!.extraRound?.count, 1, 'omitting the count still means one')
  // Round 6 (reviewer): the one authorized round closes, and the ceiling (5 + 1) stops it immediately after.
  await f.finishReviews('request-changes')
  const thirdStop = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.ok(thirdStop, 'exactly one more round runs before the ceiling stops it again')
  assert.equal(thirdStop!.round, 6)
})

test('a repeat press of an authorization saved before the round count existed still replays, never refuses', async (t) => {
  const f = await findingsRig(t)
  const file = join(f.rig.dir, 'flows-v2', `${encodeURIComponent(f.run)}.json`)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  stored.findings = { ...stored.findings, budget: { ...stored.findings.budget, rounds: 1 } }
  await writeFile(file, JSON.stringify(stored))
  await f.restart()
  await f.finishFixer()
  const stopped = f.rig.executions.stored(f.run)!.findings!.stopped
  assert.ok(stopped, 'the one-round budget stops the run at its seed round')
  await f.rig.flows.authorizeExtraRound(f.run, stopped!.round, 'one more try')
  await f.rig.flows.flush()

  // As a run authorized before this field existed would read back: the stored record has after and reason, no count.
  const midway = JSON.parse(await readFile(file, 'utf8'))
  delete midway.findings.extraRound.count
  await writeFile(file, JSON.stringify(midway))
  await f.restart()
  assert.equal('count' in f.rig.executions.stored(f.run)!.findings!.extraRound!, false)

  // A duplicate press of the exact same authorization replays it rather than refusing for "not stopped any more".
  await f.rig.flows.authorizeExtraRound(f.run, stopped!.round, 'one more try', 1)
  await f.rig.flows.flush()
  // The reviewer role seats both built-in reviewers at once; still exactly the one round opened, never a second.
  assert.equal(f.cards('reviewer').filter((one) => one.state === 'claimed').length, 2, 'still exactly the one round opened, never a second')
})
