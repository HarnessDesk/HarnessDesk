import type { Evidence, EvidenceRecord, Sha } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from './forge.js'
import { factKey, mintId } from './records.js'
import { diffOf, projectOf, revisionOf } from './revision.js'
import type { EvidenceStore } from './store.js'

/**
 * The facts the desk observes about a card's branch without being asked: its
 * diff (against the base it came from, or since the card's work began —
 * `diffOf`), its pull request, and the checks the forge ran on that pull
 * request's head.
 *
 * Looked at when a card is finished, while its holder's checkout is still
 * known, and when a board is opened, at most once every few minutes a card, so
 * a pull request merged or a CI run finished since is seen. A fact is recorded
 * only when it differs from the card's latest of its kind: the store keeps
 * what changed, not every look.
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
    const diff = await diffOf(look.cwd, look.since ?? null)
    if (diff) facts.push({ kind: 'diff', ...diff })
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
    const changed = facts.filter((fact) => JSON.stringify(known.get(factKey(fact))?.fact) !== JSON.stringify(fact))
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
          checkout: { cwd: look.cwd, branch: revision.branch },
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
