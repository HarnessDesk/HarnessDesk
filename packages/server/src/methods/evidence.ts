import type { MethodsUnder } from './context.js'

/**
 * The evidence plane, read — and, from later in phase 4, asked to run a
 * project's named checks. Everything here reaches the plane as `ctx.evidence`.
 */
export const evidenceMethods = {
  'evidence/seat': (ctx, params) => ctx.evidence.seats.latestOf(params.runtime, params.sessionId),
} satisfies MethodsUnder<'evidence/'>
