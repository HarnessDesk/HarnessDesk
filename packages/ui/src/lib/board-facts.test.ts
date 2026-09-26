import { describe, expect, it } from 'vitest'

import { runtimeId, type FlowExecution, type FlowRun, type Intent } from '@harnessdesk/protocol'

import { cardEvidence, checkView, ciView, diffView, prView } from '../preview/evidence-fixture'
import { flowRoleOf, flowStepOf, placeCard, type PlaceInput } from './board-facts'

const intent = (over: Partial<Intent> = {}): Intent => ({
  id: 1,
  title: 'Retry the checkout call on a 502',
  detail: null,
  state: 'done',
  files: [],
  dependsOn: [],
  claim: null,
  blockedReason: null,
  handoff: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const place = (over: Partial<PlaceInput> = {}) =>
  placeCard({
    intent: intent(),
    evidence: undefined,
    stranded: false,
    holderWaits: false,
    forPerson: false,
    runStopped: false,
    ...over,
  })

const HELD = { runtime: runtimeId('alpha'), sessionId: 'c1', at: 1 }

describe('work that is not finished', () => {
  it('nobody has started is To do; its holder is on it is Working', () => {
    expect(place({ intent: intent({ state: 'open' }) })).toEqual({ column: 'todo', why: null })
    expect(place({ intent: intent({ state: 'blocked', blockedBy: 'graph', dependsOn: [2] }) })).toEqual({
      column: 'todo',
      why: null,
    })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }) })).toEqual({
      column: 'working',
      why: null,
    })
  })

  it('anything that cannot move without a person Needs you, and says why', () => {
    expect(place({ intent: intent({ state: 'blocked', blockedBy: 'hand', blockedReason: 'waits on the rename' }) })).toEqual({ column: 'needs', why: 'stopped' })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }), stranded: true })).toEqual({ column: 'needs', why: null })
    expect(place({ intent: intent({ state: 'claimed', claim: HELD }), holderWaits: true })).toEqual({ column: 'needs', why: 'waiting on you' })
    expect(place({ intent: intent({ state: 'open' }), forPerson: true })).toEqual({ column: 'needs', why: 'needs your answer' })
  })
})

describe('finished work, on its facts', () => {
  it('is Ready on a current fact that says it is good: a fresh passing check, fresh passing CI, a merged pull request', () => {
    expect(place({ evidence: cardEvidence(1, [checkView()]) })).toEqual({ column: 'ready', why: null })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'skipped'])]) })).toEqual({ column: 'ready', why: null })
    expect(place({ evidence: cardEvidence(1, [prView('merged')]) })).toEqual({ column: 'ready', why: null })
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'final' } })]) })).toEqual({ column: 'ready', why: null })
  })

  it('a merged pull request is no exception: out of date or unknown, it is no verdict', () => {
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'behind', commits: 1 } })]) })).toEqual({ column: 'needs', why: 'PR #12 out of date' })
    expect(place({ evidence: cardEvidence(1, [prView('merged', { freshness: { state: 'unknown', why: 'its checkout is gone' } })]) })).toEqual({ column: 'needs', why: 'PR #12 unknown' })
  })

  it('cancelled CI is not a pass, alone or beside passes', () => {
    expect(place({ evidence: cardEvidence(1, [ciView(['cancelled'])]) })).toEqual({ column: 'needs', why: 'CI cancelled' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'cancelled', 'passed'])]) })).toEqual({ column: 'needs', why: 'CI cancelled' })
  })

  it('a fact a backup brought is unknown here, and never makes a card Ready', () => {
    const brought = checkView({ freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' } })
    expect(place({ evidence: cardEvidence(1, [brought]) })).toEqual({ column: 'needs', why: 'verify unknown' })
  })

  it('a fresh failure outranks anything that passed, and names itself', () => {
    expect(place({ evidence: cardEvidence(1, [checkView({ exit: 1 }), ciView(['passed'])]) })).toEqual({ column: 'needs', why: 'verify failed' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'failed'])]) })).toEqual({ column: 'needs', why: 'CI failed' })
    expect(place({ evidence: cardEvidence(1, [prView('closed')]) })).toEqual({ column: 'needs', why: 'PR #12 closed' })
  })

  it('is In review while its evidence is still arriving', () => {
    expect(place({ evidence: cardEvidence(1, [], [{ name: 'verify', since: 1 }]) })).toEqual({ column: 'review', why: 'verify running' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed', 'pending'])]) })).toEqual({ column: 'review', why: 'CI running' })
    expect(place({ evidence: cardEvidence(1, [prView('open'), diffView()]) })).toEqual({ column: 'review', why: 'PR #12 open' })
  })

  it('a pass that has gone stale is not a pass: the card waits for the check to run again', () => {
    const stale = cardEvidence(1, [checkView({ freshness: { state: 'behind', commits: 1 } })])
    expect(place({ evidence: stale })).toEqual({ column: 'needs', why: 'verify out of date' })
    expect(place({ evidence: cardEvidence(1, [checkView()]) }).column).toBe('ready')
  })

  it('every fact that could decide a card says which it is, and how it stands, when it is not current', () => {
    const behind = { state: 'behind', commits: 2 } as const
    const unknown = { state: 'unknown', why: 'its checkout is gone' } as const
    expect(place({ evidence: cardEvidence(1, [checkView({ freshness: unknown })]) })).toEqual({ column: 'needs', why: 'verify unknown' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed'], { freshness: behind })]) })).toEqual({ column: 'needs', why: 'CI out of date' })
    expect(place({ evidence: cardEvidence(1, [ciView(['passed'], { freshness: unknown })]) })).toEqual({ column: 'needs', why: 'CI unknown' })
    expect(place({ evidence: cardEvidence(1, [prView('open', { freshness: behind })]) })).toEqual({ column: 'needs', why: 'PR #12 out of date' })
    expect(place({ evidence: cardEvidence(1, [prView('open', { freshness: unknown })]) })).toEqual({ column: 'needs', why: 'PR #12 unknown' })
    expect(place({ evidence: cardEvidence(1, [diffView({ freshness: behind })]) })).toEqual({ column: 'needs', why: 'nothing checked' })
  })

  it('finished with nothing checked, it Needs you and says so', () => {
    expect(place()).toEqual({ column: 'needs', why: 'nothing checked' })
    expect(place({ evidence: cardEvidence(1, [diffView()]) })).toEqual({ column: 'needs', why: 'nothing checked' })
  })

  it('abandoned work is set aside, never Ready — whatever was observed on it', () => {
    expect(place({ intent: intent({ state: 'abandoned' }) })).toEqual({ column: 'aside', why: null })
    expect(place({ intent: intent({ state: 'abandoned' }), evidence: cardEvidence(1, [checkView(), prView('merged')]) })).toEqual({ column: 'aside', why: null })
  })
})

describe('a message is never evidence', () => {
  it('an agent saying the tests pass — in its finish note, its outcome, its hand-off — moves nothing', () => {
    const said = intent({ note: 'verify passed, all tests pass — ready to merge', outcome: 'pass', handoff: 'All green.' })
    expect(place({ intent: said })).toEqual({ column: 'needs', why: 'nothing checked' })
    expect(place({ intent: { ...said, state: 'claimed', claim: HELD } })).toEqual({ column: 'working', why: null })
  })
})

describe('a card a flow addressed to the person', () => {
  const run = (intents: readonly number[]): FlowRun =>
    ({
      state: 'running',
      flow: { roles: [{ id: 'approver', kind: 'person', outcomes: ['approve', 'reject'] }] },
      rounds: [{ n: 1, role: 'approver', intents, openedAt: 1 }],
    }) as unknown as FlowRun

  it("is the running flow's only when one of that run's rounds opened it", () => {
    const card = intent({ id: 7, state: 'open', role: 'approver' })
    expect(flowRoleOf(card, run([7]))?.kind).toBe('person')
    expect(flowRoleOf(card, run([3, 4]))).toBeNull()
    expect(flowRoleOf(card, undefined)).toBeNull()
    expect(flowRoleOf(intent({ id: 7, state: 'open' }), run([7]))).toBeNull()
  })
})

/*
 * A run on a Goal addresses a person the same way: its person step is
 * answered with the words that step declares, from the card's own menu.
 */
describe('a card a Goal’s run addressed to the person', () => {
  const execution = (cards: readonly number[], state: FlowExecution['state'] = 'running'): FlowExecution =>
    ({
      id: 'flow-1', goal: 'goal-1', state, reason: null, operations: [], legacyRun: null, version: 2,
      document: { format: 'agents', flow: { roles: [{ id: 'close', kind: 'person', outcomes: ['closed'] }] } },
      rounds: [{ n: 2, role: 'close', cards, seats: [], evidence: [], state: 'running', cause: 'after:1:to-close' }],
    }) as unknown as FlowExecution

  it('is a person step with its declared words, only when one of that run’s rounds opened it', () => {
    const card = intent({ id: 2, state: 'open', role: 'close' })
    expect(flowStepOf(card, undefined, [execution([2])])).toEqual({ kind: 'person', outcomes: ['closed'], stopped: false })
    expect(flowStepOf(card, undefined, [execution([5])])).toBeNull()
    expect(flowStepOf(card, undefined, [])).toBeNull()
  })

  /*
   * A round's own card keeps its role forever, whatever the run that opened
   * it is doing now. A flow settling — the ordinary way one ends — must not
   * erase which of its cards was the person's own decision: the moment it
   * settles is the moment its last card, the person's own answer, would
   * otherwise fall back to being read as an unchecked diff and land back in
   * Needs you for good (#1022).
   */
  it('keeps a card’s role once the run that opened it has settled or stopped', () => {
    const card = intent({ id: 2, state: 'done', outcome: 'closed', role: 'close' })
    expect(flowStepOf(card, undefined, [execution([2], 'settled')])).toEqual({ kind: 'person', outcomes: ['closed'], stopped: false })
    expect(flowStepOf(card, undefined, [execution([2], 'stopped')])).toEqual({ kind: 'person', outcomes: ['closed'], stopped: false })
    expect(place({ intent: card, forPerson: true })).toEqual({ column: 'ready', why: null })
  })

  /*
   * A run stopped for its person — a Seat's question nobody answered in time,
   * say — holds its unfinished cards until they act. The header already reads
   * "Needs you" for it; the board draws those cards there too, so the two
   * never disagree about the same Goal. Once the run goes on, they are Working.
   */
  it('a card of a run stopped for its person Needs you, and is Working again once the run goes on', () => {
    const card = intent({ id: 2, state: 'claimed', role: 'close', claim: HELD })
    const stopped = flowStepOf(card, undefined, [execution([2], 'stalled')])
    expect(stopped?.stopped).toBe(true)
    expect(place({ intent: card, runStopped: stopped?.stopped ?? false })).toEqual({ column: 'needs', why: 'run stopped' })
    const going = flowStepOf(card, undefined, [execution([2], 'running')])
    expect(place({ intent: card, runStopped: going?.stopped ?? false })).toEqual({ column: 'working', why: null })
    // Not yet taken, it is still the person's; a finished one keeps its evidence verdict.
    expect(place({ intent: intent({ id: 2, state: 'open', role: 'close' }), runStopped: true })).toEqual({ column: 'needs', why: 'run stopped' })
    expect(place({ intent: intent({ state: 'abandoned' }), runStopped: true })).toEqual({ column: 'aside', why: null })
  })

  /*
   * A run's stall holds whoever it is still waiting on — never a card that
   * already answered. Three reviewers on one round: the first approved
   * before a teammate's card stalled the run on its usage limit, and the
   * board once put all three in Needs you, the finished one included.
   */
  it('a finished card of a stalled round stays out of Needs you, and its still-unfinished siblings stay in it', () => {
    const stalled = execution([2, 3, 4], 'stalled')
    const approved = intent({ id: 2, state: 'done', role: 'close', outcome: 'closed' })
    const waiting = intent({ id: 3, state: 'open', role: 'close' })
    const held = intent({ id: 4, state: 'claimed', role: 'close', claim: HELD })

    const approvedStep = flowStepOf(approved, undefined, [stalled])
    expect(approvedStep?.stopped).toBe(true)
    expect(place({ intent: approved, forPerson: approvedStep?.kind === 'person', runStopped: approvedStep?.stopped ?? false })).toEqual({
      column: 'ready',
      why: null,
    })

    const waitingStep = flowStepOf(waiting, undefined, [stalled])
    expect(place({ intent: waiting, forPerson: waitingStep?.kind === 'person', runStopped: waitingStep?.stopped ?? false })).toEqual({
      column: 'needs',
      why: 'needs your answer',
    })

    const heldStep = flowStepOf(held, undefined, [stalled])
    expect(place({ intent: held, forPerson: heldStep?.kind === 'person', runStopped: heldStep?.stopped ?? false })).toEqual({
      column: 'needs',
      why: 'run stopped',
    })
  })
})
