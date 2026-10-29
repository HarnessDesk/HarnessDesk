import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { decideLeadPermission, leadBudgetProjection, summarizeLeadArguments, type LeadPermissionCall, type LeadPermissionContext, type LeadState } from '@harnessdesk/lead'
import { runtimeId, sessionId, sessionIndexCursorOf, type HostParams, type HostResult, type LeadProject, type RuntimeId, type SessionId } from '@harnessdesk/protocol'
import type { SessionIndex } from '../session-index.js'
import type { PhoneWork } from '../phone-work.js'
import { scrub } from '../phone-redact.js'
import { boundLeadChatRead } from './chat-read.js'

export interface LeadChatActivity { readonly id: string; readonly project: string; readonly state: 'running' | 'waiting' | 'idle' }

export interface LeadChatsPorts {
  readonly project: LeadProject
  readonly state: () => LeadState
  readonly managementAvailable?: () => boolean
  readonly context: (call: LeadPermissionCall) => Promise<LeadPermissionContext>
  readonly member: () => Promise<boolean>
  readonly now: () => number
  readonly index: Pick<SessionIndex, 'list' | 'get' | 'isOwn'>
  /** Actual live/transcript cwd, without restoring archived or removed sessions. */
  readonly cwd: (runtime: RuntimeId, id: SessionId) => Promise<string | null>
  readonly live: (runtime: RuntimeId, id: SessionId) => { readonly running: boolean; readonly waiting: boolean }
  /** Only the host holds this receipt; it is never exposed to the child. */
  readonly noteDispatchNotStarted: (id: string) => void
  readonly work: Pick<PhoneWork, 'threadRead' | 'startInProject' | 'sessionSend' | 'stop'>
  readonly watches?: { read(project: string): Promise<readonly string[]>; watch(project: string, id: string): Promise<void> }
  readonly publish?: (event: LeadChatActivity) => void
}
const refuse = (message: string): never => { throw new Error(message) }
const MUTATIONS = new Set(['lead/chat/start', 'lead/chat/send', 'lead/chat/stop'])
const MAX_SCAN = 200
const CURSOR_TTL = 15 * 60 * 1000

/** No Flow ownership or allowance is conferred here. These are ordinary sessions,
 * with ordinary permissions and spend, in one host-selected canonical folder.
 * Cursors are bounded host-local handles: reconnect/restart begins a fresh list. */
export class LeadChats {
  readonly #cursors = new Map<string, { root: string; cursor: string; expires: number }>()
  readonly #consumed = new Set<string>()
  readonly #watched = new Set<string>()
  readonly #states = new Map<string, 'running' | 'waiting' | 'idle'>()
  #tail: Promise<unknown> = Promise.resolve()
  #changes: Promise<unknown> = Promise.resolve()
  constructor(private readonly ports: LeadChatsPorts) {}

  #stateOf(id: string): 'running' | 'waiting' | 'idle' {
    const at = id.indexOf(':'), live = this.ports.live(runtimeId(id.slice(0, at)), sessionId(id.slice(at + 1)))
    return live.waiting ? 'waiting' : live.running ? 'running' : 'idle'
  }
  async #watch(id: string): Promise<void> {
    await this.ports.watches?.watch(this.ports.project.path, id)
    if (!this.#watched.has(id)) this.#states.set(id, this.#stateOf(id))
    this.#watched.delete(id); this.#watched.add(id)
    while (this.#watched.size > 64) { const first = this.#watched.values().next().value!; this.#watched.delete(first); this.#states.delete(first) }
  }
  /** Metadata-only authority for private chat notifications; no transcript is loaded. */
  async canRead(id: string): Promise<boolean> {
    try { await this.#target(id, true); await this.#gate({ method: 'lead/chat/read', params: { id } }); return true }
    catch { return false }
  }
  /** A reconnect baseline contains state only and never replays transcript data. */
  async activities(): Promise<readonly LeadChatActivity[]> {
    const root = this.ports.project.path
    const tracked = this.ports.watches ? await this.ports.watches.read(root) : [...this.#watched]
    const activities: LeadChatActivity[] = []
    for (const id of tracked.slice(-64)) {
      try {
        await this.#target(id, false); await this.#gate({ method: 'lead/chat/read', params: { id } })
        if (this.ports.project.path !== root) return []
        activities.push({ id, project: root, state: this.#stateOf(id) })
      } catch { /* Withdrawn, archived and removed watches disclose no identity. */ }
    }
    return activities
  }
  /** Only followed chats emit, and only on state transitions. No token output or
   * transcript bytes cross this notification path. Persisted watches survive restarts. */
  changed(runtime: RuntimeId, session: SessionId): Promise<void> {
    // Capture while the host is handling this event. A fast turn may complete
    // before asynchronous file/scope checks return; its two transitions still matter.
    const id = `${runtime}:${session}`, state = this.#stateOf(id)
    const changed = this.#changes.then(async () => {
      try {
        const tracked = this.ports.watches ? await this.ports.watches.read(this.ports.project.path) : [...this.#watched]
        if (!tracked.includes(id)) return
        await this.#target(id, false); await this.#gate({ method: 'lead/chat/read', params: { id } })
        if (this.#states.get(id) === state) return
        this.#states.set(id, state)
        while (this.#states.size > 64) this.#states.delete(this.#states.keys().next().value!)
        this.ports.publish?.({ id, project: this.ports.project.path, state })
      } catch { this.#states.delete(id) }
    })
    this.#changes = changed.catch(() => {})
    return changed
  }

  async #project(): Promise<void> {
    try {
      if (!await this.ports.member() || await realpath(this.ports.project.path) !== this.ports.project.path) refuse('Lead project is outside the selected scope.')
    } catch { refuse('Lead project is outside the selected scope.') }
  }

  async #target(id: string, archived: boolean): Promise<void> {
    await this.#project()
    const at = id.indexOf(':')
    if (at < 1 || at === id.length - 1 || id.length > 300) refuse('That session is outside the Lead project scope.')
    const runtime = runtimeId(id.slice(0, at)), session = sessionId(id.slice(at + 1))
    const check = async (cwd: string | null) => {
      if (!this.ports.index.isOwn(runtime, session, archived) || !cwd) refuse('That session is outside the Lead project scope.')
      try { if (await realpath(cwd!) !== this.ports.project.path) refuse('That session is outside the Lead project scope.') }
      catch { refuse('That session is outside the Lead project scope.') }
    }
    await check(this.ports.index.get(runtime, session)?.cwd ?? null)
    await check(await this.ports.cwd(runtime, session))
    await this.#project()
    // Membership and cwd may have changed while the descriptor was being read.
    await check(this.ports.index.get(runtime, session)?.cwd ?? null)
  }

  async #gate(call: LeadPermissionCall, attemptId?: string, finalAdmission = false): Promise<void> {
    await this.#project()
    const context = await this.ports.context(call)
    await this.#project()
    const state = this.ports.state(), now = this.ports.now()
    if (!state.policy) refuse('Lead policy is unavailable.')
    if (MUTATIONS.has(call.method) && call.method !== 'lead/chat/stop') {
      if (this.ports.managementAvailable?.() === false) refuse('Lead management is disabled or unavailable.')
      if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.recoveryBlocked || state.stopEffectsPending !== null ||
        [...state.attempts.values()].some(attempt => attempt.kind === 'mutation' &&
          (attempt.outcome === 'uncertain' || attempt.resolutionPending || attempt.contested ||
            !finalAdmission && attempt.id !== attemptId && attempt.phase === 'started' && attempt.dispatched)))
        refuse('Lead management is stopped pending recovery or user action.')
    }
    const approved = state.contract && state.consent ? { contract: state.contract, consent: state.consent,
      runIds: state.runs.map(run => run.runId), teamIds: state.teams } : null
    const decision = decideLeadPermission({ method: call.method, params: call.params, project: this.ports.project, runId: null, start: null }, {
      ...context, desk: state.policy!, project: this.ports.project, approved,
      budget: state.budget ? leadBudgetProjection(state.budget, now) : null, now,
    })
    if (decision.effect !== 'allow') refuse(`Lead chat permission refused: ${decision.reason}`)
  }

  #mutate<T>(call: LeadPermissionCall, work: (admit: (id?: string) => Promise<void>, effectStarted: () => void, attemptId: string) => Promise<T>): Promise<T> {
    const task = this.#tail.then(async () => {
      // A model cannot bypass journaling with a raw private socket call, or replay
      // a durable attempt. Summary matching is an audit constraint; the actual
      // params are independently scoped and policy-checked at every dispatch.
      const summary = JSON.stringify(summarizeLeadArguments(call.params))
      const candidates = [...this.ports.state().attempts.values()].filter(attempt => attempt.method === call.method && attempt.kind === 'mutation' &&
        attempt.phase === 'started' && attempt.dispatched && attempt.effect === 'allow' && JSON.stringify(attempt.arguments) === summary)
      if (candidates.length !== 1 || this.#consumed.has(candidates[0]!.id)) refuse('Lead chat requires one unconsumed durable allow attempt.')
      const id = candidates[0]!.id, selected = { ...this.ports.project }
      const admit = async (target?: string) => {
        if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
        const params = call.params as { id?: string }
        if (target ?? params.id) await this.#target((target ?? params.id)!, false)
        await this.#gate(call, id)
        const current = this.ports.state().attempts.get(id)
        if (!current || current.phase !== 'started' || !current.dispatched || current.effect !== 'allow') refuse('Lead chat admission changed.')
      }
      // Consume before admission can refuse: a no-effect receipt must never
      // coexist with a replay that later crosses the effect boundary.
      this.#consumed.add(id)
      // Retained journal attempts bound the replay set as the journal compacts.
      for (const previous of this.#consumed) if (!this.ports.state().attempts.has(previous)) this.#consumed.delete(previous)
      let effectStarted = false
      try {
        await admit()
        return await work(admit, () => { effectStarted = true }, id)
      } catch (error) {
        // Only this host's exact dispatch callback can cross the boundary. An
        // agent error, error text or child response cannot prove absence of effects.
        if (!effectStarted) this.ports.noteDispatchNotStarted(id)
        throw error
      }
    })
    this.#tail = task.catch(() => {})
    return task
  }

  async list(params: HostParams<'lead/chat/list'>): Promise<HostResult<'lead/chat/list'>> {
    await this.#gate({ method: 'lead/chat/list', params })
    const now = this.ports.now(), root = this.ports.project.path, limit = params.limit ?? 30
    for (const [key, value] of this.#cursors) if (value.expires <= now) this.#cursors.delete(key)
    const held = params.cursor === undefined ? undefined : this.#cursors.get(params.cursor)
    if (params.cursor !== undefined && (!held || held.root !== root)) refuse('Invalid or expired Lead chat cursor. Restart the list.')
    const page = this.ports.index.list({ ...(held ? { cursor: held.cursor } : {}), pageSize: MAX_SCAN })
    const items: HostResult<'lead/chat/list'>['items'][number][] = []
    let position = held?.cursor, more = page.nextCursor !== null
    for (let i = 0; i < page.data.length; i++) {
      const summary = page.data[i]!
      const previousPosition = position
      position = sessionIndexCursorOf(summary, 'exclude')
      const id = `${summary.runtime}:${summary.id}`
      try { await this.#target(id, false) } catch { continue }
      const live = this.ports.live(summary.runtime, summary.id)
      const item: typeof items[number] = { id, title: scrub(summary.title ?? summary.preview ?? '', 160) || 'Conversation',
        state: live.waiting ? 'waiting' : live.running ? 'running' : 'idle', updatedAt: summary.updatedAt }
      // Counts alone do not bound UTF-8 or escaped JSON. Leave room for the
      // opaque continuation token and stop before consuming the omitted row.
      if (Buffer.byteLength(JSON.stringify({ items: [...items, item], nextCursor: '0'.repeat(36) })) > 12_000) {
        position = previousPosition; more = true; break
      }
      items.push(item)
      if (items.length >= limit) { more = i < page.data.length - 1 || page.nextCursor !== null; break }
    }
    await this.#gate({ method: 'lead/chat/list', params })
    if (this.ports.project.path !== root) refuse('Lead project scope changed.')
    let nextCursor: string | null = null
    if (more && position) {
      nextCursor = randomUUID()
      this.#cursors.set(nextCursor, { root, cursor: position, expires: now + CURSOR_TTL })
      while (this.#cursors.size > 256) this.#cursors.delete(this.#cursors.keys().next().value!)
    }
    return { items, nextCursor }
  }

  async read(params: HostParams<'lead/chat/read'>): Promise<HostResult<'lead/chat/read'>> {
    const root = this.ports.project.path
    await this.#gate({ method: 'lead/chat/read', params }); await this.#target(params.id, true)
    const result = await this.ports.work.threadRead(params, async cwd => {
      await this.#target(params.id, true)
      try { if (await realpath(cwd) !== this.ports.project.path) refuse('That session is outside the Lead project scope.') }
      catch { refuse('That session is outside the Lead project scope.') }
    })
    await this.#target(params.id, true); await this.#gate({ method: 'lead/chat/read', params })
    await this.#watch(params.id)
    await this.#target(params.id, true)
    if (this.ports.project.path !== root) refuse('Lead project scope changed.')
    return boundLeadChatRead(result)
  }
  start(params: HostParams<'lead/chat/start'>): Promise<HostResult<'lead/chat/start'>> {
    const call = { method: 'lead/chat/start', params } as const
    return this.#mutate(call, (admit, effectStarted, attemptId) => {
      let createdId: string | undefined
      const scope = this.#liveScope(call, attemptId, () => createdId)
      return this.ports.work.startInProject(params, this.ports.project.path, async id => {
        createdId = id
        await admit(id)
        if (id) { await this.#watch(id); await admit(id) }
      }, effectStarted, scope)
    })
  }
  send(params: HostParams<'lead/chat/send'>): Promise<HostResult<'lead/chat/send'>> {
    const call = { method: 'lead/chat/send', params } as const
    return this.#mutate(call, (admit, effectStarted, attemptId) => {
      const scope = this.#liveScope(call, attemptId, () => params.id)
      return this.ports.work.sessionSend(params, async () => { await admit(); await this.#watch(params.id); await admit() }, effectStarted, scope)
    })
  }
  stop(params: HostParams<'lead/chat/stop'>): Promise<HostResult<'lead/chat/stop'>> {
    const call = { method: 'lead/chat/stop', params } as const
    return this.#mutate(call, (admit, effectStarted, attemptId) => this.ports.work.stop(params, admit, effectStarted, this.#liveScope(call, attemptId, () => params.id)))
  }

  #liveScope(call: LeadPermissionCall, attemptId: string, target: () => string | undefined): (cwd: string) => Promise<void> {
    const selected = { ...this.ports.project }
    // An accepted queue item outlives its journal attempt. Keep its pinned
    // scope and current policy checks, without requiring an unfinished attempt.
    return async cwd => {
      if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
      const id = target()
      if (!id) refuse('The chat identity is unavailable.')
      await this.#target(id!, false)
      try { if (await realpath(cwd) !== selected.path) refuse('That session is outside the Lead project scope.') }
      catch { refuse('That session is outside the Lead project scope.') }
      await this.#target(id!, false)
      if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
      // Queue drains run independently of the mutation tail. Healthy concurrent
      // dispatch is not recovery; every unresolved effect and live policy fence is.
      await this.#gate(call, attemptId, true)
    }
  }
}
