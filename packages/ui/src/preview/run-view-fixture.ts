import { runtimeId, type BoardEvidence, type FindingView, type FlowCheckAttempt, type FlowEntry, type FlowExecution, type FlowPreview, type FlowRunOptions, type Intent, type TeamSignal } from '@harnessdesk/protocol'
import { overviewRun, overviewTeamStore } from './team-overview-fixture'
import { runTimeline } from '../lib/run-timeline'

export const RUN_VIEW_STATES = ['running', 'attempts', 'settled', 'complete', 'stopped', 'desk-stopped', 'budget-rounds', 'budget-progress', 'stalled', 'findings', 'damaged-findings', 'many', 'narrow', 'empty', 'pending', 'failed', 'failed-check', 'person'] as const
export type RunScene = typeof RUN_VIEW_STATES[number] | 'live-polish'
const at = Date.now() - 1_200_000
const card = (id: number, working = false, start = at): Intent => ({ id, title: id === 1 ? 'Retry the checkout call on a 502' : id === 2 ? 'Verify the change' : id === 3 ? 'Review the change' : 'Answer the review',
  state: working ? 'claimed' : 'done', outcome: working ? null : id === 3 ? 'request-changes' : id === 2 ? 'pass' : 'published',
  claim: working ? { runtime: runtimeId('codex'), sessionId: 'overview-0', at: start + id * 120_000 } : null,
  createdAt: start + id * 100_000, updatedAt: start + id * 120_000 + 90_000, files: [], dependsOn: [] })
export const runFixture = (scene: RunScene = 'running') => {
  const start = scene === 'many' ? at - 2_400_000 : at
  const count = scene === 'many' ? 20 : 4
  const terminal = ['live-polish', 'settled', 'complete', 'stopped', 'desk-stopped', 'budget-rounds', 'budget-progress', 'stalled', 'failed-check'].includes(scene)
  const initial: FlowExecution = { ...overviewRun(scene === 'live-polish' || scene === 'settled' || scene === 'complete' ? 'settled' : scene === 'stopped' || scene === 'desk-stopped' ? 'stopped' : scene === 'stalled' || scene === 'failed-check' || scene.startsWith('budget-') ? 'stalled' : 'running'),
    // The check at round 2 finished (it is what a Run on the rig leaves), so a running Run offers Run again… on it and an ended one does not.
    operations: [...(scene === 'empty' ? [] : [{ key: 'check:2:0', kind: 'check' as const, card: 2, seat: null, state: 'finished' as const }]),
      ...(scene === 'stalled' ? [{ key: 'interrupted-check', kind: 'check' as const, card: count, seat: null, state: 'uncertain' as const }] : [])],
    startedAt: start, endedAt: terminal ? start + 900_000 : null, currentEndedAt: terminal ? start + 900_000 : null, revision: '3f9a1c',
    brief: 'Retry the checkout call when the payment service answers a 502, with a bounded backoff, and say on the order page when it gives up.',
    end: scene === 'settled' ? { kind: 'unrouted', card: 4, outcome: 'no-pr' } : scene === 'complete' ? { kind: 'complete' } : scene === 'stopped' || scene === 'desk-stopped' ? { kind: 'stopped', by: scene === 'stopped' ? 'person' : 'desk' } : scene.startsWith('budget-') ? { kind: 'budget', which: scene === 'budget-rounds' ? 'rounds' : 'without-progress', used: scene === 'budget-rounds' ? 6 : 3 } : scene === 'stalled' || scene === 'failed-check' ? { kind: 'stalled' } : null,
    reason: scene === 'settled' ? 'The landing check answered no-pr; no rule continues from it.' : scene === 'stopped' ? 'You stopped this Run. Its cards and findings are kept.' : scene === 'desk-stopped' ? 'The desk stopped this Run. Its cards and findings are kept.' : scene.startsWith('budget-') ? 'This Run reached its budget. Its cards and findings are kept.' : scene === 'stalled' ? 'The desk stopped while the check ran. Review it before running it again.' : scene === 'failed-check' ? 'The final check failed. Review its result before continuing.' : scene === 'complete' ? 'Every step finished. Nothing waits.' : null,
    rounds: scene === 'empty' ? [] : Array.from({ length: count }, (_, i) => ({ n: i + 1, role: i === count - 1 && scene === 'person' ? 'person' : i === 1 || (i === count - 1 && (scene === 'settled' || scene === 'stalled' || scene === 'failed-check')) ? 'verify' : i === 2 ? 'reviewer' : 'writer', cards: [i + 1], seats: i === 1 || (i === count - 1 && ['person', 'settled', 'stalled', 'failed-check'].includes(scene)) ? [] : [i === 2 ? 'seat-1' : 'seat-0'], evidence: [], cause: i ? 'review-loop' : 'seed', state: i === count - 1 && !terminal ? 'running' : 'closed' })),
    // The Flow this Run froze, whole: its Flow tab draws it, so its steps and rules are the ones its rounds name.
    document: { format: 'agents', flow: { version: 2, name: 'Build and review', inputs: [{ id: 'brief', label: 'Brief' }, { id: 'task', label: 'Task' }], messaging: 'board-only', wait: 240,
      roles: [
        { id: 'writer', kind: 'agent', uses: ['writer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
        { id: 'verify', kind: 'check', check: { run: scene === 'live-polish' ? 'PATH=/usr/bin:/home/dev/bin node /home/dev/tools/land.mjs --check' : 'pnpm verify', timeout: 600, exits: { '0': 'pass' }, otherwise: 'fail' } },
        { id: 'reviewer', kind: 'agent', uses: ['reviewer'], seats: [], isolate: true, grant: 'read', count: 2, independentOf: ['writer'] },
        { id: 'person', kind: 'person', outcomes: ['approved'] },
      ],
      rules: [
        { id: 'written', on: 'writer', then: { role: 'verify', title: 'Verify the change' } },
        { id: 'verified', on: 'verify', when: { every: ['pass'] }, then: { role: 'reviewer', title: 'Review the change' } },
        { id: 'changes', on: 'reviewer', when: { any: ['request-changes'] }, then: { role: 'writer', title: 'Answer the review' } },
        { id: 'approved', on: 'reviewer', when: { every: ['approve'] }, then: { role: 'person', title: 'Approve the change' } },
      ],
      seed: { role: 'writer', title: 'Retry the checkout call' } } },
  }
  const execution: FlowExecution = { ...initial, operations: [...initial.operations, ...initial.rounds.flatMap(round => round.seats.map(seat => ({ key: `seat-${round.n}`, kind: 'seat' as const, state: 'finished' as const, card: round.cards[0]!, seat })))] }
  const cards = Array.from({ length: count }, (_, i) => card(i + 1, i === count - 1 && !terminal, start))
  if (scene === 'settled' || scene === 'stalled' || scene === 'failed-check') cards[count - 1] = { ...cards[count - 1]!, outcome: scene === 'settled' ? 'no-pr' : null, state: scene === 'stalled' ? 'open' : 'done' }
  if (scene === 'failed-check') cards[count - 1] = { ...cards[count - 1]!, outcome: 'fail' }
  if (scene === 'live-polish') for (let i = 0; i < cards.length; i++) cards[i] = { ...cards[i]!, outcome: null }
  if (scene === 'person') cards[count - 1] = { ...cards[count - 1]!, state: 'open', claim: null }
  const signals: TeamSignal[] = cards.filter(one => execution.rounds.find(round => round.cards.includes(one.id))?.role !== 'verify').map(one => ({ id: `claim-${one.id}`, kind: 'signal', signal: 'claimed', intent: one.id, title: one.title, at: start + one.id * 120_000,
    by: { kind: 'agent', runtime: runtimeId('codex'), sessionId: 'overview-0', title: 'Alpha' } }))
  let evidence: BoardEvidence = { room: execution.goal, stamp: start, checks: [], refused: [], unreadable: null, cards: [{ card: 2, running: [], facts: [{ by: null, freshness: { state: 'fresh' }, record: { id: 'verify', observedAt: start + 400_000, round: 2, fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, dirty: false, at: 'abc123', tail: 'Passed' } } }] }] }
  if (scene === 'failed-check') evidence = { ...evidence, cards: [...evidence.cards, { card: count, running: [], facts: [{ by: null, freshness: { state: 'fresh' }, record: { id: 'failed-check', observedAt: start + 900_000, round: count, fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 1, timedOut: false, dirty: false, at: 'abc123', tail: 'The retry limit assertion failed.' } } }] }] }
  const findings: FindingView[] = scene === 'empty' || scene === 'complete' ? [] : [{ id: 'finding-retry', origin: { goal: execution.goal, run: execution.id, round: 3, card: 3, seat: 'seat-1', at: 'abc123' }, ownerGoal: execution.goal,
    title: 'The retry loop needs a ceiling', body: 'Cap the attempts.', category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [], posted: [], restored: false, problem: null }]
  if (scene === 'findings') {
    findings.push({ ...findings[0]!, id: 'finding-accepted', title: 'Keep the last failure visible', lifecycle: { state: 'repaired', confirmed: true, repairs: ['def456'] } })
  }
  if (scene === 'damaged-findings') {
    const original = findings[0]!
    findings.push(
      { ...original, id: 'finding-claimed', title: 'The backoff needs a cap', lifecycle: { state: 'repaired', confirmed: false, repairs: ['def456'] } },
      { ...original, id: 'finding-accepted', title: 'Keep the last failure visible', lifecycle: { state: 'repaired', confirmed: true, repairs: ['def456'] } },
      { ...original, id: 'finding-damaged', title: 'Preserve the retry limit', lifecycle: { state: 'repaired', confirmed: true, repairs: ['def456'] },
        problem: 'The finding history has a missing sequence.' },
    )
  }
  // What the desk recorded each time the round-2 check ran: it failed first, and passed when it was run again at a later commit.
  const attempts: ReadonlyMap<number, readonly FlowCheckAttempt[]> | undefined = scene !== 'attempts' ? undefined : new Map([[2, [
    { id: 'attempt-2-1', n: 1, at: start + 160_000, commit: '9d41c0e7ab3f52d86e1c0a4b7f93d2e8a65b10c4', exit: 1, timedOut: false, outcome: 'fail',
      tail: 'FAIL src/checkout/retry.test.ts\n  ● retries a 502 with a bounded backoff\n    expected 3 attempts, received 1\n\nTests: 1 failed, 41 passed' },
    { id: 'attempt-2-2', n: 2, at: start + 400_000, commit: '4f0b8a21c93d7e5a60b1d82f3c4e9a7d15b6c0e8', exit: 0, timedOut: false, outcome: 'pass',
      tail: 'Tests: 42 passed\nDone in 38.2s' },
  ]]])
  return { execution, cards, signals, evidence, findings, origin: 'Started by you', ...(attempts ? { attempts } : {}) }
}
export const runModel = (scene: RunScene) => runTimeline(runFixture(scene))

/** The file the fixture Run's Flow came from: what *Open the file* finds in the catalogue and reads. */
export const RUN_FLOW_ENTRY: FlowEntry = {
  id: 'build-and-review', origin: 'project', path: '.harnessdesk/flows/build-and-review.yml', name: 'Build and review',
  description: null, format: 'agents', problem: null, shadows: [],
}
export const RUN_FLOW_SOURCE = [
  'version: 2',
  'name: "Build and review"',
  'inputs:',
  '  brief: { label: Brief }',
  '  task: { label: Task }',
  'roles:',
  '  writer:',
  '    kind: agent',
  '    uses: [writer]',
  '    grant: edit',
  '    independentOf: []',
  '  verify:',
  '    kind: check',
  '    run: "pnpm verify"',
  '    timeout: 600',
  '  reviewer:',
  '    kind: agent',
  '    uses: [reviewer]',
  '    isolate: true',
  '    count: 2',
  '    grant: read',
  '    independentOf: [writer]',
  '  person:',
  '    kind: person',
  '    outcomes: [approved]',
  'seed: { role: writer, title: "Retry the checkout call" }',
  'rules:',
  '  - id: written',
  '    on: writer',
  '    then: { role: verify, title: "Verify the change" }',
  '  - id: verified',
  '    on: verify',
  '    when: { every: [pass] }',
  '    then: { role: reviewer, title: "Review the change" }',
  '  - id: changes',
  '    on: reviewer',
  '    when: { any: [request-changes] }',
  '    then: { role: writer, title: "Answer the review" }',
  '  - id: approved',
  '    on: reviewer',
  '    when: { every: [approve] }',
  '    then: { role: person, title: "Approve the change" }',
  'messaging: board-only',
  'wait: 240',
  '',
].join('\n')
export const runTeamStore = (scene: RunScene = 'complete') => {
  const base = overviewTeamStore()
  const fixture = runFixture(scene)
  const snapshot = base.getSnapshot()
  const board = { ...snapshot.teams.get('overview-team')!, intents: fixture.cards, channel: fixture.signals }
  const original = snapshot.goals.get('overview-team')!
  const goal = { ...original, board, members: scene === 'live-polish' ? original.members.map((seat, n) => ({ ...seat, ceiling: { level: n === 0 ? 'edit' as const : 'read' as const, hold: n === 0 ? 'asked' as const : 'held' as const } })) : original.members }
  let next = { ...snapshot, ...(scene === 'live-polish' ? { home: '/home/dev', sessions: new Map([...snapshot.sessions].map(([key, session], n) => [key, { ...session, settings: { ...session.settings, ceiling: goal.members[n]!.ceiling } }])) } : {}), teams: new Map([[board.id, board]]), goals: new Map([[board.id, goal]]), flowExecutions: new Map([[fixture.execution.id, fixture.execution]]),
    boardEvidence: new Map([[board.id, fixture.evidence]]) }
  const listeners = new Set<() => void>()
  return new Proxy(base, { get(target, key) {
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
    if (key === 'getSnapshot') return () => next
    if (key === 'loadFindings' || key === 'loadBoardEvidence' || key === 'loadTeamRuns') return async () => {}
    if (key === 'flowExecutionSource') return async () => ({ source: RUN_FLOW_SOURCE, vars: { task: 'Retry the checkout call', brief: fixture.execution.brief ?? '' } })
    if (key === 'previewFlow') return async (_root: string, _source: string, _vars: unknown, options?: FlowRunOptions): Promise<FlowPreview> => ({
      token: 'preview-start', compiled: { document: fixture.execution.document, bindings: [], problems: [] },
      seats: [{ role: 'writer', index: 0, agent: 'writer', isolate: false, reviews: false, plan: { id: 'writer', from: 'machine', winner: options?.seats?.writer?.[0]?.effort === 'high' ? 1 : 0, blocked: null, ceiling: { level: 'edit', hold: 'held' },
        candidates: [{ seat: { runtime: 'codex' }, label: 'Alpha · Standard', runtimeName: 'Alpha', state: options?.seats?.writer?.[0]?.effort === 'high' ? 'untried' : 'taken', reason: null, fix: null }, { seat: { runtime: 'codex', effort: 'high' }, label: 'Alpha · High', runtimeName: 'Alpha', state: options?.seats?.writer?.[0]?.effort === 'high' ? 'taken' : 'untried', reason: null, fix: null }] } }],
      commands: [{ role: 'verify', run: 'pnpm verify', cwd: '/repo', timeout: 600 }], guards: [], messaging: 'board-only', problems: [],
    })
    if (key === 'startFlowGoal') return async (input: { continues: string; vars: Record<string, string> }) => {
      const execution = { ...runFixture('running').execution, id: 'continued-run', continues: input.continues, brief: input.vars.brief, startedAt: Date.now() }
      next = { ...next, flowExecutions: new Map(next.flowExecutions).set(execution.id, execution), goals: new Map(next.goals).set(board.id, { ...goal, reservation: { run: execution.id } }) }
      for (const listener of listeners) listener()
      return execution
    }
    if (key === 'flowCatalog') return async () => [RUN_FLOW_ENTRY]
    if (key === 'flowSource') return async () => RUN_FLOW_SOURCE
    return Reflect.get(target, key)
  } })
}
