/** Host-only fingerprints. No raw patch, message or author identity is kept. */
export interface Patch {
  stable: string
  exact: string
  files: readonly string[]
}

export interface Source {
  id: string
  seats: readonly string[]
  patch: Patch
  ambiguous?: boolean
}

export type Attribution =
  | { state: 'attributed'; seats: string[]; sources: string[] }
  | { state: 'unattributed'; reason: string }

export interface SeedSeat {
  id: string
  cwd: string
  project: string
  openedAt: number
  closedAt: number | null
  restored: boolean
}

export interface SeedFact {
  id: string
  seat: string
  cwd: string
  project: string
  from: string
  to: string
  observedAt: number
  restored: boolean
}

export interface FilePatch {
  path: string
  stable: string
  exact: string
}

export interface RefMove {
  ref: string
  before: string | null
  after: string | null
}

/** Every plausible candidate must agree, including a known unknown source. */
export const reconcile = (target: Patch, sources: readonly Source[]): Attribution => {
  const matching = sources.filter((source) =>
    source.patch.stable === target.stable && source.patch.exact === target.exact,
  )
  if (!target.files.length) return { state: 'unattributed', reason: 'empty-change' }
  if (matching.some((source) => source.ambiguous || !source.seats.length)) {
    return { state: 'unattributed', reason: 'ambiguous-patch' }
  }
  const groups = new Map(matching.map((source) => {
    const seats = [...new Set(source.seats)].sort()
    return [JSON.stringify(seats), seats] as const
  }))
  if (groups.size !== 1) {
    return {
      state: 'unattributed',
      reason: groups.size ? 'ambiguous-patch' : 'no-matching-patch',
    }
  }
  return {
    state: 'attributed',
    seats: [...groups.values()][0]!,
    sources: [...new Set(matching.map((source) => source.id))].sort(),
  }
}

/** firstSeen is the binding diff's time; discovery time belongs to the journal. */
export const seed = (
  input: {
    cwd: string
    project: string
    from: string
    to: string
    firstSeen: number
    patch: Patch
  },
  seats: readonly SeedSeat[],
  facts: readonly SeedFact[],
): Source | null => {
  const valid = facts.filter((fact) =>
    !fact.restored &&
    fact.cwd === input.cwd &&
    fact.project === input.project &&
    fact.from === input.from &&
    fact.to === input.to &&
    seats.some((seat) =>
      !seat.restored &&
      seat.id === fact.seat &&
      seat.cwd === fact.cwd &&
      seat.project === fact.project &&
      seat.openedAt <= input.firstSeen &&
      seat.openedAt <= fact.observedAt &&
      (seat.closedAt === null || Math.max(input.firstSeen, fact.observedAt) <= seat.closedAt),
    ),
  )
  if (!valid.length) return null
  const ids = [...new Set(valid.map((fact) => fact.seat))].sort()
  return { id: input.to, seats: ids, patch: input.patch, ambiguous: ids.length !== 1 }
}

export const surviving = (
  old: readonly FilePatch[],
  next: readonly FilePatch[],
): { retained: string[]; unresolved: string[] } => {
  const retained = old.filter((before) => next.some((after) =>
    after.path === before.path && after.stable === before.stable && after.exact === before.exact,
  )).map((file) => file.path).sort()
  return {
    retained,
    unresolved: next.filter((file) => !retained.includes(file.path)).map((file) => file.path).sort(),
  }
}

export const moves = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): RefMove[] => [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((ref) =>
  before.get(ref) === after.get(ref)
    ? []
    : [{ ref, before: before.get(ref) ?? null, after: after.get(ref) ?? null }],
)
