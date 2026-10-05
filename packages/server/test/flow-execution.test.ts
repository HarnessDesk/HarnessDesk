import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TeamEntry, TeamSignal } from '@harnessdesk/protocol'

import { BRIEF_CHANGED, INDEPENDENT, type StoredFlowExecution } from '../src/flow-execution.js'
import { overlaps } from '../src/team.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const addedSignal = (channel: readonly TeamEntry[]): TeamSignal | undefined =>
  channel.find((entry): entry is TeamSignal => entry.kind === 'signal' && entry.signal === 'added')

const THREE_STAGES = `
version: 2
name: Write, review, decide
roles:
  author: { kind: agent, uses: [writer-a, writer-b] }
  reviewer: { kind: agent, uses: reviewer }
  person: { kind: person, outcomes: [merged] }
seed: { role: author, title: Write it }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review it } }
  - { id: decide, on: reviewer, when: { every: [approve] }, then: { role: person, title: Decide } }
`
const AGENTS = [agent('writer-a', ['done']), agent('writer-b', ['done']), agent('reviewer', ['approve'])]

test('a closed Seat no longer governs a v2 flow conversation', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(`
version: 2
name: Live seat
roles:
  fixer: { kind: agent, uses: implementer }
seed: { role: fixer, title: Fix it }
rules: []
`, [agent('implementer', ['done'])])
  const operation = rig.executions.stored(run.id)!.operations.find((one) => one.kind === 'seat')!
  const seat = rig.seats.get(operation.seat!)!
  assert.equal(rig.flows.governs(seat.session.runtime, seat.session.sessionId), true)
  assert.equal(rig.executions.seated(seat.session.runtime, seat.session.sessionId), true)
  rig.seats.set(String(seat.id), { ...seat, closed: { at: Date.now(), why: 'released' } })
  assert.equal(rig.flows.governs(seat.session.runtime, seat.session.sessionId), false)
  assert.equal(rig.executions.seated(seat.session.runtime, seat.session.sessionId), false)
})

const opens = (events: readonly string[]) => events.filter((one) => one.startsWith('open:'))
const orders = (events: readonly string[]) => events.filter((one) => one.startsWith('order:'))

const waitFor = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/*
 * Issue #1032: a round closes only once every one of its cards has finished —
 * that is the engine's own rule, not something `any` changes. `any: [pass]`
 * only widens which of a *closed* round's outcomes satisfy the guard; it
 * still waits for the second card exactly as `every` would.
 */
const RACE_AND_JUDGE = `
version: 2
name: Race and judge
roles:
  verify: { kind: agent, uses: checker, count: 2 }
  judge:  { kind: agent, uses: decider }
seed: { role: verify, title: Check the attempt }
rules:
  - { id: to-judge, on: verify, when: { any: [pass] }, then: { role: judge, title: Pick the best attempt } }
`

test('a mixed round only opens the judge once every one of its cards has finished, not on the first pass', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(RACE_AND_JUDGE, [agent('checker', ['pass', 'fail']), agent('decider', ['picked'])])
  await rig.flows.flush()

  await rig.team.complete(1, { outcome: 'pass' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.equal(
    rig.board(run.goal).intents.find((one) => one.role === 'judge'),
    undefined,
    'card #2 has not finished yet, so the round has not closed and `any: [pass]` has nothing to decide',
  )

  await rig.team.complete(2, { outcome: 'fail' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  assert.ok(
    rig.board(run.goal).intents.some((one) => one.role === 'judge'),
    'once the round closes, `any: [pass]` is satisfied — one card passed, the other failed',
  )
})

test('a person finishing a card while its round is being journaled still advances the run', async (t) => {
  const rig = await goalRig(t)
  let saveStarted!: () => void
  const saving = new Promise<void>((resolve) => { saveStarted = resolve })
  let finishCard!: (id: number) => void
  const cardFinished = new Promise<number>((resolve) => { finishCard = resolve })
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  t.after(() => { releaseSave() })
  const save = rig.files.save.bind(rig.files)
  let personCompletion: Promise<void> | null = null
  rig.files.save = async (run) => {
    if (run.rounds.some((round) => round.cards.length > 0)) {
      saveStarted()
      await saveGate
    }
    await save(run)
  }
  let completing = false
  rig.onBoardChanged = (state) => {
    const card = state.intents.find((one) => one.role === 'ship')
    if (!card) return
    if (card.state === 'done') {
      finishCard(card.id)
    } else if (!completing) {
      completing = true
      personCompletion = rig.team.intentAction(state.id, card.id, 'done', undefined, 'shipped')
    }
  }

  const start = rig.start(`
version: 2
name: Ship it
roles:
  ship: { kind: person, outcomes: [shipped] }
seed: { role: ship, title: Ship it }
`, [])
  await waitFor(saving, 'round journal save')
  const card = await waitFor(cardFinished, 'person card completion')
  assert.ok(personCompletion)
  await waitFor(personCompletion, 'person completion handling')
  releaseSave()
  const run = await waitFor(start, 'flow start')
  await rig.flows.flush()

  assert.equal(rig.board(run.goal).intents.find((one) => one.id === card)?.state, 'done')
  assert.equal(rig.flows.executionsFor(run.goal)[0]?.state, 'settled')
})

test('a card outcome is validated while its round is being journaled', async (t) => {
  const rig = await goalRig(t)
  let saveStarted!: () => void
  const saving = new Promise<void>((resolve) => { saveStarted = resolve })
  let cardAppeared!: (value: { readonly goal: string; readonly id: number }) => void
  const appeared = new Promise<{ readonly goal: string; readonly id: number }>((resolve) => { cardAppeared = resolve })
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  t.after(() => { releaseSave() })
  const save = rig.files.save.bind(rig.files)
  rig.files.save = async (run) => {
    if (run.rounds.some((round) => round.cards.length > 0)) {
      saveStarted()
      await saveGate
    }
    await save(run)
  }
  rig.onBoardChanged = (state) => {
    const card = state.intents.find((one) => one.role === 'ship')
    if (card?.state === 'open') cardAppeared({ goal: state.id, id: card.id })
  }

  const start = rig.start(`
version: 2
name: Ship it
roles:
  ship: { kind: person, outcomes: [shipped] }
seed: { role: ship, title: Ship it }
`, [])
  await waitFor(saving, 'round journal save')
  const card = await waitFor(appeared, 'person card')
  const intent = rig.board(card.goal).intents.find((one) => one.id === card.id)!
  const refusal = rig.flows.refuseOutcome(card.goal, intent, 'approve')
  releaseSave()
  await waitFor(start, 'flow start')

  assert.match(refusal ?? '', /not an answer|accepts shipped/i)
})

test('an agent card has a flow binding while its round is being journaled', async (t) => {
  const rig = await goalRig(t)
  let saveStarted!: () => void
  const saving = new Promise<void>((resolve) => { saveStarted = resolve })
  let cardAppeared!: (value: { readonly goal: string; readonly id: number }) => void
  const appeared = new Promise<{ readonly goal: string; readonly id: number }>((resolve) => { cardAppeared = resolve })
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  t.after(() => { releaseSave() })
  const save = rig.files.save.bind(rig.files)
  rig.files.save = async (run) => {
    if (run.rounds.some((round) => round.cards.length > 0)) {
      saveStarted()
      await saveGate
    }
    await save(run)
  }
  rig.onBoardChanged = (state) => {
    const card = state.intents.find((one) => one.role === 'write' && one.state === 'open')
    if (card) cardAppeared({ goal: state.id, id: card.id })
  }

  const start = rig.start(`
version: 2
name: Write it
roles:
  write: { kind: agent, uses: writer }
seed: { role: write, title: Write it }
`, [agent('writer', ['done'])])
  await waitFor(saving, 'round journal save')
  const card = await waitFor(appeared, 'agent card')
  const binding = rig.flows.bindingFor(card.goal, card.id)
  releaseSave()
  await waitFor(start, 'flow start')

  assert.deepEqual(binding, { session: null, opening: false })
})

test('candidates asked for the moment a person review card reaches the board wait for its round to finish opening', async (t) => {
  // The card is committed while its round still reads `opening`; a read that did not wait for the run's queue saw no
  // binding and offered nothing to pick (CI on #1161).
  const rig = await goalRig(t)
  const source = `
version: 2
name: Person judge
roles:
  competitor: { kind: agent, uses: [writer-a, writer-b], count: 2, isolate: true, grant: edit, independentOf: [] }
  verify: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail }
  judge: { kind: person, outcomes: [picked] }
  referee: { kind: person, outcomes: [merged] }
seed: { role: competitor, title: Attempt }
rules:
  - { id: check, on: competitor, then: { role: verify, title: Check attempt } }
  - { id: judge, on: verify, when: { any: [pass] }, then: { role: judge, title: Pick the best attempt } }
  - { id: referee, on: judge, when: { every: [picked], evidence: [{ review: picked }] }, then: { role: referee, title: Merge, detail: "Merge {{evidence.review.at}}" } }
budget: { rounds: 4, without-progress: 2 }
`
  const run = await rig.start(source, [agent('writer-a', ['done']), agent('writer-b', ['done'])])
  await rig.flows.flush()
  rig.heads.set(rig.seats.get('seat-1')!.checkout.cwd, { at: 'a'.repeat(40), dirty: false })
  rig.heads.set(rig.seats.get('seat-2')!.checkout.cwd, { at: 'b'.repeat(40), dirty: false })
  const early: { asked: Promise<readonly unknown[]> | null } = { asked: null }
  rig.onBoardChanged = (state) => {
    const judge = state.intents.find((one) => one.role === 'judge' && one.state === 'open')
    if (judge && !early.asked) early.asked = rig.flows.personReviewCandidates(run.id, judge.id)
  }
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  rig.onBoardChanged = null
  assert.ok(early.asked, 'the judge card reached the board')
  assert.equal((await early.asked).length, 2)
})

test('a person review step gets predecessor candidates and advances the referee from the same review fact', async (t) => {
  const rig = await goalRig(t)
  const source = `
version: 2
name: Person judge
roles:
  competitor: { kind: agent, uses: [writer-a, writer-b], count: 2, isolate: true, grant: edit, independentOf: [] }
  verify: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail }
  judge: { kind: person, outcomes: [picked, rejected] }
  referee: { kind: person, outcomes: [merged] }
seed: { role: competitor, title: Attempt }
rules:
  - { id: check, on: competitor, then: { role: verify, title: Check attempt } }
  - { id: judge, on: verify, when: { any: [pass] }, then: { role: judge, title: Pick the best attempt } }
  - { id: referee, on: judge, when: { every: [picked], evidence: [{ review: picked }] }, then: { role: referee, title: Merge, detail: "Merge {{evidence.review.at}}" } }
budget: { rounds: 4, without-progress: 2 }
`
  const run = await rig.start(source, [agent('writer-a', ['done']), agent('writer-b', ['done'])])
  await rig.flows.flush()
  rig.heads.set(rig.seats.get('seat-1')!.checkout.cwd, { at: 'a'.repeat(40), dirty: false })
  rig.heads.set(rig.seats.get('seat-2')!.checkout.cwd, { at: 'b'.repeat(40), dirty: false })
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  const judge = rig.board(run.goal).intents.find((one) => one.role === 'judge')
  assert.ok(judge, JSON.stringify({ execution: rig.flows.executionsFor(run.goal), board: rig.board(run.goal).intents, events: rig.events, facts: rig.facts.get(run.goal) }))
  assert.deepEqual(await rig.flows.personReviewCandidates(run.id, 1), [], 'agent cards are not person review steps')
  await assert.rejects(() => rig.flows.decidePersonReview(run.id, 1, 'candidate', 'picked'), /not an open person review step/)
  assert.equal(rig.facts.get(run.goal)?.some((one) => one.fact.kind === 'review'), false)
  const candidates = await rig.flows.personReviewCandidates(run.id, judge.id)
  assert.equal(candidates.length, 2)
  assert.ok(candidates.every((one) => one.evidence.length > 0), JSON.stringify({ candidates, facts: rig.facts.get(run.goal) }))
  const picked = candidates[1]!
  await assert.rejects(() => rig.flows.decidePersonReview(run.id, judge.id, picked.id, 'unknown'), /not an answer this step accepts/)
  await assert.rejects(() => rig.flows.decidePersonReview(run.id, judge.id, 'unknown', 'picked'), /no longer being offered/)
  assert.equal(rig.facts.get(run.goal)?.some((one) => one.fact.kind === 'review'), false)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === judge.id)?.state, 'open')
  const decisions = await Promise.allSettled([
    rig.flows.decidePersonReview(run.id, judge.id, candidates[0]!.id, 'picked'),
    rig.flows.decidePersonReview(run.id, judge.id, candidates[1]!.id, 'rejected'),
  ])
  const accepted = decisions.filter((one): one is PromiseFulfilledResult<Awaited<ReturnType<typeof rig.flows.decidePersonReview>>> => one.status === 'fulfilled')
  const refused = decisions.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
  assert.equal(accepted.length, 1, 'only one candidate decision is accepted')
  assert.equal(refused.length, 1, 'the competing decision is refused')
  assert.match(String(refused[0]!.reason), /A different verdict is already recorded for this card/)
  const winningIndex = decisions.findIndex((one) => one.status === 'fulfilled')
  const winningCandidate = candidates[winningIndex]!
  const winningVerdict = winningIndex === 0 ? 'picked' : 'rejected'
  const decided = accepted[0]!.value
  await rig.flows.flush()
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === judge.id)?.outcome, winningVerdict)
  assert.equal(rig.facts.get(run.goal)?.filter((one) => one.fact.kind === 'review').length, 1)
  const completed = rig.board(run.goal).channel.filter((one) => one.kind === 'signal' && one.signal === 'completed' && one.intent === judge.id)
  assert.equal(completed.length, 1, 'the card is answered once')
  await rig.flows.decidePersonReview(run.id, judge.id, winningCandidate.id, winningVerdict)
  assert.equal(rig.board(run.goal).channel.filter((one) => one.kind === 'signal' && one.signal === 'completed' && one.intent === judge.id).length, 1, 'retrying the winner does not answer the card again')
  const record = rig.facts.get(run.goal)?.find((one) => one.fact.kind === 'review')
  assert.equal(record?.fact.kind === 'review' ? record.fact.by : null, '00000000-0000-4000-8000-000000000001')
  assert.equal(record?.seat, null)
  assert.ok(rig.flows.executionsFor(run.goal)[0]?.rounds.some((one) => one.role === 'referee'), JSON.stringify({ execution: rig.flows.executionsFor(run.goal), board: rig.board(run.goal).intents, facts: rig.facts.get(run.goal) }))
  const referee = rig.board(run.goal).intents.find((one) => one.role === 'referee')
  assert.ok(referee, JSON.stringify({ execution: rig.flows.executionsFor(run.goal), board: rig.board(run.goal).intents }))
  assert.match(referee.detail ?? '', new RegExp(winningCandidate.at))
  assert.deepEqual(await rig.flows.personReviewCandidates(run.id, referee.id), [], 'a person step without a review guard is not a review step')
  await assert.rejects(() => rig.flows.decidePersonReview(run.id, referee.id, picked.id, 'merged'), /not an open person review step/)
  assert.equal(rig.facts.get(run.goal)?.filter((one) => one.fact.kind === 'review').length, 1)
})

test('only current round seats and every seat is durable before order', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  // The first round alone is seated, and both of its Seats exist before either is sent its card.
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), ['open:seat-1', 'open:seat-2', 'order:seat-1', 'order:seat-2'])
  assert.equal(run.rounds.length, 1)
  assert.equal(rig.board(run.goal).intents.length, 2)

  // A fresh Seat for the next round, only once the round before it is finished.
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await rig.team.complete(card, { outcome: 'done' }, rig.sessionOf(seat))
  }
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2', 'open:seat-3'])
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'])
  const reviewer = rig.seats.get('seat-3')!
  assert.equal(reviewer.agent?.id, 'reviewer')
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 3)?.claim?.sessionId, reviewer.session.sessionId)
})

test('a Seat whose record cannot be written stops the round before any order is sent', async (t) => {
  const rig = await goalRig(t)
  rig.beforeOpen = (n) => { if (n === 2) throw new Error('the Seat record could not be written') }
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  assert.deepEqual(orders(rig.events), [], 'no Seat was sent its card')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), ['release:seat-1'], 'only this round’s own opening is released')
  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /could not be opened: the Seat record could not be written/)
})

test('a round whose first Seat will not open says its sibling was not started, and what a person can do next', async (t) => {
  const rig = await goalRig(t)
  const refusal = 'No seat could be opened for this Agent:\n  claude-code=haiku — claude-code could not open a conversation: the lane was refused'
  rig.beforeOpen = (n) => { if (n === 1) throw new Error(refusal) }
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  // The design holds: a round's cards start together, so the sibling is not tried alone.
  assert.deepEqual(opens(rig.events), [], 'card #2 is never seated on its own')
  assert.deepEqual(orders(rig.events), [])
  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.equal(
    now.reason,
    `The Seat for card #1 could not be opened: ${refusal}\n` +
      'A round’s cards start together, so card #2 was not started either.\n' +
      'Next: wrap this Goal, which stops this run, then fix what stopped card #1 and start the flow again in a new Goal.',
  )

  // The facts the advice rests on. Wrapping is what stops a stalled run — the
  // wrap barrier, `stopGoal` — and the run it stops is this one.
  await rig.flows.stopGoal(run.goal, 'the Goal was wrapped')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stopped')
  // And starting the flow again opens a Goal of its own, not this one.
  rig.beforeOpen = null
  const again = await rig.start(THREE_STAGES, AGENTS)
  assert.notEqual(again.goal, run.goal)
})

test('specialists cannot claim each other’s bindings', async (t) => {
  const rig = await goalRig(t)
  const SPECIALISTS = `
version: 2
name: Two specialists
roles:
  specialists: { kind: agent, uses: [frontend, backend] }
seed: { role: specialists, title: Build your part }
rules: []
`
  const run = await rig.start(SPECIALISTS, [agent('frontend', ['done']), agent('backend', ['done'])])
  await rig.flows.flush()
  const front = rig.sessionOf('seat-1')
  const back = rig.sessionOf('seat-2')
  // Both hold the same role on the board; only the binding tells their cards apart.
  assert.equal(rig.team.roleOf(run.goal, front.runtime, front.sessionId), 'specialists')
  assert.equal(rig.team.roleOf(run.goal, back.runtime, back.sessionId), 'specialists')

  await rig.team.complete(1, { outcome: 'done' }, front)
  assert.match(await rig.team.release(2, {}, back), /released|let go|back/i)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.state, 'open')

  assert.match(await rig.team.claimNext(front), /Nothing to take/)
  assert.match(await rig.team.claim(2, front), /belongs to another Seat/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.state, 'open')
  assert.doesNotMatch(await rig.team.claim(2, back), /Refused/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.claim?.sessionId, back.sessionId)
})

test('isolation carries checkout ports and browser profile', async (t) => {
  const rig = await goalRig(t)
  const ISOLATED = `
version: 2
name: Two isolated writers
roles:
  author: { kind: agent, uses: writer, count: 2, isolate: true }
seed: { role: author, title: Write your version }
rules: []
`
  const run = await rig.start(ISOLATED, [agent('writer', ['done'])])
  await rig.flows.flush()
  const lanes = ['seat-1', 'seat-2'].map((seat) => rig.lanes.get(seat)!)
  assert.notEqual(lanes[0]!.cwd, lanes[1]!.cwd)
  assert.notDeepEqual(lanes[0]!.ports, lanes[1]!.ports)
  assert.notEqual(lanes[0]!.browserProfile, lanes[1]!.browserProfile)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2'])

  // A re-arm keeps the same lane, and goes out only while it is unchanged.
  rig.kill('seat-1')
  await rig.flows.reArm(rig.sessionOf('seat-1').runtime, rig.sessionOf('seat-1').sessionId)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-1'])
  assert.deepEqual(rig.lanes.get('seat-1'), lanes[0])

  rig.lanes.set('seat-2', { ...lanes[1]!, browserProfile: null })
  await rig.flows.reArm(rig.sessionOf('seat-2').runtime, rig.sessionOf('seat-2').sessionId)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-1'], 'a changed environment is not re-armed')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('an isolated step whose lane is incomplete is refused and its Seat released, never downgraded', async (t) => {
  const rig = await goalRig(t)
  rig.laneFor = (n, seat) => ({
    id: `lane-${n}`, goal: seat.board!, seat: String(seat.id), cwd: seat.checkout.cwd, branch: `harnessdesk/lane-${n}`,
    ports: { start: 30000, end: 30019 }, browserProfile: null, state: 'active', createdAt: 1,
  })
  const run = await rig.start(`
version: 2
name: One isolated writer
roles:
  author: { kind: agent, uses: writer, isolate: true }
seed: { role: author, title: Write }
rules: []
`, [agent('writer', ['done'])])
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), [])
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), ['release:seat-1'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('concurrent completion and evidence notices open one round', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  // The first write of the next round's plan fails; the notices after it retry.
  rig.files.failOnce = (stored) => stored.rounds.length === 2
  await Promise.all([
    rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1')),
    rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2')),
    rig.flows.wakeEvidence(run.goal),
  ])
  await rig.flows.flush()
  assert.equal(rig.files.failOnce, null, 'one journal write did fail')
  await rig.flows.wakeEvidence(run.goal)
  await rig.flows.flush()

  const rounds = rig.flows.executionsFor(run.goal)[0]!.rounds
  assert.deepEqual(rounds.map((round) => round.cause), ['seed', 'after:1:review'])
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2', 'open:seat-3'], 'one reviewer Seat')
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'], 'one order each')
  assert.equal(rig.board(run.goal).intents.filter((card) => card.role === 'reviewer').length, 1)
})

test('same and unknown providers cannot review an independent predecessor', async (t) => {
  const policy = (seat: string) => `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, seats: [${seat}], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
  const attempt = async (seat: string, opensAs?: string) => {
    const rig = await goalRig(t)
    rig.providers.set('alpha', 'first').set('alpha-two', 'first').set('beta', 'second')
    const run = await rig.start(policy(seat), [agent('writer', ['done']), agent('reviewer', ['approve'])])
    await rig.flows.flush()
    if (opensAs) rig.opensAs = (asked) => (asked === seat ? opensAs : asked)
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.flows.flush()
    return { rig, run: rig.flows.executionsFor(run.goal)[0]! }
  }

  const same = await attempt('alpha-two')
  assert.equal(same.run.state, 'stalled')
  assert.equal(same.run.reason, INDEPENDENT)
  assert.deepEqual(opens(same.rig.events), ['open:seat-1'], 'another runtime of the same provider is not opened')

  const unknown = await attempt('gamma')
  assert.equal(unknown.run.reason, INDEPENDENT)
  assert.deepEqual(opens(unknown.rig.events), ['open:seat-1'], 'an unknown provider is never taken for an independent one')

  const other = await attempt('beta')
  assert.equal(other.run.state, 'running')
  assert.deepEqual(opens(other.rig.events), ['open:seat-1', 'open:seat-2'])
  assert.deepEqual(orders(other.rig.events), ['order:seat-1', 'order:seat-2'])

  const readback = await attempt('beta', 'alpha-two')
  assert.equal(readback.run.reason, INDEPENDENT)
  assert.deepEqual(orders(readback.rig.events), ['order:seat-1'], 'a Seat that came back on the writer’s provider is sent nothing')
  assert.deepEqual(readback.rig.events.filter((one) => one.startsWith('release:')), ['release:seat-2'])
})

test('a post-open provider clash stalls without trying the next otherwise-independent seat', async (t) => {
  const rig = await goalRig(t)
  rig.providers.set('alpha', 'first').set('alpha-two', 'first').set('beta', 'second').set('beta-two', 'second')
  rig.opensAs = (asked) => asked === 'beta' ? 'alpha-two' : asked
  const run = await rig.start(`
version: 2
name: Provider changes in checkout
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, seats: [beta, beta-two], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`, [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.state, 'stalled')
  assert.equal(execution.reason, INDEPENDENT)
  assert.equal(rig.seats.get('seat-2')?.session.runtime, 'alpha-two')
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'], 'beta-two is not opened after beta returns on the writer provider')
  assert.deepEqual(orders(rig.events), ['order:seat-1'], 'the clashing opened Seat receives no review turn')
})

/*
 * A predecessor whose provider is unknown makes the round unprovable
 * (the #1019 stall). What the stall says once it happens depends on whether
 * there is anything to fix, and the agent's own presentation name is used
 * only when the desk actually has one (Opus review of #1028).
 */
const unreadableWriterFlow = (seat: string): string => `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer, seats: [${seat}] }
  reviewer: { kind: agent, uses: reviewer, seats: [beta], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`

test('an unreadable predecessor with a reader names the card and the agent, and points at its configuration', async (t) => {
  const rig = await goalRig(t)
  // 'alpha' has a reader — `readableProviders` says so — but it is never given a provider, so it reads unknown.
  rig.presentations.set('alpha', 'DeepSeek Harness')
  rig.readableProviders.add('alpha')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(stalled.state, 'stalled')
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1, DeepSeek Harness, could not have its provider read, so no seat can be proven independent of it. ' +
      'Fix that agent’s own configuration if something there points it at another host, or run this role without independentOf.',
  )
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'the reviewer is never opened once independence cannot be proven')
})

test('an unreadable predecessor with no presentation name at all falls back to naming just the card', async (t) => {
  const rig = await goalRig(t)
  // No `rig.presentations` entry for 'alpha' at all — the desk has nothing to call it.
  rig.readableProviders.add('alpha')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1 could not have its provider read, so no seat can be proven independent of it. ' +
      'Fix that agent’s own configuration if something there points it at another host, or run this role without independentOf.',
  )
})

test('an unreadable predecessor with no provider reader at all points at independentOf or reseating, never at configuration', async (t) => {
  const rig = await goalRig(t)
  // 'alpha' is never added to `readableProviders` — no reader exists for it, the Cursor case.
  rig.presentations.set('alpha', 'Cursor')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1, Cursor, could not have its provider read, so no seat can be proven independent of it. ' +
      'That agent has no provider reader at all, so the only way forward is to run this role without independentOf, or to seat that earlier card on an agent whose provider can be read.',
  )
})

test('a brief changed since the run was compiled is refused before and after opening', async (t) => {
  const rig = await goalRig(t)
  rig.digests.set('writer', 'edited-digest')
  const run = await rig.start(`
version: 2
name: One writer
roles:
  author: { kind: agent, uses: writer }
seed: { role: author, title: Write }
rules: []
`, [agent('writer', ['done'])])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), [])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.reason, BRIEF_CHANGED)
})

test('a round cannot open on a Goal that can no longer run work', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  rig.dispatch = { ok: false, reason: 'This Goal came from a backup. Start a new Goal to continue its work.' }
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await rig.team.complete(card, { outcome: 'done' }, rig.sessionOf(seat))
  }
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.rounds.length, 1)
})

test('a board-only run keeps its board board-only until it is stopped', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  assert.equal(rig.board(run.goal).messaging, false)
  assert.throws(() => rig.team.setMessaging(run.goal, true), /runs board-only/)
  await rig.flows.stopRun(run.id)
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')).sort(), ['release:seat-1', 'release:seat-2'])
  rig.team.setMessaging(run.goal, true)
  assert.equal(rig.board(run.goal).messaging, true)
})

/*
 * A round that cannot open never leaves a run reading "running" with nothing
 * happening: the run stalls, and its reason is the refusal that stopped it —
 * whether the first round (right after start) or a later one (after a card
 * finished) was the one that could not open.
 */
test('a round that cannot open stalls the run with the reason, never a silent "running"', async (t) => {
  const REFUSED = 'This Goal came from a backup. Start a new Goal to continue its work.'

  const first = await goalRig(t)
  first.dispatch = { ok: false, reason: REFUSED }
  const started = await first.start(THREE_STAGES, AGENTS)
  await first.flows.flush()
  assert.deepEqual(opens(first.events), [])
  assert.deepEqual([started.state, started.reason], ['stalled', REFUSED], 'the start answers with the stall, not a running run')

  const later = await goalRig(t)
  const run = await later.start(THREE_STAGES, AGENTS)
  await later.flows.flush()
  later.dispatch = { ok: false, reason: REFUSED }
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await later.team.complete(card, { outcome: 'done' }, later.sessionOf(seat))
  }
  await later.flows.flush()
  const execution = later.flows.executionsFor(run.goal)[0]!
  assert.deepEqual([execution.state, execution.reason], ['stalled', REFUSED])
})

test('trigger dispatch is held through durable application', async (t) => {
  const rig = await goalRig(t)
  const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
  gate: { kind: check, run: "pnpm test", timeout: 60, exits: { "0": pass }, otherwise: fail }
seed: { role: reviewer, title: Review it }
rules:
  - { id: verify, on: reviewer, when: { every: [approve] }, then: { role: gate, title: Verify } }
`
  const agents = [agent('reviewer', ['approve'])]
  // A trigger's start: the Goal and the round's cards exist, and nothing is seated, handed over or run.
  const run = await rig.startTriggered(REVIEW, agents, { again: 'reviewer' })
  await rig.flows.flush()
  assert.equal(run.intake?.dispatchHeld, true)
  assert.equal(rig.board(run.goal).intents.length, 1, 'the seed round’s card exists')
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), [], 'no Seat, order or check before the firing is applied')
  // Neither a completion notice, an evidence notice nor a re-arm can move a held run.
  await rig.flows.wakeEvidence(run.goal)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), [])

  // Released: exactly what a person's start would have done.
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), ['open:seat-1', 'order:seat-1'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.intake?.dispatchHeld, false)

  // A later firing: its round is held before it opens, whatever the first round is doing.
  const key = 'b'.repeat(64)
  const round = await rig.flows.againTriggered(run.id, key, [])
  await rig.flows.flush()
  assert.equal(round.state, 'opening')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.intake?.dispatchHeld, true)
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'the later round seats nobody while held')
  // The first round finishing does not advance a held run either.
  await rig.team.complete(1, { outcome: 'approve' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('check:')), [], 'no check runs while held')
  // Asked again, the same firing's round is the same round.
  assert.equal((await rig.flows.againTriggered(run.id, key, [])).n, round.n)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])

  // A gate that refuses stops the run with its reason instead of dispatching.
  const gated = await rig.startTriggered(REVIEW, agents)
  rig.triggerGate = () => 'Out of budget: this Goal reached its spend limit.'
  await rig.flows.resumeTriggered(gated.id)
  await rig.flows.flush()
  const stalled = rig.flows.executionsFor(gated.goal)[0]!
  assert.equal(stalled.state, 'stalled')
  assert.equal(stalled.reason, 'Out of budget: this Goal reached its spend limit.')
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'], 'the refused run seated nobody')
  rig.triggerGate = null

  // What it runs changed after the firing: the run is stopped with why, and never dispatches.
  const changed = await rig.startTriggered(REVIEW, agents, { changed: true })
  assert.equal(changed.state, 'stopped')
  assert.match(changed.reason ?? '', /changed after it fired/)
  await rig.flows.resumeTriggered(changed.id)
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])

  // A restart reads the held flag back and keeps holding.
  const held = await rig.startTriggered(REVIEW, agents)
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(held.goal)[0]!.intake?.dispatchHeld, true)
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])
})

/**
 * A card a trigger's own run opens names the trigger, never the person: the
 * trigger fired unattended, and nobody read a dry run or pressed anything.
 * `addIntentForFlow` used to attribute every card it opened to `{ kind: 'user' }`
 * unconditionally — right for a flow a person started (they read the dry run
 * and pressed Start), wrong for one a trigger opened on its own. The room's
 * channel showed "You added #1 — …" for a card admission opened while nobody
 * was at the keyboard (#898).
 */
test('a card a trigger’s run opens names the trigger, and a card a person’s run opens still names the person', async (t) => {
  const rig = await goalRig(t)
  const SEED_ONLY = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
seed: { role: reviewer, title: Review it }
rules: []
`
  const agents = [agent('reviewer', ['approve'])]

  const triggered = await rig.startTriggered(SEED_ONLY, agents)
  const triggeredAdd = addedSignal(rig.board(triggered.goal).channel)
  assert.deepEqual(triggeredAdd?.by, { kind: 'trigger', trigger: 'review' })

  const started = await rig.start(SEED_ONLY, agents)
  const startedAdd = addedSignal(rig.board(started.goal).channel)
  assert.deepEqual(startedAdd?.by, { kind: 'user' })
})

const TWO_REVIEWERS = `
version: 2
name: Review a change twice
roles:
  reviewer: { kind: agent, uses: [reviewer-a, reviewer-b] }
seed: { role: reviewer, title: Review it }
rules: []
`
const TWO_AGENTS = [agent('reviewer-a', ['approve']), agent('reviewer-b', ['approve'])]

test('a pause or the cap holds a trigger run without stopping it, and its release hands held Seats their cards again', async (t) => {
  const rig = await goalRig(t)
  const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
seed: { role: reviewer, title: Review it }
rules: []
`
  const run = await rig.startTriggered(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => /^(open|order):/.test(one)), ['open:seat-1', 'order:seat-1'])

  // Paused: the Seat's turn is interrupted and ends. The run holds, it does not stall or stop.
  const PAUSED = 'Every trigger is paused. Resume triggers to continue.'
  rig.triggerGate = () => ({ reason: PAUSED, transient: true })
  const session = rig.sessionOf('seat-1')
  await rig.flows.reArm(session.runtime, session.sessionId)
  await rig.flows.flush()
  const held = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(held.state, 'running', 'a pause is not a stop')
  assert.equal(held.reason, null, 'nor a stall a person has to clear')
  assert.equal(held.intake?.dispatchHeld, true)
  assert.equal(held.intake?.heldFor, PAUSED)
  assert.equal(orders(rig.events).length, 1, 'nothing is handed over while held')

  // Resumed: the Seat whose turn ended while held is handed its card again, once.
  rig.triggerGate = null
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const released = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(released.intake?.dispatchHeld, false)
  assert.equal(released.intake?.heldFor ?? null, null)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-1'], 'the held card goes back to its Seat')
  // A release with nothing held re-sends nothing.
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.equal(orders(rig.events).length, 2)
})

test('a stop that lands while a round is still seating hands no card over and leaves no turn running', async (t) => {
  const rig = await goalRig(t)
  const STOP = 'Timed out: this Goal reached its time budget.'

  // The stop lands after the first Seat opened, before the second is asked for.
  const early = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  let firstOpened!: () => void
  const first = new Promise<void>(resolve => { firstOpened = resolve })
  rig.beforeClaim = (n) => { if (n === 1) { rig.triggerGate = () => STOP; firstOpened() } }
  const releasing = rig.flows.resumeTriggered(early.id)
  await first
  const stopping = rig.flows.stopRun(early.id, STOP)
  await Promise.all([releasing, stopping])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'no Seat opens after the stop')
  assert.deepEqual(orders(rig.events), [], 'no card is handed over after the stop')
  assert.ok(rig.events.indexOf('interrupt:seat-1') >= 0 && rig.events.indexOf('interrupt:seat-1') < rig.events.indexOf('release:seat-1'), 'its brief turn is interrupted as it is released')
  assert.equal(rig.flows.executionsFor(early.goal)[0]!.state, 'stopped')

  // The stop lands while the second Seat is being opened: it opens, and is handed nothing.
  rig.events.length = 0
  rig.triggerGate = null
  rig.beforeClaim = null
  const late = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  let asked = 0
  let unblock!: () => void
  const blocked = new Promise<void>((resolve) => { unblock = resolve })
  let reachedSecond!: () => void
  const second = new Promise<void>((resolve) => { reachedSecond = resolve })
  rig.seatAsked = () => {
    asked += 1
    // The Goal queue is held before the second opening is queued: it waits for the test.
    if (asked === 2) {
      void rig.goalSerial.run(() => blocked)
      reachedSecond()
    }
  }
  const release2 = rig.flows.resumeTriggered(late.id)
  await second
  rig.triggerGate = () => STOP
  const stop2 = rig.flows.stopRun(late.id, STOP)
  unblock()
  await Promise.all([release2, stop2])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-2', 'open:seat-3'])
  assert.deepEqual(orders(rig.events), [], 'neither Seat is handed its card')
  for (const seat of ['seat-2', 'seat-3']) {
    const interrupted = rig.events.indexOf(`interrupt:${seat}`)
    assert.ok(interrupted >= 0 && interrupted < rig.events.indexOf(`release:${seat}`), `${seat} interrupted as it is released`)
  }
  assert.equal(rig.flows.executionsFor(late.goal)[0]!.state, 'stopped')
})

test('a pause or a stop kills a trigger run’s running check, left for a person and never run again on its own', { timeout: 20_000 }, async (t) => {
  const rig = await goalRig(t)
  const CHECK = `
version: 2
name: Check a change
roles:
  gate: { kind: check, run: "pnpm test", timeout: 600, exits: { "0": pass }, otherwise: fail }
seed: { role: gate, title: Verify }
rules: []
`
  const run = await rig.startTriggered(CHECK, [])
  let started!: () => void
  const running = new Promise<void>((resolve) => { started = resolve })
  rig.checksRunUntilStopped = started
  const releasing = rig.flows.resumeTriggered(run.id)
  await running
  // The run's queue is held by the check: the interruption reaches it without waiting there.
  rig.flows.interruptChecks(run.goal)
  await releasing
  await rig.flows.flush()
  assert.ok(rig.events.includes('check-stopped:pnpm test'), 'the running check was killed')
  const stopped = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(stopped.state, 'stalled')
  assert.match(stopped.reason ?? '', /stopped part-way/)
  assert.equal(stopped.operations.find((one) => one.key === 'check:1:0')?.state, 'uncertain', 'a person decides whether it runs again')
  assert.equal(rig.board(run.goal).intents[0]?.state === 'done', false, 'no outcome is claimed for it')
  // Nothing runs it again on its own.
  rig.checksRunUntilStopped = null
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.equal(rig.events.filter((one) => one === 'check:pnpm test').length, 1)
})

test('a hold set when one Seat’s turn ends interrupts every other Seat still in a turn', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2'])
  // Both at work; then the pause lands, and the first Seat's turn happens to end before any sweep.
  rig.busySeats.add('seat-2')
  rig.triggerGate = () => ({ reason: 'Every trigger is paused. Resume triggers to continue.', transient: true })
  const first = rig.sessionOf('seat-1')
  await rig.flows.reArm(first.runtime, first.sessionId)
  await rig.flows.flush()
  assert.ok(rig.flows.executionsFor(run.goal)[0]!.intake?.heldFor, 'held by the turn that ended')
  assert.ok(rig.events.includes('interrupt:seat-2'), 'the Seat still inside its turn is interrupted, not left working through the pause')
  assert.equal(rig.busySeats.has('seat-2'), false)
  assert.ok(!rig.events.includes('release:seat-2'), 'held, not let go')
})

/*
 * #1027, reworked after review: no poll anywhere. A Seat still busy is
 * deferred and retried on the host's own turn-ended signal (`retryRelease`,
 * the same call `reArm` answers from) — simulated here exactly as the rest
 * of this file simulates re-arming, by calling it directly rather than
 * waiting on a real turn. `RELEASE_STALL_MS` is injected small
 * (`goalRig(t, { releaseStallMs })`) so the one test that needs the bound to
 * actually pass stays fast and deterministic.
 */

test('a Seat found busy is never even tried, deferred instead — and released once the turn-ended signal answers for it (#1027)', async (t) => {
  const rig = await goalRig(t)
  // A turn an interrupt asks to stop does not end synchronously with it — this class's own `busySeats` says when it does.
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  rig.busySeats.add('seat-2')
  await rig.flows.stopRun(run.id, 'Timed out: this Goal reached its time budget.')
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('refused:')), [], 'never even tried while known busy, so never refused')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), [], 'neither Seat is released yet')
  for (const seat of ['seat-1', 'seat-2']) {
    assert.ok(rig.events.includes(`interrupt:${seat}`), `${seat} was interrupted`)
  }

  // seat-1's turn ends; the signal answers for it alone.
  rig.busySeats.delete('seat-1')
  const first = rig.sessionOf('seat-1')
  rig.flows.retryRelease(first.runtime, first.sessionId)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), ['release:seat-1'])

  // seat-2's turn ends later; the same signal, for the other session, releases it too.
  rig.busySeats.delete('seat-2')
  const second = rig.sessionOf('seat-2')
  rig.flows.retryRelease(second.runtime, second.sessionId)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')).sort(), ['release:seat-1', 'release:seat-2'])
})

test('the happy path — a Seat that is not busy — releases immediately, well under a second, no waiting at all', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const startedAt = Date.now()
  await rig.flows.stopRun(run.id, 'Timed out: this Goal reached its time budget.')
  await rig.flows.flush()
  assert.ok(Date.now() - startedAt < 1_000, 'no Seat was busy, so nothing here waited on anything')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')).sort(), ['release:seat-1', 'release:seat-2'])
  assert.deepEqual(rig.events.filter((one) => one.startsWith('refused:')), [])
})

test('a release refused because a new turn started between the check and the call is retried, not logged as a dead end (#1027)', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  // Not busy by the Seat's own check — the race is entirely in the one call to `release` itself.
  rig.raceReleaseOnce.add('seat-1')
  await rig.flows.stopRun(run.id, 'Timed out: this Goal reached its time budget.')
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('refused:')), ['refused:seat-1'], 'the race was real: the call itself was refused, once')
  assert.ok(!rig.events.includes('release:seat-1'), 'not released on that first, refused call')
  // The turn-ended signal answers again — this time the call goes through.
  const session = rig.sessionOf('seat-1')
  rig.flows.retryRelease(session.runtime, session.sessionId)
  await rig.flows.flush()
  assert.ok(rig.events.includes('release:seat-1'), 'retried and released, rather than left as a log line')
})

test('a Seat handed new work while its release still waits is not released out from under it (#1027 ownership check)', async (t) => {
  const rig = await goalRig(t)
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  await rig.flows.stopRun(run.id, 'Timed out: this Goal reached its time budget.')
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'))
  // Given different work than the card it was asked to give up: card #1 opens again, and this session claims a new card instead.
  const session = rig.sessionOf('seat-1')
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: [
      ...state.intents.map((one) => (one.id === 1 ? { ...one, state: 'open' as const, claim: null } : one)),
      {
        id: 99, title: 'New work', state: 'claimed' as const, files: [], dependsOn: [], createdAt: Date.now(), updatedAt: Date.now(),
        claim: { runtime: session.runtime as never, sessionId: session.sessionId, at: Date.now() },
      },
    ],
  })
  rig.busySeats.delete('seat-1')
  rig.flows.retryRelease(session.runtime, session.sessionId)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'), 'dropped, not released: it holds different work now, never released mid-work')
})

const STOP_WHY = 'Timed out: this Goal reached its time budget.'

test('a stopped run’s pending release names the card and the Seat in its own field, then the overdue sentence, then nothing once released — and its reason is never touched (#1027 finding 3, round 3)', async (t) => {
  const rig = await goalRig(t, { releaseStallMs: 30 })
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  await rig.flows.stopRun(run.id, STOP_WHY)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'))
  const before = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(before.state, 'stopped')
  assert.equal(before.reason, STOP_WHY, 'the run’s own reason is never touched by a pending release')
  // Deferred, and already visible on its own field — a plain "waiting" line, never silence — but not yet the overdue sentence.
  assert.match(before.pendingReleaseNote ?? '', /Waiting for/)
  assert.doesNotMatch(before.pendingReleaseNote ?? '', /turn has not ended/, 'not overdue yet: the sentence is not this soon')
  // Past the (tiny, injected) bound, with the signal never having answered.
  const deadline = Date.now() + 2_000
  let after = before
  while (!(after.pendingReleaseNote ?? '').includes('turn has not ended') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    after = rig.flows.executionsFor(run.goal)[0]!
  }
  assert.match(after.pendingReleaseNote ?? '', /card #1/)
  assert.match(after.pendingReleaseNote ?? '', /turn has not ended/)
  assert.equal(after.state, 'stopped', 'a stopped run stays stopped — the overdue sentence lives on its own field, never a state change')
  assert.equal(after.reason, STOP_WHY, 'still untouched, even past the bound')
  assert.ok(!rig.events.includes('release:seat-1'), 'still not released — the bound only ends the silence, never the wait itself')
  // The signal finally answers; the field disappears, and the Seat is released.
  rig.busySeats.delete('seat-1')
  const session = rig.sessionOf('seat-1')
  rig.flows.retryRelease(session.runtime, session.sessionId)
  await rig.flows.flush()
  assert.ok(rig.events.includes('release:seat-1'))
  const released = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(released.pendingReleaseNote, undefined, 'the field is gone once nothing is pending any more')
  assert.equal(released.reason, STOP_WHY, 'and the reason was never anything else')
})

test('dispose cancels a pending release’s bound timer and writes nothing after (#1027)', async (t) => {
  const rig = await goalRig(t, { releaseStallMs: 30 })
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  // Mocked only from here: the 30ms bound below is a virtual timer from this
  // point on, ticked by hand rather than raced against the real clock — a
  // slow, loaded machine can no longer let the real bound fire before
  // `dispose()` gets to it (review #1050 finding 2, round 2).
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await rig.flows.stopRun(run.id, STOP_WHY)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'))
  const noteBefore = rig.flows.executionsFor(run.goal)[0]!.pendingReleaseNote
  assert.match(noteBefore ?? '', /Waiting for/, 'deferred, with the plain waiting line already up, on its own field')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.reason, STOP_WHY, 'the run’s own reason is never touched by it')
  const savesBefore = rig.files.saves
  rig.flows.dispose()
  // dispose() clears every pending release outright: its field is gone from the very next read, not merely frozen where it stood.
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.pendingReleaseNote, undefined, 'nothing is pending any more')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.reason, STOP_WHY, 'still exactly the run’s own reason')
  // Well past the (still virtual) bound — nothing here waits on, or races, the real wall clock.
  t.mock.timers.tick(10_000)
  await Promise.resolve()
  assert.equal(rig.files.saves, savesBefore, 'no write happened after dispose — the overdue timer never fired')
  assert.equal(
    rig.flows.executionsFor(run.goal)[0]!.pendingReleaseNote,
    undefined,
    'still absent past the bound: the cleared timer never brought the overdue sentence back',
  )
  // Nor does the signal do anything once disposed, even once the turn genuinely ends.
  rig.busySeats.delete('seat-1')
  const session = rig.sessionOf('seat-1')
  rig.flows.retryRelease(session.runtime, session.sessionId)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'), 'disposed: nothing here releases a Seat any more')
})

test('a restart finds a Seat a stopped run left claimed, still open, and releases it through the same path (#1027)', async (t) => {
  const rig = await goalRig(t)
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  await rig.flows.stopRun(run.id, STOP_WHY)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'), 'deferred: the desk goes down before this Seat’s turn ends')
  const before = rig.flows.executionsFor(run.goal)[0]!
  assert.match(before.pendingReleaseNote ?? '', /Waiting for/, 'the pending release already shows on the old process’s own read')
  assert.equal(before.reason, STOP_WHY, 'never touched by it')
  // By the time the desk comes back, the turn has actually ended — nothing here was ever told so directly, though.
  rig.busySeats.delete('seat-1')
  await rig.restart()
  assert.ok(rig.events.includes('release:seat-1'), 'swept and released on the very next start-up, without waiting for another signal')
  const after = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(
    after.reason,
    STOP_WHY,
    'the reason is the original one — never touched to begin with, so the new process has nothing to inherit',
  )
  assert.equal(after.pendingReleaseNote, undefined, 'and nothing is pending on the new process’s own, empty table')
})

test('a restart never sweeps a question-stalled run: its Seat keeps holding its card, for the answer still coming (#1027 finding 1)', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  const asked = await rig.flows.stopForQuestion(session.runtime, session.sessionId, 'asked something and nobody answered in time')
  assert.ok(asked)
  await rig.flows.flush()
  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(stalled.state, 'stalled')
  const card = rig.board(run.goal).intents.find((one) => one.claim?.sessionId === session.sessionId)!.id
  await rig.restart()
  assert.ok(!rig.events.includes('release:seat-1'), 'a question-stalled run’s Seat is never swept: it holds its card on purpose')
  assert.ok(!rig.events.includes('release:seat-2'))
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === card)?.claim?.sessionId, session.sessionId, 'still claimed by the same Seat after the restart')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('a restart never sweeps a run stalled only because an old Seat’s release ran past the bound: the current round’s Seats stay put (#1027 finding 1)', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  // Made to look exactly like a run `#onReleaseOverdue` already stalled — same state, same sentence — without needing the real timer: the sweep only ever reads a run's persisted `state`.
  const files = await rig.files.list()
  const entry = files.find((one) => (one.raw as { id?: string } | null)?.id === run.id)!
  const raw = entry.raw as unknown as StoredFlowExecution
  await rig.files.save({
    ...raw, state: 'stalled',
    reason: 'Card #1 is still claimed by reviewer-a, whose turn has not ended, so it could not be released. Stop that Seat’s turn, or release card #1 by hand.',
  })
  await rig.restart()
  assert.ok(!rig.events.includes('release:seat-1'), 'a stalled run is never swept, whatever stalled it — the run itself is not done, so its Seats are not either')
  assert.ok(!rig.events.includes('release:seat-2'), 'the current round’s other Seat is not taken along with it')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('a restart never releases a stopped run’s Seat once a person has handed it a different card by hand (#1027 finding 2)', async (t) => {
  const rig = await goalRig(t)
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  await rig.flows.stopRun(run.id, STOP_WHY)
  await rig.flows.flush()
  assert.ok(!rig.events.includes('release:seat-1'), 'deferred: the Seat is still busy when the run stops')
  // Before the desk comes back, a person hands this Seat’s session a card of their own, unrelated to this run.
  const session = rig.sessionOf('seat-1')
  const state = rig.team.stateFor(run.goal)
  const ownCard = state.intents.find((one) => one.claim?.sessionId === session.sessionId)!.id
  rig.team.installProjection({
    ...state,
    intents: [
      ...state.intents.map((one) => (one.id === ownCard ? { ...one, state: 'open' as const, claim: null } : one)),
      {
        id: 99, title: 'Someone else’s work', state: 'claimed' as const, files: [], dependsOn: [], createdAt: Date.now(), updatedAt: Date.now(),
        claim: { runtime: session.runtime as never, sessionId: session.sessionId, at: Date.now() },
      },
    ],
  })
  await rig.restart()
  assert.ok(!rig.events.includes('release:seat-1'), 'a hand-assigned card is never swept away: it does not belong to this run’s own rounds')
  assert.ok(rig.events.includes('release:seat-2'), 'the other Seat, still holding this run’s own card, is swept normally')
  assert.equal(rig.team.stateFor(run.goal).intents.find((one) => one.id === 99)?.claim?.sessionId, session.sessionId, 'the hand-assigned card is still held')
})

// ------------------------------------------------ an agreed split, enforced (#1015)

const PAIR = `
version: 2
name: Pair build
roles:
  contract: { kind: agent, uses: writer }
  dev: { kind: agent, uses: writer, count: 2, isolate: true }
seed: { role: contract, title: Agree the split }
rules:
  - { id: build, on: contract, when: { every: [done] }, then: { role: dev, title: "Build part {{n}}", split: contract } }
`

test('each card of a split round owns the part of the split its slot was agreed, and both are seated', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The agreeing card is told to record the split, and how many parts it needs.
  assert.match(rig.board(run.goal).intents.find((card) => card.id === 1)?.detail ?? '', /complete_claim's split .* "dev" round, one list of path patterns for each of its 2 cards/)

  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/api/**', 'docs/api.md'], ['./src/ui/**']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Completed #1/)
  await rig.flows.flush()

  const board = rig.board(run.goal)
  assert.deepEqual(board.intents.find((card) => card.id === 2)?.files, ['src/api/**', 'docs/api.md'])
  assert.deepEqual(board.intents.find((card) => card.id === 3)?.files, ['src/ui/**'])
  assert.equal(board.intents.find((card) => card.id === 2)?.claim?.sessionId, rig.sessionOf('seat-2').sessionId)
  assert.equal(board.intents.find((card) => card.id === 3)?.claim?.sessionId, rig.sessionOf('seat-3').sessionId)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
})

test('a split round whose agreeing card recorded no split stops, opening no card and seating nobody', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /The 2 "dev" cards were not opened: the "contract" round \(card #1\) finished without recording a split of the files, so each card cannot be held to its own files\./)
  assert.match(now.reason ?? '', /the "contract" card has to record its split of the files when it finishes/)
  assert.doesNotMatch(now.reason ?? '', /complete_claim/, 'a person reads this, not a tool name')
  assert.equal(rig.board(run.goal).intents.length, 1, 'no card was opened with a shared list')
  assert.deepEqual(opens(rig.events), ['open:seat-1'])
})

test('a card whose files overlap a live claim is refused by name, and its sibling is not left seated', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  // Somebody else already holds the second part's paths.
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: [...state.intents, {
      id: 9, title: 'Someone else’s work', state: 'claimed', files: ['src/ui/button.ts'], dependsOn: [], createdAt: 1, updatedAt: 1,
      claim: { runtime: 'alpha' as never, sessionId: 'outsider', at: Date.now() },
    }],
  })
  await rig.team.complete(1, { outcome: 'done', split: [['src/api/**'], ['src/ui/**']] }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /card #\d+ could not be opened: Refused: the files of card #\d+ overlap a live claim — src\/ui\/button\.ts is held by #9/)
  assert.deepEqual(orders(rig.events), ['order:seat-1'], 'no dev Seat was handed its card')
  assert.ok(rig.events.includes('release:seat-2'), 'the sibling already opened is let go')
})

test('two sibling cards whose paths overlap are never both claimed', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const state = rig.team.stateFor(run.goal)
  const sibling = (id: number, files: string[], holder: string | null) => ({
    id, title: `Part ${id}`, state: holder ? 'claimed' as const : 'open' as const, files, dependsOn: [], createdAt: 1, updatedAt: 1, role: 'dev',
    ...(holder ? { claim: { runtime: 'alpha' as never, sessionId: holder, at: Date.now() } } : {}),
  })
  const intents = [...state.intents, sibling(5, ['src/**'], 'first'), sibling(6, ['src/app.ts'], null)]
  assert.equal(
    rig.team.refuseOverlap(run.goal, intents, 6, 'alpha', 'second'),
    'the files of card #6 overlap a live claim — src/** is held by #5 (a conversation that is not running). Two cards whose paths overlap are never worked at once.',
  )
  assert.equal(rig.team.refuseOverlap(run.goal, intents, 6, 'alpha', 'first'), null, 'its own claim is not a conflict')
})

test('a split whose parts overlap is refused as it is recorded, and the card stays unfinished', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/**'], ['src/ui/app.ts']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Refused: #1 is not finished, because list 1 \(src\/\*\*\) and list 2 \(src\/ui\/app\.ts\) overlap/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 1)?.state, 'claimed')
})

test('paths that differ only in case are one folder to the board, as on a case-insensitive volume', async (t) => {
  assert.equal(overlaps('src/UI/**', 'src/ui/button.ts'), true)
  assert.equal(overlaps('Docs/API.md', 'docs/api.md'), true)
  assert.equal(overlaps('src/ui/**', 'src/api/**'), false)
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/UI/**'], ['src/ui/**']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Refused: #1 is not finished, because list 1 \(src\/UI\/\*\*\) and list 2 \(src\/ui\/\*\*\) overlap/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 1)?.state, 'claimed')
})

// -------------------------------------------------------------- #1034
// One Agent playing two roles in the same flow, each with its own outcome
// vocabulary (exactly UC1 and UC5's pattern): a role's card must never offer
// or accept a word that belongs to *another* role's own rules. An outcome no
// rule anywhere routes is not illegitimate, though — it is how a flow stops
// for a person, exactly as it always has — so it stays a legitimate answer
// unless it is specifically borrowed from a sibling role.

const UC5_SHAPED = `
version: 2
name: UC5-shaped pair build
roles:
  proposal: { kind: agent, uses: [multi] }
  contract: { kind: agent, uses: [multi] }
  admit: { kind: person, outcomes: [admitted] }
seed: { role: proposal, title: Propose }
rules:
  - { id: reconcile, on: proposal, when: { any: [disagree] }, then: { role: proposal, title: Reconcile } }
  - { id: to-contract, on: proposal, when: { every: [agreed] }, then: { role: contract, title: Write the interface } }
  - { id: to-admit, on: contract, when: { every: [published] }, then: { role: admit, title: Admit the split } }
`
// One Agent, four words across its whole life: two belong to `proposal`
// (agreed, disagree), two to `contract` (published, committed) — except
// `committed` is never named by any rule anywhere, so it stays a legitimate,
// if unrouted, answer for both.
const MULTI_ROLE_AGENT = [agent('multi', ['published', 'committed', 'disagree', 'agreed'])]

test('agreed on a UC5-shaped contract card is refused, naming the words it actually accepts', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(UC5_SHAPED, MULTI_ROLE_AGENT)
  await rig.flows.flush()

  // `proposal`'s own rules read `agreed` and `disagree`; `published` belongs
  // to `contract`'s rule elsewhere in this flow and is excluded, but
  // `committed` — a word no rule anywhere routes — stays legitimate.
  const proposalCard = rig.board(run.goal).intents.find((one) => one.id === 1)
  assert.match(proposalCard?.detail ?? '', /Finish this with complete_claim and an outcome of exactly one of: committed, disagree, agreed\./)
  assert.doesNotMatch(proposalCard?.detail ?? '', /published/)

  await rig.team.complete(1, { outcome: 'agreed' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  // `contract`'s own rule reads `published`; `disagree` and `agreed` belong
  // to `proposal` and are excluded, but `committed` still stays.
  const contractCard = rig.board(run.goal).intents.find((one) => one.id === 2)
  assert.match(contractCard?.detail ?? '', /Finish this with complete_claim and an outcome of exactly one of: published, committed\./)
  assert.doesNotMatch(contractCard?.detail ?? '', /disagree|agreed/)
  assert.match(rig.orderTexts.get('seat-2')!.at(-1)!, /exactly one of: published, committed\./)

  // The bug in #1034: `agreed` is a real word this Agent may answer, but it
  // is specifically `proposal`'s word, borrowed here from the same Agent's
  // other role in this flow. It is refused here, by name, rather than
  // silently accepted and dead-ending the run later with no pointer back at
  // the wrong word.
  const refused = await rig.team.complete(2, { outcome: 'agreed' }, rig.sessionOf('seat-2'))
  assert.match(refused, /^Refused: "agreed" is not an answer this step accepts\. It accepts published, committed\./)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 2)?.state, 'claimed', 'the refused answer was never recorded')

  // The word `contract` actually handles still works, and the run moves on.
  const said = await rig.team.complete(2, { outcome: 'published' }, rig.sessionOf('seat-2'))
  assert.doesNotMatch(said, /Refused/)
  await rig.flows.flush()
  assert.ok(rig.board(run.goal).intents.some((one) => one.role === 'admit'), 'the rule fired on the word it actually handles')
})

const FAN_OUT = `
version: 2
name: Fan-out review
roles:
  build: { kind: agent, uses: [builder], grant: edit, independentOf: [] }
  review: { kind: agent, uses: [reviewer] }
  ship: { kind: person, outcomes: [shipped] }
seed: { role: build, title: Build it }
rules:
  - { id: to-review, on: build, then: { role: review, title: Review it } }
  - { id: to-ship, on: review, when: { every: [approve] }, then: { role: ship, title: Ship it } }
`
const FAN_OUT_AGENTS = [agent('builder', ['done']), agent('reviewer', ['approve', 'request-changes'])]

test('a fan-out reviewer recording request-changes is accepted, and the run stops for a person at once, naming the card and the word', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(FAN_OUT, FAN_OUT_AGENTS)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  // `review`'s only rule reads `approve`; nothing elsewhere in this flow
  // names `request-changes`, so it is unrouted rather than borrowed — and an
  // unrouted word is exactly how a review round is meant to stop for a
  // person, not a mistake to refuse.
  const reviewCard = rig.board(run.goal).intents.find((one) => one.id === 2)
  assert.match(reviewCard?.detail ?? '', /exactly one of: approve, request-changes\./)

  const said = await rig.team.complete(2, { outcome: 'request-changes' }, rig.sessionOf('seat-2'))
  assert.doesNotMatch(said, /Refused/, 'an unrouted word is still a legitimate answer, never refused')
  await rig.flows.flush()

  // Prompt and specific: settled the moment this round closed, naming the
  // exact card and word — never a generic message rounds later.
  const execution = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(execution.state, 'settled')
  assert.equal(execution.reason, '"Review it" (#2) answered request-changes; no rule continues from it, so this waits for you')
})

test('a fan-out reviewer’s request-changes is accepted through record_review as well, and still stops the run for a person', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'b'.repeat(40), dirty: false })
  const run = await rig.start(FAN_OUT, FAN_OUT_AGENTS)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const reviewCard = rig.board(run.goal).intents.find((one) => one.id === 2)!
  const reviewSession = rig.sessionOf('seat-2')

  // The review path — `record_review`, bound through `reviewBinding` — reads
  // the same scoped vocabulary as `complete_claim`. `request-changes` is
  // unrouted, never borrowed from another role, so it is accepted there too.
  const candidates = await rig.review.candidates(reviewCard.id, reviewSession)
  assert.ok(candidates.length > 0, 'the build card’s clean head is offered as a candidate to review')
  const record = await rig.review.record({ intent: reviewCard.id, candidate: candidates[0]!.id, verdict: 'request-changes' }, reviewSession)
  assert.equal(record.fact.kind, 'review')

  const said = await rig.team.complete(2, { outcome: 'request-changes' }, reviewSession)
  assert.doesNotMatch(said, /Refused/)
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'settled', 'an unrouted word accepted through either path still stops the run for a person')
})

const ALIGNMENT_SHAPED = `
version: 2
name: Alignment-shaped
roles:
  propose: { kind: agent, uses: [multi] }
  align: { kind: person, outcomes: [agreed, disagree] }
  build: { kind: agent, uses: [multi] }
seed: { role: propose, title: Propose the plan }
rules:
  - { id: to-align, on: propose, when: { every: [agreed] }, then: { role: align, title: Agree the plan } }
  - { id: to-build, on: align, when: { every: [agreed] }, then: { role: build, title: Build the agreed plan } }
`

test('an analyst answering disagree in an alignment-shaped flow is accepted, not refused for a word no rule of its own reads', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(ALIGNMENT_SHAPED, MULTI_ROLE_AGENT)
  await rig.flows.flush()

  const said = await rig.team.complete(1, { outcome: 'disagree' }, rig.sessionOf('seat-1'))
  assert.doesNotMatch(said, /Refused/)
  await rig.flows.flush()
  // `disagree` routes nowhere here (`propose`'s only rule reads `agreed`),
  // so the round settles for a person rather than being refused outright.
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'settled')
})

const TERMINAL_ROLE = `
version: 2
name: Terminal role
roles:
  first: { kind: agent, uses: [multi] }
  second: { kind: agent, uses: [multi] }
seed: { role: first, title: Go }
rules:
  - { id: to-second, on: first, when: { every: [agreed] }, then: { role: second, title: Finish } }
`

test('a role no rule is "on" is a terminal step, and its card keeps its Agent’s whole declared vocabulary', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(TERMINAL_ROLE, MULTI_ROLE_AGENT)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'agreed' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  // `second` is never named by any rule's `on`, so it is a terminal step:
  // whatever it answers settles the run, and nothing narrows its vocabulary.
  const secondCard = rig.board(run.goal).intents.find((one) => one.id === 2)
  assert.match(secondCard?.detail ?? '', /Finish this with complete_claim and an outcome of exactly one of: published, committed, disagree, agreed\./)

  const said = await rig.team.complete(2, { outcome: 'committed' }, rig.sessionOf('seat-2'))
  assert.doesNotMatch(said, /Refused/, 'a terminal role’s card still accepts every word its Agent declares')
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'settled', 'settling here is the normal end of a terminal step, not a dead end')
})

const MIXED_RULE_SHAPE = `
version: 2
name: Mixed rule shape
roles:
  first: { kind: agent, uses: [multi] }
  second: { kind: agent, uses: [multi] }
seed: { role: first, title: Go }
rules:
  - { id: if-agreed, on: first, when: { every: [agreed] }, then: { role: second, title: Agreed path } }
  - { id: otherwise, on: first, then: { role: second, title: Fallback path } }
`

test('a role with one restrictive rule and one rule with no "when" keeps its Agent’s whole declared vocabulary', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(MIXED_RULE_SHAPE, MULTI_ROLE_AGENT)
  await rig.flows.flush()

  // `first` has a restrictive rule (`every: [agreed]`) and a second rule
  // with no `when` at all. That second rule alone already fires on any
  // outcome, so nothing here is narrowed — the restrictive rule sitting
  // beside it changes nothing.
  const firstCard = rig.board(run.goal).intents.find((one) => one.id === 1)
  assert.match(firstCard?.detail ?? '', /Finish this with complete_claim and an outcome of exactly one of: published, committed, disagree, agreed\./)

  const said = await rig.team.complete(1, { outcome: 'committed' }, rig.sessionOf('seat-1'))
  assert.doesNotMatch(said, /Refused/)
  await rig.flows.flush()
  const opened = rig.board(run.goal).intents.find((one) => one.role === 'second')
  assert.ok(opened, 'the unconditional rule fired on a word its own restrictive rule never named')
  assert.equal(opened?.title, 'Fallback path', 'the restrictive rule did not match, so file order fell through to the one that always does')
})

test('a person stops a writer mid-turn without dispatching its reviewer (#1247)', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  rig.busySeats.add('seat-1')
  rig.busySeats.add('seat-2')
  const stopped = await rig.flows.stopRun(run.id, 'The seat rule changed')
  await rig.flows.flush()
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.reason, 'The seat rule changed')
  assert.deepEqual(stopped.end, { kind: 'stopped', by: 'person' })
  for (const seat of ['seat-1', 'seat-2']) assert.ok(rig.events.includes(`interrupt:${seat}`), `${seat} interrupted`)
  assert.equal(stopped.rounds.at(-1)?.state, 'closed')
  for (const card of rig.board(run.goal).intents) await rig.team.intentAction(run.goal, card.id, 'done', undefined, 'done')
  await rig.flows.flush()
  assert.ok(!rig.board(run.goal).intents.some(card => card.role === 'reviewer'))
  assert.deepEqual(await rig.flows.stopRun(run.id, 'A later reason'), stopped)
})

/*
 * #1315. Stop fires no rule and opens no card. The barrier a pending Stop
 * raises used to cover the Seat, check and turn effects only: a completion
 * already queued ahead of the Stop ran first and opened the reviewer's card
 * on a run that read stopped.
 */
test('a completion queued ahead of a person’s stop opens no reviewer card', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  // Something else holds the run's queue, so both completions wait behind it and the Stop is accepted while they do.
  const holding = rig.flows.withDecision(run.id, () => held)
  for (const card of rig.board(run.goal).intents) await rig.team.intentAction(run.goal, card.id, 'done', undefined, 'done')
  const stopping = rig.flows.stopRun(run.id, 'The person stopped it')
  release()
  const [stopped] = await Promise.all([stopping, holding])
  await rig.flows.flush()
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.reason, 'The person stopped it')
  assert.deepEqual(stopped.end, { kind: 'stopped', by: 'person' })
  assert.ok(!rig.board(run.goal).intents.some(card => card.role === 'reviewer'), 'no reviewer card opened')
  assert.equal(rig.flows.executionOf(run.id)!.rounds.length, 1, 'and no second round was begun')
  assert.equal(opens(rig.events).length, 2, 'nor was a Seat opened for one')
  assert.deepEqual(rig.logs.filter(line => /could not open a round/.test(line)), [], 'what the Stop held back is not reported as a round that failed to open')
})

test('a stop accepted while the next round is being prepared opens none of its cards', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  let reached!: () => void
  const preparing = new Promise<void>((resolve) => { reached = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  // The save that journals the reviewer round as prepared is held; nothing has been added to the board yet.
  const save = rig.files.save.bind(rig.files)
  rig.files.save = async (stored) => {
    if (stored.operations.some((one) => one.key === 'round:2' && one.state === 'prepared')) {
      reached()
      await gate
    }
    await save(stored)
  }
  for (const card of rig.board(run.goal).intents) await rig.team.intentAction(run.goal, card.id, 'done', undefined, 'done')
  await preparing
  const stopping = rig.flows.stopRun(run.id, 'The person stopped it')
  release()
  const stopped = await stopping
  await rig.flows.flush()
  assert.equal(stopped.state, 'stopped')
  assert.ok(!rig.board(run.goal).intents.some(card => card.role === 'reviewer'), 'no reviewer card opened')
  assert.ok(stopped.rounds.every(round => round.state === 'closed'), 'and the round that was being prepared is closed with the rest')
  assert.equal(opens(rig.events).length, 2, 'no Seat was opened for it')
})

test('a stop that fails to save lets the completion it held back open its round', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  const holding = rig.flows.withDecision(run.id, () => held)
  for (const card of rig.board(run.goal).intents) await rig.team.intentAction(run.goal, card.id, 'done', undefined, 'done')
  rig.files.failOnce = (stored) => stored.state === 'stopped'
  const stopping = assert.rejects(rig.flows.stopRun(run.id, 'The person stopped it'), /the journal write failed/)
  release()
  await Promise.all([stopping, holding])
  await rig.flows.flush()
  // The Stop did not happen, so what it held back is not lost: the run goes on as if it had not been asked.
  assert.equal(rig.flows.executionOf(run.id)!.state, 'running')
  assert.ok(rig.board(run.goal).intents.some(card => card.role === 'reviewer'), 'the rule the completion fires opens its card')
})

/*
 * #1315. Stop's cleanup can be retried. A Stop ends the run and then tells the
 * listeners that cancel what the run had released and not yet sent
 * (`onRunStopped`). The run is stopped for good once its own write lands, so a
 * listener that failed after that left a stopped run and a Stop that said it
 * had failed — and asking again was answered from the ended run without
 * telling the listener, so the retry succeeded having cancelled nothing.
 */
test('a stop whose cleanup failed is finished by asking again', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  const told: string[] = []
  let failing = true
  rig.flows.onRunStopped(async (id) => {
    told.push(id)
    if (failing) { failing = false; throw new Error('the cancellation could not be written') }
  })
  await assert.rejects(rig.flows.stopRun(run.id, 'The person stopped it'), /the cancellation could not be written/)
  const ended = rig.flows.executionOf(run.id)!
  assert.equal(ended.state, 'stopped', 'the run itself ended: it is only what follows the Stop that failed')
  assert.equal(ended.reason, 'The person stopped it')
  const again = await rig.flows.stopRun(run.id, 'A later reason')
  assert.deepEqual(told, [run.id, run.id], 'the second Stop did what the first could not finish')
  assert.deepEqual(again, ended, 'and answered with the run as it ended, never rewritten by the later reason')
  assert.deepEqual(rig.flows.executionOf(run.id), ended)
})

test('stopping a run that already settled tells the stop listeners, and leaves it as it settled', async t => {
  const rig = await goalRig(t)
  const run = await rig.start(FAN_OUT, FAN_OUT_AGENTS)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  await rig.team.complete(2, { outcome: 'request-changes' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  const settled = rig.flows.executionOf(run.id)!
  assert.equal(settled.state, 'settled')
  const told: string[] = []
  rig.flows.onRunStopped(async (id) => { told.push(id) })
  assert.deepEqual(await rig.flows.stopRun(run.id, 'A person stops what settled'), settled, 'an ended run is answered as it stands')
  assert.deepEqual(told, [run.id], 'but what it had not yet sent is still cancelled')
  assert.deepEqual(rig.flows.executionOf(run.id), settled)
})

test('hand-backs of a Seat’s own block reclaim it without spending the stall budget (#1403)', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(`
version: 2
name: Self-block recovery
roles:
  author: { kind: agent, uses: writer, grant: edit }
seed: { role: author, title: Publish it }
rules: []
`, [agent('writer', ['published'])])
  await rig.flows.flush()
  const scope = rig.sessionOf('seat-1')
  for (let turn = 0; turn < 5; turn++) {
    if (rig.board(run.goal).intents[0]!.state === 'claimed') {
      assert.match(await rig.team.release(1, { blocked: true, reason: 'waiting for a commit' }, scope), /^Released/)
    }
    await rig.flows.reArm(scope.runtime, scope.sessionId)
    await rig.flows.flush()
  }
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
  assert.equal(rig.board(run.goal).intents[0]!.state, 'claimed', 'handed back with a live claim')
  assert.equal(orders(rig.events).length, 6)
  assert.match(await rig.team.complete(1, { outcome: 'published' }, scope), /^Completed/)
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'settled')
})

test('a person block is held across a relaunch without handing it to its Seat (#1403)', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(`
version: 2
name: Person block
roles:
  author: { kind: agent, uses: writer }
seed: { role: author, title: Wait }
rules: []
`, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.intentAction(run.goal, 1, 'block', 'stopped by the person')
  const before = orders(rig.events).length
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  assert.equal(orders(rig.events).length, before)
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
  assert.equal(rig.board(run.goal).intents[0]!.state, 'blocked')
})
