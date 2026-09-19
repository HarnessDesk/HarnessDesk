import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { seed, type Patch, type Source } from './model.js'

/**
 * Records have already passed EvidenceStore.read(project, 'evidence'). Both
 * checkout paths must be canonical admitted identities, never a cwd fallback.
 * A range fact binds this range; it says nothing about intermediate commits.
 */
export const sourceFromFacts = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): Source | null => {
  const shaped = seats.map((seat) => ({
    id: seat.id,
    cwd: seat.checkout.cwd,
    project: seat.checkout.project,
    openedAt: seat.openedAt,
    closedAt: seat.closed?.at ?? null,
    restored: !!seat.restored,
  }))
  const found = records.flatMap((record) => {
    if (record.fact.kind !== 'diff' || !record.seat || !record.checkout) return []
    const fact = {
      id: record.id,
      seat: record.seat,
      cwd: record.checkout.cwd,
      project,
      from: record.fact.from,
      to: record.fact.to,
      observedAt: record.observedAt,
      restored: !!record.restored,
    }
    const source = seed({
      project, cwd, from, to, firstSeen: fact.observedAt, patch,
    }, shaped, [fact])
    return source ? [source] : []
  })
  if (!found.length) return null
  const ids = [...new Set(found.flatMap((source) => source.seats))].sort()
  return { id: to, seats: ids, patch, ambiguous: ids.length !== 1 }
}
