import type { FlowExecution, TeamSignal } from '@harnessdesk/protocol'
import type { ClientSnapshot } from './snapshot.js'
import { runTimeline, type RunTimelineInput } from './run-timeline.js'

/** Held subscription facts plus explicit on-demand reads; no transport or clock. */
export function runTimelineOf(snapshot: ClientSnapshot, execution: FlowExecution,
  extras: Omit<RunTimelineInput, 'execution' | 'cards' | 'signals' | 'origin'> & { origin?: string | null } = {},
): ReturnType<typeof runTimeline> {
  const team = snapshot.teams.find(one => one.goal.id === execution.goal)
  const board = snapshot.boards.find(one => one.id === team?.board.id || one.id === execution.goal) ?? team?.board
  return runTimeline({
    ...extras, publicationOn: extras.publicationOn ?? team?.goal.findingPublication !== false, execution, cards: board?.intents ?? [],
    signals: board?.channel?.filter((one): one is TeamSignal => one.kind === 'signal') ?? [],
    origin: extras.origin !== undefined ? extras.origin : execution.intake ? `From trigger ${execution.intake.trigger}`
      : team?.goal.origin?.kind === 'person' ? 'Started by you' : null,
  })
}
