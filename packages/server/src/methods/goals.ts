import type { GoalView } from '@harnessdesk/protocol'

import { cardsForWire } from '../team.js'
import type { MethodsUnder } from './context.js'

/**
 * The one seam between what `GoalPlane.view` answers (raw — its board is
 * also what `Team`'s own copy re-syncs from, `dirtyPaths` and all) and what
 * a `goal/*` method actually hands a client. Every method below that
 * returns a `GoalView` goes through this, so a claim's dirty-paths snapshot
 * never reaches a renderer, whichever of them a caller used to read it.
 */
export const goalViewForWire = (view: GoalView): GoalView =>
  ({ ...view, board: { ...view.board, intents: cardsForWire(view.board.intents) } })

export const goalMethods = {
  'goal/list': async (ctx, params) => (await ctx.goals.list(params.root)).map(goalViewForWire),
  'goal/read': async (ctx, params) => goalViewForWire(await ctx.goals.view(params.goal)),
  'goal/create': async (ctx, params) => goalViewForWire(await ctx.goals.create(params)),
  'goal/update': async (ctx, params) => goalViewForWire(await ctx.goals.update(params.goal, params.revision, {
    ...(params.sentence === undefined ? {} : { sentence: params.sentence }),
    ...(params.dependsOn === undefined ? {} : { dependsOn: params.dependsOn }),
  })),
  'goal/seat': (ctx, params) => ctx.goals.seat(params),
  'goal/assign': (ctx, params) => ctx.goals.assign(params.goal, params.card, params.session),
  'goal/release': async (ctx, params) => {
    await ctx.goals.release(params.goal, params.seat)
    return null
  },
  'goal/preview': (ctx, params) => ctx.goals.preview(params.goal, params.choices),
  'goal/wrap': (ctx, params) => ctx.goals.wrap(params.goal, params.stamp, params.choices),
  'goal/receipt': (ctx, params) => ctx.goals.receipt(params.goal),
  'goal/cite': async (ctx, params) => {
    await ctx.goals.cite(params.goal, params.citation)
    return null
  },
  'goal/migration/ack': async (ctx) => {
    await ctx.goals.store.acknowledgeMigration()
    return null
  },
} satisfies MethodsUnder<'goal/'>
