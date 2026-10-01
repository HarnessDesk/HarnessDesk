/**
 * What a person has typed into a conversation and not yet sent — kept by the
 * conversation, not by the composer that happens to be drawing it.
 *
 * A typed message is never lost. The composer is drawn and taken away for
 * reasons that have nothing to do with the words in it: a Side by side tile
 * expanded and returned to the grid, a narrow room's tab switched, the room
 * going back to its chat, a window reloaded mid-sentence. Held in the
 * composer's own state, the draft went with it every time. Held here, keyed
 * by conversation, the next composer to draw that conversation picks it up.
 *
 * One module for every kind of draft a conversation keeps, so there is one
 * source of truth per conversation: this holds the live draft; a refused or
 * displaced draft waiting to be restored belongs beside it.
 *
 * Mirrored to `sessionStorage` (debounced), so a reload loses nothing either.
 * Storage can be full, blocked or absent; every read and write is guarded,
 * and a draft that cannot be mirrored is still held in memory.
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

/** The key prefix every mirrored draft is stored under. */
export const DRAFT_STORAGE_PREFIX = 'harnessdesk:draft:'
const MIRROR_DELAY_MS = 300

const isEmpty = (draft: Draft): boolean => draft.text.trim() === '' && draft.attachments.length === 0

const readStored = (raw: string | null): Draft | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Draft>
    if (typeof value?.text !== 'string') return null
    const attachments = Array.isArray(value.attachments)
      ? value.attachments.filter(
          (one): one is DraftAttachment =>
            !!one && typeof one === 'object' && typeof (one as DraftAttachment).id === 'string' &&
            typeof (one as DraftAttachment).path === 'string' && typeof (one as DraftAttachment).name === 'string',
        )
      : []
    return { text: value.text, attachments }
  } catch {
    return null
  }
}

export class Drafts {
  readonly #live = new Map<SessionKey, Draft>()
  readonly #storage: Storage | null
  readonly #pending = new Map<SessionKey, ReturnType<typeof setTimeout>>()

  constructor(storage: Storage | null) {
    this.#storage = storage
  }

  /** The draft typed into this conversation and not sent, or null. */
  live(key: SessionKey): Draft | null {
    const held = this.#live.get(key)
    if (held) return held
    let raw: string | null = null
    try {
      raw = this.#storage?.getItem(DRAFT_STORAGE_PREFIX + key) ?? null
    } catch {
      raw = null
    }
    const stored = readStored(raw)
    if (stored && !isEmpty(stored)) this.#live.set(key, stored)
    return stored && !isEmpty(stored) ? stored : null
  }

  /** Keep what is typed now. An empty draft — sent, or cleared — is forgotten. */
  setLive(key: SessionKey, draft: Draft): void {
    if (isEmpty(draft)) this.#live.delete(key)
    else this.#live.set(key, { text: draft.text, attachments: [...draft.attachments] })
    this.#mirror(key)
  }

  /** Forget a conversation's draft outright — the conversation itself is gone. */
  forget(key: SessionKey): void {
    this.#live.delete(key)
    const timer = this.#pending.get(key)
    if (timer) clearTimeout(timer)
    this.#pending.delete(key)
    try {
      this.#storage?.removeItem(DRAFT_STORAGE_PREFIX + key)
    } catch {
      // Memory is already clear; a mirror that cannot be removed is overwritten by the next draft.
    }
  }

  /** Write every pending mirror now — before the window goes away, and in tests. */
  flush(): void {
    for (const key of [...this.#pending.keys()]) this.#write(key)
  }

  #mirror(key: SessionKey): void {
    if (!this.#storage) return
    const timer = this.#pending.get(key)
    if (timer) clearTimeout(timer)
    this.#pending.set(key, setTimeout(() => this.#write(key), MIRROR_DELAY_MS))
  }

  #write(key: SessionKey): void {
    const timer = this.#pending.get(key)
    if (timer) clearTimeout(timer)
    this.#pending.delete(key)
    const draft = this.#live.get(key)
    try {
      if (draft) this.#storage?.setItem(DRAFT_STORAGE_PREFIX + key, JSON.stringify(draft))
      else this.#storage?.removeItem(DRAFT_STORAGE_PREFIX + key)
    } catch {
      // Full or blocked: the draft is still held in memory for this window.
    }
  }
}

const sessionStorageOrNull = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * The drafts a store keeps. The app's own store carries one mirrored to
 * `sessionStorage`; any other store (a stub in a test, the preview's) gets
 * one in memory of its own, so two stores never share a draft.
 */
const unmirrored = new WeakMap<object, Drafts>()
export const draftsOf = (store: object): Drafts => {
  const own = (store as { drafts?: unknown }).drafts
  if (own instanceof Drafts) return own
  let held = unmirrored.get(store)
  if (!held) {
    held = new Drafts(null)
    unmirrored.set(store, held)
  }
  return held
}

/** The `Drafts` the app's own store holds: mirrored to this window's session storage. */
export const appDrafts = (): Drafts => new Drafts(sessionStorageOrNull())
