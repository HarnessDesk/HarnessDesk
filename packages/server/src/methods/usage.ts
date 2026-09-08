import type { MethodsUnder } from './context.js'

/** Plan usage across every metered runtime, and the token ledger behind it. */
export const usageMethods = {
  'usage/reports': (ctx) => ctx.usage().reports(),

  'usage/refresh': (ctx, params) => ctx.usage().refresh(params.runtime),

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
