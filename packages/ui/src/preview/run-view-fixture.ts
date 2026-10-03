import { runtimeId, type BoardEvidence, type FindingView, type FlowExecution, type Intent, type TeamSignal } from '@harnessdesk/protocol'
import { overviewRun, overviewTeamStore } from './team-overview-fixture'
import { runTimeline } from '../lib/run-timeline'

export const RUN_VIEW_STATES = ['running', 'settled', 'complete', 'stopped', 'stalled', 'findings', 'many', 'narrow', 'empty', 'pending', 'failed', 'person'] as const
export type RunScene = typeof RUN_VIEW_STATES[number]
const at = Date.now() - 1_200_000
const card = (id: number, working = false, start = at): Intent => ({ id, title: id === 1 ? 'Retry the checkout call on a 502' : id === 2 ? 'Verify the change' : id === 3 ? 'Review the change' : 'Answer the review',
  state: working ? 'claimed' : 'done', outcome: working ? null : id === 3 ? 'request-changes' : id === 2 ? 'pass' : 'published',
  claim: working ? { runtime: runtimeId('codex'), sessionId: 'overview-0', at: start + id * 120_000 } : null,
  createdAt: start + id * 100_000, updatedAt: start + id * 120_000 + 90_000, files: [], dependsOn: [] })
export const runFixture = (scene: RunScene = 'running') => {
  const start = scene === 'many' ? at - 2_400_000 : at
  const count = scene === 'many' ? 20 : 4
  const terminal = ['settled', 'complete', 'stopped', 'stalled'].includes(scene)
  const initial: FlowExecution = { ...overviewRun(scene === 'settled' || scene === 'complete' ? 'settled' : scene === 'stopped' ? 'stopped' : scene === 'stalled' ? 'stalled' : 'running'),
    operations: scene === 'stalled' ? [{ key: 'interrupted-check', kind: 'check', card: count, seat: null, state: 'uncertain' }] : [],
    startedAt: start, endedAt: terminal ? start + 900_000 : null, revision: '3f9a1c',
    brief: 'Retry the checkout call when the payment service answers a 502, with a bounded backoff, and say on the order page when it gives up.',
    end: scene === 'settled' ? { kind: 'unrouted', card: 4, outcome: 'no-pr' } : scene === 'complete' ? { kind: 'complete' } : scene === 'stopped' ? { kind: 'stopped', by: 'person' } : scene === 'stalled' ? { kind: 'stalled' } : null,
    reason: scene === 'settled' ? 'The landing check answered no-pr; no rule continues from it.' : scene === 'stopped' ? 'You stopped this Run. Its cards and findings are kept.' : scene === 'stalled' ? 'The desk stopped while the check ran. Review it before running it again.' : scene === 'complete' ? 'Every step finished. Nothing waits.' : null,
    rounds: scene === 'empty' ? [] : Array.from({ length: count }, (_, i) => ({ n: i + 1, role: i === count - 1 && scene === 'person' ? 'person' : i === 1 || (i === count - 1 && (scene === 'settled' || scene === 'stalled')) ? 'verify' : i === 2 ? 'reviewer' : 'writer', cards: [i + 1], seats: i === 1 || (i === count - 1 && ['person', 'settled', 'stalled'].includes(scene)) ? [] : [i === 2 ? 'seat-1' : 'seat-0'], evidence: [], cause: i ? 'review-loop' : 'seed', state: i === count - 1 && !terminal ? 'running' : 'closed' })),
    document: { format: 'agents', flow: { version: 2, name: 'Build and review', inputs: [], rules: [], messaging: 'board-only', wait: 240, roles: [{ id: 'person', kind: 'person', outcomes: ['approved'] }, { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 600, exits: { '0': 'pass' }, otherwise: 'fail' } }], seed: { role: 'writer', title: 'Retry the checkout call' } } },
  }
  const execution: FlowExecution = { ...initial, operations: [...initial.operations, ...initial.rounds.flatMap(round => round.seats.map(seat => ({ key: `seat-${round.n}`, kind: 'seat' as const, state: 'finished' as const, card: round.cards[0]!, seat })))] }
  const cards = Array.from({ length: count }, (_, i) => card(i + 1, i === count - 1 && !terminal, start))
  if (scene === 'settled' || scene === 'stalled') cards[count - 1] = { ...cards[count - 1]!, outcome: scene === 'settled' ? 'no-pr' : null, state: scene === 'stalled' ? 'open' : 'done' }
  if (scene === 'person') cards[count - 1] = { ...cards[count - 1]!, state: 'open', claim: null }
  const signals: TeamSignal[] = cards.filter(one => execution.rounds.find(round => round.cards.includes(one.id))?.role !== 'verify').map(one => ({ id: `claim-${one.id}`, kind: 'signal', signal: 'claimed', intent: one.id, title: one.title, at: start + one.id * 120_000,
    by: { kind: 'agent', runtime: runtimeId('codex'), sessionId: 'overview-0', title: 'Alpha' } }))
  const evidence: BoardEvidence = { room: execution.goal, stamp: start, checks: [], refused: [], unreadable: null, cards: [{ card: 2, running: [], facts: [{ by: null, freshness: { state: 'fresh' }, record: { id: 'verify', observedAt: start + 400_000, round: 2, fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, dirty: false, at: 'abc123', tail: 'Passed' } } }] }] }
  const findings: FindingView[] = scene === 'empty' || scene === 'complete' ? [] : [{ id: 'finding-retry', origin: { goal: execution.goal, run: execution.id, round: 3, card: 3, seat: 'seat-1', at: 'abc123' }, ownerGoal: execution.goal,
    title: 'The retry loop needs a ceiling', body: 'Cap the attempts.', category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [], posted: [], restored: false, problem: null }]
  if (scene === 'findings') {
    const original = findings[0]!
    findings.push(
      { ...original, id: 'finding-claimed', title: 'The backoff needs a cap', lifecycle: { state: 'repaired', confirmed: false, repairs: ['def456'] } },
      { ...original, id: 'finding-accepted', title: 'Keep the last failure visible', lifecycle: { state: 'repaired', confirmed: true, repairs: ['def456'] } },
      { ...original, id: 'finding-damaged', title: 'Preserve the retry limit', lifecycle: { state: 'repaired', confirmed: true, repairs: ['def456'] },
        problem: 'The finding history has a missing sequence.' },
    )
  }
  return { execution, cards, signals, evidence, findings, origin: 'Started by you' }
}
export const runModel = (scene: RunScene) => runTimeline(runFixture(scene))
export const runTeamStore = () => {
  const base = overviewTeamStore()
  const fixture = runFixture('complete')
  const snapshot = base.getSnapshot()
  const board = { ...snapshot.teams.get('overview-team')!, intents: fixture.cards, channel: fixture.signals }
  const goal = { ...snapshot.goals.get('overview-team')!, board }
  const next = { ...snapshot, teams: new Map([[board.id, board]]), goals: new Map([[board.id, goal]]), flowExecutions: new Map([[fixture.execution.id, fixture.execution]]),
    boardEvidence: new Map([[board.id, fixture.evidence]]) }
  return new Proxy(base, { get(target, key) {
    if (key === 'getSnapshot') return () => next
    if (key === 'loadFindings' || key === 'loadBoardEvidence' || key === 'loadTeamRuns') return async () => {}
    return Reflect.get(target, key)
  } })
}
