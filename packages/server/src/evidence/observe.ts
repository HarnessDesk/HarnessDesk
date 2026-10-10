import type { Evidence, EvidenceRecord, Sha } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from './forge.js'
import { factKey, mintId } from './records.js'
import { diffOf, pathsAddedSince, projectOf, revisionOf } from './revision.js'
import type { EvidenceStore } from './store.js'

/**
 * The facts the desk observes about a card's branch without being asked: its
 * diff (against the base it came from, or since the card's work began —
 * `diffOf`), its pull request, and the checks the forge ran on that pull
 * request's head.
 *
 * Looked at when a card is finished, released or abandoned, while its
 * holder's checkout is still known, and when a board is opened, at most once
 * every few minutes a card, so a pull request merged or a CI run finished
 * since is seen. A fact is recorded only when it differs from the card's
 * latest of its kind: the store keeps what changed, not every look.
 *
 * A card's diff is the one fact whose bound is not always HEAD: a card still
 * held is measured all the way there, but a card that has stopped is measured
 * only to `Look.until`, where its own checkout stood the moment it stopped —
 * so a later look, on a checkout the next card goes on to share, still finds
 * the pull request and its checks moving, and the stopped card's own diff
 * standing exactly where it left it.
 */

/** How long a card's branch is left before a board opened again looks at it again. */
export const OBSERVE_EVERY_MS = 5 * 60 * 1000

export interface Look {
  readonly room: string
  readonly card: number
  /** The room's project: a checkout outside it is not looked at. */
  readonly project: string
  readonly cwd: string
  /** The Seat holding the card when it was looked at; null when nobody was. */
  readonly seat: string | null
  /**
   * The commit the card's work began at — its Seat's head when it opened —
   * which a diff is measured from when there is no work beyond the base branch
   * to measure (`diffOf`). Null when no Seat of this desk says.
   */
  readonly since?: Sha | null
  /**
   * Where the remote's copy of the branch stood when the card was taken, as
   * its claim recorded it; absent when the claim recorded nothing (`diffOf`).
   */
  readonly upstream?: Sha | null
  /**
   * The commit the card's own checkout stood at the moment it stopped being
   * held — finished, released or abandoned — so its diff is bounded to
   * `since..until` rather than to HEAD as the checkout stands now (`diffOf`).
   * Absent, or null, while the card is still held: then its diff is measured
   * all the way to HEAD, because the card's own work is still landing there.
   * Where a stopped card's own `until` comes from on a later look is the
   * board's to say (`plane.ts`): this desk only ever bounds a diff to what it
   * is given.
   */
  readonly until?: Sha | null
  /**
   * The branch captured with `until`, including null for a detached HEAD.
   * Only the bounded diff uses it: later forge facts still describe the
   * branch the forge was asked about. Absent for legacy stops and live cards.
   */
  readonly untilBranch?: string | null
  /**
   * A card no longer held with no `until` is never diffed, whether or not it
   * already has a diff fact: it keeps whatever it last showed, or none at
   * all — diffing it just this once, unbounded, is exactly how a stopped
   * card ends up bounded forever to a wrong reading (issue #1035). Its pull
   * request and checks are still looked at; only the diff step is skipped.
   * Absent, or false, for every card whose diff is worth attempting — held,
   * or stopped with a known `until`.
   */
  readonly skipDiff?: boolean
  /**
   * Paths already dirty in this checkout the moment the card was claimed —
   * `IntentClaim.dirtyPaths`. Given as a list, the diff fact's own `dirty`
   * counts only a path dirty now that was not dirty then (`pathsAddedSince`),
   * so a checkout shared with other work is never marked stale for dirt this
   * card's own holder never made. Absent (no claim ever recorded one — a
   * card settled before this existed) or null (the read failed at claim
   * time) both fall back to the whole checkout's own `dirty`, as it always
   * answered.
   */
  readonly sinceDirtyPaths?: readonly string[] | null
}

export class Observer {
  readonly #store: EvidenceStore
  readonly #gh: GhInCheckout | undefined
  readonly #now: () => number
  readonly #log: (message: string, details?: Readonly<Record<string, unknown>>) => void
  readonly #looked = new Map<string, number>()

  constructor(parts: {
    readonly store: EvidenceStore
    readonly gh?: GhInCheckout
    readonly now?: () => number
    readonly log: (message: string, details?: Readonly<Record<string, unknown>>) => void
  }) {
    this.#store = parts.store
    this.#gh = parts.gh
    this.#now = parts.now ?? Date.now
    this.#log = parts.log
  }

  /**
   * Whether a card is due another look — never looked at, or not for a while —
   * and if it is, marks it looked at now, so a second board read before the
   * look happens does not queue it again.
   */
  take(room: string, card: number): boolean {
    const key = JSON.stringify([room, card])
    const at = this.#looked.get(key)
    if (at !== undefined && this.#now() - at < OBSERVE_EVERY_MS) return false
    this.#looked.set(key, this.#now())
    return true
  }

  /** Looks at one card's branch now and records each fact that is new. Answers whether anything was. */
  async observe(look: Look): Promise<boolean> {
    this.#looked.set(JSON.stringify([look.room, look.card]), this.#now())
    if ((await projectOf(look.cwd)) !== look.project) {
      this.#log('a card was not looked at: its checkout is not part of its room’s project', {
        room: look.room,
        card: look.card,
        cwd: look.cwd,
      })
      return false
    }
    const revision = await revisionOf(look.cwd)
    if (!revision) return false

    const facts: Evidence[] = []
    const diff = look.skipDiff ? null : await diffOf(look.cwd, look.since ?? null, {
      ...(look.upstream !== undefined ? { upstream: look.upstream } : {}),
      ...(look.until !== undefined ? { until: look.until } : {}),
    })
    /*
     * Whether the checkout held changes not committed at this same look, from
     * the read this look already made — never a second probe. A hand finish
     * left dirty is not refused (#1049), but its diff is drawn stale.
     *
     * A checkout shared with other work is not this card's own dirt: given
     * `sinceDirtyPaths` — the snapshot taken when the card was claimed — only
     * a path dirty now that was not dirty then counts (`pathsAddedSince`),
     * so a person's own untracked file elsewhere in the tree never marks a
     * cleanly finished card stale. With no snapshot to compare against, the
     * whole checkout's own `dirty` answers as it always did.
     */
    const dirty = look.sinceDirtyPaths === undefined || look.sinceDirtyPaths === null
      ? revision.dirty
      : revision.dirtyPaths === null
        ? true
        : pathsAddedSince(revision.dirtyPaths, look.sinceDirtyPaths).length > 0
    if (diff) facts.push({ kind: 'diff', ...diff, dirty })
    const forge = await readPullRequest(look.cwd, this.#gh)
    if (forge.kind === 'unreachable') {
      this.#log('the forge could not be read for a card', { room: look.room, card: look.card, why: forge.why })
    } else if (forge.kind === 'found') {
      facts.push({ kind: 'pr', ...forge.pr })
      if (forge.ci.length > 0) facts.push({ kind: 'ci', checks: forge.ci, at: forge.pr.head })
    }

    // What this desk has observed before. A fact a backup brought is not: the desk's own look is recorded beside it.
    const known = new Map<string, EvidenceRecord>()
    for (const line of (await this.#store.read(look.project, 'evidence')).lines) {
      if (line.type !== 'evidence' || line.record.card?.board !== look.room || line.record.card.id !== look.card) continue
      if (line.record.restored) continue
      known.set(factKey(line.record.fact), line.record)
    }
    const checkoutOf = (fact: Evidence) => ({ cwd: look.cwd,
      branch: fact.kind === 'diff' && look.until != null && look.untilBranch !== undefined ? look.untilBranch : revision.branch,
    })
    // The same payload on another branch is another observation. Otherwise
    // a same-commit switch silently keeps the earlier checkout identity.
    const changed = facts.filter((fact) => {
      const before = known.get(factKey(fact))
      const checkout = checkoutOf(fact)
      return JSON.stringify(before?.fact) !== JSON.stringify(fact) ||
        before?.checkout?.cwd !== checkout.cwd || before?.checkout?.branch !== checkout.branch
    })
    if (changed.length === 0) return false
    const observedAt = this.#now()
    await this.#store.append(
      look.project,
      'evidence',
      changed.map((fact) => ({
        type: 'evidence' as const,
        record: {
          id: mintId(),
          fact,
          card: { board: look.room, id: look.card },
          checkout: checkoutOf(fact),
          seat: look.seat,
          round: null,
          observedAt,
          posted: null,
        },
      })),
    )
    return true
  }
}
