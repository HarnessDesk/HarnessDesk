import type { UsageReport } from '@harnessdesk/protocol'

import { mergePlanIntoReport } from '../usage/plan-merge.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * Folds each report's stored plan fee/budget in, when the account has one.
 * `report.account` is null for an agent with no signed-in identity to key on
 * (a bare API key with no account label) — nothing is stored for those, so
 * they pass through unchanged.
 */
const withPlans = async (ctx: HostContext, reports: readonly UsageReport[]): Promise<readonly UsageReport[]> =>
  Promise.all(
    reports.map(async (report) => {
      if (report.account === null) return report
      const stored = await ctx.plans.entryFor(report.runtime, report.account)
      return mergePlanIntoReport(report, stored)
    }),
  )

/** Plan usage across every metered runtime, and the token ledger behind it. */
export const usageMethods = {
  'usage/reports': async (ctx) => withPlans(ctx, await ctx.usage().reports()),

  'usage/refresh': async (ctx, params) => withPlans(ctx, await ctx.usage().refresh(params.runtime)),

  'usage/plan/read': (ctx) => ctx.plans.read(),

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
