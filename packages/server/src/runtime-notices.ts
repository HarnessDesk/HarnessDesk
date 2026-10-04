import { classifyNotice, readRuntimeNotices, runtimeNoticeKey, type AgentEvent, type RetainedRuntimeNotice, type RuntimeId, type RuntimeInboxEntry } from '@harnessdesk/protocol'
export { readRuntimeNotices }

/** Retain information before there is any window to hear the runtime. */
export const retainRuntimeNotice = (raw: unknown, runtime: RuntimeId, event: Extract<AgentEvent, { type: 'notice' }>, counts: Readonly<Record<string, unknown>> = {}): RetainedRuntimeNotice[] => {
  const history = readRuntimeNotices(raw)
  if (classifyNotice(event) !== 'inbox') return history
  const key = runtimeNoticeKey(runtime, event)
  const previous = history.find(entry => runtimeNoticeKey(entry.runtime, entry.event) === key)
  if (event.id && previous?.event.id === event.id) return history
  const recorded = counts[key]
  const count = Math.max(previous?.event.count ?? (previous ? 1 : 0), typeof recorded === 'number' && Number.isSafeInteger(recorded) && recorded > 0 ? recorded : 0) + 1
  return [{ runtime, event: { ...event, class: 'info' as const, count } }, ...history.filter(entry => runtimeNoticeKey(entry.runtime, entry.event) !== key)].slice(0, 100)
}

const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/** Apply only the new occurrence; a window never supplies read or policy state. */
export const keepRuntimeInboxEntry = (preferences: Readonly<Record<string, unknown>>, entry: RuntimeInboxEntry): Record<string, unknown> | null => {
  const policy = object(preferences['noticePolicy'])
  if (strings(policy['muted']).includes(entry.kind)) return null
  const kept = strings(policy['kept'])
  const inbox = Array.isArray(preferences['inbox']) ? preferences['inbox'].map(object) : []
  const old = inbox.find(row => row['id'] === entry.id)
  if (!old && kept.includes(entry.contentKey)) return null
  const oldCount = typeof old?.['count'] === 'number' && Number.isSafeInteger(old['count']) && old['count'] > 0 ? old['count'] : old ? 1 : 0
  if (old && ((entry.lastEvent && old['lastEvent'] === entry.lastEvent) || (entry.at <= Number(old['at']) && entry.count <= oldCount))) return null
  const row = { ...entry, count: Math.max(entry.count, oldCount), read: old?.['read'] === true }
  const noticePolicy = kept.includes(entry.contentKey) ? policy : { ...policy, kept: [...kept, entry.contentKey] }
  return { inbox: [row, ...inbox.filter(row => row['id'] !== entry.id)].slice(0, 100), noticePolicy }
}
