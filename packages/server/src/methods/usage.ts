/**
 * A stored plan fee/budget is folded into every report by `UsageService`'s
 * own overlay (`planOverlay`, wired up in `host.ts`) — once, on the one path
 * every report leaves through, `reports()`, `refresh()` and the `onReport`
 * push behind `usage/updated` alike. Nothing merges here any more
 * (BLOCKING 1): a handler that re-merged per request is exactly how a
 * pushed report used to lose the stored plan the moment it bypassed this file.
 */
import type { MethodsUnder } from './context.js'

/** Plan usage across every metered runtime, and the token ledger behind it. */
export const usageMethods = {
  'usage/reports': async (ctx) => ctx.usage().reports(),

  'usage/refresh': async (ctx, params) => ctx.usage().refresh(params.runtime),

  'usage/plan/read': (ctx, params) => ctx.plans.read(params),

  'usage/plan/set': (ctx, params) => ctx.plans.set(params),

  'usage/ledger': async (ctx, params) => {
    const ledger = ctx.ledger()
    // Prices load the first time someone asks for money, not at boot.
    await ledger.warm()
    // A first read on a machine that has never scanned would be empty and
    // wrong-looking; the scan is started here and its progress is an event.
    if (ledger.progress.finishedAt === null && !ledger.progress.running) ledger.begin()
    return ledger.query(params)
  },

  'usage/scan': async (ctx, params) => {
    const ledger = ctx.ledger()
    await ledger.warm()
    return ledger.begin(params.full === true ? { full: true } : {})
  },
} satisfies MethodsUnder<'usage/'>
