import type { MethodsUnder } from './context.js'

/**
 * The findings ledger, read and decided by a person.
 *
 * A Seat's own scoped read and its raise/repair/verdict tools stay behind the
 * Team capability — `readForSeat` in the findings plane, reached through the
 * extension protocol, never through a wire method. Everything here is a
 * loopback read or a person-only decision, confined to the Goal the caller
 * names through the existing Goal resolution `ctx.findings` closes over.
 */
export const findingMethods = {
  'finding/list': (ctx, params) => ctx.findings.list(params),
  'finding/read': (ctx, params) => ctx.findings.read(params),
  'finding/carry': (ctx, params) => ctx.findings.carry(params),
  'finding/publication': (ctx, params) => ctx.findings.setPublication(params.goal, params.revision, params.enabled),

  'finding/run': async (ctx, params) => {
    const view = await ctx.findings.run(params)
    if (view.goal !== params.goal) throw new Error('That run does not belong to this Goal.')
    return view
  },

  'finding/decide': (ctx, params) => ctx.findings.decide(params),
} satisfies MethodsUnder<'finding/'>
