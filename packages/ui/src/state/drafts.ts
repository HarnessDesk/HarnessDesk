/**
 * What a person has typed into a conversation and not yet sent — kept by the
 * conversation, not by the composer that happens to be drawing it.
 *
 * A typed message is never lost. The composer is drawn and taken away for
 * reasons that have nothing to do with the words in it: a Side by side tile
 * expanded and returned to the grid, a narrow room's tab switched, the room
 * going back to its chat. Held in the composer's own state, the draft went
 * with it every time. Held here, keyed by conversation, the next composer to
 * draw that conversation picks it up.
 *
 * One module for every kind of draft a conversation keeps, so there is one
 * source of truth per conversation: this holds the live draft; a refused or
 * displaced draft waiting to be restored belongs beside it, and so does
 * keeping drafts across a reload — one persistence path, added with them.
 */
import type { SessionKey } from '@harnessdesk/protocol'

/** One attached chip, as the composer holds it — a file, an image, a skill, a context or a note. */
export interface DraftAttachment {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'image' | 'skill' | 'session' | 'context' | 'note'
  readonly contextId?: string
  readonly ref?: string
  readonly text?: string
}

/** What the composer would send: the words and the chips beside them. */
export interface Draft {
  readonly text: string
  readonly attachments: readonly DraftAttachment[]
}

const isEmpty = (draft: Draft): boolean => draft.text.trim() === '' && draft.attachments.length === 0

export class Drafts {
  readonly #live = new Map<SessionKey, Draft>()
  readonly #listeners = new Map<SessionKey, Set<(draft: Draft) => void>>()

  /** The draft typed into this conversation and not sent, or null. */
  live(key: SessionKey): Draft | null {
    return this.#live.get(key) ?? null
  }

  /** Keep what is typed now. An empty draft — sent, or cleared — is forgotten. */
  setLive(key: SessionKey, draft: Draft): void {
    if (isEmpty(draft)) this.#live.delete(key)
    else this.#live.set(key, { text: draft.text, attachments: [...draft.attachments] })
  }

  /**
   * Put a message back into its conversation — a send that failed after the
   * composer that sent it moved on or went away. Whatever was typed there
   * since wins, field by field, and any composer drawing that conversation
   * now is told, so it shows the words rather than overwrite them.
   */
  putBack(key: SessionKey, draft: Draft): void {
    const there = this.live(key)
    const merged: Draft = {
      text: there && there.text.trim().length > 0 ? there.text : draft.text,
      attachments: there && there.attachments.length > 0 ? there.attachments : draft.attachments,
    }
    this.setLive(key, merged)
    for (const listener of this.#listeners.get(key) ?? []) listener(merged)
  }

  /** Hear a message put back into this conversation. Returns the way to stop. */
  onPutBack(key: SessionKey, listener: (draft: Draft) => void): () => void {
    const set = this.#listeners.get(key) ?? new Set()
    set.add(listener)
    this.#listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(key)
    }
  }

  /** Forget a conversation's draft outright — the conversation itself is gone. */
  forget(key: SessionKey): void {
    this.#live.delete(key)
  }
}

/**
 * The drafts a store keeps. The app's own store carries one; any other store
 * (a stub in a test, the preview's) gets one of its own, so two stores never
 * share a draft.
 */
const ownDrafts = new WeakMap<object, Drafts>()
export const draftsOf = (store: object): Drafts => {
  const own = (store as { drafts?: unknown }).drafts
  if (own instanceof Drafts) return own
  let held = ownDrafts.get(store)
  if (!held) {
    held = new Drafts()
    ownDrafts.set(store, held)
  }
  return held
}
