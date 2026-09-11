import type { RateLimits, UsageWindow } from '@harnessdesk/protocol'

/**
 * What a metered runtime's limits mean for the person using it.
 *
 * The backend hands over three unrelated facts — rolling usage windows, a
 * prepaid credit balance, and whether a limit has actually been hit — and
 * the UI used to collapse them into "out of credits" whenever the prepaid
 * flag was false, which it is for every plan user who never bought credits.
 * This reads them apart: `blocked` is the only thing that means turns will
 * fail; `usage` is what the vendor's own app shows as "usage remaining".
 */

export type Tone = 'good' | 'warn' | 'bad'

/**
 * The same three states, named the way the design layer names its six.
 *
 * Two vocabularies exist because they were asked different questions: this
 * file grades an allowance, and `design/ui/tone` grades anything at all. The
 * mapping is one line and it lives here, on the side that has the opinion,
 * so a screen never writes its own — which is how one card would end up amber
 * at 19% and another at 25%.
 *
 * **`good` is neutral, not green.** A plan with room is the ordinary case,
 * and the app has always drawn it in the ink it draws everything else in;
 * green would make "nothing is wrong" the loudest thing on the screen and
 * leave the two states that *are* claims — running low, spent — competing
 * with it.
 */
export const paletteTone = (tone: Tone): 'neutral' | 'warning' | 'danger' =>
  tone === 'bad' ? 'danger' : tone === 'warn' ? 'warning' : 'neutral'

export interface UsageSummary {
  /** "4% left" */
  readonly label: string
  /** "Weekly · resets 4:00 PM" */
  readonly detail: string
  readonly remainingPercent: number
  readonly tone: Tone
  readonly window: UsageWindow
}

export interface Blocked {
  readonly title: string
  readonly detail: string
}

export interface LimitsView {
  readonly blocked: Blocked | null
  readonly usage: UsageSummary | null
  readonly windows: readonly UsageWindow[]
  /** Prepaid balance, only when there is one to show. */
  readonly credits: { readonly label: string; readonly tone: Tone } | null
}

const BLOCKED: Record<string, Blocked> = {
  rate_limit_reached: {
    title: 'Usage limit reached',
    detail: 'New turns will fail until the window resets. Past sessions are still readable.',
  },
  workspace_owner_usage_limit_reached: {
    title: 'Usage limit reached',
    detail: "This workspace's usage limit has been reached. Past sessions are still readable.",
  },
  workspace_member_usage_limit_reached: {
    title: 'Usage limit reached',
    detail: 'Your usage limit in this workspace has been reached. Past sessions are still readable.',
  },
  workspace_owner_credits_depleted: {
    title: 'Credits depleted',
    detail: 'This workspace has used all of its credits, so new turns will fail. Past sessions are still readable.',
  },
  workspace_member_credits_depleted: {
    title: 'Credits depleted',
    detail: 'Your credits in this workspace are used up, so new turns will fail. Past sessions are still readable.',
  },
}

export const formatReset = (at: number | null, now = Date.now()): string | null => {
  if (at === null) return null
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

const toneFor = (remaining: number): Tone => (remaining <= 0 ? 'bad' : remaining < 20 ? 'warn' : 'good')

export const describeLimits = (limits: RateLimits | null | undefined, now = Date.now()): LimitsView | null => {
  if (!limits) return null
  const windows = limits.windows ?? []
  const reached = limits.reached ?? null
  const blocked = reached
    ? (BLOCKED[reached] ?? {
        title: 'Limit reached',
        detail: 'New turns will fail for now. Past sessions are still readable.',
      })
    : null

  // The window with the least left is the one that will bite first.
  const tightest = windows.reduce<UsageWindow | null>(
    (best, window) => (best === null || window.usedPercent > best.usedPercent ? window : best),
    null,
  )
  const usage: UsageSummary | null = tightest
    ? (() => {
        const remaining = Math.max(0, Math.round(100 - tightest.usedPercent))
        const reset = formatReset(tightest.resetsAt, now)
        return {
          label: `${remaining}% left`,
          detail: reset ? `${tightest.label} · resets ${reset}` : tightest.label,
          remainingPercent: remaining,
          tone: blocked ? 'bad' : toneFor(remaining),
          window: tightest,
        }
      })()
    : null

  const credits = limits.unlimited
    ? { label: 'unlimited', tone: 'good' as const }
    : // A balance of 0 is a balance: read as a truth value it was none at all (#85).
      // NaN is a number to typeof, and it's what Number() makes of a balance
      // string that isn't one; that's no balance either (review, round 1).
      limits.hasCredits && typeof limits.balance === 'number' && Number.isFinite(limits.balance)
      ? { label: `${limits.balance.toLocaleString()} credits`, tone: limits.balance > 0 ? ('good' as const) : ('bad' as const) }
      : null

  return { blocked, usage, windows, credits }
}
