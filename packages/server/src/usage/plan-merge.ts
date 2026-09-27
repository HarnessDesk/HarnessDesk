import type { PlanEntry, UsageBilling, UsageReport } from '@harnessdesk/protocol'

import type { PlanStore } from './plan-store.js'

/**
 * Folds a stored plan entry into one report's `billing`, `source: 'user'`.
 *
 * A vendor-reported fee — should a reader ever produce one — always wins: the
 * stored entry is what a person typed because the vendor did not say, and it
 * never overrides the vendor's own word once there is one. A budget has no
 * vendor counterpart at all, so a stored one always applies. Returns the same
 * report instance when there is nothing to fold in, so a caller can tell
 * whether anything changed without a deep comparison.
 */
export const mergePlanIntoReport = (report: UsageReport, stored: PlanEntry | null): UsageReport => {
  if (!stored || (!stored.fee && !stored.budget)) return report
  const billing = report.billing
  const vendorFee = billing?.fee && billing.fee.source === 'vendor' ? billing.fee : null
  const fee = vendorFee ?? (stored.fee ? { amount: stored.fee.amount, currency: stored.fee.currency, period: stored.fee.period, source: 'user' as const } : billing?.fee)
  const budget = stored.budget ? { amount: stored.budget.amount, currency: stored.budget.currency, period: 'month' as const } : billing?.budget
  if (fee === billing?.fee && budget === billing?.budget) return report
  const nextBilling: UsageBilling = { kinds: billing?.kinds ?? [], ...billing, fee, budget }
  return { ...report, billing: nextBilling }
}

/**
 * The one merge every report passes through (`UsageService`'s `overlay`
 * option) — `usage/reports`, `usage/refresh` and every `usage/updated` push
 * all funnel through `UsageService#finish`, so a fee or budget set on an
 * account is never visible on one path and gone on the next.
 *
 * Reads `plans.json` fresh on every call rather than once at startup — a
 * `Use $20/mo` click has to show up on the very next report — and a file
 * that cannot be read is logged and never blocks the report it would have
 * decorated: one broken overlay must not take usage down (BLOCKING 2).
 * `report.account === null` (no signed-in identity to key on) skips the
 * read entirely; nothing is ever stored for that account.
 */
export const planOverlay = (
  plans: Pick<PlanStore, 'entryFor'>,
  log?: (message: string, details?: Record<string, unknown>) => void,
): ((report: UsageReport) => Promise<UsageReport>) => {
  return async (report) => {
    if (report.account === null) return report
    try {
      const stored = await plans.entryFor(report.runtime, report.account)
      return mergePlanIntoReport(report, stored)
    } catch (error) {
      log?.('plans.json could not be read; usage reports are unmerged', {
        error: error instanceof Error ? error.message : String(error),
      })
      return report
    }
  }
}
