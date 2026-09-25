export interface ComparableCost {
  readonly goal: string
  readonly side: 'left' | 'right'
  readonly value: number | null
  readonly basis: 'listPrice' | 'vendorMetered' | 'mixed' | 'unknown'
  readonly complete: boolean
}

/** Pair work before summing it: an unmatched low-cost Goal cannot win a comparison. */
export function pairedCosts(rows: readonly ComparableCost[]): { goals: readonly string[]; left: number | null; right: number | null } {
  const pairs = new Map<string, ComparableCost[]>()
  for (const row of rows) pairs.set(row.goal, [...(pairs.get(row.goal) ?? []), row])
  const accepted = [...pairs.entries()].filter(([, pair]) => {
    const left = pair.filter((row) => row.side === 'left')
    const right = pair.filter((row) => row.side === 'right')
    if (left.length !== 1 || right.length !== 1) return false
    const [a] = left; const [b] = right
    return a!.complete && b!.complete && a!.value !== null && b!.value !== null
      && Number.isFinite(a!.value) && Number.isFinite(b!.value) && a!.value >= 0 && b!.value >= 0
      && a!.basis === b!.basis && a!.basis !== 'mixed' && a!.basis !== 'unknown'
  }).sort(([a], [b]) => a.localeCompare(b))
  if (accepted.length === 0) return { goals: [], left: null, right: null }
  const bases = new Set(accepted.map(([, pair]) => pair[0]!.basis))
  if (bases.size !== 1) return { goals: [], left: null, right: null }
  const total = (side: 'left' | 'right') => accepted.reduce((sum, [, pair]) => sum + pair.find((row) => row.side === side)!.value!, 0)
  const left = total('left'); const right = total('right')
  return Number.isFinite(left) && Number.isFinite(right) ? { goals: accepted.map(([goal]) => goal), left, right } : { goals: [], left: null, right: null }
}

export function activeMilliseconds(intervals: readonly { readonly from: number; readonly to: number }[]): number | null {
  if (intervals.length === 0 || intervals.some(({ from, to }) => !Number.isFinite(from) || !Number.isFinite(to) || to < from)) return null
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to)
  let start = sorted[0]!.from; let end = sorted[0]!.to; let total = 0
  for (const interval of sorted.slice(1)) {
    if (interval.from <= end) end = Math.max(end, interval.to)
    else { total += end - start; start = interval.from; end = interval.to }
  }
  const result = total + end - start
  return Number.isFinite(result) ? result : null
}
