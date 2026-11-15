import { createHash, type Hash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { InsightCacheUnavailableError, type UsageSample } from './insight.js'
import { decodeSample, sourceKey } from './insight-persistent.js'
import type { ScanTarget } from './scan.js'

/** A pinned generation is addressed independently from its possibly repeated discovery positions. */
export interface SnapshotReference { readonly target: ScanTarget; readonly generation: string }
export interface SnapshotSession { readonly runtime: string; readonly session: string }
interface Group { readonly generation: string; readonly project: string | null; readonly runtime: string; readonly session: string | null; count: number; digest: string; hash?: Hash }
interface Row { readonly generation: string; readonly ordinal: number; readonly project: string | null; readonly runtime: string; readonly session: string | null; readonly at: number | null; readonly payload: string }
const groupKey = (generation: string, project: string | null, runtime: string, session: string | null): string => JSON.stringify([generation, project, runtime, session])
const lookupKey = (project: string, runtime: string, session: string): string => JSON.stringify([project, runtime, session])
const addRow = (hash: Hash, row: Row): void => { hash.update(`${row.ordinal}\0${Buffer.byteLength(row.payload)}\0`).update(row.payload) }
const validRow = (row: Row, sample: UsageSample): boolean => row.project === sample.project && row.runtime === sample.runtime && row.session === sample.sessionId && row.at === sample.from

/**
 * Read-only pinned cache snapshot. Its manifest authenticates unique groups before
 * duplicate discovery references are expanded. It never owns provider files.
 */
export class InsightSnapshot {
  readonly #reader: DatabaseSync
  readonly #observer: DatabaseSync
  readonly #version: number
  readonly #groups = new Map<string, Group>()
  readonly #lookup = new Map<string, string[]>()
  readonly #refs: readonly SnapshotReference[]
  readonly #orders = new Map<string, number[]>()
  readonly #projects = new Set<string>()
  #closed = false

  constructor(path: string, refs: readonly SnapshotReference[]) {
    this.#refs = refs
    try { this.#reader = new DatabaseSync(path, { readOnly: true }) }
    catch { throw new InsightCacheUnavailableError() }
    try { this.#observer = new DatabaseSync(path, { readOnly: true }) }
    catch { try { this.#reader.close() } catch {}; throw new InsightCacheUnavailableError() }
    try {
      this.#version = this.#dataVersion()
      this.#reader.exec('BEGIN; CREATE TEMP TABLE active (generation TEXT NOT NULL, source_order INTEGER NOT NULL); CREATE INDEX active_generation ON active(generation); CREATE TEMP TABLE wanted_projects (project TEXT PRIMARY KEY); CREATE TEMP TABLE wanted_sessions (runtime TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(runtime, session));')
      // Establish the read snapshot before any post-read Seat or consult callback.
      this.#reader.prepare('SELECT count(*) AS n FROM generations').get()
      this.#assertStable()
      const active = this.#reader.prepare('INSERT INTO active VALUES (?, ?)')
      for (let at = 0; at < refs.length; at++) {
        const id = refs[at]!.generation; active.run(id, at)
        const held = this.#orders.get(id) ?? []; held.push(at); this.#orders.set(id, held)
      }
      const unique = new Map(refs.map((ref) => [ref.generation, ref]))
      const generation = this.#reader.prepare('SELECT entry, digest FROM generations WHERE id = ? AND source = ?')
      const observations = this.#reader.prepare('SELECT generation, ordinal, project, runtime, session, at, payload FROM observations WHERE generation = ? ORDER BY ordinal')
      for (const ref of unique.values()) {
        const meta = generation.get(ref.generation, sourceKey(ref.target)) as { entry?: unknown; digest?: unknown } | undefined
        if (typeof meta?.entry !== 'string' || typeof meta.digest !== 'string') throw new InsightCacheUnavailableError()
        const hash = createHash('sha256').update(meta.entry)
        const generationGroups: Group[] = []
        for (const value of observations.iterate(ref.generation)) {
          const row = value as unknown as Row; const sample = decodeSample(row.payload)
          if (!validRow(row, sample)) throw new InsightCacheUnavailableError()
          hash.update('\0').update(JSON.stringify(row.project)).update('\0').update(row.payload)
          const key = groupKey(row.generation, row.project, row.runtime, row.session)
          let group = this.#groups.get(key)
          if (!group) {
            group = { generation: row.generation, project: row.project, runtime: row.runtime, session: row.session, count: 0, digest: '', hash: createHash('sha256') }
            this.#groups.set(key, group); generationGroups.push(group)
            if (row.project !== null) this.#projects.add(row.project)
            if (row.project !== null && row.session !== null) {
              const lookup = lookupKey(row.project, row.runtime, row.session); const held = this.#lookup.get(lookup) ?? []
              held.push(key); this.#lookup.set(lookup, held)
            }
          }
          group.count++; addRow(group.hash!, row)
        }
        if (hash.digest('hex') !== meta.digest) throw new InsightCacheUnavailableError()
        for (const group of generationGroups) { group.digest = group.hash!.digest('hex'); delete group.hash }
      }
      this.#assertStable()
    } catch { this.close(); throw new InsightCacheUnavailableError() }
  }

  #dataVersion(): number { return Number((this.#observer.prepare('PRAGMA data_version').get() as { data_version: number }).data_version) }
  #assertStable(): void { if (this.#closed || this.#dataVersion() !== this.#version) throw new InsightCacheUnavailableError() }
  projects(): readonly string[] { return [...this.#projects] }

  /** Every logical source observation in discovery/emission order, including duplicate references. */
  each(visit: (sample: UsageSample) => void): void {
    try {
      this.#assertStable()
      const rows = this.#reader.prepare('SELECT project, payload FROM observations WHERE generation = ? ORDER BY ordinal')
      const meta = this.#reader.prepare('SELECT entry, digest FROM generations WHERE id = ? AND source = ?')
      for (const ref of this.#refs) {
        const held = meta.get(ref.generation, sourceKey(ref.target)) as { entry?: unknown; digest?: unknown } | undefined
        if (typeof held?.entry !== 'string' || typeof held.digest !== 'string') throw new InsightCacheUnavailableError()
        const hash = createHash('sha256').update(held.entry)
        for (const value of rows.iterate(ref.generation)) {
          const row = value as { project: string | null; payload: string }
          hash.update('\0').update(JSON.stringify(row.project)).update('\0').update(row.payload)
          visit(decodeSample(row.payload))
        }
        if (hash.digest('hex') !== held.digest) throw new InsightCacheUnavailableError()
      }
      this.#assertStable()
    } catch { throw new InsightCacheUnavailableError() }
  }

  /** Verify full unique groups, then expand discovery duplicates and visit in source order. */
  select(projects: readonly string[], sessions: readonly SnapshotSession[], visit: (sample: UsageSample, sourceOrder: number, ordinal: number) => void): void {
    try {
      this.#assertStable()
      this.#reader.exec('DELETE FROM wanted_projects; DELETE FROM wanted_sessions')
      const addProject = this.#reader.prepare('INSERT OR IGNORE INTO wanted_projects VALUES (?)')
      const addSession = this.#reader.prepare('INSERT OR IGNORE INTO wanted_sessions VALUES (?, ?)')
      const expected = new Set<string>()
      for (const project of projects) {
        addProject.run(project)
        for (const session of sessions) for (const key of this.#lookup.get(lookupKey(project, session.runtime, session.session)) ?? []) expected.add(key)
      }
      for (const session of sessions) addSession.run(session.runtime, session.session)
      const prefix = `FROM wanted_projects p CROSS JOIN wanted_sessions w CROSS JOIN observations o INDEXED BY observations_lookup
        WHERE o.project = p.project AND o.runtime = w.runtime AND o.session = w.session AND EXISTS (SELECT 1 FROM active a WHERE a.generation = o.generation)`
      const rows = this.#reader.prepare(`SELECT o.generation, o.ordinal, o.project, o.runtime, o.session, o.at, o.payload ${prefix} ORDER BY o.generation, o.ordinal`)
      const seen = new Map<string, { count: number; hash: Hash }>()
      for (const value of rows.iterate()) {
        const row = value as unknown as Row; const sample = decodeSample(row.payload)
        if (!validRow(row, sample)) throw new InsightCacheUnavailableError()
        const key = groupKey(row.generation, row.project, row.runtime, row.session)
        if (!expected.has(key)) throw new InsightCacheUnavailableError()
        const state = seen.get(key) ?? { count: 0, hash: createHash('sha256') }
        state.count++; addRow(state.hash, row); seen.set(key, state)
      }
      for (const key of expected) {
        const group = this.#groups.get(key)!; const found = seen.get(key)
        if (!found || found.count !== group.count || found.hash.digest('hex') !== group.digest) throw new InsightCacheUnavailableError()
      }
      const expanded = this.#reader.prepare(`SELECT o.generation, o.ordinal, o.project, o.runtime, o.session, o.at, o.payload, a.source_order FROM wanted_projects p CROSS JOIN wanted_sessions w CROSS JOIN observations o INDEXED BY observations_lookup JOIN active a ON a.generation = o.generation WHERE o.project = p.project AND o.runtime = w.runtime AND o.session = w.session ORDER BY a.source_order, o.ordinal`)
      const expandedSeen = new Map<string, { count: number; hash: Hash }>()
      for (const value of expanded.iterate()) {
        const row = value as unknown as Row & { source_order: number }; const sample = decodeSample(row.payload)
        if (!validRow(row, sample)) throw new InsightCacheUnavailableError()
        const group = groupKey(row.generation, row.project, row.runtime, row.session)
        if (!expected.has(group)) throw new InsightCacheUnavailableError()
        const key = JSON.stringify([row.source_order, group]); const state = expandedSeen.get(key) ?? { count: 0, hash: createHash('sha256') }
        state.count++; addRow(state.hash, row); expandedSeen.set(key, state)
        visit(sample, row.source_order, row.ordinal)
      }
      for (const key of expected) {
        const group = this.#groups.get(key)!
        for (const order of this.#orders.get(group.generation) ?? []) {
          const found = expandedSeen.get(JSON.stringify([order, key]))
          if (!found || found.count !== group.count || found.hash.digest('hex') !== group.digest) throw new InsightCacheUnavailableError()
        }
      }
      this.#assertStable()
    } catch { throw new InsightCacheUnavailableError() }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try { this.#reader.exec('ROLLBACK') } catch {}
    try { this.#reader.close() } catch {}
    try { this.#observer.close() } catch {}
  }
}
