import type { UsageBalanceHistory } from '@harnessdesk/protocol'

export interface BalanceDay {
  /** Local midnight for this bucket. */
  readonly day: number
  /** The latest known balance, or zero only as an inert value while unknown. */
  readonly remaining: number
  readonly unknown: boolean
}

/** One carried-forward balance value per local day, oldest first. */
export const balanceSeries = (
  history: UsageBalanceHistory | null | undefined,
  now: number,
  days = 30,
): BalanceDay[] => {
  if (!Number.isInteger(days) || days <= 0) return []

  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))

  const points = [...(history?.points ?? [])]
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.remaining) && point.at <= now)
    .sort((a, b) => a.at - b.at)
  let pointIndex = 0
  let remaining = 0
  let known = false
  while (pointIndex < points.length && (points[pointIndex]?.at ?? Infinity) < start.getTime()) {
    remaining = points[pointIndex]?.remaining ?? remaining
    known = true
    pointIndex += 1
  }

  const result: BalanceDay[] = []
  const day = new Date(start)
  for (let index = 0; index < days; index += 1) {
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)
    while (pointIndex < points.length && (points[pointIndex]?.at ?? Infinity) < nextDay.getTime()) {
      remaining = points[pointIndex]?.remaining ?? remaining
      known = true
      pointIndex += 1
    }
    result.push({ day: day.getTime(), remaining, unknown: !known })
    day.setDate(day.getDate() + 1)
  }
  return result
}
