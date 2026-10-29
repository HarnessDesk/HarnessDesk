import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_IDS = 64, MAX_BYTES = 64 * 1024
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 300 && id.indexOf(':') > 0 && !id.endsWith(':')

/** One selected project's bounded wake targets. These ids confer no authority:
 * every event still rechecks the ordinary session's current project and policy. */
export class LeadChatWatches {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  async #read(project: string): Promise<readonly string[]> {
    try {
      if (await realpath(project) !== project) return []
      const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > MAX_BYTES) return []
        const bytes = Buffer.alloc(MAX_BYTES + 1)
        let length = 0
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length)
          if (read.bytesRead === 0) break
          length += read.bytesRead
        }
        if (length > MAX_BYTES) return []
        const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
          !('project' in value) || value.project !== project || !('ids' in value) || !Array.isArray(value.ids) ||
          value.ids.length > MAX_IDS || !value.ids.every(validId) || new Set(value.ids).size !== value.ids.length) return []
        return value.ids
      } finally { await file.close() }
    } catch { return [] }
  }

  async read(project: string): Promise<readonly string[]> {
    await this.#tail
    return this.#read(project)
  }

  watch(project: string, id: string): Promise<void> {
    const write = this.#tail.then(async () => {
      if (!validId(id) || project.length > 4096 || await realpath(project) !== project) throw new Error('Invalid Lead chat watch target.')
      const previous = await this.#read(project)
      const ids = [...previous.filter(value => value !== id), id].slice(-MAX_IDS)
      if (JSON.stringify(previous) === JSON.stringify(ids)) return
      const directory = dirname(this.file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify({ version: 1, project, ids })); await file.sync() } finally { await file.close() }
        // Resolve again after I/O; a retargeted path never gains wake authority.
        if (await realpath(project) !== project) throw new Error('Lead chat project changed.')
        await rename(temporary, this.file)
        const parent = await open(directory, 'r')
        try { await parent.sync() } finally { await parent.close() }
      } finally { await rm(temporary, { force: true }) }
    })
    this.#tail = write.catch(() => {})
    return write
  }
}
