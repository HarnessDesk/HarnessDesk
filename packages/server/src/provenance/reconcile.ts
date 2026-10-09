import { createHash } from 'node:crypto'

import type { CardRef, EvidenceRecord, ProvenanceSeat, SeatRecord } from '@harnessdesk/protocol'

import type { GitReader, ReflogMove } from './git.js'
import { reconcile, seed, surviving, type FilePatch, type Patch, type Source } from './model.js'
import { WorkSlices, type SliceOptions } from './slices.js'

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

export interface CommitObservation {
  readonly id: string
  readonly sha: string
  readonly parents: readonly string[]
  readonly tree: string
  readonly firstSeenAt: number
  readonly fingerprintVersion: 1
  readonly discoveredBy: readonly string[]
  readonly checkoutHints: readonly string[]
  readonly window: { readonly from: number | null; readonly to: number }
  readonly patch: Patch | null
  readonly files: readonly FilePatch[]
  readonly why: string | null
}

export interface RangeObservation {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly commits: readonly string[]
  readonly patch: Patch
  readonly seats: readonly string[]
  readonly ambiguous: boolean
  readonly at: number
}

export interface LinkObservation {
  readonly id: string
  readonly sha: string
  readonly seats: readonly string[]
  readonly sourceIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly retainedPaths: readonly string[]
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly via: 'observed' | 'patch' | 'amend' | 'squash' | null
  readonly reason: string | null
  readonly at: number
}

export interface ReconcileInput {
  readonly commits: readonly CommitObservation[]
  readonly sources: readonly Source[]
  readonly priorLinks: readonly LinkObservation[]
  readonly moves: readonly ReflogMove[]
  readonly now: number
  /** Deterministic cost evidence; counts index lookups and range member reads. */
  readonly slices?: SliceOptions
  readonly work?: { patchLookups: number; sourceRebuilds: number; rangeMembers: number }
}

/** Additional internal proof, rebuilt from durable facts/ranges on startup. */
export interface ProvenanceSource extends Source {
  readonly proof: {
    readonly kind: 'diff' | 'range'
    readonly from: string
    readonly to: string
    readonly commits: readonly string[]
    readonly evidenceIds: readonly string[]
    readonly restored: boolean
  }
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const live = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('capture-aborted')
}
const proven = (source: Source): source is ProvenanceSource =>
  'proof' in source && typeof source.proof === 'object' && source.proof !== null

/** Source IDs bind the exact fact set, so new competing evidence is a new decision. */
export const factSource = (
  project: string,
  cwd: string,
  from: string,
  to: string,
  patch: Patch,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): ProvenanceSource | null => {
  const source = sourceFromFacts(project, cwd, from, to, patch, seats, records)
  if (!source) return null
  const evidenceIds = unique(records.filter((record) =>
    sourceFromFacts(project, cwd, from, to, patch, seats, [record]) !== null,
  ).map((record) => record.id))
  return {
    ...source,
    id: digest(['diff', 1, project, cwd, from, to, patch, evidenceIds, source.seats]),
    proof: { kind: 'diff', from, to, commits: [to], evidenceIds, restored: false },
  }
}

const latestLinks = (links: readonly LinkObservation[]): Map<string, LinkObservation> => {
  const latest = new Map<string, LinkObservation>()
  // Journal order breaks an equal-time tie. Wall-clock time never reorders records.
  for (const link of links) latest.set(link.sha, link)
  return latest
}

/**
 * Capture before the source objects disappear. The caller appends this range
 * durably before offering rangeSource to reconciliation or advancing a cursor.
 */
export const captureRange = async (
  from: string,
  parts: readonly CommitObservation[],
  links: readonly LinkObservation[],
  git: GitReader,
  signal: AbortSignal,
  at: number,
): Promise<RangeObservation> => {
  live(signal)
  if (!parts.length || parts.length > 64) throw new Error('limit-exceeded')
  const found = await git.kinds(parts.map((part) => part.sha), signal)
  let parent = from
  for (const part of parts) {
    if (part.parents.length !== 1 || part.parents[0] !== parent) throw new Error('history-gap')
    if (found.get(part.sha) !== 'commit') throw new Error('missing-object')
    parent = part.sha
  }
  const latest = latestLinks(links)
  const owners = new Map<string, Set<string>>()
  let ambiguous = false
  for (const part of parts) {
    const link = latest.get(part.sha)
    if (!part.patch || part.why || !link || link.coverage !== 'complete' || !link.seats.length) {
      ambiguous = true
      continue
    }
    for (const file of part.files) {
      const seats = owners.get(file.path) ?? new Set<string>()
      for (const seat of link.seats) seats.add(seat)
      owners.set(file.path, seats)
    }
  }
  const to = parts.at(-1)!.sha
  const patch = await git.patch(from, to, signal)
  // The net delta's paths are the patch's own; what each path fingerprints to
  // is not read here, so it is not asked of Git.
  const netFiles = patch.files
  // One Seat owns all mutations on a path: a nonempty net delta retains some
  // of that Seat's contribution. Two Seats require line survival, which this
  // phase deliberately does not infer. A reverted path supplies no survivor.
  for (const [path, seats] of owners) {
    if (seats.size !== 1 || !netFiles.includes(path)) ambiguous = true
  }
  if (!patch.files.length || netFiles.some((path) => !owners.has(path))) ambiguous = true
  const sourceIds = parts.flatMap((part) => [part.id, latest.get(part.sha)?.id ?? 'missing-link'])
  return {
    id: digest(['range', 1, from, to, sourceIds]),
    from,
    to,
    commits: parts.map((part) => part.sha),
    patch,
    seats: unique([...owners.values()].flatMap((set) => [...set])),
    ambiguous,
    at,
  }
}

/** A restored range can be displayed as history; it cannot seed a local rewrite. */
export const rangeSource = (
  range: RangeObservation,
  links: readonly LinkObservation[],
  restored = false,
  latest = latestLinks(links),
): ProvenanceSource => {
  const parts = range.commits.map((sha) => latest.get(sha))
  const seats = unique(parts.flatMap((part) => part?.seats ?? []))
  const incomplete = parts.some((part) => !part || part.coverage !== 'complete') ||
    JSON.stringify(seats) !== JSON.stringify(unique(range.seats))
  return {
    id: range.id,
    seats: range.seats,
    patch: range.patch,
    ambiguous: range.ambiguous || incomplete,
    proof: {
      kind: 'range', from: range.from, to: range.to, commits: range.commits,
      evidenceIds: unique(parts.flatMap((part) => part?.evidenceIds ?? [])), restored,
    },
  }
}

/** What a range needs to be read: the commit before its first part, and its parts, oldest first. */
export interface RangeCandidate {
  readonly key: string
  readonly from: string
  readonly commits: readonly CommitObservation[]
}

/** At most this many never-tried ranges are offered at once; the rest are named as pending. */
const OFFERED = 256

/**
 * A pending entry that no later pass can act on: it marks a range that could
 * not be read, or a history longer than a range may be. Anything else pending
 * is work still to do.
 */
export const LIMIT_PREFIX = 'limit:'

/** Whether a later pass has something to do that no change in what it reads is needed for. */
export const backlog = (pending: readonly string[]): boolean => pending.some((key) => !key.startsWith(LIMIT_PREFIX))

/**
 * Contiguous first-parent suffixes only; the worker persists the returned remainder.
 * A range in `failed` could not be read when it was tried: it is offered
 * separately, as `retry`, so ranges that could not be read take no place from
 * ranges that have never been tried.
 */
function* candidateSteps(
  commits: readonly CommitObservation[],
  captured: ReadonlySet<string>,
  failed: ReadonlySet<string> = new Set(),
): Generator<void, { ready: readonly RangeCandidate[]; pending: readonly string[]; retry: readonly RangeCandidate[] }> {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const ready: RangeCandidate[] = []
  const retry: RangeCandidate[] = []
  const pending: string[] = []
  for (const tip of [...commits].sort((a, b) => a.sha.localeCompare(b.sha))) {
    const parts: CommitObservation[] = []
    const seen = new Set<string>()
    let current: CommitObservation | undefined = tip
    while (current && current.parents.length === 1 && parts.length < 64 && !seen.has(current.sha)) {
      seen.add(current.sha)
      parts.unshift(current)
      const from = current.parents[0]!
      const key = digest([from, tip.sha, parts.map((part) => part.id)])
      if (parts.length > 1 && !captured.has(key)) {
        if (failed.has(key)) retry.push({ key, from, commits: [...parts] })
        else if (ready.length < OFFERED) ready.push({ key, from, commits: [...parts] })
        else pending.push(key)
      }
      current = bySha.get(from)
    }
    if (current && parts.length === 64) pending.push(`${LIMIT_PREFIX}${tip.sha}`)
    yield
  }
  return { ready, pending, retry }
}

/** Rewrite edges are undirected; sharing a parent never joins independent branches. */
export const rangeCandidates = (
  ...args: Parameters<typeof candidateSteps>
): ReturnType<typeof rangeCandidatesAsync> extends Promise<infer T> ? T : never => {
  const steps = candidateSteps(...args)
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}

export const rangeCandidatesAsync = async (
  commits: readonly CommitObservation[], captured: ReadonlySet<string>, failed: ReadonlySet<string> = new Set(),
  slices = new WorkSlices(),
): Promise<{ ready: readonly RangeCandidate[]; pending: readonly string[]; retry: readonly RangeCandidate[] }> => {
  const steps = candidateSteps(commits, captured, failed)
  let next = steps.next()
  while (!next.done) {
    await slices.step()
    next = steps.next()
  }
  return next.value
}

const lineage = async (moves: readonly ReflogMove[], slices: WorkSlices): Promise<(from: string, to: string) => boolean> => {
  const graph = new Map<string, Set<string>>()
  for (const move of moves) {
    await slices.step()
    if (!move.before || !move.after) continue
    for (const [a, b] of [[move.before, move.after], [move.after, move.before]] as const) {
      const neighbours = graph.get(a) ?? new Set<string>()
      neighbours.add(b)
      graph.set(a, neighbours)
    }
  }
  const components = new Map<string, string>()
  for (const start of graph.keys()) {
    if (components.has(start)) continue
    const todo = [start]
    components.set(start, start)
    while (todo.length) {
      await slices.step()
      for (const next of graph.get(todo.pop()!) ?? []) {
        if (components.has(next)) continue
        components.set(next, start)
        todo.push(next)
      }
    }
  }
  return (from, to) => from === to ||
    (components.has(from) && components.get(from) === components.get(to))
}

/**
 * The fixed phase API retains git; object reads belong to captureRange, before
 * its journal append. This decision pass needs only durable observations, so
 * reopening it does not require original objects to remain in Git.
 */
export const reconcileProject = async (
  input: ReconcileInput,
  git: GitReader,
  signal: AbortSignal,
): Promise<readonly LinkObservation[]> => {
  void git
  const slices = new WorkSlices(input.slices)
  const output: LinkObservation[] = []
  const latest = latestLinks(input.priorLinks)
  const oldIds = new Set(input.priorLinks.map((link) => link.id))
  const observed = new Map(input.commits.map((commit) => [commit.sha, commit]))
  const sources = input.sources.filter(proven)
  const related = await lineage(input.moves, slices)
  const patchKey = (patch: Patch): string => {
    if (input.work) input.work.patchLookups += 1
    return JSON.stringify([patch.stable, patch.exact])
  }
  const index = async <T>(values: readonly T[], patch: (value: T) => Patch | null): Promise<Map<string, T[]>> => {
    const byPatch = new Map<string, T[]>()
    for (const value of values) {
      await slices.step()
      const fingerprint = patch(value)
      if (!fingerprint) continue
      const key = patchKey(fingerprint)
      const group = byPatch.get(key) ?? []
      group.push(value)
      byPatch.set(key, group)
    }
    return byPatch
  }
  const byPatch = await index(sources, (source) => source.patch)
  const unscopedByPatch = await index(input.sources.filter((source) => !proven(source)), (source) => source.patch)
  const commitsByPatch = await index(input.commits, (commit) => commit.patch)
  const movesTo = new Map<string, ReflogMove[]>()
  for (const move of input.moves) {
    await slices.step()
    if (!move.after) continue
    const group = movesTo.get(move.after) ?? []
    group.push(move)
    movesTo.set(move.after, group)
  }
  const dependent = new Map<string, Set<ProvenanceSource>>()
  const dirty = new Set<ProvenanceSource>()
  const refreshed = new Map<ProvenanceSource, ProvenanceSource>()
  const byId = new Map(sources.map((source) => [source.id, source]))
  for (const source of sources) {
    await slices.step()
    if (source.proof.kind !== 'range') continue
    dirty.add(source)
    for (const sha of source.proof.commits) {
      const ranges = dependent.get(sha) ?? new Set<ProvenanceSource>()
      ranges.add(source)
      dependent.set(sha, ranges)
    }
  }
  const refresh = (source: ProvenanceSource): ProvenanceSource => {
    if (!dirty.delete(source)) return refreshed.get(source) ?? source
    if (input.work) {
      input.work.sourceRebuilds += 1
      input.work.rangeMembers += source.proof.commits.length
    }
    const parts = source.proof.commits.map((sha) => latest.get(sha))
    const seats = unique(parts.flatMap((part) => part?.seats ?? []))
    const invalid = parts.some((part) => !part || part.coverage !== 'complete') ||
      JSON.stringify(seats) !== JSON.stringify(unique(source.seats))
    const current = { ...source, ambiguous: source.ambiguous || invalid }
    refreshed.set(source, current)
    return current
  }
  // One initial rebuild, then only ranges depending on a changed decision.
  for (const source of sources) {
    await slices.step()
    refresh(source)
  }
  const decide = (commit: CommitObservation, result: Omit<LinkObservation, 'id' | 'sha' | 'at'>) => {
    const normalized = {
      ...result,
      seats: unique(result.seats), sourceIds: unique(result.sourceIds),
      evidenceIds: unique(result.evidenceIds), retainedPaths: unique(result.retainedPaths),
    }
    const previous = latest.get(commit.sha)
    if (previous) {
      const { id: previousId, sha: previousSha, at: previousAt, ...decision } = previous
      void [previousId, previousSha, previousAt]
      if (decision.coverage === normalized.coverage && decision.via === normalized.via &&
        decision.reason === normalized.reason &&
        JSON.stringify(unique(decision.seats)) === JSON.stringify(normalized.seats) &&
        JSON.stringify(unique(decision.sourceIds)) === JSON.stringify(normalized.sourceIds) &&
        JSON.stringify(unique(decision.evidenceIds)) === JSON.stringify(normalized.evidenceIds) &&
        JSON.stringify(unique(decision.retainedPaths)) === JSON.stringify(normalized.retainedPaths)) return
    }
    const id = digest(['link', 1, commit.id, commit.sha, previous?.id ?? null, normalized])
    const link: LinkObservation = { ...normalized, id, sha: commit.sha, at: input.now }
    latest.set(commit.sha, link)
    for (const source of dependent.get(commit.sha) ?? []) dirty.add(source)
    if (!oldIds.has(id)) output.push(link)
  }
  for (const commit of [...input.commits].sort((a, b) =>
    a.firstSeenAt - b.firstSeenAt || a.sha.localeCompare(b.sha),
  )) {
    await slices.step()
    live(signal)
    const refuse = (reason: string, sourceIds: readonly string[] = []) => decide(commit, {
      seats: [], sourceIds, evidenceIds: [], retainedPaths: [],
      coverage: 'none', via: null, reason,
    })
    const patch = commit.patch
    if (!patch) {
      refuse(commit.why ?? 'missing-object')
      continue
    }
    const key = patchKey(patch)
    const matches = (byPatch.get(key) ?? []).map(refresh)
    const direct = matches.filter((source) => !source.proof.restored &&
      source.proof.to === commit.sha &&
      source.proof.from === commit.parents[0],
    )
    if (commit.parents.length > 1 && !direct.length) {
      refuse('unsupported-merge')
      continue
    }
    if (!patch.files.length) {
      refuse('empty-change')
      continue
    }
    if (commit.why) {
      refuse(commit.why)
      continue
    }
    const unscoped = (unscopedByPatch.get(key) ?? [])
      .map((source) => ({ ...source, seats: [], ambiguous: true }))
    let candidates: Source[] = [...direct, ...unscoped]
    if (!direct.length) {
      candidates = [...matches.filter((source) => !source.proof.restored), ...unscoped]
      // A discovered equal patch with no binding proof is a known alternative.
      // Copies already explained by the same lineage are represented by their
      // source, rather than being counted twice as known and unknown.
      for (const other of commitsByPatch.get(key) ?? []) {
        await slices.step()
        if (other.sha === commit.sha || !other.patch) continue
        const explained = matches.some((source) => !source.proof.restored &&
          (source.proof.to === other.sha || related(source.proof.to, other.sha)),
        )
        if (!explained) candidates.push({ id: other.id, patch: other.patch, seats: [] })
      }
      if (candidates.some((source) => proven(source) && !related(source.proof.to, commit.sha))) {
        refuse('ambiguous-patch', candidates.map((source) => source.id))
        continue
      }
    }
    const complete = reconcile(patch, candidates)
    if (complete.state === 'attributed') {
      const used = candidates.filter((source) => complete.sources.includes(source.id))
      decide(commit, {
        seats: complete.seats,
        sourceIds: unique([commit.id, ...used.flatMap((source) => {
          if (!proven(source)) return [source.id]
          if (source.proof.kind === 'range') return [source.id]
          return source.proof.commits.flatMap((sha) => {
            const original = observed.get(sha)
            return original ? [original.id] : []
          })
        })]),
        evidenceIds: unique(used.flatMap((source) => proven(source) ? source.proof.evidenceIds : [])),
        retainedPaths: patch.files,
        coverage: 'complete',
        via: direct.length ? 'observed' : used.some((source) => proven(source) && source.proof.kind === 'range') ? 'squash' : 'patch',
        reason: null,
      })
      continue
    }
    if (complete.reason === 'ambiguous-patch') {
      refuse('ambiguous-patch', candidates.map((source) => source.id))
      continue
    }
    const replacements = (movesTo.get(commit.sha) ?? []).filter((move) => move.before &&
      (move.checkout === null || commit.checkoutHints.includes(move.checkout)),
    ).map((move) => observed.get(move.before!)).filter((old): old is CommitObservation =>
      !!old && JSON.stringify(old.parents) === JSON.stringify(commit.parents),
    )
    const ownership = (
      sha: string,
      path: string,
      seen = new Set<string>(),
    ): { seats: string[]; evidenceIds: string[] } | null => {
      if (seen.has(sha)) return null
      seen.add(sha)
      const link = latest.get(sha)
      if (!link || link.coverage === 'none' || !link.retainedPaths.includes(path)) return null
      if (link.seats.length === 1) return { seats: [...link.seats], evidenceIds: [...link.evidenceIds] }
      const ranges = link.sourceIds.flatMap((id) => {
        const source = byId.get(id)
        if (!source || source.proof.kind !== 'range') return []
        const current = refresh(source)
        return current.ambiguous ? [] : [current]
      })
      const parts = unique(ranges.flatMap((range) => range.proof.commits))
        .filter((part) => observed.get(part)?.files.some((file) => file.path === path))
      const owners = parts.map((part) => ownership(part, path, new Set(seen)))
      if (!owners.length || owners.some((owner) => !owner)) return null
      const seats = unique(owners.flatMap((owner) => owner!.seats))
      if (seats.length !== 1) return null
      return { seats, evidenceIds: unique(owners.flatMap((owner) => owner!.evidenceIds)) }
    }
    const retained: {
      old: CommitObservation
      link: LinkObservation
      paths: string[]
      seats: string[]
      evidenceIds: string[]
    }[] = []
    let ambiguous = false
    for (const old of replacements) {
      const link = latest.get(old.sha)
      const paths = surviving(old.files, commit.files).retained
        .filter((path) => link?.retainedPaths.includes(path))
      if (!paths.length) continue
      const owners = paths.map((path) => ownership(old.sha, path))
      if (!link || owners.some((owner) => !owner)) {
        ambiguous = true
        continue
      }
      retained.push({
        old, link, paths,
        seats: unique(owners.flatMap((owner) => owner!.seats)),
        evidenceIds: unique(owners.flatMap((owner) => owner!.evidenceIds)),
      })
    }
    const seatSets = new Set(retained.map((part) => JSON.stringify(part.seats)))
    if (ambiguous || seatSets.size > 1) {
      refuse('ambiguous-patch')
      continue
    }
    if (retained.length) {
      const paths = unique(retained.flatMap((part) => part.paths))
      const unresolved = commit.files.filter((file) => !paths.includes(file.path))
      decide(commit, {
        seats: retained[0]!.seats,
        sourceIds: retained.flatMap(({ old, link }) => [old.id, link.id, ...link.sourceIds]),
        evidenceIds: retained.flatMap((part) => part.evidenceIds),
        retainedPaths: paths,
        coverage: unresolved.length ? 'partial' : 'complete',
        via: 'amend',
        reason: unresolved.length ? 'changed-patch' : null,
      })
      continue
    }
    refuse(replacements.length ? 'changed-patch' :
      matches.some((source) => source.proof.restored) ? 'restored-history' : 'no-seat-evidence')
  }
  return output
}

/** Join proof IDs only. Other facts retain the revision they were observed at. */
export const relatedEvidence = (
  link: LinkObservation,
  seats: readonly SeatRecord[],
  records: readonly EvidenceRecord[],
): {
  seats: readonly ProvenanceSeat[]
  missingSeats: readonly string[]
  evidenceIds: readonly string[]
  cards: readonly CardRef[]
} => {
  const found = seats.filter((seat) => link.seats.includes(seat.id))
  const evidence = records.filter((record) => link.evidenceIds.includes(record.id))
  const cards = new Map(evidence.flatMap((record) => record.card
    ? [[JSON.stringify([record.card.board, record.card.id]), record.card] as const]
    : []))
  return {
    seats: found.map((seat) => ({
      id: seat.id, agentName: seat.agent?.name ?? null,
      runtime: seat.session.runtime, seatLabel: seat.seatLabel, session: seat.session,
    })),
    missingSeats: link.seats.filter((id) => !found.some((seat) => seat.id === id)),
    evidenceIds: link.evidenceIds,
    cards: [...cards.values()],
  }
}
