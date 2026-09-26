import type { PlanEntry, UsageBilling, UsageReport } from '@harnessdesk/protocol'

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
