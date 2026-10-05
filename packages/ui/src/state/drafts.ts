/** Conversation-owned drafts and their one reload mirror. */
import type { RuntimeId, SessionKey } from '@harnessdesk/protocol'

/** One attached chip, as the composer holds it. Image bytes never enter storage. */
export interface DraftAttachment {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'image' | 'skill' | 'session' | 'context' | 'note'
  readonly contextId?: string
  readonly ref?: string
  readonly text?: string
  readonly runtime?: RuntimeId
}

/** What the composer would send: the words and the chips beside them. */
export interface Draft {
  readonly text: string
  readonly attachments: readonly DraftAttachment[]
  /** True when an image is present in memory but omitted from the reload mirror. */
  readonly imagesWillBeLostOnReload?: boolean
}

export type RecoverableAttachment = Omit<DraftAttachment, 'id'> & { readonly id?: string }

/** A refused, displaced, or unsaved draft which can be restored to its origin. */
export interface RecoverableDraft {
  readonly id: number
  readonly sourceId?: string
  readonly originQueueRowId?: string
  readonly createdAt: number
  readonly reason: 'refused' | 'saved' | 'edit'
  readonly text: string
  readonly attachments: readonly RecoverableAttachment[]
  readonly detail: string
}

export type NewRecoverableDraft = Omit<RecoverableDraft, 'id' | 'createdAt' | 'reason' | 'attachments'> & {
  readonly id?: number
  readonly createdAt?: number
  readonly reason?: RecoverableDraft['reason']
  readonly attachments: readonly RecoverableAttachment[]
}

interface StoredDrafts {
  readonly live?: Draft
  readonly recoverable: readonly RecoverableDraft[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const STORAGE_KEY = 'harnessdesk:drafts:v1'
const LEGACY_STORAGE_KEY = 'harnessdesk:recoverable-drafts:v1'
const WRITE_DELAY_MS = 250
const MEMORY_ONLY = ' Not saved for a reload — it stays only while this window is open.'
/** Recoveries from a refused first send have no conversation to own them yet. */
export const UNSCOPED_RECOVERY_KEY = '\u0000new-session' as SessionKey

const empty = (draft: Draft): boolean =>
  draft.text.trim() === '' && draft.attachments.length === 0 && !draft.imagesWillBeLostOnReload
const defaultStorage = (): StorageLike | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

const copyDraft = (draft: Draft): Draft => ({
  text: draft.text,
  attachments: [...draft.attachments],
  ...(draft.imagesWillBeLostOnReload ? { imagesWillBeLostOnReload: true } : {}),
})

const parseDraft = (value: unknown): Draft | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Draft>
  if (typeof candidate.text !== 'string' || !Array.isArray(candidate.attachments)) return null
  return {
    text: candidate.text,
    attachments: candidate.attachments.flatMap((item, index): DraftAttachment[] =>
      Boolean(item && typeof item === 'object' && typeof item.name === 'string' &&
        typeof item.path === 'string' && typeof item.kind === 'string' && item.kind !== 'image')
        ? [{ ...item, id: typeof (item as DraftAttachment).id === 'string' ? (item as DraftAttachment).id : `restored-${index}` } as DraftAttachment]
        : [],
    ),
    ...(candidate.imagesWillBeLostOnReload === true ? { imagesWillBeLostOnReload: true } : {}),
  }
}

const parseRecoverable = (value: unknown, nextId: () => number): RecoverableDraft | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RecoverableDraft>
  const draft = parseDraft(candidate)
  if (!draft || typeof candidate.detail !== 'string') return null
  const imageWasDropped = Array.isArray(candidate.attachments) && candidate.attachments.some((item) =>
    Boolean(item && typeof item === 'object' && (item as DraftAttachment).kind === 'image'),
  )
  return {
    id: typeof candidate.id === 'number' ? candidate.id : nextId(),
    ...(typeof candidate.sourceId === 'string' ? { sourceId: candidate.sourceId } : {}),
    ...(typeof candidate.originQueueRowId === 'string' ? { originQueueRowId: candidate.originQueueRowId } : {}),
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    reason: candidate.reason === 'saved' || candidate.reason === 'edit' ? candidate.reason : 'refused',
    text: draft.text,
    attachments: draft.attachments,
    detail: imageWasDropped && !candidate.detail.toLowerCase().includes('image')
      ? `${candidate.detail} Images are not kept across a reload.`
      : candidate.detail,
  }
}

const safeAttachments = (attachments: readonly RecoverableAttachment[]): readonly DraftAttachment[] =>
  attachments
    .filter((attachment) => attachment.kind !== 'image' && !attachment.path.startsWith('data:'))
    .map((attachment, index) => ({ ...attachment, id: attachment.id ?? `draft-${index}` }))

/**
 * Every kind of unsent draft for a conversation, with one sessionStorage
 * mirror. Writes are coalesced; clearing and removal are written immediately.
 */
export class Drafts {
  readonly #entries = new Map<SessionKey, { live?: Draft; recoverable: RecoverableDraft[] }>()
  readonly #forgotten = new Set<SessionKey>()
  readonly #recoverableListeners = new Set<() => void>()
  readonly #storage: StorageLike | null
  readonly #onMemoryOnly?: () => void
  #nextId = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #memoryOnly = false

  constructor(storage: StorageLike | null = defaultStorage(), options: { onMemoryOnly?: () => void } = {}) {
    this.#storage = storage
    this.#onMemoryOnly = options.onMemoryOnly
    this.#read()
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#flushNow)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#onVisibilityChange)
  }

  #entry(key: SessionKey): { live?: Draft; recoverable: RecoverableDraft[] } {
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { recoverable: [] }
      this.#entries.set(key, entry)
    }
    return entry
  }

  #read(): void {
    if (!this.#storage) return
    let raw: unknown
    try {
      raw = JSON.parse(this.#storage.getItem(STORAGE_KEY) ?? 'null')
    } catch {
      raw = null
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue
        const stored = value as StoredDrafts
        const live = parseDraft(stored.live)
        const recoverable = Array.isArray(stored.recoverable)
          ? stored.recoverable.flatMap((item) => {
              const parsed = parseRecoverable(item, () => ++this.#nextId)
              if (parsed) this.#nextId = Math.max(this.#nextId, parsed.id)
              return parsed ? [parsed] : []
            })
          : []
        if (live || recoverable.length > 0) {
          this.#entries.set(key as SessionKey, { ...(live ? { live } : {}), recoverable })
        }
      }
      return
    }
    // Upgrade #1167's original mirror without losing drafts already in this tab.
    try {
      const legacy: unknown = JSON.parse(this.#storage.getItem(LEGACY_STORAGE_KEY) ?? 'null')
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return
      for (const [key, values] of Object.entries(legacy)) {
        if (!Array.isArray(values)) continue
        const recoverable = values.flatMap((item) => {
          const parsed = parseRecoverable(item, () => ++this.#nextId)
          if (parsed) this.#nextId = Math.max(this.#nextId, parsed.id)
          return parsed ? [parsed] : []
        })
        if (recoverable.length) this.#entries.set(key as SessionKey, { recoverable })
      }
    } catch {
      // A malformed or unavailable legacy value is simply absent.
    }
  }

  #serialized(): Record<string, StoredDrafts> {
    const result: Record<string, StoredDrafts> = {}
    for (const [key, entry] of this.#entries) {
      const live = entry.live
      const recoverable = entry.recoverable
      if (!live && recoverable.length === 0) continue
      const attachments = live ? safeAttachments(live.attachments) : []
      const imageOmitted = Boolean(live && attachments.length !== live.attachments.length)
      result[key] = {
        ...(live
          ? {
              live: {
                text: live.text,
                attachments,
                ...(live.imagesWillBeLostOnReload || imageOmitted ? { imagesWillBeLostOnReload: true } : {}),
              },
            }
          : {}),
        recoverable: recoverable.map((item) => {
          const attachments = safeAttachments(item.attachments)
          const droppedImage = attachments.length !== item.attachments.length
          return {
            ...item,
            attachments,
            detail: droppedImage && !item.detail.toLowerCase().includes('image')
              ? `${item.detail} Images are not kept across a reload.`
              : item.detail,
          }
        }),
      }
    }
    return result
  }

  #write(): void {
    if (!this.#storage) return
    try {
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(this.#serialized()))
      try { this.#storage.removeItem(LEGACY_STORAGE_KEY) } catch { /* best effort migration cleanup */ }
    } catch {
      // Never leave an older draft looking current when the latest one failed.
      try { this.#storage.removeItem(STORAGE_KEY) } catch { /* storage may be unavailable */ }
      try { this.#storage.removeItem(LEGACY_STORAGE_KEY) } catch { /* clear the old mirror too */ }
      if (!this.#memoryOnly) {
        this.#memoryOnly = true
        for (const entry of this.#entries.values()) {
          entry.recoverable = entry.recoverable.map((item) => item.detail.endsWith(MEMORY_ONLY)
            ? item
            : { ...item, detail: `${item.detail}${MEMORY_ONLY}` })
        }
        this.#onMemoryOnly?.()
        this.#emitRecoverableChange()
      }
    }
  }

  #scheduleWrite(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#write()
    }, WRITE_DELAY_MS)
  }

  #flushNow = (): void => {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#write()
  }

  #onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.#flushNow()
  }

  #emitRecoverableChange(): void {
    for (const listener of this.#recoverableListeners) listener()
  }

  onRecoverableChange(listener: () => void): () => void {
    this.#recoverableListeners.add(listener)
    return () => this.#recoverableListeners.delete(listener)
  }

  /** The unsent draft, or null. */
  live(key: SessionKey): Draft | null {
    return this.#entries.get(key)?.live ?? null
  }

  /** Keep what is typed now. Empty drafts delete the mirror synchronously. */
  setLive(key: SessionKey, draft: Draft): void {
    if (this.#forgotten.has(key)) return
    const entry = this.#entry(key)
    if (empty(draft)) {
      delete entry.live
      this.#writeImmediately()
    } else {
      const copied = copyDraft(draft)
      entry.live = draft.attachments.some((attachment) => attachment.kind === 'image')
        ? { ...copied, imagesWillBeLostOnReload: true }
        : copied
      this.#scheduleWrite()
    }
    this.#prune(key, entry)
  }

  #writeImmediately(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#write()
  }

  #prune(key: SessionKey, entry: { live?: Draft; recoverable: RecoverableDraft[] }): void {
    if (!entry.live && entry.recoverable.length === 0) this.#entries.delete(key)
  }

  /** Add a refusal or displacement to this conversation's Restore list. */
  addRecoverable(key: SessionKey, draft: NewRecoverableDraft): RecoverableDraft | null {
    if (this.#forgotten.has(key)) return null
    const id = draft.id ?? ++this.#nextId
    this.#nextId = Math.max(this.#nextId, id)
    const entry = this.#entry(key)
    const recoverable: RecoverableDraft = {
      ...draft,
      id,
      createdAt: draft.createdAt ?? Date.now(),
      reason: draft.reason ?? (draft.sourceId || draft.originQueueRowId ? 'edit' : 'refused'),
      attachments: draft.attachments.map((attachment, index) => ({
        ...attachment,
        id: attachment.id ?? `recoverable-${id}-${index}`,
      })),
    }
    entry.recoverable = [...entry.recoverable, recoverable]
    this.#emitRecoverableChange()
    this.#scheduleWrite()
    return recoverable
  }

  recoverable(key: SessionKey): readonly RecoverableDraft[] {
    return this.#entries.get(key)?.recoverable ?? []
  }

  recoverableSnapshot(): ReadonlyMap<SessionKey, readonly RecoverableDraft[]> {
    const result = new Map<SessionKey, readonly RecoverableDraft[]>()
    for (const [key, entry] of this.#entries) if (entry.recoverable.length) result.set(key, entry.recoverable)
    return result
  }

  removeRecoverable(key: SessionKey, id: number): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    const remaining = entry.recoverable.filter((draft) => draft.id !== id)
    if (remaining.length === entry.recoverable.length) return
    entry.recoverable = remaining
    this.#prune(key, entry)
    this.#emitRecoverableChange()
    this.#writeImmediately()
  }

  /** Swap a recovery into the chosen composer, retaining its current draft. */
  restore(
    key: SessionKey,
    id: number,
    destination: { readonly key: SessionKey | null; readonly draft: Draft | null } = { key, draft: this.live(key) },
  ): Draft | null {
    if (this.#forgotten.has(key) || (destination.key && this.#forgotten.has(destination.key))) return null
    const entry = this.#entries.get(key)
    const selected = entry?.recoverable.find((draft) => draft.id === id)
    if (!entry || !selected) return null
    const displaced = destination.draft
    const restored: Draft = {
      text: selected.text,
      attachments: selected.attachments.map((attachment, index) => ({
        ...attachment,
        id: attachment.id ?? `restored-${id}-${index}`,
      })),
      ...(selected.attachments.some((attachment) => attachment.kind === 'image')
        ? { imagesWillBeLostOnReload: true }
        : {}),
    }
    entry.recoverable = entry.recoverable.filter((draft) => draft.id !== id)
    // Fresh composers keep their live text locally. Only a conversation can
    // own a live draft; its displaced text can still use the unscoped list.
    const target = this.#entry(destination.key ?? UNSCOPED_RECOVERY_KEY)
    if (destination.key) target.live = restored
    if (displaced && !empty(displaced)) {
      target.recoverable.push({
        id: ++this.#nextId,
        createdAt: Date.now(),
        reason: 'saved',
        text: displaced.text,
        attachments: [...displaced.attachments],
        detail: 'Restore it to swap with the current draft.',
      })
    }
    this.#prune(key, entry)
    this.#prune(destination.key ?? UNSCOPED_RECOVERY_KEY, target)
    this.#emitRecoverableChange()
    this.#writeImmediately()
    return restored
  }

  /** Compatibility name used by the composer: a failed send is a Restore entry. */
  putBack(key: SessionKey, draft: Draft): void {
    this.addRecoverable(key, {
      text: draft.text,
      attachments: draft.attachments,
      detail: 'Restore the refused message to the composer; your current draft stays available.',
      reason: 'refused',
    })
  }

  /** A deleted conversation has no draft in memory or in the reload mirror. */
  forget(key: SessionKey): void {
    this.#forgotten.add(key)
    this.#entries.delete(key)
    this.#emitRecoverableChange()
    this.#writeImmediately()
  }
}

/** Each store object gets a private Drafts owner, including lightweight tests. */
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
