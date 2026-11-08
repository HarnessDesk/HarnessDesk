import type { ReviewTargetBinding } from '@harnessdesk/protocol'
import { isRevisionName } from './git-revision.js'
import { canonicalRepository } from './git-gateway/record.js'

/** Format only complete, validated forge observations; never invent a value for an unreadable response. */
export const reviewTargetDiagnostic = (expected: ReviewTargetBinding, observed?: ReviewTargetBinding, unavailable?: string): string => {
  const format = (target: ReviewTargetBinding) => `${target.repository} #${target.number} head ${target.head.slice(0, 12)} base ${target.baseRef}@${target.baseTip.slice(0, 12)}`
  return `Pull request target changed or could not be verified. Expected ${format(expected)}; ${observed ? `observed ${format(observed)}` : `${unavailable ?? 'current target'} unavailable`}. Start a fresh review.`
}
export const observedReviewTarget = (value: { repository?: unknown; number?: unknown; head?: unknown; baseRef?: unknown; baseTip?: unknown }): ReviewTargetBinding | null => {
  if (typeof value.repository !== 'string' || !Number.isSafeInteger(value.number) || Number(value.number) < 1 ||
      typeof value.head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.head) ||
      typeof value.baseTip !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.baseTip) ||
      typeof value.baseRef !== 'string' || value.baseRef.length > 255 || !isRevisionName(value.baseRef)) return null
  try {
    return { repository: canonicalRepository(value.repository), number: value.number as number, head: value.head, baseRef: value.baseRef, baseTip: value.baseTip }
  } catch { return null }
}
