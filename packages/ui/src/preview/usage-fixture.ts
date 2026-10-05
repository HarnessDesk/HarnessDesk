import type { AppSnapshot, AppStore } from '../state/store'
import { PREVIEW_SEAT } from './evidence-fixture'
import { sceneFlowExecution } from './flow-fixture'
import { PREVIEW_GOAL } from './goal-fixture'
import { insightReportFor, previewStore } from './harness'

/** Dashboard's retained Team and Run belong to its frame, never the shared Goal roster. */
export const usagePreviewStore = (): AppStore => {
  const own = previewStore()
  const mutable = own as unknown as { patch(partial: Partial<AppSnapshot>): void }
  own.readUsageInsight = async (query: import('@harnessdesk/protocol').InsightQuery): Promise<import('@harnessdesk/protocol').InsightReport> => {
    const base = insightReportFor(PREVIEW_GOAL.goal.id)
    const unknown = new URLSearchParams(window.location.search).get('amounts') === 'unknown'
    const usd = unknown ? { ...base.totals.usd, value: null, quality: 'unknown' as const, coverage: 'none' as const } : base.totals.usd
    const row = base.breakdowns[0]!.rows[0]!
    const goal = { ...PREVIEW_GOAL, board: { ...PREVIEW_GOAL.board, name: 'Storefront' } }
    const seat = { ...PREVIEW_SEAT, board: goal.goal.id }
    const execution = { ...sceneFlowExecution('pinned'), goal: goal.goal.id, startedAt: query.to - 3_600_000,
      base: { branch: 'feature/storefront', at: 'a'.repeat(40), remote: 'origin' } }
    const seatedExecution = { ...execution, rounds: execution.rounds.map(round => ({ ...round, seats: [seat.id] })) }
    mutable.patch({ goals: new Map(own.getSnapshot().goals).set(goal.goal.id, goal),
      flowExecutions: new Map(own.getSnapshot().flowExecutions).set(execution.id, seatedExecution) })
    return { ...base, query, goals: [goal.goal], seats: [seat],
      scan: unknown ? 'partial' : 'complete', totals: { ...base.totals, usd },
      breakdowns: ['goal', 'agent'].map(dimension => ({ dimension: dimension as 'goal' | 'agent',
        rows: [{ ...row, goal: dimension === 'goal' ? goal.goal.id : null, key: dimension === 'goal' ? `goal:${PREVIEW_GOAL.goal.id}` : 'agent:project:scout', label: dimension === 'goal' ? goal.board.name : 'Scout', amounts: { ...row.amounts, usd } }],
        unattributed: { ...base.breakdowns[0]!.unattributed, usd: unknown ? usd : base.breakdowns[0]!.unattributed.usd }, reason: 'No unique historical Seat could be established.',
      })), gaps: unknown ? ['Insight stopped at 64 MiB of source data. Choose a narrower range.'] : [],
    }
  }

  /** The fixture already contains the retained Team metadata and Run. */
  own.loadGoals = async (): Promise<void> => {}
  own.loadTeamRuns = async (): Promise<void> => {}
  own.loadTeamRunsBatch = async (teams): Promise<{ loaded: ReadonlySet<string>; unavailable: ReadonlySet<string> }> => ({
    loaded: new Set(teams),
    unavailable: new Set(),
  })

  return own
}
