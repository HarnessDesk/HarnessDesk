import { classifyNotice, readRuntimeNotices, runtimeNoticeKey, type AgentEvent, type RetainedRuntimeNotice, type RuntimeId } from '@harnessdesk/protocol'
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
