import { itemId, runtimeId, sessionId, sessionKey, turnId, type AgentId, type FlowExecution, type Intent, type SeatRecord, type Session } from '@harnessdesk/protocol'
import { flowGraphDocument } from './flow-graph-fixture'
import { flowModel } from '../lib/flow-model'
import { flowOverlay, type OverlayCheckHistory } from '../lib/flow-overlay'
import { PREVIEW_GOAL } from './goal-fixture'
import { previewStore } from './harness'
import type { AppSnapshot, AppStore } from '../state/store'

export const FLOW_OVERLAY_SCENES = ['fix', 'fix-reading', 'fix-idle', 'check-again', 'review', 'you', 'answered', 'evidence-wait', 'settled', 'stopped', 'pending', 'failed', 'empty'] as const
export type FlowOverlayScene = typeof FLOW_OVERLAY_SCENES[number]
const START = Date.now() - 22 * 60_000
const ROLES = ['write', 'check', 'review', 'fix', 'check', 'review', 'land', 'you'] as const
const CAUSES = ['seed', 'after:1:written', 'after:2:checked', 'after:3:changes', 'after:4:fixed', 'after:5:checked', 'after:6:approved', 'after:7:landed']
const OUTCOMES = ['published', 'passes', 'request-changes', 'fixed', 'passes', 'approve', 'landed', 'merged']
const TIMES = [0, 11, 14, 20, 22, 25, 28, 29, 30].map(minute => START + minute * 60_000)
const agent = (id: string, name: string, runtime: string, level: 'edit' | 'read' = 'edit'): SeatRecord => ({
  id, session: { runtime: runtimeId(runtime), sessionId: sessionId(id) },
  briefDigest: null, seat: { runtime }, passedOver: [], standing: { kind: 'ceiling', level },
  checkout: { cwd: '/work/storefront', project: '/work/storefront', head: null, branch: null }, board: 'overlay-team',
  role: null, openedAt: START, closed: null, agent: { id: id as AgentId, name, origin: 'project' }, seatLabel: name, ceiling: { level, hold: 'held' },
})
export const OVERLAY_SEATS = [agent('alpha', 'Alpha Writer', 'codex'), agent('beta', 'Beta Reviewer', 'claude', 'read'), agent('gamma', 'Gamma Reviewer', 'cursor', 'read')]
const seatsFor = (role: string): string[] => role === 'review' ? ['beta', 'gamma'] : role === 'write' || role === 'fix' ? ['alpha'] : []

/** Real host record shapes, including the cause key that records which rule fired. All identities are placeholders. */
export const flowOverlayFixture = (scene: FlowOverlayScene) => {
  const count = scene === 'empty' ? 0 : scene.startsWith('fix') || scene === 'stopped' || scene === 'pending' || scene === 'failed' ? 4 : scene === 'check-again' ? 5 : scene === 'review' ? 6 : 8
  const cards: Intent[] = []
  const rounds: FlowExecution['rounds'][number][] = []
  const operations: FlowExecution['operations'][number][] = []
  const attempts = new Map<number, OverlayCheckHistory>()
  for (let i = 0; i < count; i++) {
    const role = ROLES[i]!
    const live = i === count - 1 && scene !== 'settled'
    const answered = !live || scene === 'answered' || scene === 'evidence-wait'
    const seats = seatsFor(role)
    const ids = role === 'review' ? [(i + 1) * 10 + 1, (i + 1) * 10 + 2] : [(i + 1) * 10]
    rounds.push({ n: i + 1, role, cards: ids, seats, state: scene === 'stopped' ? 'closed' : live ? scene === 'evidence-wait' ? 'waiting-evidence' : 'running' : 'closed', cause: CAUSES[i]!, evidence: [] })
    ids.forEach((id, slot) => {
      cards.push({ id, title: `Open ${role}`, detail: null, state: answered ? 'done' : role === 'you' || scene === 'stopped' ? 'open' : 'claimed', files: [], dependsOn: [],
        createdAt: TIMES[i]!, updatedAt: answered ? TIMES[i + 1]! : TIMES[i]!, outcome: answered ? OUTCOMES[i]! : null,
        claim: live && seats[slot] ? { runtime: runtimeId(OVERLAY_SEATS.find(seat => seat.id === seats[slot])!.session.runtime), sessionId: seats[slot]!, at: TIMES[i]! } : null,
      })
      if (seats[slot]) operations.push({ key: `seat:${i + 1}:${slot}`, kind: 'seat', state: 'finished', card: id, seat: seats[slot]! })
      if (role === 'check' || role === 'land') {
        operations.push({ key: `check:${i + 1}:${slot}`, kind: 'check', state: live ? 'started' : 'finished', card: id, seat: null })
        attempts.set(id, { attempts: live ? [] : [{ id: `result-${id}`, at: TIMES[i + 1]! }], complete: true })
      }
    })
  }
  // A check can be run again within one round as well as reached again through the loop.
  if (count >= 5) attempts.set(50, { attempts: [{ id: 'earlier-result-50', at: TIMES[4]! },
    ...(scene === 'check-again' ? [] : [{ id: 'result-50', at: TIMES[5]! }])], complete: true })
  if (scene === 'failed') attempts.set(20, { attempts: [{ id: 'result-20', at: TIMES[2]! }], complete: false })
  if (scene === 'pending') attempts.clear()
  const execution: FlowExecution = { version: 2, id: 'overlay-run', goal: 'overlay-team', state: scene === 'settled' ? 'settled' : scene === 'stopped' ? 'stopped' : 'running',
    document: flowGraphDocument('blueprint'), revision: '3f9a1c', rounds, operations, legacyRun: null, reason: scene === 'evidence-wait' ? 'Waiting for recorded evidence' : scene === 'stopped' ? 'Stopped by you' : null, startedAt: START,
    ...(scene === 'stopped' ? { endedAt: TIMES[4], end: { kind: 'stopped' as const, by: 'person' as const } } : {}),
    ...(scene === 'settled' ? { endedAt: TIMES[8], end: { kind: 'complete' as const } } : {}),
  }
  const model = flowModel(execution.document.flow)
  return { execution, cards, attempts, model, overlay: flowOverlay({ execution, cards, attempts, model }) }
}

/** A fake host whose pushes update a mounted real Team pane, without opening a native window. */
export const flowOverlayRig = (initial: FlowOverlayScene = 'fix') => {
  const base = previewStore()
  const seed = base.getSnapshot()
  let scene = initial
  const snapshotFor = (scene: FlowOverlayScene): AppSnapshot => {
    const source = flowOverlayFixture(scene)
    const board = { ...PREVIEW_GOAL.board, id: source.execution.goal, name: 'Retry the checkout call on a 502', root: '/work/storefront',
      members: OVERLAY_SEATS.map(seat => sessionKey(seat.session.runtime, seat.session.sessionId)), intents: source.cards, channel: [],
      nicknames: Object.fromEntries(OVERLAY_SEATS.map(seat => [sessionKey(seat.session.runtime, seat.session.sessionId), seat.agent!.name])),
    }
    const goal = { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, id: board.id, root: board.root, cwd: board.root, sentence: board.name, state: 'open' as const,
      reservation: undefined }, reservation: { run: source.execution.id }, members: OVERLAY_SEATS, board, activity: 'working' as const }
    const sessions = new Map(OVERLAY_SEATS.map(seat => {
      const live = source.execution.state === 'running' && (source.execution.rounds.at(-1)?.seats.includes(seat.id) ?? false)
      const session: Session = { runtime: runtimeId(seat.session.runtime), id: sessionId(seat.session.sessionId), title: seat.agent!.name, cwd: board.root,
        createdAt: START, updatedAt: Date.now(), status: { type: live ? 'active' : 'idle' }, itemsLoaded: true,
        turns: live ? [{ id: turnId('work'), startedAt: Date.now() - 120_000, status: 'inProgress', items: scene === 'fix-idle' ? [] : seat.ceiling?.level === 'read' || scene === 'fix-reading' ? [{ id: itemId('read'), type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'inProgress', args: { path: scene === 'fix-reading' ? 'src/checkout/cart.ts' : 'src/checkout/retry.ts' } }] : [{ id: itemId('edit'), type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/checkout/retry.ts', kind: { type: 'update', movePath: null }, diff: '' }] }] }] : [],
      } as Session
      return [sessionKey(seat.session.runtime, seat.session.sessionId), session]
    }))
    return { ...seed, teams: new Map([[board.id, board]]), goals: new Map([[board.id, goal]]), flowExecutions: new Map([[source.execution.id, source.execution]]),
      sessions, history: [...sessions.values()], approvals: [], inbox: [], boardEvidence: new Map(),
      workspace: { path: board.root, name: 'Storefront', lastOpenedAt: START }, workspaces: [{ path: board.root, name: 'Storefront', lastOpenedAt: START }],
    }
  }
  const patch = (partial: Partial<AppSnapshot>) => (base as unknown as { patch: (partial: Partial<AppSnapshot>) => void }).patch(partial)
  patch(snapshotFor(scene))
  const store = new Proxy(base, { get(target, key) {
    if (key === 'readCheckAttempts') return async (_run: string, card: number) => {
      const history = flowOverlayFixture(scene).attempts.get(card)
      return { attempts: history?.attempts.map((attempt, i) => ({ ...attempt, n: history.complete ? i + 1 : null, commit: '3f9a1c', exit: 0, timedOut: false, outcome: 'passes', tail: 'Passed' })) ?? [], complete: history?.complete ?? false }
    }
    if (key === 'loadTeamRuns' || key === 'loadBoardEvidence' || key === 'loadFindings' || key === 'readGoalInsight') return async () => undefined
    if (key === 'teamPeers') return async () => []
    return Reflect.get(target, key)
  } }) as AppStore
  return { store, advance: (next: FlowOverlayScene | 'refresh') => {
    if (next !== 'refresh') scene = next
    patch(snapshotFor(scene))
  } }
}
