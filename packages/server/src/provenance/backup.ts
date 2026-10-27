import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

import type { ProvenanceBackup } from '@harnessdesk/protocol'

import { digest, JOURNAL_LIMIT, object, ProvenanceJournal, ProvenanceJournalChangedError, ProvenanceJournalLimitError, validValue, type JournalKind } from './journal.js'

export interface BackupPort {
  prepare?(project: string): Promise<void>
  projects(): Promise<readonly string[]>
  journal(project: string): ProvenanceJournal
}
export interface ProvenanceRestoreReport {
  restored: number
  duplicate: number
  refused: number
}
const BYTES = 10 * 1024 * 1024
const historical = new Set<JournalKind>(['ref', 'commit', 'range', 'link', 'gap'])
const projectPath = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && !value.includes('\0')

export const exportProvenance = async (port: BackupPort): Promise<ProvenanceBackup> => {
  const projects: { project: string; entries: unknown[] }[] = []
  const omittedProjects: { project: string; reason: 'journal-limit-exceeded' }[] = []
  let count = 0
  // The fixed wrapper includes both project-array brackets; each item is measured once.
  let bytes = '{"version":1,"projects":[]}'.length
  for (const project of await port.projects()) {
    let read
    try { read = await port.journal(project).read() } catch (error) {
      if (!(error instanceof ProvenanceJournalLimitError)) throw error
      const omitted = { project, reason: 'journal-limit-exceeded' as const }
      omittedProjects.push(omitted)
      if (projects.length + omittedProjects.length > 100) throw new Error('provenance-backup-limit')
      bytes += Buffer.byteLength(JSON.stringify(omitted)) +
        (omittedProjects.length === 1 ? ',"omittedProjects":[]'.length : 1)
      if (bytes > BYTES) throw new Error('provenance-backup-limit')
      continue
    }
    if (read.broken) throw new Error('provenance-journal-damaged')
    const entries = read.entries.filter((entry) => historical.has(entry.kind))
      .map(({ kind, value }) => ({ kind, value }))
    if (!entries.length) continue
    const saved = { project, entries }
    projects.push(saved)
    count += entries.length
    if (projects.length + omittedProjects.length > 100 || count > 50000) {
      throw new Error('provenance-backup-limit')
    }
    bytes += Buffer.byteLength(JSON.stringify(saved)) + (projects.length > 1 ? 1 : 0)
    if (bytes > BYTES) throw new Error('provenance-backup-limit')
  }
  return { version: 1, projects, ...(omittedProjects.length ? { omittedProjects } : {}) }
}

/** The plane serializes imports with its project lifecycle; the journal deduplicates writes. */
export const importProvenance = async (
  port: BackupPort,
  raw: unknown,
  now = Date.now(),
): Promise<ProvenanceRestoreReport> => {
  const report = { restored: 0, duplicate: 0, refused: 0 }
  if (raw === undefined) return report
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.projects) ||
    raw.projects.length > 100 || Buffer.byteLength(JSON.stringify(raw)) > BYTES) {
    return { ...report, refused: 1 }
  }
  let count = 0
  for (const project of raw.projects) {
    if (!object(project) || !projectPath(project.project) || !Array.isArray(project.entries)) {
      report.refused += 1
      continue
    }
    await port.prepare?.(project.project)
    const journal = port.journal(project.project)
    let read
    try { read = await journal.read() } catch (error) {
      if (!(error instanceof ProvenanceJournalLimitError)) throw error
      report.refused += project.entries.length
      continue
    }
    const ids = new Set(read.entries.map((entry) => `${entry.kind}:${(entry.value as { id: string }).id}`))
    for (let index = 0; index < project.entries.length; index += 1) {
      const entry = project.entries[index]
      if (++count > 50000 || read.broken || !object(entry) || !historical.has(entry.kind as JournalKind) ||
        !validValue(entry.kind as JournalKind, entry.value) || Buffer.byteLength(JSON.stringify(entry)) > JOURNAL_LIMIT - 512) {
        report.refused += 1
        continue
      }
      const kind = entry.kind as JournalKind
      const input = entry.value as Record<string, unknown>
      const data = 'restoredAt' in input ? input.data as Record<string, unknown> : input
      const id = digest(['restored', kind, data.id])
      // A local observation always wins. Imported IDs never shadow a later local observation.
      if (ids.has(`${kind}:${id}`) || ids.has(`${kind}:${data.id}`)) {
        report.duplicate += 1
        continue
      }
      try {
        await journal.append(kind, { id, restoredAt: now, data })
        ids.add(`${kind}:${id}`)
        report.restored += 1
      } catch (error) {
        if (error instanceof ProvenanceJournalLimitError || error instanceof ProvenanceJournalChangedError) {
          // A journal-wide refusal cannot be repaired by the next backup row.
          // Keep the admission budget for healthy projects, too.
          count -= 1
          report.refused += project.entries.length - index
          break
        }
        report.refused += 1
      }
    }
  }
  return report
}

/** Task 4's host composition; Task 5 moves ownership to the live plane. */
export class ProvenanceBackups {
  readonly #journals = new Map<string, ProvenanceJournal>()
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly store: {
    folderOf(project: string): string
    projects(): Promise<readonly string[]>
  }) {}

  #journal(project: string): ProvenanceJournal {
    let journal = this.#journals.get(project)
    if (!journal) {
      journal = new ProvenanceJournal(join(this.store.folderOf(project), 'provenance.ndjson'))
      this.#journals.set(project, journal)
    }
    return journal
  }

  #port(): BackupPort {
    return {
      projects: async () => [...new Set([...await this.store.projects(), ...this.#journals.keys()])],
      journal: (project) => this.#journal(project),
      prepare: async (project) => {
        const folder = this.store.folderOf(project)
        await mkdir(folder, { recursive: true, mode: 0o700 })
        await writeFile(join(folder, 'project.json'), `${JSON.stringify({ root: project })}\n`, { flag: 'wx', mode: 0o600 })
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      },
    }
  }

  #queue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action)
    this.#tail = next.catch(() => {})
    return next
  }

  backup(): Promise<ProvenanceBackup> {
    return this.#queue(() => exportProvenance(this.#port()))
  }

  restore(raw: unknown): Promise<ProvenanceRestoreReport> {
    return this.#queue(() => importProvenance(this.#port(), raw))
  }

  async close(): Promise<void> {
    await this.#tail
    for (const journal of this.#journals.values()) await journal.flush()
  }
}
