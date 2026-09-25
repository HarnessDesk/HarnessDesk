import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test } from 'node:test'

import type { AgentEntry, Session } from '@harnessdesk/protocol'

import { evidenceGuard } from '../src/flow-evidence.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { FAKE_RUNTIME_ID } from './fixtures/fake-runtime.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

/*
 * The comparison shape's own contest — two isolated attempts at one task, a
 * check on each, a judge that picks one against what it actually observed,
 * a person who merges — proved on the engine directly, the same rig
 * `flow-checks.test.ts` proves the check fan-out on. Real evidence and a
 * real `FlowReview`, not a second, test-only imitation of either: `goalRig`
 * wires both (see its own doc comment) so this exercises the actual guard
 * and review logic UC2 depends on, including the transitive dependency walk
 * a judge one round after a check needs to reach what it is actually judging.
 *
 * The referee's gate names only `evidence: [{ review: picked }]`. A `check`
 * guard beside it would be judged too: a fact counts for a rule by the card
 * it is filed on — any card of the walk back to the competitors, the check
 * round's included — and the revision it names, never by the round number it
 * carries (the invariant at `FlowSubject` in `flow-evidence.ts`).
 */

const JUDGE_PRODUCES_REVIEW = (id: string, runtime: string): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest: `${id}-digest`, shadows: [], problems: [],
  definition: {
    id, name: id, ceiling: 'read', ceilingFrom: 'ceiling', answers: ['picked', 'neither'], produces: ['review'], skills: [], mcp: [],
    prefer: [{ runtime }], brief: `${id} brief`,
  },
})

const UC2_FLOW = `
version: 2
name: Comparison
inputs:
  task:
    label: Task
roles:
  competitor: { kind: agent, uses: implementer, count: 2, isolate: true, grant: edit, independentOf: [] }
  verify: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 600 }
  judge: { kind: agent, uses: judge, grant: read, independentOf: [competitor] }
  referee: { kind: person, outcomes: [merged] }
seed: { role: competitor, title: "{{task}}" }
rules:
  - { id: to-verify, on: competitor, then: { role: verify, title: "Check the attempt" } }
  - { id: to-judge, on: verify, when: { every: [pass] }, then: { role: judge, title: "Pick the better attempt" } }
  - { id: to-referee, on: judge, when: { every: [picked], evidence: [{ review: picked }] }, then: { role: referee, title: "Merge the picked change" } }
messaging: board-only
wait: 240
budget: { rounds: 4, without-progress: 2 }
`

test('UC2 keeps two lanes and carries the chosen revision', async (t) => {
  const rig = await goalRig(t)
  rig.providers.set('alpha', 'vendor-x')
  rig.providers.set('beta', 'vendor-y')
  rig.heads.set('/repo/.lanes/1', { at: 'sha-attempt-1', dirty: false })
  rig.heads.set('/repo/.lanes/2', { at: 'sha-attempt-2', dirty: false })

  const run = await rig.start(UC2_FLOW, [agent('implementer', ['done'], 'alpha'), JUDGE_PRODUCES_REVIEW('judge', 'beta')])
  await rig.flows.flush()

  // Two isolated competitors, each its own lane and its own commit.
  const board = () => rig.board(run.goal)
  const competitors = board().intents.filter((one) => one.role === 'competitor')
  assert.equal(competitors.length, 2, 'both competitor cards opened')
  assert.equal(rig.seats.get('seat-1')?.checkout.cwd, '/repo/.lanes/1')
  assert.equal(rig.seats.get('seat-2')?.checkout.cwd, '/repo/.lanes/2')
  await rig.team.complete(competitors[0]!.id, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(competitors[1]!.id, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()

  // Both branches checked, fanned out, no aggregate command standing in for either.
  const verifies = board().intents.filter((one) => one.role === 'verify')
  assert.equal(verifies.length, 2, 'a check card per lane')
  assert.deepEqual(rig.checkCwds, ['/repo/.lanes/1', '/repo/.lanes/2'])
  assert.ok(verifies.every((one) => one.outcome === 'pass'))

  // The judge — an independent provider — reviews what it actually observed
  // and picks attempt 1's exact revision.
  const judgeCard = board().intents.find((one) => one.role === 'judge')!
  const judgeSeat = [...rig.seats.values()].find((one) => one.agent?.id === 'judge')!
  const judgeSession = judgeSeat.session
  const candidates = await rig.review.candidates(judgeCard.id, judgeSession)
  assert.equal(candidates.length, 2, 'both lanes offered, from their own predecessor subjects — not the judge’s own seat')
  assert.deepEqual(candidates.map((one) => one.at).sort(), ['sha-attempt-1', 'sha-attempt-2'])
  const picked = candidates.find((one) => one.at === 'sha-attempt-1')!
  const record = await rig.review.record({ intent: judgeCard.id, candidate: picked.id, verdict: 'picked' }, judgeSession)
  assert.equal(record.fact.kind, 'review')
  assert.equal(record.fact.kind === 'review' ? record.fact.at : null, 'sha-attempt-1')
  await rig.team.complete(judgeCard.id, { outcome: 'picked' }, judgeSession)
  await rig.flows.flush()

  // The person card carries the judge's exact chosen revision — never a
  // guess, never the other attempt.
  const referee = board().intents.find((one) => one.role === 'referee')
  assert.ok(referee, 'the guarded rule fired: a fresh review naming the winner satisfied it')
  const execution = rig.flows.executionsFor(run.goal)[0]!
  // The referee round keeps the review that authorized it, by id — the
  // judge's own record, filed on the judge's card, naming attempt 1.
  const reviewFact = rig.facts.get(run.goal)?.find((one) => one.fact.kind === 'review')
  assert.ok(reviewFact)
  assert.deepEqual(execution.rounds.find((one) => one.role === 'referee')?.evidence, [reviewFact!.id])

  // Moving the selected head after the fact stales the recorded review: the
  // same guard, evaluated again, no longer matches on the now-superseded fact.
  rig.staleFacts.add(reviewFact!.id)
  const judgeRound = execution.rounds.find((one) => one.role === 'judge')!
  const subjects = await rig.executions.subjectsOf(run.goal, judgeRound)
  const outcomes = judgeRound.cards.map((id) => board().intents.find((one) => one.id === id)?.outcome ?? null)
  const facts = (rig.facts.get(run.goal) ?? []).map((one) => ({
    record: one, freshness: rig.staleFacts.has(one.id) ? ({ state: 'moved' as const }) : ({ state: 'fresh' as const }), by: null,
  }))
  const guard = evidenceGuard(
    [{ review: 'picked' }],
    {
      goal: run.goal, finished: judgeRound, subjects, unsettled: [], facts, outcomes, reviewers: judgeRound.seats,
      cards: [...judgeRound.cards, ...verifies.map((one) => one.id), ...competitors.map((one) => one.id)],
    },
  )
  // Stale, not a fresh match: the same guard, asked again, does not silently
  // keep authorizing a merge once the winning branch has moved on.
  assert.notEqual(guard.state, 'matched')
  assert.equal(guard.state, 'waiting', 'a review whose branch moved on reads as no fresh evidence yet, never a false match')
})

test('plain conversation creates no flow Goal or repository files', async (t) => {
  const desk = await evidenceDesk(t)
  const before = await readdir(desk.repo.dir)
  assert.ok(!before.includes('.harnessdesk'), 'a fresh repository names no flow or Agent folder yet')

  const session = (await desk.host.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: desk.repo.dir },
  })) as Session
  assert.ok(session.id, 'the plain path still starts an ordinary conversation')

  const after = await readdir(desk.repo.dir)
  assert.deepEqual(after, before, 'opening a plain conversation reads or writes nothing new in the project')

  // Written after this task's own seven shipped starting points (`packages/server/flows`)
  // existed to read: the catalogue now legitimately lists them, at `builtin` origin — the
  // claim this test actually makes is narrower, and still true, than "reads as none":
  // this *project* names no flow of its own, and reading the effective catalogue,
  // shipped entries included, still makes nothing on disk.
  const catalog = (await desk.host.call('flow/catalog', { root: desk.repo.dir })) as readonly { readonly origin: string }[]
  assert.ok(catalog.length > 0, 'the ones that ship are still listed')
  assert.ok(catalog.every((one) => one.origin === 'builtin'), 'this project names none of its own')
  const afterCatalog = await readdir(desk.repo.dir)
  assert.deepEqual(afterCatalog, before, 'reading the catalogue still creates nothing in the project')
})
