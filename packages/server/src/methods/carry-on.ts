import type { MethodsUnder } from './context.js'

/**
 * Carrying a conversation on past a usage limit: the live incidents, and the
 * person's answer to one.
 *
 * Declared ahead of the service that answers them, so the renderer can be
 * built against the final shape; until `CarryOnService` lands, both refuse
 * with a sentence that says so rather than answering with an empty list that
 * would read as "nothing is stuck".
 */
const notYet = (method: string): never => {
  throw new Error(`${method} is not available yet: carrying a conversation on past a usage limit is still being built`)
}

export const carryOnMethods = {
  'carryOn/list': () => notYet('carryOn/list'),

  'carryOn/decide': () => notYet('carryOn/decide'),
} satisfies MethodsUnder<'carryOn/'>
