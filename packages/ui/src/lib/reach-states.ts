import type { ReachState } from '@harnessdesk/protocol'

/**
 * What each reach state is called, in the two registers the app needs.
 *
 * One file for the same reason `tool-names.ts` is one file: the moment two
 * surfaces keep their own table of the same nine states, they drift, and the
 * drift is invisible because each one reads fine on its own. The matrix and
 * the cards were already two words apart on `unscanned` — "Not read" against
 * "Installed where this agent does not look" — which is a difference in
 * *length*, not in meaning, and exactly the kind that turns into a
 * difference in meaning six months later.
 *
 * So the registers are named rather than chosen ad hoc:
 *
 *   NAME     is what fits a table cell's accessible label and a chip. Two or
 *            three words, no verb where one can be avoided.
 *   SENTENCE is what a tooltip or a detail row can afford. It says the same
 *            thing and is allowed to say it properly.
 *
 * Neither is a description of severity — `isReachProblem` owns that — and
 * neither ever names an agent, because the caller has the column and knows
 * which one it is talking about.
 */
export const REACH_NAME: Readonly<Record<ReachState, string>> = {
  reaches: 'Reaches',
  absent: 'Not installed',
  unscanned: 'Not read',
  stale: 'Not loaded yet',
  rejected: 'Refused',
  hollow: 'Empty',
  differs: 'Copies differ',
  unhostable: 'Cannot host',
  off: 'Switched off',
}

/** The same nine, at the length a tooltip or a detail row can carry. */
export const REACH_SENTENCE: Readonly<Record<ReachState, string>> = {
  reaches: 'Loads it',
  absent: 'Not installed',
  unscanned: 'Installed where this agent does not look',
  stale: 'Installed where this agent looks, and not in the list it reported',
  rejected: 'This agent read the definition and would not load it',
  hollow: 'Empty on disk — the name lists and nothing loads',
  differs: 'Two copies disagree; scan order decides which one wins',
  unhostable: 'This agent’s configuration cannot represent it',
  off: 'Installed here and switched off',
}
