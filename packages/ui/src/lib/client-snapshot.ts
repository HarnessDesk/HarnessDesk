import { splitSessionKey } from '@harnessdesk/protocol'
import type { ClientSnapshot } from '@harnessdesk/client/views'
import type { AppSnapshot } from '../state/snapshot'

/** The window holds the host's facts too, without using the client transport. */
export function clientSnapshot(snapshot: AppSnapshot): ClientSnapshot {
  return {
    teams: [...snapshot.goals.values()],
    runs: [...snapshot.flowExecutions.values()],
    boards: [...snapshot.teams.values()],
    seats: [...snapshot.seatActivities.values()],
    approvals: snapshot.approvals.map(({ key, approval }) => {
      const { runtime, id: sessionId } = splitSessionKey(key)
      return { runtime, sessionId, approval }
    }),
    reviews: [...snapshot.findingRuns.values()].map(view => ({ run: view.run, rounds: [...view.rounds] })),
  }
}
