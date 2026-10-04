import type { AgentEvent, NoticeClass, NoticeDetail } from './events.js'
import type { RuntimeId } from './ids.js'

export const classifyNotice = (notice: { readonly class?: NoticeClass; readonly kind?: string; readonly sessionId?: string }): 'toast' | 'inbox' | 'conversation' | 'standing' => {
  if (notice.class === 'result') return 'toast'
  if (notice.class === 'actionable') return 'standing'
  if (notice.class === 'info' || notice.kind === 'runtime:config' || notice.kind === 'runtime:deprecation') return 'inbox'
  return notice.sessionId || notice.class === 'conversation' ? 'conversation' : 'inbox'
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
