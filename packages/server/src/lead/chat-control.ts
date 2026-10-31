import { realpath } from 'node:fs/promises'
import type { LeadChatControl, LeadChatControlList, LeadChatHolder } from '@harnessdesk/protocol'
import { readBoundedJson, writeAtomicJson } from './bounded-json.js'

const MAX_CHATS = 64, MAX_KEYS = 32, MAX_BYTES = 256 * 1024
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 300 && id.indexOf(':') > 0 && !id.endsWith(':')
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)
const validChat = (chat: unknown): chat is LeadChatControl => {
  if (!chat || typeof chat !== 'object') return false
  const { id, holder, sent } = chat as Record<string, unknown>
  return validId(id) && (holder === 'lead' || holder === 'person') && Array.isArray(sent) && sent.length <= MAX_KEYS && sent.every(validKey)
}

/**
 * Who directs each ordinary chat the Lead has written to, and what it sent.
 * The holder is the person's decision and is checked by the host on every
 * Lead send, stop and queued delivery; the keys let the renderer vouch for a
 * "Sent by" label. Neither confers authority to the Lead: an absent or
 * unreadable file means no chat is held by the Lead, and every ordinary
 * Lead policy check still runs.
 */
export class LeadChatControlStore {
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  async #read(project: string): Promise<readonly LeadChatControl[]> {
    try { if (await realpath(project) !== project) return [] } catch { return [] }
    const value = await readBoundedJson(this.file, MAX_BYTES) as Record<string, unknown> | undefined
    if (!value || typeof value !== 'object' || value.version !== 1 || value.project !== project ||
      !Array.isArray(value.chats) || value.chats.length > MAX_CHATS || !value.chats.every(validChat) ||
      new Set(value.chats.map(chat => (chat as LeadChatControl).id)).size !== value.chats.length) return []
    return value.chats as LeadChatControl[]
  }

  #write(project: string, change: (chats: readonly LeadChatControl[]) => readonly LeadChatControl[] | null): Promise<readonly LeadChatControl[] | null> {
    const write = this.#tail.then(async () => {
      if (project.length > 4096 || await realpath(project) !== project) throw new Error('Invalid Lead chat project.')
      const previous = await this.#read(project)
      const next = change(previous)
      if (next === null) return null
      await writeAtomicJson(this.file, { version: 1, project, chats: next.slice(-MAX_CHATS) }, async () => {
        if (await realpath(project) !== project) throw new Error('Lead chat project changed.')
      })
      return next
    })
    this.#tail = write.catch(() => {})
    return write
  }

  async list(project: string): Promise<LeadChatControlList> {
    await this.#tail
    return { project, chats: await this.#read(project) }
  }

  async holder(project: string, id: string): Promise<LeadChatHolder | null> {
    return (await this.list(project)).chats.find(chat => chat.id === id)?.holder ?? null
  }

  async noteSent(project: string, id: string, key: string): Promise<void> {
    if (!validId(id) || !validKey(key)) throw new Error('Invalid Lead chat record.')
    await this.#write(project, chats => {
      const prior = chats.find(chat => chat.id === id)
      const entry: LeadChatControl = { id, holder: prior?.holder ?? 'lead', sent: [...(prior?.sent ?? []).filter(k => k !== key), key].slice(-MAX_KEYS) }
      return [...chats.filter(chat => chat.id !== id), entry]
    })
  }

  async setHolder(project: string, id: string, holder: LeadChatHolder): Promise<boolean> {
    if (!validId(id)) return false
    const result = await this.#write(project, chats => {
      const prior = chats.find(chat => chat.id === id)
      if (!prior) return null
      if (prior.holder === holder) return chats
      return chats.map(chat => chat.id === id ? { ...chat, holder } : chat)
    })
    return result !== null
  }
}
