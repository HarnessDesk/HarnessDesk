import { sessionKey, type GoalId, type InsightReport, type RuntimeId, type TeamSignal, type FlowExecution, type FindingRunView } from '@harnessdesk/protocol'
import type { ClientSnapshot } from './snapshot.js'
import { teamOverview, type TeamOverviewInput, type TeamOverviewSeat } from './team-overview.js'

/** Adapt held client state to the same input the window supplies. */
export function teamOverviewInputOf(snapshot: ClientSnapshot, team: GoalId, extras: {
  report: InsightReport | null
  runtimes: readonly { id: RuntimeId; name: string; metered: boolean }[]
  sentences?: ReadonlyMap<string, string>
  /** Window facts retain unread marks and local conversations; host activity is the fallback. */
  seats?: readonly TeamOverviewSeat[]
  run?: { execution: FlowExecution; startedAt: number | null } | null
  findingRun?: FindingRunView | null
  publicationOn?: boolean
}): TeamOverviewInput {
  const view = snapshot.teams.find(one => one.goal.id === team)
  const board = snapshot.boards.find(one => one.id === view?.board.id || one.id === team) ?? view?.board
  const runtimeCapabilities = new Map<string, { metered: boolean }>(extras.runtimes.map(one => [one.id, { metered: one.metered }]))
  const execution = snapshot.runs.filter(one => one.goal === team).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
  return {
    team,
    seats: (extras.seats ?? (view?.members ?? []).map((record): TeamOverviewSeat => ({
      record,
      name: board?.nicknames?.[sessionKey(record.session.runtime, record.session.sessionId)] ?? record.agent?.name ?? record.seatLabel ?? 'Agent',
      runtime: runtimeCapabilities.has(record.session.runtime) ? { capabilities: runtimeCapabilities.get(record.session.runtime)! } : null,
      session: null,
      unreadSince: null,
      approvals: snapshot.approvals.filter(one => one.runtime === record.session.runtime && one.sessionId === record.session.sessionId).map(one => one.approval),
    }))).map(seat => ({ ...seat, activity: snapshot.seats.find(one => one.goal === team && one.seat === `${seat.record.session.runtime}:${seat.record.session.sessionId}`) ?? seat.activity ?? null })),
    cards: board?.intents ?? [],
    run: extras.run !== undefined ? extras.run : execution ? { execution, startedAt: execution.startedAt ?? null } : null,
    findingRun: extras.findingRun,
    publicationOn: extras.publicationOn ?? view?.goal.findingPublication !== false,
    report: extras.report,
    ...(board?.channel ? { signals: board.channel.filter((one): one is TeamSignal => one.kind === 'signal') } : {}),
    runtimeCapabilities,
    toolSentences: extras.sentences,
  }
}

export function teamOverviewOf(...args: Parameters<typeof teamOverviewInputOf>): ReturnType<typeof teamOverview> {
  return teamOverview(teamOverviewInputOf(...args))
}
