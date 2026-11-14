import { isDeepStrictEqual } from 'node:util'
import type { AgentItem } from '@harnessdesk/protocol'

/**
 * Reconcile one uniquely matched item, field by field. ItemStatus is shared by
 * command, fileChange, toolCall, webSearch and subagent: completed, failed and
 * declined are terminal; items without that lifecycle are final observations.
 * Final items accept replay fields only with the same status. Final fields
 * accept only missing values, equality or append-only strings/arrays. Running
 * fields accept rewrites and lifecycle updates, retaining only missing values
 * and strict prefixes of saved strings/arrays. Arrays are atomic leading
 * slices, never paired by position to combine unrelated content.
 */
export const mergeReplayItem = (saved: AgentItem, replay: AgentItem): AgentItem => {
  if (saved.type !== replay.type) return saved
  const final = !('status' in saved) || saved.status === 'completed' || saved.status === 'failed' || saved.status === 'declined'
  if (final && 'status' in saved && (!('status' in replay) || replay.status !== saved.status)) return saved

  const merge = (before: unknown, after: unknown): unknown => {
    if (before === undefined || before === null || isDeepStrictEqual(before, after)) return after
    if (after === undefined) return before
    if (typeof before === 'string' && typeof after === 'string') {
      return final ? after.startsWith(before) ? after : before
        : before.length > after.length && before.startsWith(after) ? before : after
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const prefix = (short: unknown[], long: unknown[]) => short.every((value, i) => isDeepStrictEqual(value, long[i]))
      return final ? after.length >= before.length && prefix(before, after) ? after : before
        : after.length < before.length && prefix(after, before) ? before : after
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      const result = { ...after } as Record<string, unknown>
      for (const [field, value] of Object.entries(before)) result[field] = merge(value, result[field])
      return isDeepStrictEqual(result, after) ? after : result
    }
    return final ? before : after
  }
  return merge(saved, replay) as AgentItem
}
