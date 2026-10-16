import { type FlowExecution, type TeamState } from '@harnessdesk/protocol'
import { overviewTeamStore } from './team-overview-fixture'
import { noticesD3Preferences } from './notices-d3-preferences'

/** A placeholder Team waiting for the person's pick, with the ordinary production facts. */
export const waitingInboxFixture = () => {
  const snapshot = overviewTeamStore('running').getSnapshot()
  const team = snapshot.teams.get('overview-team')!
  const base = [...snapshot.flowExecutions.values()][0]!
  if (base.document.format !== 'agents') throw new Error('The fixture needs an agents Flow')
  const at = Date.now() - 90_000
  const card = { id: 4, title: 'Your pick is next', role: 'pick', state: 'open' as const, files: [], dependsOn: [], createdAt: at, updatedAt: at }
  const execution: FlowExecution = { ...base, state: 'running', rounds: [{ n: 1, role: 'pick', cards: [4], seats: [], evidence: [], cause: 'seed', state: 'running' }],
    document: { format: 'agents', flow: { ...base.document.flow, roles: [{ id: 'pick', kind: 'person', outcomes: ['kept', 'stopped'] }] } } }
  const board: TeamState = { ...team, intents: [card] }
  return { snapshot: { ...snapshot, teams: new Map([[board.id, board]]), goals: new Map([[board.id, { ...snapshot.goals.get(board.id)!, board }]]), flowExecutions: new Map([[execution.id, execution]]), approvals: [] }, board, execution }
}

/** Seed the complete window only when a notices-d3 browser specimen asks for it. */
export const installNoticesD3 = (store: import('../state/store').AppStore) => {
  const scene = new URLSearchParams(location.search).get('notices-d3')
  if (!scene) return
  const snapshot = store.getSnapshot()
  const runtime = snapshot.activeRuntime ?? snapshot.runtimes[0]!.id
  const now = Date.now()
  Object.assign(snapshot, {
    preferencesLoaded: true, activeRuntime: runtime,
    health: { state: 'ready' }, healthByRuntime: { [runtime]: { state: 'ready' } },
    noticePolicy: { muted: [], records: {}, seen: [], surfaces: {}, kept: [] },
    account: { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] },
    accountsByRuntime: { [runtime]: { accounts: [{ kind: 'oauth', label: 'dev@example.com' }], signInMethods: [] } },
    inbox: [], agentNotices: [], notices: [],
    usage: [{ runtime, account: 'dev@example.com', plan: null,
      lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: scene === 'roomy' ? 40 : 86, windowMinutes: 10080, resetsAt: now + 6.5 * 86400000, usageKnown: true }],
      credits: null, spend: null, reached: null, source: { kind: 'api', label: 'Preview fixture' }, fetchedAt: now, staleAfterMs: 600000, error: null }],
  })
  if (scene === 'fresh') Object.assign(snapshot, { sessions: new Map([...snapshot.sessions].map(([key, session]) => [key, { ...session, turns: [] }])) })
  if (scene === 'waiting') {
    noticesD3Preferences(store)
    const { snapshot: waits, execution, board } = waitingInboxFixture()
    Object.assign(snapshot, { teams: waits.teams, goals: waits.goals, flowExecutions: new Map(), approvals: [], usage: [], sessions: new Map([...snapshot.sessions, ...waits.sessions]) })
    const push = (notification: import('@harnessdesk/protocol').WireNotification) => (store.transport as unknown as { handlers: { onNotification(value: import('@harnessdesk/protocol').WireNotification): void } }).handlers.onNotification(notification)
    push({ method: 'flow/execution-changed', params: { execution } })
    // StrictMode may construct a discarded specimen too; send the fixture event to every copy.
    const surface = window as unknown as { noticesD3?: { answers: (() => void)[]; answer(): void } }
    surface.noticesD3 ??= { answers: [], answer() { this.answers.forEach(answer => answer()) } }
    surface.noticesD3.answers.push(() => push({ method: 'team/changed', params: { state: { ...board, intents: board.intents.map(card => ({ ...card, state: 'done' })) } } }))
  }
}
