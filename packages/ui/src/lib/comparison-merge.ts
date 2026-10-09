import type { Intent } from '@harnessdesk/protocol'

/** Kept in the existing person step's handoff after Git reports a conflict-free merge. */
export interface ComparisonMergeReceipt {
  readonly version: 1
  readonly run: string
  readonly card: number
  readonly revision: string
  readonly commit: string
  readonly branch: string
  readonly at: number
}
export const encodeComparisonMerge = (receipt: ComparisonMergeReceipt): string => JSON.stringify({ comparisonMerge: receipt })
export const comparisonMergeOf = (run: string, cards: readonly Pick<Intent, 'state' | 'outcome' | 'handoff'>[]): ComparisonMergeReceipt | null => {
  for (const card of [...cards].reverse()) {
    if (card.state !== 'done' || card.outcome !== 'merged' || !card.handoff) continue
    try {
      const value: unknown = JSON.parse(card.handoff)
      if (!value || typeof value !== 'object' || !('comparisonMerge' in value)) continue
      const receipt = value.comparisonMerge
      if (!receipt || typeof receipt !== 'object') continue
      const one = receipt as Partial<ComparisonMergeReceipt>
      if (one.version === 1 && one.run === run && Number.isSafeInteger(one.card) && one.card! > 0 &&
        typeof one.revision === 'string' && /^[a-f0-9]{40,64}$/.test(one.revision) &&
        typeof one.commit === 'string' && /^[a-f0-9]{40,64}$/.test(one.commit) &&
        typeof one.branch === 'string' && one.branch.length > 0 && typeof one.at === 'number' && Number.isFinite(one.at) && one.at >= 0) return one as ComparisonMergeReceipt
    } catch { /* An ordinary handoff is prose, and carries no receipt. */ }
  }
  return null
}
