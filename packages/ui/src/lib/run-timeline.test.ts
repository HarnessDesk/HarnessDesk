import { describe, expect, it } from 'vitest'
import { runtimeId, sessionId, sessionKey, turnId, type BoardEvidence, type FindingView, type FlowExecution, type Intent, type Session, type TeamSignal } from '@harnessdesk/protocol'
import { runTimeline } from './run-timeline'

const run = (patch: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2, id: 'run', goal: 'team', state: 'running', reason: null, legacyRun: null,
  operations: [], rounds: [{ n: 1, role: 'writer', cards: [1], seats: ['Alpha'], evidence: [], state: 'running', cause: 'seed' }],
  document: { format: 'agents', flow: { version: 2, name: 'Build and review', inputs: [], roles: [
    { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } },
    { id: 'person', kind: 'person', outcomes: ['yes'] },
  ], rules: [], seed: { role: 'writer', title: 'Build' }, messaging: 'board-only', wait: 1 } }, ...patch,
})
const card = (patch: Partial<Intent> = {}): Intent => ({ id: 1, title: 'Build', state: 'claimed', claim: { runtime: runtimeId('agent'), sessionId: 'alpha', at: 100 }, createdAt: 50, updatedAt: 300, files: [], dependsOn: [], ...patch })
const signal = (at: number, event: TeamSignal['signal']): TeamSignal => ({ id: `${event}-${at}`, kind: 'signal', at, signal: event, intent: 1, title: 'Build', by: { kind: 'agent', runtime: runtimeId('agent'), sessionId: 'alpha', title: 'Alpha' } })
const session = (startedAt = 100, busy = true): Session => ({ runtime: runtimeId('agent'), id: sessionId('alpha'), cwd: '/work/project',
  createdAt: 50, updatedAt: 300, itemsLoaded: true, status: { type: busy ? 'active' : 'idle' },
  turns: [{ id: turnId('turn'), startedAt, status: busy ? 'inProgress' : 'completed', items: [] }] })
const evidence: BoardEvidence = { room: 'team', stamp: 400, checks: [], refused: [], unreadable: null, cards: [{ card: 1, running: [], facts: [{ freshness: { state: 'fresh' }, by: null, record: { id: 'check', observedAt: 350, round: 1, fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, at: 'abc', dirty: false, tail: 'passed' } } }] }] }

describe('runTimeline', () => {
  it('restores live claimed work after a stopped Run resumes, despite its historical end', () => {
    const execution = { ...run({ endedAt: 250 }), currentEndedAt: null }
    const resumed = card({ claim: { ...card().claim!, at: 400 }, updatedAt: 400 })
    expect(runTimeline({ execution, cards: [resumed] }).rows.find(row => row.card === 1))
      .toMatchObject({ status: 'Working', working: true, since: 400, durationMs: null })
  })
  it('does not infer the current ending or its turn from an older Run’s first departure', () => {
    const execution = run({ state: 'stopped', endedAt: 250 })
    const sessions = new Map([[sessionKey('agent', 'alpha'), session(100)]])
    const model = runTimeline({ execution, cards: [card()], sessions })
    expect(model.rows.find(row => row.card === 1)).toMatchObject({ status: 'Stopped', working: false, durationMs: null })
    expect(model.rows.at(-1)?.since).toBeNull()
  })
  it('uses the second stop after a stall and resume for retained work and the end row', () => {
    const execution = { ...run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), currentEndedAt: 700 }
    const resumed = card({ claim: { ...card().claim!, at: 400 }, updatedAt: 400 })
    for (const busy of [true, false]) {
      const sessions = new Map([[sessionKey('agent', 'alpha'), session(400, busy)]])
      const model = runTimeline({ execution, cards: [resumed], sessions })
      expect(model.rows.find(row => row.card === 1))
        .toMatchObject({ status: busy ? 'Stopping' : 'Stopped', working: false, durationMs: 300 })
      expect(model.rows.at(-1)?.since).toBe(700)
    }
    expect(execution.endedAt).toBe(250)
  })
  it('keeps a completed post-resume claim and round at their true duration', () => {
    const completed = card({ state: 'done', outcome: 'published', claim: null, updatedAt: 650 })
    const signals = [signal(100, 'claimed'), signal(300, 'completed'), signal(400, 'claimed'), signal(650, 'completed')]
    for (const state of ['running', 'settled'] as const) {
      const execution = { ...run({ state, endedAt: 250, rounds: [{ ...run().rounds[0]!, state: 'closed' }] }), currentEndedAt: state === 'running' ? null : 700 }
      const model = runTimeline({ execution, cards: [completed], signals })
      expect(model.rows.find(row => row.card === 1)).toMatchObject({ status: 'Published', durationMs: 250, working: false })
      expect(model.rows.find(row => row.kind === 'round')?.durationMs).toBe(250)
    }
  })
  it.each(['stopped', 'settled', 'stalled'] as const)('freezes claimed work when the Run is %s, until and after its turn ends', state => {
    const execution = run({ state, endedAt: 250, currentEndedAt: 250 })
    for (const busy of [true, false]) {
      const sessions = new Map([[sessionKey('agent', 'alpha'), session(100, busy)]])
      expect(runTimeline({ execution, cards: [card()], sessions }).rows.find(row => row.card === 1))
        .toMatchObject({ status: busy ? 'Stopping' : 'Stopped', working: false, durationMs: 150 })
    }
  })
  it('does not call an absent or later follow-up turn Stopping, or invent a missing end time', () => {
    for (const sessions of [undefined, new Map([[sessionKey('agent', 'alpha'), session(400)]])]) {
      expect(runTimeline({ execution: run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), cards: [card()], sessions }).rows.find(row => row.card === 1))
        .toMatchObject({ status: 'Stopped', working: false, durationMs: 150 })
    }
    expect(runTimeline({ execution: run({ state: 'stopped' }), cards: [card()] }).rows.find(row => row.card === 1))
      .toMatchObject({ status: 'Stopped', working: false, durationMs: null })
  })
  it('keeps a late completion duration bounded by the Run end without losing its answer', () => {
    expect(runTimeline({ execution: run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), cards: [card({ state: 'done', outcome: 'published' })] }).rows.find(row => row.card === 1))
      .toMatchObject({ status: 'Published', working: false, durationMs: 150 })
  })
  it.each(['verify', 'person'])('does not leave a claimed %s step Working after the Run ends', role => {
    const execution = run({ state: 'stopped', endedAt: 250, currentEndedAt: 250, rounds: [{ ...run().rounds[0]!, role }],
      operations: [{ key: 'check', kind: 'check', state: 'started', seat: null, card: 1 }] })
    expect(runTimeline({ execution, cards: [card()] }).rows.find(row => row.card === 1))
      .toMatchObject({ status: 'Stopped', working: false, durationMs: 150 })
  })
  it.each([
    ['published', 'Published'], ['committed', 'Committed'], ['approve', 'Approve'],
    ['request-changes', 'Request changes'], ['agreed', 'Agreed'], ['disagree', 'Disagree'],
    ['pass', 'Pass'], ['fail', 'Fail'], ['passed', 'Passed'], ['failed', 'Failed'],
    ['no-pr', 'No pr'], ['needs_follow_up', 'Needs follow up'],
  ])('reads the verdict %s in the shared app vocabulary as %s', (outcome, status) => {
    for (const role of ['writer', 'person', 'verify']) {
      const execution = run({ rounds: [{ ...run().rounds[0]!, role }] })
      expect(runTimeline({ execution, cards: [card({ state: 'done', outcome })] }).rows.find(row => row.card === 1)?.status).toBe(status)
    }
  })
  it.each(['running', 'settled', 'stopped', 'stalled'] as const)('reads %s without inventing unavailable fields', state => {
    const model = runTimeline({ execution: run({ state }), cards: [card()] })
    expect(model.header.state).toBe(state)
    expect(model.header.revision).toBeNull()
    expect(model.rows.map(row => row.kind)).toEqual(state === 'running' ? ['start', 'round', 'card'] : ['start', 'round', 'card', 'end'])
    expect(model.rows.some(row => row.kind === 'findings')).toBe(false)
  })
  it('keeps repeated roles in distinct rounds, oldest first, and never draws future work', () => {
    const first = run().rounds[0]!
    const model = runTimeline({ execution: run({ brief: 'Build it', revision: 'digest', continues: 'old-run', rounds: [{ ...first, n: 2, cards: [2] }, { ...first, state: 'closed' }] }), cards: [card(), card({ id: 2 })] })
    expect(model.rows.map(row => row.id)).toEqual(['start', 'brief', 'round-1', 'card-1-1', 'round-2', 'card-2-2'])
    expect(model.header).toMatchObject({ revision: 'digest', continues: 'old-run' })
  })
  it('uses claim signals after completion clears a claim; unrelated updates do not start a duration', () => {
    const model = runTimeline({ execution: run(), cards: [card({ state: 'done', claim: null })], signals: [signal(80, 'claimed'), signal(90, 'completed'), signal(120, 'claimed'), signal(300, 'completed')] })
    expect(model.rows.find(row => row.kind === 'card')?.durationMs).toBe(180)
    expect(runTimeline({ execution: run(), cards: [card({ state: 'done', claim: null })] }).rows.find(row => row.kind === 'card')?.durationMs).toBeNull()
  })
  it('reads the latest matching check result and the operation while a check runs', () => {
    const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
    const input = { execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence }
    expect(runTimeline(input).rows.find(row => row.kind === 'check')).toMatchObject({ title: 'pnpm verify', status: 'Passed' })
    expect(runTimeline({ ...input, execution: { ...execution, operations: [{ key: 'check', kind: 'check', state: 'started', seat: null, card: 1 }] } }).rows.find(row => row.kind === 'check')?.status).toBe('Working')
    expect(runTimeline({ ...input, execution: { ...execution, operations: [{ key: 'check', kind: 'check', state: 'uncertain', seat: null, card: 1 }] } }).rows.find(row => row.kind === 'check')?.status).toBe('Needs you')
  })
  it('does not substitute another check command or invent output while evidence is unavailable', () => {
    const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
    const changed = { ...evidence, cards: evidence.cards.map(one => ({ ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, fact: { ...view.record.fact, run: 'another command' } } })) })) } as BoardEvidence
    expect(runTimeline({ execution, cards: [card({ state: 'done' })], evidence: changed }).rows.find(row => row.kind === 'check')?.status).toBe('Result unavailable')
  })
  it('shows a person step waiting and preserves the host reason for an unrouted outcome', () => {
    const execution = run({ state: 'settled', end: { kind: 'unrouted', card: 1, outcome: 'no-pr' }, reason: 'The landing check answered no-pr; no rule continues from it', rounds: [{ ...run().rounds[0]!, role: 'person' }] })
    const model = runTimeline({ execution, cards: [card({ state: 'done', claim: null, outcome: 'no-pr' })] })
    expect(model.header.needsYou).toBe(true)
    expect(model.rows.find(row => row.kind === 'person')?.status).toBe('No pr')
    expect(runTimeline({ execution: run({ rounds: [{ ...run().rounds[0]!, role: 'person' }] }), cards: [card({ state: 'open', claim: null })] }).rows.find(row => row.kind === 'person')).toMatchObject({ status: 'Needs you', attention: true })
    expect(model.rows.at(-1)).toMatchObject({ title: 'Ended without a next step', detail: execution.reason })
  })
})

it('groups findings only by their recorded Run and round, with repair claims distinguished', () => {
  const finding: FindingView = { id: 'finding', title: 'Cap the retries', body: 'Bound the attempts.',
    origin: { goal: 'team', run: 'run', round: 1, card: 1, seat: 'reviewer', at: 'abc' }, ownerGoal: 'team',
    category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'repaired', confirmed: false, repairs: ['def'] },
    sequence: 2, evidence: [], posted: [], restored: false, problem: null }
  const model = runTimeline({ execution: run(), cards: [card()], findings: [finding, { ...finding, id: 'old-finding', origin: { ...finding.origin, run: 'old-run' } }] })
  expect(model.rows.filter(row => row.kind === 'findings')).toHaveLength(1)
  expect(model.rows.find(row => row.kind === 'findings')).toMatchObject({ title: '1 finding', detail: 'Cap the retries · Repair claimed · awaiting review' })
})

it.each([
  { state: 'repaired', confirmed: false },
  { state: 'repaired', confirmed: true },
  { state: 'withdrawn', confirmed: true },
] as const)('keeps a damaged $state finding unreadable even when confirmed=$confirmed', lifecycle => {
  const finding: FindingView = { id: 'damaged-finding', title: 'Cap the retries', body: 'Bound the attempts.',
    origin: { goal: 'team', run: 'run', round: 1, card: 1, seat: 'reviewer', at: 'abc' }, ownerGoal: 'team',
    category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { ...lifecycle, repairs: ['def'] },
    sequence: 4, evidence: [], posted: [], restored: false, problem: 'The finding history has a missing sequence.' }
  const detail = runTimeline({ execution: run(), cards: [card()], findings: [finding] }).rows.find(row => row.kind === 'findings')?.detail
  expect(detail).toBe('Cap the retries · Unreadable · The finding history has a missing sequence.')
})

it('does not replace a Flow check with a later project check of the same command', () => {
  const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
  const earlier = evidence.cards[0]!.facts[0]!
  const later = { ...earlier, record: { ...earlier.record, id: 'project-check', observedAt: 400, fact: { ...earlier.record.fact, name: 'project-verify', exit: 1 } } }
  const mixed = { ...evidence, cards: [{ ...evidence.cards[0]!, facts: [earlier, later] }] } as BoardEvidence
  expect(runTimeline({ execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence: mixed }).rows.find(row => row.kind === 'check')?.status).toBe('Passed')
})

it('does not ask for an answer to a person step in a stopped Run or a closed round', () => {
  const round = { ...run().rounds[0]!, role: 'person' }
  for (const execution of [run({ state: 'stopped', rounds: [round] }), run({ rounds: [{ ...round, state: 'closed' }] })]) {
    const model = runTimeline({ execution, cards: [card({ state: 'open', claim: null })] })
    expect(model.rows.find(row => row.kind === 'person')).toMatchObject({ status: 'Waiting', attention: false })
  }
})

it('attributes a card to its recorded Seat when recovery reordered the round roster', () => {
  const first = run().rounds[0]!
  const execution = run({ rounds: [{ ...first, cards: [1, 2], seats: ['Beta', 'Alpha'] }], operations: [
    { key: 'seat-1', kind: 'seat', state: 'finished', card: 1, seat: 'Alpha' },
    { key: 'seat-2', kind: 'seat', state: 'finished', card: 2, seat: 'Beta' },
  ] })
  expect(runTimeline({ execution, cards: [card(), card({ id: 2 })] }).rows.filter(row => row.kind === 'card').map(row => row.seat)).toEqual(['Alpha', 'Beta'])
  expect(runTimeline({ execution: run(), cards: [card()] }).rows.find(row => row.kind === 'card')?.seat).toBeNull()
})

it('does not use a manual same-name check as a Flow result without round attribution', () => {
  const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
  const manual = { ...evidence, cards: evidence.cards.map(one => ({ ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, round: null, fact: { ...view.record.fact, exit: 1 } } })) })) } as BoardEvidence
  expect(runTimeline({ execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence: manual }).rows.find(row => row.kind === 'check')?.status).toBe('Pass')
})
