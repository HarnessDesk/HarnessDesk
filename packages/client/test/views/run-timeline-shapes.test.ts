import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeId, type BoardEvidence, type Evidence, type EvidenceView, type FindingView, type FlowExecution, type FlowPolicy, type FlowPolicyRole, type FlowRoundState, type Intent } from '@harnessdesk/protocol'
import { runTimeline, type RunTimelineInput } from '../../src/views/run-timeline.js'

/**
 * The shipped shapes (`packages/server/flows/`), as a Run leaves them: what a round of several cards, a pick, a blind
 * round, a person's step and a committed answer each look like in the recorded rows. Revisions are full length, as the
 * desk records them.
 */
const BASE = '0'.repeat(40)
const REV = { a: 'a1'.repeat(20), b: 'b2'.repeat(20), c: 'c3'.repeat(20) }
const agent = (id: string, over: Partial<Extract<FlowPolicyRole, { kind: 'agent' }>> = {}): FlowPolicyRole =>
  ({ id, kind: 'agent', uses: [id], seats: [], isolate: false, grant: 'edit', independentOf: [], ...over })
const check = (id: string, run = 'pnpm verify'): FlowPolicyRole =>
  ({ id, kind: 'check', check: { run, timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } })
const person = (id: string, outcomes: string[]): FlowPolicyRole => ({ id, kind: 'person', outcomes })
const round = (n: number, role: string, cards: number[], state: FlowRoundState['state']): FlowRoundState =>
  ({ n, role, cards, seats: cards.map(id => `seat-${id}`), evidence: [], state, cause: `cause-${n}` })
const execution = (roles: FlowPolicyRole[], rounds: FlowRoundState[], patch: Partial<FlowExecution> = {}, rules: FlowPolicy['rules'] = []): FlowExecution => ({
  version: 2, id: 'run', goal: 'team', state: 'running', reason: null, legacyRun: null, operations: [], rounds, startedAt: 1_000,
  document: { format: 'agents', flow: { version: 2, name: 'Shape', inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Task' }, messaging: 'board-only', wait: 1 } },
  ...patch,
})
const card = (id: number, role: string, over: Partial<Intent> = {}): Intent =>
  ({ id, title: `Card ${id}`, state: 'done', outcome: 'delivered', role, claim: null, createdAt: 10 * id, updatedAt: 100 * id, files: [], dependsOn: [], ...over })
const view = (cardId: number, round: number, fact: Evidence, over: { cwd?: string; branch?: string | null; restored?: boolean; freshness?: EvidenceView['freshness'] } = {}): EvidenceView => ({
  freshness: over.freshness ?? { state: 'fresh' }, by: null,
  record: { id: `${cardId}-${fact.kind}`, observedAt: 500 + cardId, round, card: { board: 'team', id: cardId }, fact,
    ...(over.cwd ? { checkout: { cwd: over.cwd, branch: over.branch ?? null } } : {}), ...(over.restored ? { restored: { from: 'backup', at: 1 } as never } : {}) },
})
const board = (...views: EvidenceView[]): BoardEvidence => ({ room: 'team', stamp: 1, checks: [], refused: [], unreadable: null,
  cards: [...new Set(views.map(one => one.record.card!.id))].map(id => ({ card: id, running: [], facts: views.filter(one => one.record.card!.id === id) })) })
const diff = (to: string, added: number, removed: number, files = 2): Extract<Evidence, { kind: 'diff' }> => ({ kind: 'diff', files, added, removed, from: BASE, to })
const ran = (at: string, exit: number): Extract<Evidence, { kind: 'check' }> => ({ kind: 'check', name: 'verify', run: 'pnpm verify', exit, timedOut: false, at, dirty: false, tail: '' })
const rowsOf = (input: RunTimelineInput) => runTimeline(input).rows
const find = (rows: ReturnType<typeof rowsOf>, id: string) => rows.find(one => one.id === id)!

/** The shipped comparison, past its pick: two attempts, a check on each, a judge, and a person to merge. */
const comparison = (over: { facts?: EvidenceView[]; judge?: Partial<Intent>; state?: FlowExecution['state'] } = {}) => {
  const roles = [agent('competitor', { isolate: true, count: 2 }), check('verify'), agent('judge', { grant: 'read', independentOf: ['competitor'] }), person('referee', ['merged'])]
  const rounds = [round(1, 'competitor', [1, 2], 'closed'), round(2, 'verify', [3, 4], 'closed'), round(3, 'judge', [5], 'closed'), round(4, 'referee', [6], 'running')]
  const cards = [card(1, 'competitor', { note: 'Caches the ranked results per query.' }), card(2, 'competitor', { note: 'Moves the ranking into one SQL query.' }),
    card(3, 'verify', { outcome: 'pass', dependsOn: [1, 2] }), card(4, 'verify', { outcome: 'fail', dependsOn: [1, 2] }),
    card(5, 'judge', { outcome: 'picked', dependsOn: [3, 4], note: 'A keeps the old ordering.', ...over.judge }),
    card(6, 'referee', { state: 'open', outcome: null, dependsOn: [5], title: 'Merge the picked change', detail: `Merge exactly ${REV.a}, the revision the judge picked.\n\nFinish this with complete_claim and an outcome of exactly one of: merged.` })]
  const facts = over.facts ?? [
    view(1, 1, diff(REV.a, 142, 60), { cwd: '/work/race-a', branch: 'race/a' }), view(2, 1, diff(REV.b, 97, 41), { cwd: '/work/race-b', branch: 'race/b' }),
    view(3, 2, ran(REV.a, 0), { cwd: '/work/race-a' }), view(4, 2, ran(REV.b, 1), { cwd: '/work/race-b' }),
    view(5, 3, { kind: 'review', verdict: 'picked', by: 'seat-5' as never, at: REV.a }),
  ]
  return { execution: execution(roles, rounds, { state: over.state ?? 'running' }), cards, evidence: board(...facts) }
}

describe('runTimeline · a round of several cards', () => {
  it('says how many cards a round asked and how many are answered', () => {
    const rows = rowsOf(comparison())
    assert.partialDeepStrictEqual(find(rows, 'round-1'), { asked: 2, answered: 2 })
    const open = comparison()
    open.cards[1] = card(2, 'competitor', { state: 'claimed', outcome: null, claim: { runtime: runtimeId('agent'), sessionId: 'b', at: 150 } })
    assert.partialDeepStrictEqual(find(rowsOf(open), 'round-1'), { asked: 2, answered: 1 })
    assert.equal(find(rows, 'card-1-1').asked, null)
  })

  describe('blind', () => {
    const specialists = (patch: Partial<Extract<FlowPolicyRole, { kind: 'agent' }>> = {}, state: FlowRoundState['state'] = 'running', run: Partial<FlowExecution> = {}) => ({
      execution: execution([agent('build'), agent('specialists', { grant: 'read', uses: ['security', 'performance', 'api'], independentOf: ['build'], ...patch })],
        [round(1, 'build', [1], 'closed'), { ...round(2, 'specialists', [2, 3, 4], state), blind: patch.blind !== false }], run),
      cards: [card(1, 'build'), card(2, 'specialists'), card(3, 'specialists', { state: 'claimed', outcome: null }), card(4, 'specialists', { state: 'claimed', outcome: null })],
    })
    it('marks an open round of several read-only Seats on a live Run', () => {
      const rows = rowsOf(specialists())
      assert.equal(find(rows, 'round-2').blind, true)
      assert.partialDeepStrictEqual(find(rows, 'round-2'), { asked: 3, answered: 1 })
      assert.equal(find(rows, 'round-1').blind, false)
    })
    it('stays blind while the Run waits on a person or a stall, and ends with the round or the Run', () => {
      assert.equal(find(rowsOf(specialists({}, 'running', { state: 'stalled' })), 'round-2').blind, true)
      assert.equal(find(rowsOf(specialists({}, 'closed')), 'round-2').blind, false)
      for (const state of ['stopped', 'settled'] as const) assert.equal(find(rowsOf(specialists({}, 'running', { state })), 'round-2').blind, false)
    })
    it('uses the host flag regardless of grant, and never guesses it for an older host', () => {
      assert.equal(find(rowsOf(specialists({ blind: false })), 'round-2').blind, false)
      assert.equal(find(rowsOf(specialists({ grant: 'edit' })), 'round-2').blind, true)
      const older = specialists()
      assert.equal(find(rowsOf({ ...older, execution: { ...older.execution, rounds: older.execution.rounds.map(one => { const { blind: _blind, ...rest } = one; return rest }) } }), 'round-2').blind, false)
      assert.equal(find(rowsOf(specialists({ grant: 'edit', blind: true })), 'round-2').blind, true)
    })
    it('is not blind for one card', () => {
      const one = specialists()
      const lone = { ...one, execution: { ...one.execution, rounds: [one.execution.rounds[0]!, { ...one.execution.rounds[1]!, cards: [2] }] } }
      assert.equal(find(rowsOf(lone), 'round-2').blind, false)
    })
  })
})

describe('runTimeline · a comparison', () => {
  it('names each competitor an attempt, in the order its round opened them', () => {
    const rows = rowsOf(comparison())
    assert.equal(find(rows, 'card-1-1').attempt, 'Attempt A')
    assert.equal(find(rows, 'card-1-2').attempt, 'Attempt B')
    assert.equal(find(rows, 'check-2-3').attempt, null)
    assert.equal(find(rows, 'card-3-5').attempt, null)
  })
  it('is not an attempt unless the Seats were isolated from one another', () => {
    const shared = comparison()
    const roles = shared.execution.document.flow.roles.map(role => role.id === 'competitor' && role.kind === 'agent' ? { ...role, isolate: false } : role)
    const rows = rowsOf({ ...shared, execution: { ...shared.execution, document: { format: 'agents', flow: { ...shared.execution.document.flow, roles } as never } } })
    assert.equal(find(rows, 'card-1-1').attempt, null)
    assert.equal(find(rows, 'check-2-3').on, null)
    assert.equal(find(rows, 'card-3-5').pick, null)
  })
  it('carries the change each attempt recorded: its size, its revision and its branch', () => {
    assert.deepEqual(find(rowsOf(comparison()), 'card-1-1').change, { revision: REV.a, from: BASE, added: 142, removed: 60, files: 2, cwd: '/work/race-a', branch: 'race/a' })
    assert.equal(find(rowsOf(comparison()), 'person-4-6').change, null)
  })
  it('leaves out a change that is not whole, current and its own', () => {
    for (const odd of [{ restored: true }, { freshness: { state: 'uncommitted' } as const }]) {
      const facts = [view(1, 1, diff(REV.a, 142, 60), { cwd: '/work/race-a', ...odd })]
      assert.equal(find(rowsOf(comparison({ facts })), 'card-1-1').change, null, JSON.stringify(odd))
    }
    const dirty = [view(1, 1, { ...diff(REV.a, 1, 1), dirty: true }, { cwd: '/work/race-a' })]
    assert.equal(find(rowsOf(comparison({ facts: dirty })), 'card-1-1').change, null)
  })

  describe('a check per attempt', () => {
    it('names the attempt a check ran on, from the revision it ran at', () => {
      const rows = rowsOf(comparison())
      assert.equal(find(rows, 'check-2-3').on, 'Attempt A')
      assert.equal(find(rows, 'check-2-4').on, 'Attempt B')
    })
    it('names it from the order of the cards when no check has run yet and the counts agree', () => {
      const rows = rowsOf(comparison({ facts: [view(1, 1, diff(REV.a, 1, 1)), view(2, 1, diff(REV.b, 1, 1))] }))
      assert.equal(find(rows, 'check-2-3').on, 'Attempt A')
      assert.equal(find(rows, 'check-2-4').on, 'Attempt B')
    })
    it('says nothing when it cannot tell: a check that ran at a revision of none, or counts that disagree', () => {
      const stray = comparison({ facts: [view(1, 1, diff(REV.a, 1, 1)), view(2, 1, diff(REV.b, 1, 1)), view(3, 2, ran(REV.c, 0))] })
      assert.equal(find(rowsOf(stray), 'check-2-3').on, null)
      const three = comparison({ facts: [] })
      three.execution = { ...three.execution, rounds: three.execution.rounds.map(one => one.n === 2 ? { ...one, cards: [3, 4, 7] } : one) }
      three.cards.push(card(7, 'verify', { outcome: 'pass' }))
      assert.equal(find(rowsOf(three), 'check-2-3').on, null)
    })
  })

  describe('a pick keeps one attempt', () => {
    it('names the revision the judge picked on its card, with each attempt and whether it was kept', () => {
      const rows = rowsOf(comparison())
      assert.deepEqual(find(rows, 'card-3-5').pick, { revision: REV.a, attempts: [
        { card: 1, label: 'Attempt A', revision: REV.a, keep: 'kept' }, { card: 2, label: 'Attempt B', revision: REV.b, keep: 'not-kept' }] })
      assert.equal(find(rows, 'card-1-1').keep, 'kept')
      assert.equal(find(rows, 'card-1-2').keep, 'not-kept')
    })
    it('keeps nothing until a review has picked', () => {
      const facts = comparison().evidence.cards.flatMap(one => one.facts).filter(one => one.record.fact.kind !== 'review')
      const rows = rowsOf(comparison({ facts }))
      assert.equal(find(rows, 'card-3-5').pick, null)
      assert.equal(find(rows, 'card-1-1').keep, null)
    })
    it('ignores a review that picked nothing, one only a backup recorded, and the answer "neither"', () => {
      for (const odd of [{ restored: true }, {}] as const) {
        const verdict = Object.keys(odd).length ? 'picked' : 'neither'
        const facts = [view(1, 1, diff(REV.a, 1, 1)), view(2, 1, diff(REV.b, 1, 1)), view(5, 3, { kind: 'review', verdict, by: 'seat-5' as never, at: REV.a }, odd)]
        assert.equal(find(rowsOf(comparison({ facts })), 'card-3-5').pick, null, JSON.stringify(odd))
      }
    })
    it('leaves each attempt undecided when the pick names a revision of none of them', () => {
      const facts = [view(1, 1, diff(REV.a, 1, 1)), view(2, 1, diff(REV.b, 1, 1)), view(5, 3, { kind: 'review', verdict: 'picked', by: 'seat-5' as never, at: REV.c })]
      const rows = rowsOf(comparison({ facts }))
      assert.deepEqual(find(rows, 'card-3-5').pick?.attempts.map(one => one.keep), [null, null])
      assert.equal(find(rows, 'card-3-5').pick?.revision, REV.c)
      assert.equal(find(rows, 'card-1-1').keep, null)
    })
    it('does not guess the revision of an attempt that recorded no change', () => {
      const facts = [view(1, 1, diff(REV.a, 1, 1)), view(5, 3, { kind: 'review', verdict: 'picked', by: 'seat-5' as never, at: REV.a })]
      const attempts = find(rowsOf(comparison({ facts })), 'card-3-5').pick!.attempts
      assert.deepEqual(attempts.map(one => [one.label, one.revision, one.keep]), [['Attempt A', REV.a, 'kept'], ['Attempt B', null, null]])
    })
  })

  describe('findings on an attempt that was not kept', () => {
    const finding = (id: string, patch: Partial<FindingView> = {}): FindingView => ({ id, origin: { goal: 'team', run: 'run', round: 3, card: 5, seat: 'seat-5', at: REV.b }, ownerGoal: 'team',
      title: `Finding ${id}`, body: '', category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
      sequence: 1, evidence: [], posted: [], restored: false, problem: null, ...patch }) as FindingView
    it('says Not kept beside the lifecycle the finding is still in', () => {
      const findings = [finding('kept'), finding('lost', { activeBlocking: false, inactiveReason: 'The review selected revision bbbbbbbbbbbb for the next step.' })]
      const detail = find(rowsOf({ ...comparison(), findings }), 'findings-3').detail!.split('\n')
      assert.deepEqual(detail, ['Finding kept · Open', 'Finding lost · Open · Not kept'])
    })
  })
})

describe('runTimeline · a person’s step', () => {
  it('gives the card the words of its step, without the instructions the engine adds for an agent', () => {
    const referee = find(rowsOf(comparison()), 'person-4-6')
    assert.equal(referee.summary, `Merge exactly ${REV.a}, the revision the judge picked.`)
  })
  it('gives an agent card its completion note, else the first paragraph of its handoff, else nothing', () => {
    const rows = rowsOf(comparison())
    assert.equal(find(rows, 'card-1-1').summary, 'Caches the ranked results per query.')
    const input = comparison()
    input.cards[0] = card(1, 'competitor', { note: '  ', handoff: 'First paragraph.\n\nSecond paragraph.' })
    input.cards[1] = card(2, 'competitor')
    const out = rowsOf(input)
    assert.equal(find(out, 'card-1-1').summary, 'First paragraph.')
    assert.equal(find(out, 'card-1-2').summary, null)
  })

  describe('the rounds that wait on it', () => {
    const alignment = (state: FlowExecution['state'] = 'running', personState: Intent['state'] = 'open') => {
      const roles = [agent('propose', { grant: 'read' }), person('align', ['agreed', 'disagree']), agent('build')]
      const rules = [
        { id: 'to-align', on: 'propose', when: { every: ['agreed'] }, then: { role: 'align', title: 'Agree the plan before anything is built' } },
        { id: 'to-build', on: 'align', when: { every: ['agreed'] }, then: { role: 'build', title: 'Build the agreed plan' } },
      ] as FlowPolicy['rules']
      return { execution: execution(roles, [round(1, 'propose', [1], 'closed'), round(2, 'align', [2], 'running')], { state }, rules),
        cards: [card(1, 'propose', { outcome: 'agreed' }), card(2, 'align', { state: personState, outcome: null, claim: null, title: 'Agree the plan before anything is built' })] }
    }
    it('lists the rounds its Flow opens after the answer, as not yet reached', () => {
      const rows = rowsOf(alignment())
      const ahead = rows.filter(one => one.kind === 'ahead')
      assert.deepEqual(ahead.map(one => [one.id, one.title, one.detail, one.round, one.status]), [['ahead-3', 'Round 3 · build', 'Build the agreed plan', null, 'Not reached']])
      assert.equal(rows.at(-1)!.kind, 'ahead')
    })
    it('draws none once the person has answered, or the Run has ended, or nothing follows the step', () => {
      assert.equal(rowsOf(alignment('running', 'done')).some(one => one.kind === 'ahead'), false)
      for (const state of ['stopped', 'settled'] as const) assert.equal(rowsOf(alignment(state)).some(one => one.kind === 'ahead'), false, state)
      assert.equal(rowsOf(comparison()).some(one => one.kind === 'ahead'), false)
    })
    it('follows a single way on, and stops where the Flow forks or comes back round', () => {
      const input = alignment()
      const flow = input.execution.document.flow
      const forked = { ...flow, rules: [...flow.rules, { id: 'to-ship', on: 'align', when: { any: ['disagree'] }, then: { role: 'propose', title: 'Plan again' } }] }
      assert.deepEqual(rowsOf({ ...input, execution: { ...input.execution, document: { format: 'agents', flow: forked as never } } }).filter(one => one.kind === 'ahead'), [])
      const chained = { ...flow, roles: [...flow.roles, check('land')], rules: [...flow.rules, { id: 'to-land', on: 'build', then: { role: 'land', title: 'Land it' } }, { id: 'again', on: 'land', then: { role: 'build', title: 'Build again' } }] }
      assert.deepEqual(rowsOf({ ...input, execution: { ...input.execution, document: { format: 'agents', flow: chained as never } } }).filter(one => one.kind === 'ahead').map(one => one.id), ['ahead-3', 'ahead-4'])
    })
  })
})

describe('runTimeline · a committed answer', () => {
  const investigation = (facts: EvidenceView[], extra: Partial<FlowExecution> = {}) => {
    const roles = [agent('research'), person('close', ['closed'])]
    const rules = [{ id: 'to-close', on: 'research', when: { every: ['gathered'], evidence: [{ diff: true }] }, then: { role: 'close', title: 'Read the committed answer' } }] as FlowPolicy['rules']
    return { execution: execution(roles, [round(1, 'research', [1], 'closed'), round(2, 'close', [2], 'running')], extra, rules),
      cards: [card(1, 'research', { outcome: 'gathered', note: 'Friday’s batch export holds a lock.' }), card(2, 'close', { state: 'open', outcome: null, title: 'Read the committed answer' })],
      evidence: board(...facts) }
  }
  it('says what a Run that makes no pull request made, when its Flow has a person read the committed change', () => {
    const input = investigation([view(1, 1, diff(REV.a, 84, 0, 1), { cwd: '/work/research', branch: 'research/fridays' })])
    assert.deepEqual(runTimeline(input).header.answer, { revision: REV.a })
    assert.deepEqual(find(rowsOf(input), 'card-1-1').change, { revision: REV.a, from: BASE, added: 84, removed: 0, files: 1, cwd: '/work/research', branch: 'research/fridays' })
  })
  it('says nothing before the answer is committed, or when a pull request says what was made', () => {
    assert.equal(runTimeline(investigation([])).header.answer, null)
    const pr: Evidence = { kind: 'pr', number: 12, head: REV.a, state: 'open', url: 'https://example.com/pull/12' }
    assert.equal(runTimeline(investigation([view(1, 1, diff(REV.a, 84, 0, 1)), view(1, 1, pr)])).header.answer, null)
  })
  it('says nothing of a Flow whose people read no committed change', () => {
    assert.equal(runTimeline(comparison()).header.answer, null)
  })
})

it('keeps only the selected checkout when competitors record the same revision', () => {
  const facts = [view(1, 1, diff(REV.a, 10, 0), { cwd: '/work/a' }), view(2, 1, diff(REV.a, 10, 0), { cwd: '/work/b' }),
    view(5, 3, { kind: 'review', verdict: 'picked', by: 'seat-5' as never, at: REV.a }, { cwd: '/work/a' })]
  const rows = rowsOf(comparison({ facts }))
  assert.equal(find(rows, 'card-1-1').keep, 'kept')
  assert.equal(find(rows, 'card-1-2').keep, 'not-kept')
  const ambiguous = rowsOf(comparison({ facts: facts.map(one => one.record.fact.kind === 'review' ? { ...one, record: { ...one.record, checkout: undefined } } : one) }))
  assert.equal(find(ambiguous, 'card-1-1').keep, null)
  assert.equal(find(ambiguous, 'card-1-2').keep, null)
})
