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


/** Merge the edits a window made, rather than replacing another window's memory. */
export const mergeNoticePreferences = (preferences: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>, base?: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const merged = { ...patch }
  if (base && 'inbox' in patch && 'inbox' in base) {
    const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : []
    const before = rows(base['inbox'])
    const after = rows(patch['inbox'])
    const current = rows(preferences['inbox'])
    const removed = before.filter(row => !after.some(next => next['id'] === row['id']))
    const kept = strings(object(preferences['noticePolicy'])['kept'])
    const added = after.filter(row => !before.some(old => old['id'] === row['id']) &&
      !current.some(old => old['id'] === row['id'] && Number(row['at']) <= Number(old['at'])) &&
      !(typeof row['contentKey'] === 'string' && kept.includes(row['contentKey']) && !current.some(old => old['id'] === row['id'])))
    merged['inbox'] = [...added, ...current.filter(row => !removed.some(old => old['id'] === row['id']) && !added.some(next => next['id'] === row['id'])).map(row => {
      const old = before.find(entry => entry['id'] === row['id'])
      const next = after.find(entry => entry['id'] === row['id'])
      // A read edits a row only if it still exists; never restore a cleared row.
      if (!old || !next) return row
      const changed = { ...row }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (JSON.stringify(old[key]) === JSON.stringify(next[key])) continue
        if (key !== 'read' && Number(next['at']) < Number(row['at'])) continue
        if (key in next) changed[key] = next[key]
        else delete changed[key]
      }
      return changed
    })].sort((left, right) => Number(right['at']) - Number(left['at'])).slice(0, 100)
  }
  if (base && 'noticePolicy' in patch && 'noticePolicy' in base) {
    const before = object(base['noticePolicy'])
    const after = object(patch['noticePolicy'])
    const current = object(preferences['noticePolicy'])
    const policy = { ...current }
    for (const field of ['muted', 'kept', 'seen']) {
      const old = strings(before[field])
      const next = strings(after[field])
      policy[field] = [...new Set([...strings(current[field]).filter(key => !old.includes(key) || next.includes(key)), ...next.filter(key => !old.includes(key))])]
    }
    policy['seen'] = strings(policy['seen']).slice(-40)
    policy['kept'] = [...strings(policy['kept']).filter(key => key.startsWith('content:')), ...strings(policy['kept']).filter(key => !key.startsWith('content:')).slice(-40)]
    for (const field of ['records', 'surfaces']) {
      const old = object(before[field])
      const next = object(after[field])
      const values = { ...object(current[field]) }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (JSON.stringify(old[key]) === JSON.stringify(next[key])) continue
        if (!(key in next)) delete values[key]
        else if (field === 'records') {
          const record = object(next[key])
          values[key] = { ...record, count: Number(object(values[key])['count'] ?? 0) + Number(record['count'] ?? 0) - Number(object(old[key])['count'] ?? 0) }
        } else values[key] = next[key]
      }
      policy[field] = values
    }
    merged['noticePolicy'] = policy
  }
  return merged
}
