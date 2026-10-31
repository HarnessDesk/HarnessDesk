import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { LeadChatControl, LeadChatControlList, LeadChatHolder } from '@harnessdesk/protocol'
import { readBoundedJsonResult, writeAtomicJson } from './bounded-json.js'

const MAX_CHATS = 64, MAX_KEYS = 32, MAX_BYTES = 256 * 1024
export const LEAD_CONTROL_UNREADABLE = 'The Lead chat control record cannot be read safely. Lead sends and stops are blocked. Use Reset chat control in the chat notice to recover.'
export const LEAD_CONTROL_FULL = 'All 64 chat control slots are held by the person. Hand back a chat before the Lead starts another.'
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 300 && id.indexOf(':') > 0 && !id.endsWith(':')
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)
const keysAre = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const validChat = (chat: unknown): chat is LeadChatControl => {
  if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !keysAre(chat, ['id', 'holder', 'sent'])) return false
  const { id, holder, sent } = chat as Record<string, unknown>
  return validId(id) && (holder === 'lead' || holder === 'person') && Array.isArray(sent) && sent.length <= MAX_KEYS && sent.every(validKey) && new Set(sent).size === sent.length
}
const validChats = (chats: unknown): chats is LeadChatControl[] => Array.isArray(chats) && chats.length <= MAX_CHATS && chats.every(validChat) && new Set(chats.map(chat => chat.id)).size === chats.length
const projectKey = (project: string, id: string) => JSON.stringify([project, id])
type Projects = Map<string, readonly LeadChatControl[]>

/** Disk is the durable copy; person holds in this host's map never disappear on a read or failed write. */
export class LeadChatControlStore {
  #tail: Promise<unknown> = Promise.resolve()
  #projects: Projects = new Map()
  #loaded = false
  #problem: string | null = null
  #holds = new Map<string, number>()
  #epoch = 0
  constructor(private readonly file: string) {}

  get problem(): string | null { return this.#problem }
  #unreadable(): never { this.#problem = LEAD_CONTROL_UNREADABLE; throw new Error(LEAD_CONTROL_UNREADABLE) }
  async #canonical(project: string): Promise<boolean> {
    return project.length <= 4096 && isAbsolute(project) && normalize(project) === project && await realpath(project).catch(() => null) === project
  }
  async #disk(project: string): Promise<Projects> {
    const read = await readBoundedJsonResult(this.file, MAX_BYTES)
    if (read.kind === 'missing') return new Map()
    if (read.kind !== 'value') return this.#unreadable()
    const value = read.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.#unreadable()
    const record = value as Record<string, unknown>
    // A valid matching legacy record migrates on its next write. A mismatched
    // legacy selection is ambiguous and requires the person's explicit reset.
    if (record.version === 1) {
      if (!keysAre(record, ['version', 'project', 'chats']) || record.project !== project || !validChats(record.chats) || !await this.#canonical(project)) return this.#unreadable()
      return new Map([[project, record.chats]])
    }
    if (record.version !== 2 || !keysAre(record, ['version', 'projects']) || !record.projects || typeof record.projects !== 'object' || Array.isArray(record.projects)) return this.#unreadable()
    const projects: Projects = new Map()
    for (const [root, chats] of Object.entries(record.projects)) {
      if (!await this.#canonical(root) || !validChats(chats)) return this.#unreadable()
      projects.set(root, chats)
    }
    return projects
  }
  #merge(projects: Projects, release?: string): Projects {
    for (const [project, chats] of this.#projects) {
      const next = [...(projects.get(project) ?? [])]
      for (const chat of chats) {
        if (chat.holder !== 'person' || projectKey(project, chat.id) === release) continue
        const index = next.findIndex(one => one.id === chat.id)
        if (index < 0) next.push(chat)
        else next[index] = { ...next[index]!, holder: 'person' }
      }
      projects.set(project, next)
    }
    for (const [project, chats] of projects) projects.set(project, chats.map(chat => this.#holds.has(projectKey(project, chat.id)) && projectKey(project, chat.id) !== release ? { ...chat, holder: 'person' } : chat))
    return projects
  }
  async #read(project: string): Promise<Projects> {
    if (this.#problem) throw new Error(this.#problem)
    if (!await this.#canonical(project)) return this.#unreadable()
    this.#projects = this.#merge(await this.#disk(project))
    this.#loaded = true
    return this.#projects
  }
  /** Installs the person's fence before any I/O, including when a previous admission is awaiting a path check. */
  hold(project: string, id: string): void {
    if (!validId(id)) throw new Error('Invalid Lead chat record.')
    this.#holds.set(projectKey(project, id), ++this.#epoch)
    const chats = this.#projects.get(project)
    if (chats) this.#projects.set(project, chats.map(chat => chat.id === id ? { ...chat, holder: 'person' } : chat))
  }
  current(project: string): LeadChatControlList { return { project, chats: this.#projects.get(project) ?? [] } }
  /** Called synchronously at the actual runtime dispatch boundary. Never reads disk or returns a promise. */
  assertDispatch(project: string, id: string): void {
    if (this.#problem || !this.#loaded) throw new Error(this.#problem ?? LEAD_CONTROL_UNREADABLE)
    if (this.#holds.has(projectKey(project, id)) || this.#projects.get(project)?.some(chat => chat.id === id && chat.holder === 'person'))
      throw new Error('The person has taken this chat over. Wait until they hand it back.')
  }
  async assertCanStart(project: string): Promise<void> {
    const { chats } = await this.list(project)
    if (chats.length >= MAX_CHATS && chats.every(chat => chat.holder === 'person')) throw new Error(LEAD_CONTROL_FULL)
  }
  #write(project: string, change: (chats: readonly LeadChatControl[]) => readonly LeadChatControl[] | null, release?: { key: string; epoch: number | undefined }): Promise<boolean> {
    const write = this.#tail.then(async () => {
      const projects = new Map(await this.#read(project)), next = change(projects.get(project) ?? [])
      if (next === null) return false
      const bounded = [...next]
      while (bounded.length > MAX_CHATS) {
        const index = bounded.findIndex(chat => chat.holder === 'lead')
        if (index < 0) throw new Error(LEAD_CONTROL_FULL)
        bounded.splice(index, 1)
      }
      projects.set(project, bounded)
      const value = { version: 2, projects: Object.fromEntries(projects) }
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('The Lead chat control record is full. Hand back chats or use Reset chat control.')
      await writeAtomicJson(this.file, value, async () => {
        if (!await this.#canonical(project)) throw new Error('Lead chat project changed.')
        await this.#disk(project) // Never replace a record that became unreadable during the write.
      })
      const released = release && this.#holds.get(release.key) === release.epoch ? release.key : undefined
      if (released) this.#holds.delete(released)
      this.#projects = this.#merge(projects, released)
      return true
    })
    this.#tail = write.catch(() => {})
    return write
  }
  async list(project: string): Promise<LeadChatControlList> {
    await this.#tail
    return { project, chats: (await this.#read(project)).get(project) ?? [] }
  }
  async holder(project: string, id: string): Promise<LeadChatHolder | null> {
    const list = await this.list(project)
    return this.#holds.has(projectKey(project, id)) ? 'person' : list.chats.find(chat => chat.id === id)?.holder ?? null
  }
  async noteSent(project: string, id: string, key: string): Promise<void> {
    if (!validId(id) || !validKey(key)) throw new Error('Invalid Lead chat record.')
    await this.#write(project, chats => {
      const prior = chats.find(chat => chat.id === id)
      if (!prior && chats.length >= MAX_CHATS && chats.every(chat => chat.holder === 'person')) throw new Error(LEAD_CONTROL_FULL)
      const entry: LeadChatControl = { id, holder: prior?.holder ?? 'lead', sent: [...(prior?.sent ?? []).filter(k => k !== key), key].slice(-MAX_KEYS) }
      return [...chats.filter(chat => chat.id !== id), entry]
    })
  }
  async setHolder(project: string, id: string, holder: LeadChatHolder): Promise<boolean> {
    if (!validId(id)) return false
    if (holder === 'person') this.hold(project, id)
    const key = projectKey(project, id), epoch = this.#holds.get(key)
    const result = await this.#write(project, chats => chats.some(chat => chat.id === id) ? chats.map(chat => chat.id === id ? { ...chat, holder } : chat) : null,
      holder === 'lead' ? { key, epoch } : undefined)
    if (!result && this.#holds.get(key) === epoch) this.#holds.delete(key)
    return result
  }
  /** Explicit window-only recovery; a failure keeps every in-memory hold and the unreadable fence. */
  async reset(): Promise<void> {
    const through = this.#epoch
    const reset = this.#tail.then(async () => {
      await writeAtomicJson(this.file, { version: 2, projects: {} }, async () => {})
      // The confirmed reset releases only holds that existed when it was
      // requested. A newer take-over wins and its queued write persists it.
      for (const [key, epoch] of this.#holds) if (epoch <= through) this.#holds.delete(key)
      this.#projects = new Map([...this.#projects].map(([project, chats]) => [project,
        chats.filter(chat => this.#holds.has(projectKey(project, chat.id))).map(chat => ({ ...chat, holder: 'person' as const }))]))
      this.#loaded = true; this.#problem = null
    })
    this.#tail = reset.catch(() => {})
    return reset
  }
}
