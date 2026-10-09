import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { GitReader } from '../src/provenance/git.js'
import { reconcile, surviving, type Patch, type Source } from '../src/provenance/model.js'
import { factSource, reconcileProject, type CommitObservation, type LinkObservation, type ProvenanceSource, type ReconcileInput } from '../src/provenance/reconcile.js'

// Frozen pre-index implementation: an independent decision oracle for this change.
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: Patch, b: Patch): boolean => a.stable === b.stable && a.exact === b.exact
const live = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('capture-aborted')
}
const proven = (source: Source): source is ProvenanceSource =>
  'proof' in source && typeof source.proof === 'object' && source.proof !== null

const latestLinks = (links: readonly LinkObservation[]): Map<string, LinkObservation> => {
  const latest = new Map<string, LinkObservation>()
  // Journal order breaks an equal-time tie. Wall-clock time never reorders records.
  for (const link of links) latest.set(link.sha, link)
  return latest
}

const related = (input: ReconcileInput, from: string, to: string): boolean => {
  if (from === to) return true
  const graph = new Map<string, Set<string>>()
  const edge = (a: string, b: string) => {
    const neighbours = graph.get(a) ?? new Set<string>()
    neighbours.add(b)
    graph.set(a, neighbours)
  }
  // Rewrite movement edges are undirected. A range names its observed tip.
  // Sharing a base never joins independent branches into a rewrite lineage.
  for (const move of input.moves) {
    if (!move.before || !move.after) continue
    edge(move.before, move.after)
    edge(move.after, move.before)
  }
  const todo = [from]
  const seen = new Set<string>()
  while (todo.length) {
    const sha = todo.pop()!
    if (sha === to) return true
    if (seen.has(sha)) continue
    seen.add(sha)
    for (const next of graph.get(sha) ?? []) todo.push(next)
  }
  return false
}

const oldReconcileProject = async (
  input: ReconcileInput,
  git: GitReader,
  signal: AbortSignal,
): Promise<readonly LinkObservation[]> => {
  void git
  const output: LinkObservation[] = []
  const latest = latestLinks(input.priorLinks)
  const oldIds = new Set(input.priorLinks.map((link) => link.id))
  const observed = new Map(input.commits.map((commit) => [commit.sha, commit]))
  const sources = input.sources.filter(proven)
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
    if (!oldIds.has(id)) output.push(link)
  }
  for (const commit of [...input.commits].sort((a, b) =>
    a.firstSeenAt - b.firstSeenAt || a.sha.localeCompare(b.sha),
  )) {
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
    const currentSources = sources.map((source): ProvenanceSource => {
      if (source.proof.kind !== 'range') return source
      const parts = source.proof.commits.map((sha) => latest.get(sha))
      const seats = unique(parts.flatMap((part) => part?.seats ?? []))
      const invalid = parts.some((part) => !part || part.coverage !== 'complete') ||
        JSON.stringify(seats) !== JSON.stringify(unique(source.seats))
      return { ...source, ambiguous: source.ambiguous || invalid }
    })
    const matches = currentSources.filter((source) => same(source.patch, patch))
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
    const unscoped = input.sources.filter((source) => !proven(source) && same(source.patch, patch))
      .map((source) => ({ ...source, seats: [], ambiguous: true }))
    let candidates: Source[] = [...direct, ...unscoped]
    if (!direct.length) {
      candidates = [...matches.filter((source) => !source.proof.restored), ...unscoped]
      // A discovered equal patch with no binding proof is a known alternative.
      // Copies already explained by the same lineage are represented by their
      // source, rather than being counted twice as known and unknown.
      for (const other of input.commits) {
        if (other.sha === commit.sha || !other.patch || !same(other.patch, patch)) continue
        const explained = sources.some((source) => !source.proof.restored &&
          same(source.patch, patch) &&
          (source.proof.to === other.sha || related(input, source.proof.to, other.sha)),
        )
        if (!explained) candidates.push({ id: other.id, patch: other.patch, seats: [] })
      }
      if (candidates.some((source) => proven(source) && !related(input, source.proof.to, commit.sha))) {
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
    const replacements = input.moves.filter((move) => move.after === commit.sha && move.before &&
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
      const ranges = currentSources.filter((source) => source.proof.kind === 'range' &&
        !source.ambiguous && link.sourceIds.includes(source.id),
      )
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


const sha = (n: number) => n.toString(16).padStart(40, '0')
const commit = (n: number, patch = { stable: sha(n), exact: sha(n), files: ['file'] }): CommitObservation => ({
  id: `commit-${n}`, sha: sha(n), tree: sha(n), parents: [sha(n - 1)], firstSeenAt: n,
  fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: n },
  patch, files: patch.files.map((path) => ({ path, stable: patch.stable, exact: patch.exact })), why: null,
})
const direct = (c: CommitObservation, id: string, seats = ['seat-a']): ProvenanceSource => ({
  id, seats, patch: c.patch!, proof: { kind: 'diff', from: c.parents[0]!, to: c.sha, commits: [c.sha], evidenceIds: [id], restored: false },
})
const git = {} as GitReader
const signal = () => new AbortController().signal

test('indexed decisions equal the old pass across deterministic random facts, ranges, restores and rewrites', async () => {
  let state = 1550
  const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n }
  for (let history = 0; history < 40; history += 1) {
    const commits = Array.from({ length: 24 }, (_, i) => commit(i + 1, {
      stable: sha(random(8) + 1), exact: sha(random(8) + 1), files: random(8) ? ['file'] : [],
    }))
    const sources: (Source | ProvenanceSource)[] = []
    for (const c of commits) {
      const seat = { id: 'seat-a', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded Seat', passedOver: [], standing: { kind: 'permission' as const, permission: 'read' as const }, ceiling: null,
        checkout: { cwd: '/work/project', project: '/work/project', branch: null, head: null }, session: { runtime: 'fixture', sessionId: 'session' }, board: null, role: null, openedAt: 0, closed: null }
      const fact = { id: `fact-${c.id}`, seat: seat.id, checkout: { cwd: seat.checkout.cwd, branch: null }, observedAt: c.firstSeenAt,
        fact: { kind: 'diff' as const, files: 1, added: 1, removed: 0, from: c.parents[0]!, to: c.sha } }
      const source = factSource(seat.checkout.project, seat.checkout.cwd, fact.fact.from, c.sha, c.patch!, [seat], [fact])!
      if (random(3)) sources.push(source)
      if (!random(4)) sources.push({ ...direct(c, `competing-${c.id}`, ['seat-b']), ambiguous: !!random(2) })
      if (!random(4)) sources.push({ id: `unscoped-${c.id}`, patch: c.patch!, seats: ['seat-a'] })
      if (!random(3)) sources.push({ ...direct(c, `range-${c.id}`), ambiguous: !!random(2), proof: {
        kind: 'range', from: c.parents[0]!, to: c.sha, commits: [sha(random(24) + 1), c.sha], evidenceIds: [], restored: !!random(2),
      } })
    }
    const moves = commits.slice(1).filter(() => !!random(2)).map((c, i) => ({ id: `move-${i}`, ref: 'refs/heads/topic', before: commits[i]!.sha, after: c.sha, checkout: null, recordedAt: null }))
    // Include content amendments, missing objects and merges as well as patch copies.
    commits[2] = { ...commits[2]!, parents: commits[1]!.parents }
    commits[3] = { ...commits[3]!, patch: null, why: 'missing-object' }
    commits[4] = { ...commits[4]!, parents: [sha(1), sha(2)] }
    const input = { commits, sources, moves, priorLinks: [], now: 100 }
    const expected = await oldReconcileProject(input, git, signal())
    assert.deepEqual(await reconcileProject(input, git, signal()), expected)
    const changed = { ...input, sources: sources.slice(1), priorLinks: expected, now: 101 }
    assert.deepEqual(await reconcileProject(changed, git, signal()), await oldReconcileProject(changed, git, signal()))
  }
})

test('3000 commits and 12000 ranges rebuild and look up sources linearly', async () => {
  const commits = Array.from({ length: 3000 }, (_, i) => commit(i + 1))
  const sources = commits.map((c) => direct(c, `source-${c.sha}`))
  for (let i = 0; i < 12000; i += 1) {
    const c = commits[i % commits.length]!
    sources.push({ ...direct(c, `range-${i}`), patch: { stable: sha(10000 + i), exact: sha(10000 + i), files: ['file'] },
      proof: { kind: 'range', from: c.parents[0]!, to: c.sha, commits: [c.sha], evidenceIds: [], restored: false } })
  }
  let patchReads = 0
  const fingerprints = new Set([...commits.map((c) => c.patch!), ...sources.map((source) => source.patch)])
  for (const patch of fingerprints) {
    for (const field of ['stable', 'exact'] as const) {
      const value = patch[field]
      Object.defineProperty(patch, field, { get: () => { patchReads += 1; return value } })
    }
  }
  const work = { patchLookups: 0, sourceRebuilds: 0, rangeMembers: 0 }
  const input = { commits, sources, moves: [], priorLinks: [], now: 4000, work }
  assert.equal((await reconcileProject(input, git, signal())).length, 3000)
  assert.ok(patchReads <= 4 * (commits.length + sources.length), `${patchReads} fingerprint reads, including model comparisons`)
  assert.ok(work.sourceRebuilds > 0, 'the counters must measure actual source work')
  assert.ok(work.sourceRebuilds <= 24000, `${work.sourceRebuilds} rebuilds`)
  assert.ok(work.rangeMembers <= 24000, `${work.rangeMembers} member reads`)
  assert.ok(work.patchLookups <= 4 * (commits.length + sources.length), `${work.patchLookups} patch lookups`)
})
