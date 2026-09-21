import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'

import { object } from './journal.js'

export interface CapturePreference {
  readonly enabled: boolean
  readonly problem: string | null
}
const projectKey = (project: string): string => {
  if (!isAbsolute(project) || normalize(project) !== project || project.includes('\0')) {
    throw new Error('provenance-invalid-project')
  }
  return createHash('sha256').update(project).digest('hex')
}

export class ProvenancePreferences {
  #projects: Record<string, { enabled: boolean }> = {}
  #problem: string | null = null
  #loaded: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  load(): Promise<void> {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  async #read(): Promise<void> {
    try {
      const bytes = await fs.readFile(this.#file)
      if (bytes.length > 1024 * 1024) throw new Error('preference-limit')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (!object(value) || value.version !== 1 || !object(value.projects) ||
        !Object.entries(value.projects).every(([key, entry]) =>
          /^[a-f0-9]{64}$/.test(key) && object(entry) && typeof entry.enabled === 'boolean',
        )) throw new Error('preference-shape')
      this.#projects = value.projects as Record<string, { enabled: boolean }>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#problem = 'preference-invalid'
    }
  }

  get(project: string): CapturePreference {
    const key = projectKey(project)
    return { enabled: this.#problem ? false : this.#projects[key]?.enabled ?? true, problem: this.#problem }
  }

  set(project: string, enabled: boolean): Promise<void> {
    const key = projectKey(project)
    const next = this.#tail.then(async () => {
      await this.load()
      if (this.#problem) throw new Error(this.#problem)
      const projects = { ...this.#projects, [key]: { enabled } }
      const folder = dirname(this.#file)
      await fs.mkdir(folder, { recursive: true })
      const temporary = `${this.#file}.${randomUUID()}.tmp`
      try {
        const file = await fs.open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(`${JSON.stringify({ version: 1, projects })}\n`)
          await file.sync()
        } finally {
          await file.close()
        }
        await fs.rename(temporary, this.#file)
        const directory = await fs.open(folder, 'r')
        try {
          await directory.sync().catch((error: NodeJS.ErrnoException) => {
            if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code ?? '')) throw error
          })
        } finally {
          await directory.close()
        }
        this.#projects = projects
      } finally {
        await fs.rm(temporary, { force: true })
      }
    })
    this.#tail = next.catch(() => {})
    return next
  }
}
