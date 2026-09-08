import {
  contributionId,
  scopeApplies,
  type CapabilityContribution,
  type ContextImage,
  type ContributionId,
  type ContributionKind,
  type ExtensionEvent,
  type HookInvocation,
  type PluginInstanceId,
  type ScopeQuery,
  type ToolResult,
} from '@harnessdesk/protocol'

/**
 * Where contributions and their executors live.
 *
 * Split from the services on purpose: a service is the plugin-facing API, while
 * this is the host-facing one. The descriptor half is serialisable and reaches
 * the UI; the executor half never leaves this process.
 *
 * Contributions are grouped by owner so a reloading plugin's whole set can be
 * replaced in one step. Consumers see a revision bump, never a half-loaded
 * plugin with some tools present and others missing.
 */

export type ToolExecutor = (args: unknown, scope: ScopeQuery) => Promise<ToolResult> | ToolResult

export type HookHandler = (
  invocation: HookInvocation,
) => Promise<HookVerdictLike> | HookVerdictLike

export type HookVerdictLike =
  | void
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }

/**
 * What a provider hands back. A string is the common case; the object form
 * carries an image beside (or instead of) the text — a screenshot chip.
 * Only chips may return the object form: automatic every-turn context is
 * text or nothing.
 */
export type ContextResolution = string | { readonly text?: string; readonly image?: ContextImage }

export type ContextResolver = (scope: ScopeQuery, ref?: string) => Promise<ContextResolution> | ContextResolution

export type CommandHandler = (argument: string, scope: ScopeQuery) => Promise<void> | void

/**
 * `Omit` over a union collapses it to the shared keys, which would erase every
 * variant's own fields. Distributing keeps each branch intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A contribution as a service supplies it: id and revision are the store's to assign. */
export type ContributionDraft = DistributiveOmit<CapabilityContribution, 'id' | 'revision'> & {
  readonly id?: ContributionId
}

interface Entry {
  readonly contribution: CapabilityContribution
  readonly executor?: ToolExecutor
  readonly hook?: HookHandler
  readonly resolver?: ContextResolver
  readonly command?: CommandHandler
}

export class ContributionStore {
  readonly #byId = new Map<string, Entry>()
  /** Insertion order per owner, so contributions render in the order declared. */
  readonly #byOwner = new Map<string, Set<string>>()
  readonly #revisions = new Map<string, number>()
  readonly #listeners = new Set<(event: ExtensionEvent) => void>()
  #counter = 0

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  revisionOf(owner: PluginInstanceId): number {
    return this.#revisions.get(owner) ?? 0
  }

  /** Owners mid-load: their adds are staged and announced once, at commit. */
  readonly #staging = new Set<PluginInstanceId>()
  /** Owners whose mid-life changes are waiting for the microtask announce. */
  readonly #dirty = new Set<PluginInstanceId>()

  /**
   * Starts a new revision for an owner. Called when a plugin (re)loads, before
   * it registers anything, so the swap at `commit()` is atomic.
   */
  beginRevision(owner: PluginInstanceId): number {
    const next = (this.#revisions.get(owner) ?? 0) + 1
    this.#revisions.set(owner, next)
    this.#staging.add(owner)
    return next
  }

  /** Announces the owner's current set as one revision. */
  commit(owner: PluginInstanceId): void {
    this.#staging.delete(owner)
    this.#dirty.delete(owner)
    this.#emit({
      type: 'contributions/changed',
      owner,
      revision: this.revisionOf(owner),
      contributions: this.forOwner(owner),
    })
  }

  /**
   * A contribution added or withdrawn after its plugin loaded — a live panel
   * updating its data, a tool appearing on demand — announces the owner's new
   * set. Without this, only a reload ever tells anyone anything: the exact
   * bug that made the first installed plugin's panel invisible. Coalesced per
   * microtask so a burst of registrations is one event, and silent while the
   * owner is mid-load, where `commit()` is the single atomic announcement.
   */
  #announceSoon(owner: PluginInstanceId): void {
    if (this.#staging.has(owner)) return
    if (this.#dirty.has(owner)) return
    this.#dirty.add(owner)
    queueMicrotask(() => {
      if (!this.#dirty.delete(owner)) return
      this.#emit({
        type: 'contributions/changed',
        owner,
        revision: this.revisionOf(owner),
        contributions: this.forOwner(owner),
      })
    })
  }

  add(
    contribution: ContributionDraft,
    handlers: Omit<Entry, 'contribution'> = {},
  ): { id: ContributionId; dispose: () => void } {
    const id = contribution.id ?? contributionId(`c${++this.#counter}`)
    const full = {
      ...contribution,
      id,
      revision: this.revisionOf(contribution.owner),
    } as CapabilityContribution

    this.#byId.set(id, { contribution: full, ...handlers })
    const owned = this.#byOwner.get(contribution.owner) ?? new Set<string>()
    owned.add(id)
    this.#byOwner.set(contribution.owner, owned)
    this.#announceSoon(contribution.owner)

    return {
      id,
      dispose: () => {
        this.#byId.delete(id)
        this.#byOwner.get(contribution.owner)?.delete(id)
        this.#announceSoon(contribution.owner)
      },
    }
  }

  /** Drops everything an owner registered. Used when a plugin is disposed. */
  removeOwner(owner: PluginInstanceId): void {
    const owned = this.#byOwner.get(owner)
    if (!owned) return
    for (const id of owned) this.#byId.delete(id)
    this.#byOwner.delete(owner)
    this.#emit({
      type: 'contributions/changed',
      owner,
      revision: this.revisionOf(owner),
      contributions: [],
    })
  }

  forOwner(owner: PluginInstanceId): CapabilityContribution[] {
    const owned = this.#byOwner.get(owner)
    if (!owned) return []
    return [...owned]
      .map((id) => this.#byId.get(id)?.contribution)
      .filter((entry): entry is CapabilityContribution => entry !== undefined)
  }

  list<K extends ContributionKind>(
    kind: K,
    query: ScopeQuery = {},
  ): Extract<CapabilityContribution, { kind: K }>[] {
    const out: Extract<CapabilityContribution, { kind: K }>[] = []
    for (const entry of this.#byId.values()) {
      if (entry.contribution.kind !== kind) continue
      if (!scopeApplies(entry.contribution.scope, query)) continue
      out.push(entry.contribution as Extract<CapabilityContribution, { kind: K }>)
    }
    return out
  }

  all(): CapabilityContribution[] {
    return [...this.#byId.values()].map((entry) => entry.contribution)
  }

  get(id: ContributionId): Entry | undefined {
    return this.#byId.get(id)
  }

  emit(event: ExtensionEvent): void {
    this.#emit(event)
  }

  #emit(event: ExtensionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A misbehaving consumer must not stop the others from being told.
      }
    }
  }
}
