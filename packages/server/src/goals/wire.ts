import type { GoalView } from '@harnessdesk/protocol'

import { cardsForWire } from '../team.js'

/**
 * The one seam between what `GoalPlane.view` answers (raw — its board is
 * also what `Team`'s own copy re-syncs from, `dirtyPaths` and all) and what
 * a client is handed, whether a `goal/*` method's result or a `goal/changed`
 * push. A claim's dirty-paths snapshot never reaches a renderer, whichever
 * of them a caller used to read it.
 */
export const goalViewForWire = (view: GoalView): GoalView =>
  ({ ...view, board: { ...view.board, intents: cardsForWire(view.board.intents) } })
