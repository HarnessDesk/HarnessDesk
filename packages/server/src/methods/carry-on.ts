import type { MethodsUnder } from './context.js'

/**
 * Carrying a conversation on past a usage limit: the live incidents, for a
 * window that reconnects, and the person's answer to one. The host re-checks
 * the answer against the incident as it stands now; one that has moved on is
 * refused with the current incident (`CarryOnStaleError`), so the card can
 * show what is true instead.
 */
export const carryOnMethods = {
  'carryOn/list': ctx => ({ incidents: ctx.carryOn.list() }),

  'carryOn/decide': async (ctx, params) => ({ incident: await ctx.carryOn.decide(params) }),
} satisfies MethodsUnder<'carryOn/'>
