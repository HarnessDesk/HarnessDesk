import type { InstallCopy, InstallInfo, InstallStanding } from '@harnessdesk/protocol'

import type { Readiness } from './readiness'

/**
 * Every copy of an agent on the machine, as the settings page says it — the
 * pure half. The host found the copies and judged them; what the interface
 * owes on top is one sentence per copy that says what it is and why it is
 * or is not the one running, and one line for the whole that a person
 * wondering "which one am I on?" can read without opening the section.
 */

/** The chip a copy wears: what it is doing, in a word. */
export const standingChip = (standing: InstallStanding): { readonly state: Readiness; readonly label: string } => {
  switch (standing) {
    case 'chosen':
      return { state: 'ready', label: 'In use' }
    case 'pinned':
      return { state: 'ready', label: 'Pinned' }
    case 'older':
      return { state: 'available', label: 'Older' }
    case 'too-old':
      return { state: 'broken', label: 'Too old' }
    case 'unreadable':
      return { state: 'broken', label: 'Unreadable' }
  }
}

/** The copy's own line: its version and the road it came by. */
export const describeCopy = (copy: InstallCopy): string => {
  const version = copy.version ?? 'version unknown'
  const via = copy.managed ? 'downloaded by HarnessDesk' : `via ${copy.channelLabel}`
  return `${version} · ${via}`
}

/**
 * Why a copy stands where it does, when the reason is worth a line: the
 * floor it misses, the update that would fix it, the pin that overrides
 * it. The chosen copy's line is the path, which is the fact a person
 * checks against their terminal.
 *
 * Commands are written between backticks, the way the host writes them in
 * its own messages; the surface sets them as code. See `lib/health.ts`.
 */
export const copyReason = (copy: InstallCopy, info: InstallInfo): string | null => {
  switch (copy.standing) {
    case 'too-old': {
      // The knowledge's own reason is a sentence and ends like one; the
      // stand-in has to be given its full stop, or the update that follows
      // runs straight on from the version — "Needs 2.0.0 Update it with…".
      const needs = info.minVersionReason ?? `Needs ${info.minVersion ?? 'a newer build'}.`
      return `${needs}${copy.updateCommand ? ` Update it with \`${copy.updateCommand}\`.` : ''}`
    }
    case 'unreadable':
      return 'Did not answer for its version, so it is never run.'
    case 'older':
      return info.policy === 'pinned'
        ? 'Would run under the newest-wins rule; a pin overrides it.'
        : copy.updateCommand
          ? `Outranked by a newer copy. Update it with \`${copy.updateCommand}\`, or remove it.`
          : 'Outranked by a newer copy.'
    case 'chosen':
    case 'pinned':
      return copy.path
  }
}

/**
 * The one line for the whole: what answers right now. Names the copy in
 * use, or the fallback, or the absence — never "installed" alone, because
 * a machine with three copies is exactly where that word stops meaning
 * anything.
 */
export const installSummary = (info: InstallInfo): string => {
  const others = info.copies.filter((copy) => copy.standing !== 'chosen' && copy.standing !== 'pinned').length
  const more = others > 0 ? ` (${others} other ${others === 1 ? 'copy' : 'copies'} found)` : ''
  if (info.chosen) {
    const how = info.policy === 'pinned' ? 'Pinned to' : 'Running'
    return `${how} ${describeCopy(info.chosen)}${more}`
  }
  if (info.fallback) {
    const what = info.fallback.managed
      ? `HarnessDesk's own ${info.fallback.version ?? 'download'}`
      : info.fallback.command
    return `Running ${what}${info.copies.length > 0 ? ' — no installed copy qualifies' : ' — nothing else installed'}${more}`
  }
  return info.copies.length > 0 ? 'No installed copy qualifies, and there is no fallback' : 'Not installed'
}

/**
 * What the fallback row says it is — or nothing, because most of the time it
 * has nothing to add.
 *
 * The fallback is the row's own command, and it is worth a line in exactly
 * two cases: it is what is actually running (no installed copy qualified),
 * or it is a build the desk downloaded and can replace. Anything else is the
 * same binary described twice — OpenClaw listed `/opt/homebrew/bin/openclaw`
 * as the copy in use and `openclaw acp` as a fallback standing by, which is
 * one program wearing two rows.
 */
export const describeFallback = (info: InstallInfo): string | null => {
  const fallback = info.fallback
  if (!fallback) return null
  if (info.chosen && !fallback.managed) return null
  if (info.chosen && fallback.command === info.chosen.path) return null
  if (fallback.managed) {
    return `${fallback.version ?? 'A build'} downloaded by HarnessDesk${
      info.registryUpdate ? `; ${info.registryUpdate.version} is in the registry` : ''
    }`
  }
  return fallback.command
}
