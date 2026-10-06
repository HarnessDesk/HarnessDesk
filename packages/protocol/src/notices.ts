import type { AgentEvent, NoticeClass, NoticeDetail } from './events.js'
import { sessionKey, type RuntimeId, type SessionId, type SessionKey } from './ids.js'
import { reduceSession } from './reduce.js'
import type { Session, Turn } from './session.js'

const MAX_PENDING_NOTICES_PER_CONVERSATION = 20
const MAX_PENDING_CONVERSATIONS = 100

/** Identifies a host-created turn that holds conversation notices before real turns arrive. */
export const isNoticeTurn = (turn: Turn): boolean => String(turn.id).startsWith('notice:')

export const classifyNotice = (notice: { readonly class?: NoticeClass; readonly kind?: string; readonly sessionId?: string }): 'toast' | 'inbox' | 'conversation' | 'standing' => {
  if (notice.class === 'result') return 'toast'
  if (notice.class === 'actionable') return 'standing'
  if (notice.class === 'info' || notice.kind === 'runtime:config' || notice.kind === 'runtime:deprecation') return 'inbox'
  return notice.sessionId || notice.class === 'conversation' ? 'conversation' : 'inbox'
}

/** Notices wait for real metadata; both the host and its window projection use the same fold. */
export class PendingConversationNotices {
  readonly #pending = new Map<SessionKey, Extract<AgentEvent, { type: 'notice' }>[]>()

  keep(runtime: RuntimeId, event: AgentEvent): void {
    if (event.type !== 'notice' || !event.sessionId || classifyNotice(event) !== 'conversation') return
    const key = sessionKey(runtime, event.sessionId)
    const pending = this.#pending.get(key) ?? []
    if (event.id && pending.some(notice => notice.id === event.id)) return
    pending.push(event)
    if (pending.length > MAX_PENDING_NOTICES_PER_CONVERSATION) {
      pending.splice(0, pending.length - MAX_PENDING_NOTICES_PER_CONVERSATION)
    }
    if (!this.#pending.has(key) && this.#pending.size >= MAX_PENDING_CONVERSATIONS) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) this.#pending.delete(oldest)
    }
    this.#pending.set(key, pending)
  }

  apply(session: Session): Session {
    const key = sessionKey(session.runtime, session.id)
    const pending = this.#pending.get(key)
    this.#pending.delete(key)
    if (!pending) return session
    // A host registration/sync already carries its counted content. Replaying
    // intermediate occurrences would count them twice: a row remembers only
    // its first and latest event ids, not every occurrence between them.
    const carried = new Set(session.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'notice' && item.contentKey ? [item.contentKey] : [])))
    return pending.reduce((held, notice) => {
      const content = notice.contentKey ?? JSON.stringify([notice.kind ?? 'conversation:warning', notice.message])
      return carried.has(content) ? held : reduceSession(held, notice)
    }, session)
  }

  delete(runtime: RuntimeId, id: SessionId): void {
    this.#pending.delete(sessionKey(runtime, id))
  }
}

/** Exact serialization keeps unchanged content stable across processes and launches. */
export const contentKeyFor = (classification: NoticeClass, kind: string, content: readonly unknown[]): string =>
  `content:${JSON.stringify([classification, kind, ...content])}`

export const runtimeNoticeKey = (runtime: RuntimeId, event: Extract<AgentEvent, { type: 'notice' }>): string =>
  contentKeyFor('info', event.kind ?? 'runtime:warning', [runtime, event.level, event.message, event.detail?.summary ?? null, event.detail?.details ?? null, event.detail?.settings ?? [], event.detail?.file ?? null])

export interface RetainedRuntimeNotice {
  readonly runtime: RuntimeId
  readonly event: Extract<AgentEvent, { type: 'notice' }>
}

/** Host preferences can be edited or restored from an older version. */
export const readRuntimeNotices = (raw: unknown): RetainedRuntimeNotice[] => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(value => {
    if (!value || typeof value !== 'object' || typeof value.runtime !== 'string') return []
    const event = value.event
    if (!event || event.type !== 'notice' || typeof event.message !== 'string' || !['info', 'warning', 'error'].includes(event.level) || classifyNotice(event) !== 'inbox') return []
    let detail: NoticeDetail | undefined
    if (event.detail && typeof event.detail.summary === 'string') {
      detail = { summary: event.detail.summary, settings: Array.isArray(event.detail.settings) ? event.detail.settings.filter((v: unknown): v is string => typeof v === 'string') : [], ...(typeof event.detail.details === 'string' ? { details: event.detail.details } : {}), ...(typeof event.detail.file === 'string' ? { file: event.detail.file } : {}) }
    }
    return [{ runtime: value.runtime as RuntimeId, event: {
      type: 'notice' as const, class: 'info' as const, level: event.level, message: event.message,
      ...(typeof event.kind === 'string' ? { kind: event.kind } : {}),
      ...(typeof event.id === 'string' ? { id: event.id } : {}),
      ...(typeof event.at === 'number' && Number.isFinite(event.at) ? { at: event.at } : {}),
      ...(typeof event.count === 'number' && Number.isFinite(event.count) && event.count > 0 ? { count: Math.floor(event.count) } : {}),
      ...(detail ? { detail } : {}),
    } }]
  }).slice(0, 100)
}


/** One content-keyed runtime message offered to the host's Inbox memory. */
export interface RuntimeInboxEntry {
  readonly id: string
  readonly contentKey: string
  readonly kind: string
  readonly title: string
  readonly tone: 'neutral' | 'info' | 'warning' | 'danger'
  readonly at: number
  readonly count: number
  readonly lastEvent?: string
  readonly body?: string
  readonly file?: string
  readonly settings?: readonly string[]
}
