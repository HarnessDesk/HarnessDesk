import type { Intent } from '@harnessdesk/protocol'

import { sameCanonicalPath } from './path-identity.js'

/** A deliberate agent block may be undone only by that same conversation. */
export const blockedByCaller = (card: Intent, caller: { readonly runtime: string; readonly sessionId: string }): boolean =>
  card.state === 'blocked' && card.blockedBy === 'hand' &&
  card.blockedByAgent?.runtime === caller.runtime && card.blockedByAgent.sessionId === caller.sessionId

// One day gives a restarted writer time to recover without retaining an idle checkout forever.
export const RETAINED_WORK_MS = 24 * 60 * 60 * 1000

/** Older snapshots have no release timestamp, so their claim time is the conservative bound. */
export const retainedWorkExpired = (claim: NonNullable<Intent['previousClaim']>): boolean =>
  Date.now() - (claim.releasedAt ?? claim.at) >= RETAINED_WORK_MS

/** Preserve the ownership baseline, never the current dirt, when the same card comes back. */
export const carryCardWork = (before: readonly Intent[], next: readonly Intent[]): readonly Intent[] => {
  const prior = new Map(before.map((card) => [card.id, card]))
  const claimed = next.filter((card) => {
    const old = prior.get(card.id)?.claim
    return card.claim && (!old || card.claim.at !== old.at || card.claim.runtime !== old.runtime || card.claim.sessionId !== old.sessionId)
  })
  const carried = next.map((card) => {
    const old = prior.get(card.id)
    if (!old || old === card) return card
    if (old.claim && !card.claim) {
      const shared = old.claim.cwd && next.some((other) => other.id !== card.id && other.claim?.cwd &&
        sameCanonicalPath(other.claim.cwd, old.claim!.cwd!))
      return { ...card, previousClaim: !shared && (card.state === 'open' || card.state === 'blocked')
        ? { ...old.claim, releasedAt: Date.now() } : null }
    }
    if (!old.claim && card.claim) {
      const previous = old.previousClaim
      const resumes = previous?.cwd && card.claim.cwd && sameCanonicalPath(previous.cwd, card.claim.cwd) &&
        previous.runtime === card.claim.runtime && previous.sessionId === card.claim.sessionId &&
        Array.isArray(previous.dirtyPaths) && !retainedWorkExpired(previous)
      return {
        ...card, previousClaim: null,
        claim: resumes ? { ...card.claim, head: previous.head, upstream: previous.upstream, dirtyPaths: previous.dirtyPaths, resumed: true } : card.claim,
      }
    }
    // A patch inherits ownership from the old card, including a durable discard applied by the caller.
    return !old.claim && !card.claim && old.previousClaim !== card.previousClaim
      ? { ...card, previousClaim: old.previousClaim ?? null } : card
  }).map((card) => card.previousClaim && (card.state === 'done' || card.state === 'abandoned' ||
    retainedWorkExpired(card.previousClaim) || (card.previousClaim.cwd && claimed.some((one) =>
      one.id !== card.id && one.claim?.cwd && sameCanonicalPath(one.claim.cwd, card.previousClaim!.cwd!),
    ))) ? { ...card, previousClaim: null } : card)
  return carried.every((card, index) => card === next[index]) ? next : carried
}
