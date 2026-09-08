import type { RuntimeInfo } from '@harnessdesk/protocol'

/**
 * The one line that explains a model list: which build produced it.
 *
 * A runtime's models are whatever the running agent declared, so the version
 * belongs beside the list, not three screens away in settings. For a bridge
 * the agent it drives is the build that matters and is named first; the
 * bridge's own version follows, because a stale bridge is the other way a
 * list stops growing. Nothing here names a vendor — every word is the
 * runtime's own.
 */
export const describeVersion = (info: RuntimeInfo): string | null => {
  const name = info.presentation.name
  const own = shortVersion(info.version)
  const driven = shortVersion(info.drives?.version)
  if (driven) return own ? `${name} ${driven} · bridge ${own}` : `${name} ${driven}`
  return own ? `${name} ${own}` : null
}

/** `codex-cli 0.135.0` → `0.135.0`; a string with no release triple is kept whole. */
export const shortVersion = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(raw)
  return match ? match[0] : raw
}

/**
 * What to say when a newer build is published, and what to run. The reason
 * it matters is stated plainly — a user reading this is usually asking where
 * a model went, and "update available" alone does not answer them.
 */
export const describeUpdate = (
  info: RuntimeInfo,
): { readonly text: string; readonly command?: string; readonly url?: string } | null => {
  const update = info.update
  if (!update) return null
  return {
    text: `${info.presentation.name} ${update.version} is available. Newer models and reasoning levels may be missing until it is installed.`,
    ...(update.command ? { command: update.command } : {}),
    ...(update.url ? { url: update.url } : {}),
  }
}

/**
 * When the list was last re-read, as a short phrase — "checked 4:41 PM" —
 * or null before the first check. Sits under the build in the menu footer,
 * so a person wondering whether a model "should be there yet" can see how
 * old the answer is instead of guessing.
 */
export const describeChecked = (info: RuntimeInfo, now = Date.now()): string | null => {
  const at = info.catalogCheckedAt
  if (!at) return null
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `models checked ${sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`}`
}

/** Older than this, a returning window re-asks before showing the list. */
export const STALE_AFTER_MS = 10 * 60 * 1000

export const isStale = (info: RuntimeInfo, now = Date.now()): boolean =>
  !info.catalogCheckedAt || now - info.catalogCheckedAt > STALE_AFTER_MS
