import type { FlowExecution, GoalView, TeamState } from '@harnessdesk/protocol'

import { goalName } from './goals'
import { goalRunOf } from './goal-run'
import { teamSeats } from './team-seats'

/**
 * What a seat in a Team is called when nobody typed to it.
 *
 * A seat is somebody's job in a Team, handed its brief by the desk rather than
 * a person, so there is no first message to name its conversation by, and the
 * list read "Untitled session" down a whole Team. A seat is named by what it
 * does and where: "Implementer · Fix the retry bug". The job is the round's if
 * a round has taken it, else the one the seat was opened with, else the
 * agent's own name — a seat with no job still says who it is.
 *
 * Only a last resort. A conversation a person did write in keeps the words
 * they wrote; this is read where the row would otherwise say nothing.
 */

/** "code-reviewer" is a job said in a word-processor's words: "Code reviewer". */
const inWords = (role: string): string => {
  const spaced = role.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

type Held = {
  readonly teams: ReadonlyMap<string, TeamState>
  readonly goals: ReadonlyMap<string, GoalView>
  readonly flowExecutions: ReadonlyMap<string, FlowExecution>
}

let last: { readonly held: Held; readonly labels: ReadonlyMap<string, string> } | null = null

/**
 * Every seat's name by session key, worked out once for a snapshot.
 *
 * A row asks for its own, and a thousand rows asking one by one would work out
 * every Team a thousand times, so the answer is kept for as long as the three
 * maps it is read from are the same ones.
 */
export const seatLabelsOf = (held: Held): ReadonlyMap<string, string> => {
  if (last && last.held.teams === held.teams && last.held.goals === held.goals && last.held.flowExecutions === held.flowExecutions) {
    return last.labels
  }
  const labels = new Map<string, string>()
  for (const team of held.teams.values()) {
    const goal = held.goals.get(team.id)
    const named = goal ? goalName(goal.goal) : team.name
    for (const seat of teamSeats(goal, team, goalRunOf(team.id, goal, held.flowExecutions))) {
      const key = String(seat.key)
      if (!labels.has(key)) labels.set(key, `${seat.role ? inWords(seat.role) : seat.name} · ${named}`)
    }
  }
  last = { held: { teams: held.teams, goals: held.goals, flowExecutions: held.flowExecutions }, labels }
  return labels
}
