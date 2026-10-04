import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runtimeId, sessionId, sessionKey, turnId, type Session, type FindingRunView, type FlowCheckAttempt, type BoardEvidence, type FindingView, type FlowExecution, type Intent, type TeamSignal } from '@harnessdesk/protocol'
import { runTimeline } from '../../src/views/run-timeline.js'

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
    assert.partialDeepStrictEqual(runTimeline({ execution, cards: [resumed] }).rows.find(row => row.card === 1), { status: 'Working', working: true, since: 400, durationMs: null })
  })
  it('does not infer the current ending or its turn from an older Run’s first departure', () => {
    const execution = run({ state: 'stopped', endedAt: 250 })
    const sessions = new Map([[sessionKey('agent', 'alpha'), session(100)]])
    const model = runTimeline({ execution, cards: [card()], sessions })
    assert.partialDeepStrictEqual(model.rows.find(row => row.card === 1), { status: 'Stopped', working: false, durationMs: null })
    assert.equal(model.rows.at(-1)?.since, null)
  })
  it('uses the second stop after a stall and resume for retained work and the end row', () => {
    const execution = { ...run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), currentEndedAt: 700 }
    const resumed = card({ claim: { ...card().claim!, at: 400 }, updatedAt: 400 })
    for (const busy of [true, false]) {
      const sessions = new Map([[sessionKey('agent', 'alpha'), session(400, busy)]])
      const model = runTimeline({ execution, cards: [resumed], sessions })
      assert.partialDeepStrictEqual(model.rows.find(row => row.card === 1), { status: busy ? 'Stopping' : 'Stopped', working: false, durationMs: 300 })
      assert.equal(model.rows.at(-1)?.since, 700)
    }
    assert.equal(execution.endedAt, 250)
  })
  it('keeps a completed post-resume claim and round at their true duration', () => {
    const completed = card({ state: 'done', outcome: 'published', claim: null, updatedAt: 650 })
    const signals = [signal(100, 'claimed'), signal(300, 'completed'), signal(400, 'claimed'), signal(650, 'completed')]
    for (const state of ['running', 'settled'] as const) {
      const execution = { ...run({ state, endedAt: 250, rounds: [{ ...run().rounds[0]!, state: 'closed' }] }), currentEndedAt: state === 'running' ? null : 700 }
      const model = runTimeline({ execution, cards: [completed], signals })
      assert.partialDeepStrictEqual(model.rows.find(row => row.card === 1), { status: 'Published', durationMs: 250, working: false })
      assert.equal(model.rows.find(row => row.kind === 'round')?.durationMs, 250)
    }
  })
  ;(['stopped', 'settled', 'stalled'] as const).forEach((state) => it('freezes claimed work when the Run is %s, until and after its turn ends' + JSON.stringify(state), () => {
    const execution = run({ state, endedAt: 250, currentEndedAt: 250 });
    for (const busy of [true, false]) {
        const sessions = new Map([[sessionKey('agent', 'alpha'), session(100, busy)]]);
        assert.partialDeepStrictEqual(runTimeline({ execution, cards: [card()], sessions }).rows.find(row => row.card === 1), { status: busy ? 'Stopping' : 'Stopped', working: false, durationMs: 150 });
    }
}));
  it('does not call an absent or later follow-up turn Stopping, or invent a missing end time', () => {
    for (const sessions of [undefined, new Map([[sessionKey('agent', 'alpha'), session(400)]])]) {
      assert.partialDeepStrictEqual(runTimeline({ execution: run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), cards: [card()], sessions }).rows.find(row => row.card === 1), { status: 'Stopped', working: false, durationMs: 150 })
    }
    assert.partialDeepStrictEqual(runTimeline({ execution: run({ state: 'stopped' }), cards: [card()] }).rows.find(row => row.card === 1), { status: 'Stopped', working: false, durationMs: null })
  })
  it('keeps a late completion duration bounded by the Run end without losing its answer', () => {
    assert.partialDeepStrictEqual(runTimeline({ execution: run({ state: 'stopped', endedAt: 250, currentEndedAt: 250 }), cards: [card({ state: 'done', outcome: 'published' })] }).rows.find(row => row.card === 1), { status: 'Published', working: false, durationMs: 150 })
  })
  ;['verify', 'person'].forEach((role) => it('does not leave a claimed %s step Working after the Run ends' + JSON.stringify(role), () => {
    const execution = run({ state: 'stopped', endedAt: 250, currentEndedAt: 250, rounds: [{ ...run().rounds[0]!, role }],
        operations: [{ key: 'check', kind: 'check', state: 'started', seat: null, card: 1 }] });
    assert.partialDeepStrictEqual(runTimeline({ execution, cards: [card()] }).rows.find(row => row.card === 1), { status: 'Stopped', working: false, durationMs: 150 });
}));
  it('a completed Run says nothing waits even when its recorded reason predates that distinction', () => {
    const model = runTimeline({ execution: run({ state: 'settled', end: { kind: 'complete' }, reason: 'No rule continues, so this waits for you.' }), cards: [] })
    assert.equal(model.rows.at(-1)?.detail, 'Nothing waits.')
  })
  ;[
    ['published', 'Published'], ['committed', 'Committed'], ['approve', 'Approve'],
    ['request-changes', 'Request changes'], ['agreed', 'Agreed'], ['disagree', 'Disagree'],
    ['pass', 'Pass'], ['fail', 'Fail'], ['passed', 'Passed'], ['failed', 'Failed'],
    ['no-pr', 'No pr'], ['needs_follow_up', 'Needs follow up'],
].forEach(([outcome, status]) => it('reads the verdict %s in the shared app vocabulary as %s' + JSON.stringify([outcome, status]), () => {
    for (const role of ['writer', 'person', 'verify']) {
        const execution = run({ rounds: [{ ...run().rounds[0]!, role }] });
        assert.equal(runTimeline({ execution, cards: [card({ state: 'done', outcome })] }).rows.find(row => row.card === 1)?.status, status);
    }
}));
  ;(['running', 'settled', 'stopped', 'stalled'] as const).forEach((state) => it('reads %s without inventing unavailable fields' + JSON.stringify(state), () => {
    const model = runTimeline({ execution: run({ state }), cards: [card()] });
    assert.equal(model.header.state, state);
    assert.equal(model.header.revision, null);
    assert.deepEqual(model.rows.map(row => row.kind), state === 'running' ? ['start', 'round', 'card'] : ['start', 'round', 'card', 'end']);
    assert.equal(model.rows.some(row => row.kind === 'findings'), false);
}));
  it('keeps repeated roles in distinct rounds, oldest first, and never draws future work', () => {
    const first = run().rounds[0]!
    const model = runTimeline({ execution: run({ brief: 'Build it', revision: 'digest', continues: 'old-run', rounds: [{ ...first, n: 2, cards: [2] }, { ...first, state: 'closed' }] }), cards: [card(), card({ id: 2 })] })
    assert.deepEqual(model.rows.map(row => row.id), ['start', 'brief', 'round-1', 'card-1-1', 'round-2', 'card-2-2'])
    assert.partialDeepStrictEqual(model.header, { revision: 'digest', continues: 'old-run' })
  })
  it('uses claim signals after completion clears a claim; unrelated updates do not start a duration', () => {
    const model = runTimeline({ execution: run(), cards: [card({ state: 'done', claim: null })], signals: [signal(80, 'claimed'), signal(90, 'completed'), signal(120, 'claimed'), signal(300, 'completed')] })
    assert.equal(model.rows.find(row => row.kind === 'card')?.durationMs, 180)
    assert.equal(runTimeline({ execution: run(), cards: [card({ state: 'done', claim: null })] }).rows.find(row => row.kind === 'card')?.durationMs, null)
  })
  it('reads the latest matching check result and the operation while a check runs', () => {
    const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
    const input = { execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence }
    assert.partialDeepStrictEqual(runTimeline(input).rows.find(row => row.kind === 'check'), { title: 'pnpm verify', status: 'Passed' })
    assert.equal(runTimeline({ ...input, execution: { ...execution, operations: [{ key: 'check', kind: 'check', state: 'started', seat: null, card: 1 }] } }).rows.find(row => row.kind === 'check')?.status, 'Working')
    assert.equal(runTimeline({ ...input, execution: { ...execution, operations: [{ key: 'check', kind: 'check', state: 'uncertain', seat: null, card: 1 }] } }).rows.find(row => row.kind === 'check')?.status, 'Needs you')
  })
  it('does not substitute another check command or invent output while evidence is unavailable', () => {
    const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
    const changed = { ...evidence, cards: evidence.cards.map(one => ({ ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, fact: { ...view.record.fact, run: 'another command' } } })) })) } as BoardEvidence
    assert.equal(runTimeline({ execution, cards: [card({ state: 'done' })], evidence: changed }).rows.find(row => row.kind === 'check')?.status, 'Result unavailable')
  })
  it('shows a person step waiting and preserves the host reason for an unrouted outcome', () => {
    const execution = run({ state: 'settled', end: { kind: 'unrouted', card: 1, outcome: 'no-pr' }, reason: 'The landing check answered no-pr; no rule continues from it', rounds: [{ ...run().rounds[0]!, role: 'person' }] })
    const model = runTimeline({ execution, cards: [card({ state: 'done', claim: null, outcome: 'no-pr' })] })
    assert.equal(model.header.needsYou, true)
    assert.equal(model.rows.find(row => row.kind === 'person')?.status, 'No pr')
    assert.partialDeepStrictEqual(runTimeline({ execution: run({ rounds: [{ ...run().rounds[0]!, role: 'person' }] }), cards: [card({ state: 'open', claim: null })] }).rows.find(row => row.kind === 'person'), { status: 'Needs you', attention: true })
    assert.partialDeepStrictEqual(model.rows.at(-1), { title: 'Ended without a next step', detail: execution.reason })
  })
})

it('groups findings only by their recorded Run and round, with repair claims distinguished', () => {
  const finding: FindingView = { id: 'finding', title: 'Cap the retries', body: 'Bound the attempts.',
    origin: { goal: 'team', run: 'run', round: 1, card: 1, seat: 'reviewer', at: 'abc' }, ownerGoal: 'team',
    category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'repaired', confirmed: false, repairs: ['def'] },
    sequence: 2, evidence: [], posted: [], restored: false, problem: null }
  const model = runTimeline({ execution: run(), cards: [card()], findings: [finding, { ...finding, id: 'old-finding', origin: { ...finding.origin, run: 'old-run' } }] })
  assert.equal(model.rows.filter(row => row.kind === 'findings').length, 1)
  assert.partialDeepStrictEqual(model.rows.find(row => row.kind === 'findings'), { title: '1 finding', detail: 'Cap the retries · Repair claimed · awaiting review' })
})

;([
    { state: 'repaired', confirmed: false },
    { state: 'repaired', confirmed: true },
    { state: 'withdrawn', confirmed: true },
] as const).forEach((lifecycle) => it('keeps a damaged $state finding unreadable even when confirmed=$confirmed' + JSON.stringify(lifecycle), () => {
    const finding: FindingView = { id: 'damaged-finding', title: 'Cap the retries', body: 'Bound the attempts.',
        origin: { goal: 'team', run: 'run', round: 1, card: 1, seat: 'reviewer', at: 'abc' }, ownerGoal: 'team',
        category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { ...lifecycle, repairs: ['def'] },
        sequence: 4, evidence: [], posted: [], restored: false, problem: 'The finding history has a missing sequence.' };
    const detail = runTimeline({ execution: run(), cards: [card()], findings: [finding] }).rows.find(row => row.kind === 'findings')?.detail;
    assert.equal(detail, 'Cap the retries · Unreadable · The finding history has a missing sequence.');
}));

it('does not replace a Flow check with a later project check of the same command', () => {
  const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
  const earlier = evidence.cards[0]!.facts[0]!
  const later = { ...earlier, record: { ...earlier.record, id: 'project-check', observedAt: 400, fact: { ...earlier.record.fact, name: 'project-verify', exit: 1 } } }
  const mixed = { ...evidence, cards: [{ ...evidence.cards[0]!, facts: [earlier, later] }] } as BoardEvidence
  assert.equal(runTimeline({ execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence: mixed }).rows.find(row => row.kind === 'check')?.status, 'Passed')
})

it('does not ask for an answer to a person step in a stopped Run or a closed round', () => {
  const round = { ...run().rounds[0]!, role: 'person' }
  for (const execution of [run({ state: 'stopped', rounds: [round] }), run({ rounds: [{ ...round, state: 'closed' }] })]) {
    const model = runTimeline({ execution, cards: [card({ state: 'open', claim: null })] })
    assert.partialDeepStrictEqual(model.rows.find(row => row.kind === 'person'), { status: 'Waiting', attention: false })
  }
})

it('attributes a card to its recorded Seat when recovery reordered the round roster', () => {
  const first = run().rounds[0]!
  const execution = run({ rounds: [{ ...first, cards: [1, 2], seats: ['Beta', 'Alpha'] }], operations: [
    { key: 'seat-1', kind: 'seat', state: 'finished', card: 1, seat: 'Alpha' },
    { key: 'seat-2', kind: 'seat', state: 'finished', card: 2, seat: 'Beta' },
  ] })
  assert.deepEqual(runTimeline({ execution, cards: [card(), card({ id: 2 })] }).rows.filter(row => row.kind === 'card').map(row => row.seat), ['Alpha', 'Beta'])
  assert.equal(runTimeline({ execution: run(), cards: [card()] }).rows.find(row => row.kind === 'card')?.seat, null)
})

it('does not use a manual same-name check as a Flow result without round attribution', () => {
  const execution = run({ rounds: [{ ...run().rounds[0]!, role: 'verify' }] })
  const manual = { ...evidence, cards: evidence.cards.map(one => ({ ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, round: null, fact: { ...view.record.fact, exit: 1 } } })) })) } as BoardEvidence
  assert.equal(runTimeline({ execution, cards: [card({ state: 'done', outcome: 'pass' })], evidence: manual }).rows.find(row => row.kind === 'check')?.status, 'Pass')
})

const publicationRun = (patch: Partial<FindingRunView> = {}): FindingRunView => ({
  run: 'run', goal: 'team', round: 1, finished: 1, total: 1, embargoed: false, open: 1, blocking: 1,
  reason: 'The review was kept on the desk.', ceilingStop: false, stamp: 'publication-stamp', publication: 'local',
  rounds: [{ round: 1, state: 'local', reason: 'The review was kept on the desk.', pr: 7, cards: [1] }],
  reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
  boundPr: { repo: 'acme/widgets', pr: 7 }, unbound: null, undecidable: null, ...patch,
})
const publicationFinding: FindingView = { id: 'publication-finding', title: 'Bound the retry', body: 'Cap attempts.',
  origin: { goal: 'team', run: 'run', round: 1, card: 1, seat: 'reviewer', at: 'abc' }, ownerGoal: 'team',
  category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
  sequence: 1, evidence: [], posted: [], restored: false, problem: null }
;([
    ['posted', true, 7, 'Posted to #7', 'neutral', false],
    ['pending', true, 7, 'Waiting to post', 'neutral', false],
    ['partial', true, 7, 'Partly posted', 'warning', true],
    ['uncertain', true, 7, 'Not confirmed', 'warning', true],
    ['local', true, 7, 'Not posted', 'warning', true],
    ['local', false, 7, 'Kept on the desk', 'neutral', false],
    ['local', true, null, 'Kept on the desk', 'neutral', false],
] as const).forEach(([state, publicationOn, pr, label, tone, needsYou]) => it('maps aggregate %s with posting %s and PR %s' + JSON.stringify([state, publicationOn, pr, label, tone, needsYou]), () => {
    const findingRun = publicationRun({ publication: state, boundPr: pr ? { repo: 'acme/widgets', pr } : null });
    const model = runTimeline({ execution: run({ state: 'settled' }), cards: [card()], findings: [publicationFinding], findingRun, publicationOn });
    assert.deepEqual(model.header.publication, { label, tone, needsYou });
    assert.equal(model.header.needsYou, needsYou);
    assert.deepEqual(model.rows.at(-1)?.publication, model.header.publication);
}));
;[{ rounds: [] }, { rounds: [{ round: 1, state: 'none' as const, reason: null, pr: null, cards: [1] }] }].forEach(({ rounds }) => it('never guesses a round chip from a posted aggregate ($rounds)' + JSON.stringify({ rounds }), () => {
    const model = runTimeline({ execution: run(), cards: [card()], findings: [publicationFinding], findingRun: publicationRun({ publication: 'posted', rounds }) });
    assert.equal(model.header.publication?.label, 'Posted to #7');
    assert.equal(model.rows.find(row => row.card === 1)?.publication, null);
    assert.equal(model.rows.find(row => row.kind === 'findings')?.publication, null);
}));
it('keeps round publication separate from the aggregate and omits chips when there are no findings', () => {
  const input = { execution: run(), cards: [card()], findings: [publicationFinding], findingRun: publicationRun({ publication: 'partial' }) }
  const model = runTimeline(input)
  assert.equal(model.header.publication?.label, 'Partly posted')
  assert.equal(model.rows.find(row => row.card === 1)?.publication?.label, 'Not posted')
  assert.equal(model.rows.find(row => row.kind === 'findings')?.publication?.label, 'Not posted')
  assert.equal(runTimeline({ ...input, findingRun: publicationRun({ total: 3, open: 0, blocking: 0, rounds: [{ round: 1, state: 'none', reason: null, pr: null, cards: [1] }] }), findings: [] }).header.publication, null)
})
it('shows an authoritative posted review round even when it raised no ledger findings', () => {
 const model=runTimeline({execution:run(),cards:[card()],findings:[],findingRun:publicationRun({publication:'posted',open:0,blocking:0,rounds:[{round:1,state:'posted',reason:null,pr:7,cards:[1]}]})})
 assert.equal(model.rows.find(one => one.card === 1)?.publication?.label, 'Posted to #7')
 assert.equal(model.rows.some(one => one.kind === 'findings'), false)
})
;[true, false].forEach((publicationOn) => it('uses the current PR binding for a local round kept before binding (posting %s)' + JSON.stringify(publicationOn), () => {
    const findingRun = publicationRun({ rounds: [{ round: 1, state: 'local', reason: 'Kept before binding.', pr: null, cards: [1] }] });
    const model = runTimeline({ execution: run(), cards: [card()], findingRun, publicationOn });
    assert.equal(model.rows.find(row => row.card === 1)?.publication?.label, publicationOn ? 'Not posted' : 'Kept on the desk');
}));
it('preserves a posted round’s recorded target when the Run binds another PR', () => {
  const findingRun = publicationRun({ publication: 'posted', rounds: [{ round: 1, state: 'posted', reason: null, pr: 9, cards: [1] }] })
  assert.equal(runTimeline({ execution: run(), cards: [card()], findingRun }).rows.find(row => row.card === 1)?.publication?.label, 'Posted to #9')
})
describe('a check run again', () => {
  const gate = (patch: Partial<FlowExecution> = {}) => run({ rounds: [{ ...run().rounds[0]!, role: 'verify', state: 'closed' }], ...patch })
  const finished = { key: 'check', kind: 'check' as const, state: 'finished' as const, seat: null, card: 1 }
  const attempt = (n: number, patch: Partial<FlowCheckAttempt> = {}): FlowCheckAttempt =>
    ({ id: `attempt-${n}`, n, at: 1000 * n, commit: 'abc', exit: 1, timedOut: false, outcome: 'fail', tail: `attempt ${n}`, ...patch })
  const attempts = (...list: FlowCheckAttempt[]) => new Map([[1, list]])
  const rows = (input: Parameters<typeof runTimeline>[0]) => runTimeline(input).rows

  it('draws each attempt under its check once there is more than one, oldest first, in the check row’s own words', () => {
    const list = rows({ execution: gate({ operations: [finished] }), cards: [card({ state: 'done', outcome: 'pass' })], evidence,
      attempts: attempts(attempt(1), attempt(2, { exit: 0, outcome: 'pass' })) })
    assert.deepEqual(list.map(row => row.id), ['start', 'round-1', 'check-1-1', 'attempt-1-1-1', 'attempt-1-1-2'])
    assert.partialDeepStrictEqual(list.filter(row => row.kind === 'attempt'), [
    { title: 'Attempt 1', status: 'Failed', card: 1, round: 1, since: 1000, attention: false, detail: null },
    { title: 'Attempt 2', status: 'Passed', card: 1, round: 1, since: 2000, attention: false, detail: null },
])
  })
  it('draws no attempt under a check that has one result or none, because the check row already says it', () => {
    const input = { execution: gate({ operations: [finished] }), cards: [card({ state: 'done', outcome: 'pass' })], evidence }
    for (const read of [undefined, attempts(), attempts(attempt(1))]) {
      assert.equal(rows({ ...input, ...(read ? { attempts: read } : {}) }).some(row => row.kind === 'attempt'), false)
    }
  })
  it('does not assign readable subset ordinals to timeline rows when earlier evidence may be missing', () => {
    const list = rows({ execution: gate({ operations: [finished] }), cards: [card({ state: 'done', outcome: 'pass' })], evidence,
      attempts: attempts(attempt(1, { n: null }), attempt(2, { n: null, exit: 0, outcome: 'pass' })) })
    assert.equal(list.some(row => row.kind === 'attempt'), false)
  })
  it('keeps a check’s attempts with that check, and ignores a read for a card that is not a check', () => {
    const execution = gate({ rounds: [{ ...gate().rounds[0]!, cards: [1, 2] }], operations: [finished] })
    const list = rows({ execution, cards: [card({ state: 'done' }), card({ id: 2, state: 'done' })],
      attempts: new Map([[1, [attempt(1), attempt(2)]], [2, [attempt(1), attempt(2)]], [9, [attempt(1), attempt(2)]]]) })
    assert.deepEqual(list.map(row => row.id), ['start', 'round-1', 'check-1-1', 'attempt-1-1-1', 'attempt-1-1-2', 'check-1-2', 'attempt-1-2-1', 'attempt-1-2-2'])
    const writer = run({ rounds: [{ ...run().rounds[0]!, cards: [1] }] })
    assert.equal(rows({ execution: writer, cards: [card()], attempts: attempts(attempt(1), attempt(2)) }).some(row => row.kind === 'attempt'), false)
  })
  ;([
    ['a status the Flow reads as pass', { exit: 0, outcome: 'pass' }, 'Passed'],
    ['a status the Flow reads as fail', { exit: 2, outcome: 'fail' }, 'Failed'],
    ['a timeout the Flow reads as fail', { exit: null, timedOut: true, outcome: 'fail' }, 'Timed out'],
    ['a result with no exit that was not a timeout', { exit: null, timedOut: false, outcome: 'fail' }, 'Did not finish'],
    ['an outcome word only the Flow knows', { exit: 0, outcome: 'no-pr' }, 'No pr'],
    ['a retry word', { exit: 1, outcome: 'retry' }, 'Retry'],
] as const).forEach(([_what, patch, word]) => it('words %s as %s' + JSON.stringify([_what, patch, word]), () => {
    const [, one] = rows({ execution: gate({ operations: [finished] }), cards: [card({ state: 'done' })], attempts: attempts(attempt(1), attempt(2, patch)) }).filter(row => row.kind === 'attempt');
    assert.equal(one!.status, word);
}));
  it('says why a check cannot run again from its run and its operation, in the host’s sentence, and offers it otherwise', () => {
    const refusal = (execution: FlowExecution) => rows({ execution, cards: [card({ state: 'done' })] }).find(row => row.kind === 'check')!.retryRefusal
    assert.equal(refusal(gate({ operations: [finished] })), null)
    assert.equal(refusal(gate({ state: 'stalled', operations: [{ ...finished, state: 'uncertain' }] })), null)
    assert.equal(refusal(gate({ state: 'settled', operations: [finished] })), 'This run is settled. Start a new run to run this check again.')
    assert.equal(refusal(gate({ state: 'stopped', operations: [{ ...finished, state: 'uncertain' }] })), 'This run is stopped. Start a new run to run this check again.')
    assert.equal(refusal(gate({ operations: [{ ...finished, state: 'started' }] })), 'This check is not waiting to be run again.')
    assert.equal(refusal(gate()), 'This check is not waiting to be run again.')
  })
  it('words the check row and its newest attempt alike, including a result with no exit', () => {
    const noExit = { ...evidence, cards: evidence.cards.map(one => ({ ...one, facts: one.facts.map(view => ({ ...view, record: { ...view.record, fact: { ...view.record.fact, exit: null, timedOut: false } } })) })) } as BoardEvidence
    const list = rows({ execution: gate({ operations: [finished] }), cards: [card({ state: 'done', outcome: 'fail' })], evidence: noExit,
      attempts: attempts(attempt(1), attempt(2, { exit: null })) })
    assert.equal(list.find(row => row.kind === 'check')?.status, 'Did not finish')
    assert.equal(list.filter(row => row.kind === 'attempt').at(-1)?.status, 'Did not finish')
  })
  it('asks nothing of a card that is not a check', () => {
    const list = rows({ execution: run(), cards: [card()] })
    assert.equal(list.every(row => row.retryRefusal === null), true)
  })
})

it('uses the baseline Team publication preference without changing the round or aggregate rules', async () => {
  const { runTimelineOf } = await import('../../src/views/index.js')
  const execution = run()
  const snapshot = {
    teams: [{ goal: { id: execution.goal, origin: { kind: 'person' }, findingPublication: false }, board: { id: execution.goal } }],
    runs: [execution], boards: [{ id: execution.goal, intents: [card()], channel: [] }], seats: [], approvals: [], reviews: [],
  } as unknown as import('../../src/views/index.js').ClientSnapshot
  const extras = { findings: [publicationFinding], findingRun: publicationRun() }
  assert.deepEqual(runTimelineOf(snapshot, execution, extras), runTimeline({ execution, cards: [card()], signals: [], origin: 'Started by you', ...extras, publicationOn: false }))
})
