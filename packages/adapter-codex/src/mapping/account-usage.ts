import type { AccountActivity } from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

type AccountTokenUsage = CodexProtocol.v2.GetAccountTokenUsageResponse

const localMidnight = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

const tokenCount = (value: unknown): number | null => {
  if (value === null) return null
  if (typeof value !== 'bigint' && typeof value !== 'number') throw new TypeError('Invalid account usage token count')
  const result = Number(value)
  if (!Number.isFinite(result)) throw new TypeError('Invalid account usage token count')
  return result
}

/** Maps Codex's account-wide usage response into the runtime-neutral report shape. */
export const mapAccountActivity = (response: AccountTokenUsage): AccountActivity | null => {
  try {
    if (!response || typeof response !== 'object' || !response.summary) return null
    const buckets = response.dailyUsageBuckets
    if (buckets !== null && !Array.isArray(buckets)) return null
    const days = (buckets ?? []).flatMap((bucket) => {
      const day = localMidnight(bucket?.startDate)
      if (day === null) return []
      const tokens = tokenCount(bucket?.tokens)
      return tokens === null ? [] : [{ day, tokens }]
    })
    const lifetimeTokens = tokenCount(response.summary.lifetimeTokens)
    const peakDailyTokens = tokenCount(response.summary.peakDailyTokens)
    const currentStreakDays = tokenCount(response.summary.currentStreakDays)
    const longestStreakDays = tokenCount(response.summary.longestStreakDays)
    if (
      days.length === 0 && lifetimeTokens === null && peakDailyTokens === null &&
      currentStreakDays === null && longestStreakDays === null
    ) return null
    return {
      days,
      lifetimeTokens,
      peakDailyTokens,
      currentStreakDays,
      longestStreakDays,
    }
  } catch {
    return null
  }
}
