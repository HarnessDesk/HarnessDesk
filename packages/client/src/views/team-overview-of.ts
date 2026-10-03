import { sessionKey, type GoalId, type InsightReport, type RuntimeId, type TeamSignal } from '@harnessdesk/protocol'
import type { ClientSnapshot } from './snapshot.js'
import { teamOverview } from './team-overview.js'

/** Adapt held client state to the same input the window supplies. */
export function teamOverviewOf(snapshot: ClientSnapshot, team: GoalId, extras: {
  report: InsightReport | null
  runtimes: readonly { id: RuntimeId; name: string; metered: boolean }[]
  sentences?: ReadonlyMap<string, string>
}): ReturnType<typeof teamOverview> {
  const view = snapshot.teams.find(one => one.goal.id === team)
  const board = snapshot.boards.find(one => one.id === view?.board.id) ?? view?.board
  const runtimeCapabilities = new Map<string, { metered: boolean }>(extras.runtimes.map(one => [one.id, { metered: one.metered }]))
  const execution = snapshot.runs.filter(one => one.goal === team).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
  return teamOverview({
    team,
    seats: (view?.members ?? []).map(record => ({
      record,
      name: board?.nicknames?.[sessionKey(record.session.runtime, record.session.sessionId)] ?? record.agent?.name ?? record.seatLabel ?? 'Agent',
      runtime: runtimeCapabilities.has(record.session.runtime) ? { capabilities: runtimeCapabilities.get(record.session.runtime)! } : null,
      session: null,
      activity: snapshot.seats.find(one => one.goal === team && one.seat === `${record.session.runtime}:${record.session.sessionId}`) ?? null,
      unreadSince: null,
      approvals: snapshot.approvals.filter(one => one.runtime === record.session.runtime && one.sessionId === record.session.sessionId).map(one => one.approval),
    })),
    cards: board?.intents ?? [],
    run: execution ? { execution, startedAt: execution.startedAt ?? null } : null,
    report: extras.report,
    ...(board?.channel ? { signals: board.channel.filter((one): one is TeamSignal => one.kind === 'signal') } : {}),
    runtimeCapabilities,
    toolSentences: extras.sentences,
  })
}
