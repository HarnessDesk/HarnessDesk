import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FindingRunView } from '@harnessdesk/protocol'

import { findingsRig, SHA2, type FindingsRig } from './fixtures/findings-rig.js'

/*
 * `finding/decide` on the real flow engine: the stamp a person read and the
 * action it authorizes are checked and applied as one step inside the run's
 * own queue, so two submissions of one read can never both apply; a Goal
 * that is no longer open takes no decision at all; and "merge anyway" asks
 * only for a bound pull request, never for posting to be on.
 */

/** A run stopped for a person: a later review raised a new security claim. */
const stoppedRun = async (t: { after(fn: () => Promise<void>): void }): Promise<{ f: FindingsRig; view: FindingRunView; security: string }> => {
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
  const security = await f.plane.raise({ intent: again!.id, candidate: c2.id, request: 'r2', title: 'New hole', body: 'B', category: 'security', blocking: true }, f.scope(String(holder.id)))
  await f.finishReviews('request-changes')
  assert.ok(f.rig.executions.stored(f.run)!.findings!.stopped, 'the run stopped for a person')
  return { f, view: await f.plane.runView(f.run), security: security.id }
}

const input = (f: FindingsRig, view: FindingRunView) => ({ goal: f.goal, run: f.run, round: view.round, stamp: view.stamp })

test('two submissions of one read, decided at once, apply exactly one decision', async (t) => {
  const { f, view } = await stoppedRun(t)
  const outcomes = await Promise.allSettled([
    f.plane.decideRun({ ...input(f, view), action: { kind: 'another-round' }, reason: 'once more' }),
    f.plane.decideRun({ ...input(f, view), action: { kind: 'drop' }, reason: 'drop it' }),
  ])
  assert.equal(outcomes.filter((one) => one.status === 'fulfilled').length, 1, 'exactly one of them applied')
  const refused = outcomes.find((one) => one.status === 'rejected') as PromiseRejectedResult
  assert.match(String(refused.reason), /already used for a different decision|changed since you read it/)
  await f.rig.flows.flush()
  const run = f.rig.executions.stored(f.run)!
  const extra = run.findings!.extraRound !== null
  const dropped = run.state === 'stopped'
  assert.notEqual(extra, dropped, 'the run was either given its round or dropped, never both')
})

test('the same submission sent twice at once applies once and answers both the same', async (t) => {
  const { f, view } = await stoppedRun(t)
  const decision = { ...input(f, view), action: { kind: 'another-round' as const }, reason: 'once more' }
  const [one, two] = await Promise.all([f.plane.decideRun(decision), f.plane.decideRun(decision)])
  assert.equal(one.stamp, two.stamp)
  await f.rig.flows.flush()
  assert.equal(f.cards('fixer').filter((card) => card.state === 'claimed').length, 1, 'one round opened')
  assert.deepEqual(f.rig.executions.stored(f.run)!.findings!.lastDecision?.stamp, view.stamp)
})

test('a wrapped Goal takes no decision, and its run view says why', async (t) => {
  const { f, view, security } = await stoppedRun(t)
  f.goalClosed = 'This Goal is wrapped. Its findings are history here; carry them into an open Goal to decide them.'
  const now = await f.plane.runView(f.run)
  assert.equal(now.undecidable, f.goalClosed)
  for (const action of [
    { kind: 'another-round' as const },
    { kind: 'drop' as const },
    { kind: 'admit-exceptions' as const, findings: [security] },
    { kind: 'adjudicate' as const, finding: security, state: 'withdrawn' as const },
  ]) {
    await assert.rejects(f.plane.decideRun({ ...input(f, view), action, reason: 'after the wrap' }), /This Goal is wrapped/)
  }
  const run = f.rig.executions.stored(f.run)!
  assert.equal(run.findings!.extraRound, null)
  assert.equal(run.findings!.lastDecision, null)
  assert.notEqual(run.state, 'stopped')
  assert.equal((await f.view(security)).lifecycle.state, 'open', 'no person verdict was written')
})

test('merge anyway needs a bound pull request, not posting: the view carries the bound pull request whatever the preference', async (t) => {
  const { f } = await stoppedRun(t)
  const unbound = await f.plane.runView(f.run)
  assert.equal(unbound.boundPr, null)
  assert.match(unbound.unbound ?? '', /No open pull request is bound/)
  f.rig.facts.set(f.goal, [...(f.rig.facts.get(f.goal) ?? []), {
    id: 'pr-1', fact: { kind: 'pr', number: 7, head: SHA2, state: 'open', url: 'https://github.com/acme/widgets/pull/7' },
    card: { board: f.goal, id: 1 }, checkout: { cwd: '/repo', branch: 'fix' }, seat: null, round: null, observedAt: 1, posted: null,
  }])
  const bound = await f.plane.runView(f.run)
  assert.deepEqual(bound.boundPr, { repo: 'acme/widgets', pr: 7 })
  assert.equal(bound.unbound, null)
  assert.equal(bound.publication, 'local', 'nothing was posted: posting may be off or the rounds local')
  await f.plane.decideRun({ ...input(f, bound), action: { kind: 'merge-anyway' }, reason: 'ship it' })
  assert.equal(f.rig.executions.stored(f.run)!.findings!.overrides.length, 1)
})

test('merge anyway leaves a durable, readable confirmation on the run\'s own view, not only the port', async (t) => {
  const { f } = await stoppedRun(t)
  f.rig.facts.set(f.goal, [...(f.rig.facts.get(f.goal) ?? []), {
    id: 'pr-1', fact: { kind: 'pr', number: 7, head: SHA2, state: 'open', url: 'https://github.com/acme/widgets/pull/7' },
    card: { board: f.goal, id: 1 }, checkout: { cwd: '/repo', branch: 'fix' }, seat: null, round: null, observedAt: 1, posted: null,
  }])
  const bound = await f.plane.runView(f.run)
  assert.equal(bound.override ?? null, null, 'nothing was overridden yet')
  await f.plane.decideRun({ ...input(f, bound), action: { kind: 'merge-anyway' }, reason: 'shipping with a tracked follow-up' })
  // A person reading this run again — not the direct wire call that recorded it — must still see it happened.
  const after = await f.plane.runView(f.run)
  assert.equal(after.override?.reason, 'shipping with a tracked follow-up')
  assert.equal(typeof after.override?.decidedAt, 'number')
})

test('a dropped run says so on its own view: the stale round-ceiling reason clears and nothing more is decided', async (t) => {
  const { f, view } = await stoppedRun(t)
  assert.ok(view.reason, 'the round is at its ceiling, waiting for a person')
  assert.equal(view.undecidable, null)
  await f.plane.decideRun({ ...input(f, view), action: { kind: 'drop' }, reason: 'parking this Goal' })
  // A fresh read of the run — the same read the Findings pane does after a decision and on every
  // navigation — must reflect the drop, not repeat the pre-decision ceiling text forever.
  const after = await f.plane.runView(f.run)
  assert.equal(after.reason, null, 'the stale "waiting for a person" reason no longer lingers once the run was decided')
  assert.match(after.undecidable ?? '', /parking this Goal/, 'the run\'s own conclusion is why nothing more is decided')
})
