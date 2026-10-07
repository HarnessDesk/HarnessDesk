import type { FlowExecution } from '@harnessdesk/protocol'
import type { SeatRow } from './team-overview'

type Cost = SeatRow['cost']
export const costWords = (cost: Cost | undefined): string => cost ? `${cost.estimated ? 'About ' : ''}${cost.unit === 'money' ? `$${cost.value.toFixed(2)}` : `${cost.value} turns`}` : 'Not recorded'

/** Count each recorded Run Seat once and keep missing costs explicit. */
export const runSeatCosts = <T extends { id: string; cost?: Cost }>(execution: FlowExecution, seats: readonly T[]) => {
  const ids = [...new Set(execution.rounds.flatMap(round => round.seats))]
  const recorded = ids.flatMap(id => { const seat = seats.find(one => one.id === id); return seat ? [seat] : [] })
  const costs = recorded.flatMap(seat => seat.cost ? [seat.cost] : [])
  const totals = (['money', 'turns'] as const).flatMap(unit => {
    const values = costs.filter(cost => cost.unit === unit)
    return values.length ? [costWords({ unit, value: values.reduce((sum, cost) => sum + cost.value, 0), estimated: values.some(cost => cost.estimated) })] : []
  })
  const summary = totals.length ? `${totals.join(' · ')}${costs.length < ids.length ? ' · Partial' : ''}` : null
  return { ids, recorded, costs, summary }
}
