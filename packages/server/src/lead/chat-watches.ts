import { realpath } from 'node:fs/promises'
import { readBoundedJson, writeAtomicJson } from './bounded-json.js'

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
      const value = await readBoundedJson(this.file, MAX_BYTES)
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
        !('project' in value) || value.project !== project || !('ids' in value) || !Array.isArray(value.ids) ||
        value.ids.length > MAX_IDS || !value.ids.every(validId) || new Set(value.ids).size !== value.ids.length) return []
      return value.ids
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
      await writeAtomicJson(this.file, { version: 1, project, ids }, async () => {
        if (await realpath(project) !== project) throw new Error('Lead chat project changed.')
      })
    })
    this.#tail = write.catch(() => {})
    return write
  }
}
