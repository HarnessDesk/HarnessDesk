import { formatAge } from './usage'

/** A source observation predating this window must not look like a read made by this desk. */
export const dashboardReadLabel = (fetchedAt: number, now: number, startedAt: number): string =>
  fetchedAt < startedAt ? 'From a cached read' : `Read ${formatAge(fetchedAt, now)}`
