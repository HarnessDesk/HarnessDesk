/** Stable ranking that leaves every unmeasured slot exactly where it was. */
export function rankKnownSlots(order: readonly string[], costs: ReadonlyMap<string, number>): string[] {
  const known = order.map((key, index) => ({ key, index, cost: costs.get(key) }))
    .filter((row): row is { key: string; index: number; cost: number } => row.cost !== undefined && Number.isFinite(row.cost) && row.cost >= 0)
    .sort((a, b) => a.cost - b.cost || a.index - b.index)
  let next = 0
  return order.map((key) => {
    const cost = costs.get(key)
    return cost !== undefined && Number.isFinite(cost) && cost >= 0 ? known[next++]!.key : key
  })
}

export function assertOrderUnchanged(expected: string, current: string): void {
  if (expected !== current) throw new Error('Seats changed while you were choosing. Refresh and try again.')
}
