import { leadStage, quoteLeadWorkText, type LeadStage, type LeadStartCause } from '@harnessdesk/protocol'
import type { DispatchAdmission } from '../dispatch-admission.js'
import { LEAD_LIMITS, deskContextContent, leadDisplayName, leadMessageEnvelope, leadMessageKey } from '@harnessdesk/protocol'
import { LeadChatHeldError, type LeadChatControlStore } from './chat-control.js'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { decideLeadPermission, leadBudgetProjection, summarizeLeadArguments, type LeadPermissionCall, type LeadPermissionContext, type LeadState } from '@harnessdesk/lead'
import { runtimeId, sessionId, sessionIndexCursorOf, type HostParams, type HostResult, type LeadProject, type RuntimeId, type SessionId } from '@harnessdesk/protocol'
import type { SessionIndex } from '../session-index.js'
import type { PhoneWork } from '../phone-work.js'
import { scrub } from '../phone-redact.js'
import { LeadChatIncidents } from './incidents.js'
import type { AgentError, LeadChatCandidate, LeadChatIncidentObservation, RateLimits, Turn } from '@harnessdesk/protocol'
import { boundLeadChatRead } from './chat-read.js'
import type { LeadWorkLedger, LeadWorkLinkState } from './work.js'

export class LeadChatBusyError extends Error { constructor() { super('That chat is busy; defer the recovery retry.') } }

export const LEAD_CHAT_HELD = 'The person has taken this chat over. Wait until they hand it back.'

export interface LeadChatActivity { readonly id: string; readonly project: string; readonly state: 'running' | 'waiting' | 'idle'; readonly stage: LeadStage; readonly incident?: LeadChatIncidentObservation }

export interface LeadChatsPorts {
  readonly control?: Pick<LeadChatControlStore, 'holder' | 'noteSent'> & Partial<Pick<LeadChatControlStore, 'assertDispatch' | 'assertCanStart' | 'current'>>
  readonly project: LeadProject
  readonly state: () => LeadState
  readonly managementAvailable?: () => boolean
  readonly queuedSends?: () => boolean
  readonly context: (call: LeadPermissionCall) => Promise<LeadPermissionContext>
  readonly member: () => Promise<boolean>
  readonly now: () => number
  readonly index: Pick<SessionIndex, 'list' | 'get' | 'isOwn'>
  /** Actual live/transcript cwd, without restoring archived or removed sessions. */
  readonly cwd: (runtime: RuntimeId, id: SessionId) => Promise<string | null>
  readonly live: (runtime: RuntimeId, id: SessionId) => { readonly running: boolean; readonly waiting: boolean; readonly approvalWaiting?: boolean; readonly queued?: boolean; readonly failed?: boolean; readonly queuePaused?: boolean; readonly stopped?: boolean }
  /** Only the host holds this receipt; it is never exposed to the child. */
  readonly noteDispatchNotStarted: (id: string) => void
  readonly work: Pick<PhoneWork, 'threadRead' | 'startInProject' | 'sessionSend' | 'stop'>
  readonly watches?: { read(project: string): Promise<readonly string[]>; watch(project: string, id: string): Promise<void> }
  readonly recovery?: {
    readonly file: string
    readonly problem?: (reason: string) => void
    readonly candidates: (exclude?: string) => Promise<readonly (LeadChatCandidate & { readonly agent?: string })[]>
    readonly limits: (id: string) => Promise<RateLimits | null>
    readonly firstMessage: (id: string) => Promise<string | null>
    readonly retry: (id: string, current: () => boolean, started: () => void) => Promise<void | 'not-started' | 'busy'>
    readonly busy?: (id: string) => boolean
    readonly schedule?: (run: () => void, delay: number) => () => void
  }
  readonly publish?: (event: LeadChatActivity) => void
  /** The reserved run: a start the Lead makes for automatic work is refused while only the person's slot is left. */
  readonly slots?: { admit(cause: LeadStartCause): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>; hold(cause: LeadStartCause): { release(): void } | null; mark(id: string, cause: LeadStartCause): Promise<void>; readonly reasons: { readonly cap: string } }
  /**
   * The goal's time: true once the open goal's deadline has passed (read after the file has loaded). A start or a send
   * the Lead makes on its own for that goal is refused then; the person's own are not.
   */
  readonly deadlinePassed?: () => Promise<boolean>
  /** The Lead's question the person has not answered yet, if any (`LeadPresenceStore.unansweredAsk`). While it is open
   * no chat starts: the Lead never picks an option for the person, and a repeat of the request points to the question. */
  readonly unansweredAsk?: () => { readonly question: string; readonly options: readonly string[] } | null
  /**
   * Account pacing. Asked only for a start the Lead made without naming an agent, and answered only when the person
   * turned on "Prefer the account that resets soonest" for the agent the desk would start on. The agent is one the
   * desk can start on now; the label is the presentation name the Lead may say, never an address.
   */
  readonly pacing?: { readonly choose: () => Promise<{ readonly agent: string; readonly label: string } | null> }
  /** The work ledger's duplicate guard: a start joins an open item or makes one, and a duplicate is refused. */
  readonly ledger?: Pick<LeadWorkLedger, 'claim' | 'started' | 'release'> & Partial<Pick<LeadWorkLedger, 'leadStopped'>>
}
const refuse = (message: string): never => { throw new Error(message) }
const MUTATIONS = new Set(['lead/chat/start', 'lead/chat/send', 'lead/chat/stop'])
const MOVE_TEXT_CHARS = 48 * 1024
const MAX_SCAN = 200
const CURSOR_TTL = 15 * 60 * 1000

/** No Flow ownership or allowance is conferred here. These are ordinary sessions,
 * with ordinary permissions and spend, in one host-selected canonical folder.
 * Cursors are bounded host-local handles: reconnect/restart begins a fresh list. */
export class LeadChats {
  readonly #cursors = new Map<string, { root: string; cursor: string; expires: number }>()
  readonly #consumed = new Set<string>()
  readonly #watched = new Set<string>()
  readonly #states = new Map<string, LeadStage>()
  readonly #queuedMutations = new Set<string>()
  #effectGeneration = 0
  /** Local liveness only: journal history cannot manufacture a queued effect. */
  get effectsQueued(): boolean {
    const state = this.ports.state()
    if (['stopped', 'accepted', 'declined'].includes(state.phase) || state.recoveryBlocked || state.stopEffectsPending !== null) {
      this.#queuedMutations.clear(); return false
    }
    for (const id of this.#queuedMutations) {
      const attempt = state.attempts.get(id)
      if (!attempt || attempt.phase !== 'started' || !attempt.dispatched || attempt.effect !== 'allow' || attempt.recoveryReported) this.#queuedMutations.delete(id)
    }
    return this.#queuedMutations.size > 0 || this.ports.queuedSends?.() === true
  }
  clearEffects(): void { this.#effectGeneration++; this.#queuedMutations.clear() }
  #tail: Promise<unknown> = Promise.resolve()
  #changes: Promise<unknown> = Promise.resolve()
  incidents: LeadChatIncidents | undefined
  #ready: Promise<void>
  constructor(private readonly ports: LeadChatsPorts) {
    this.incidents = this.#createIncidents(); this.#ready = this.incidents?.restore() ?? Promise.resolve()
    void this.#ready.catch(() => {})
  }
  restore(): Promise<void> { return this.#ready }
  /** Chats the Lead holds that are working right now. */
  liveHeld(include: (id: string) => boolean = () => true): number {
    const chats = this.ports.control?.current?.(this.ports.project.path).chats ?? []
    return chats.filter(chat => { if (chat.holder !== 'lead' || !include(chat.id)) return false
      const at = chat.id.indexOf(':'); return at > 0 && this.ports.live(runtimeId(chat.id.slice(0, at)), sessionId(chat.id.slice(at + 1))).running }).length
  }
  async idle(retries = true): Promise<void> {
    await this.#ready
    for (;;) { const changes = this.#changes; await changes; if (retries) await this.incidents?.idle(); if (changes === this.#changes) return }
  }
  #createIncidents(): LeadChatIncidents | undefined {
    const ports = this.ports
    if (ports.recovery) return new LeadChatIncidents({ file: ports.recovery.file, project: ports.project.path, now: ports.now,
      ...(ports.recovery.schedule ? { schedule: ports.recovery.schedule } : {}),
      goalStartedSeq: () => ports.state().goalStartedSeq,
      personRevision: () => Math.max(0, ...ports.state().messages.filter(message => message.role === 'user' && message.source === 'person').map(message => message.revision)),
      problem: ports.recovery.problem, busy: id => { const at = id.indexOf(':'); return ports.recovery!.busy?.(id) || ports.live(runtimeId(id.slice(0, at)), sessionId(id.slice(at + 1))).running },
      admit: id => this.#incidentAllowed(id, true), allowed: id => this.#incidentAllowed(id), retry: ports.recovery.retry,
      publish: async incident => {
        if (!await this.#incidentAllowed(incident.chatId)) return
        const candidates = (await ports.recovery!.candidates(incident.chatId)).map(({ key, name }) => ({ key, name }))
        if (!await this.#incidentAllowed(incident.chatId)) return
        this.ports.control?.assertDispatch?.(ports.project.path, incident.chatId)
        // Timers and transcript content stay host-owned; this bounded observation is the only wake.
        this.#states.set(incident.chatId, 'you-blocked')
        ports.publish?.({ id: incident.chatId, project: ports.project.path, state: 'waiting', stage: 'you-blocked', incident: { chatId: incident.chatId, turnId: incident.turnId, kind: incident.kind, attempts: incident.attempts, firstAt: incident.firstAt, lastAt: incident.lastAt, resetsAt: incident.resetsAt, lastError: incident.lastError, state: incident.state, ...(incident.movedTo ? { movedTo: incident.movedTo } : {}), candidates } })
      },
    })
  }
  async projectChanged(): Promise<void> {
    this.incidents?.cancel(); this.incidents?.close(); await this.incidents?.idle()
    this.incidents = this.#createIncidents(); this.#ready = this.incidents?.restore() ?? Promise.resolve()
    void this.#ready.catch(() => {})
    this.#watched.clear(); this.#states.clear(); this.#cursors.clear()
  }
  async close(): Promise<void> { this.incidents?.close(); await this.#changes; await this.incidents?.idle() }
  async #incidentAllowed(id: string, retry = false): Promise<boolean> {
    try {
      if (this.ports.managementAvailable?.() === false || ['stopped', 'accepted', 'declined'].includes(this.ports.state().phase)) return false
      const tracked = this.ports.watches ? await this.ports.watches.read(this.ports.project.path) : [...this.#watched]
      if (!tracked.includes(id) || await this.ports.control?.holder(this.ports.project.path, id) !== 'lead') return false
      await this.#target(id, false); await this.#gate(retry ? { method: 'lead/chat/send', params: { id, text: 'Continue from where you stopped.' } } : { method: 'lead/chat/read', params: { id } })
      return await this.ports.control?.holder(this.ports.project.path, id) === 'lead'
    } catch { return false }
  }
  async #activity(id: string): Promise<LeadChatActivity> {
    const incident = this.incidents?.get(id)
    if (this.#stateOf(id) === 'waiting') return { id, project: this.ports.project.path, state: 'waiting', stage: this.#stageOf(id) }
    if (incident?.state === 'asked') {
      const candidates = (await this.ports.recovery!.candidates(id)).map(({ key, name }) => ({ key, name }))
      return { id, project: this.ports.project.path, state: 'waiting', stage: 'you-blocked', incident: { chatId: incident.chatId, turnId: incident.turnId, kind: incident.kind, attempts: incident.attempts, firstAt: incident.firstAt, lastAt: incident.lastAt, resetsAt: incident.resetsAt, lastError: incident.lastError, state: incident.state, ...(incident.movedTo ? { movedTo: incident.movedTo } : {}), candidates } }
    }
    return { id, project: this.ports.project.path, state: this.incidents?.waiting(id) ? 'running' : this.#stateOf(id), stage: this.#stageOf(id) }
  }

  #stateOf(id: string): 'running' | 'waiting' | 'idle' {
    const at = id.indexOf(':'), live = this.ports.live(runtimeId(id.slice(0, at)), sessionId(id.slice(at + 1)))
    return live.waiting ? 'waiting' : live.running ? 'running' : 'idle'
  }
  #stageOf(id: string, recovering = true): LeadStage {
    const at = id.indexOf(':'), live = this.ports.live(runtimeId(id.slice(0, at)), sessionId(id.slice(at + 1)))
    return leadStage({ kind: 'session', archived: false, waiting: live.approvalWaiting ?? live.waiting, running: recovering && this.incidents?.waiting(id) || live.running, failed: recovering && this.incidents?.waiting(id) ? false : live.failed ?? false, queuePaused: live.queuePaused ?? false, queued: live.queued ?? false, stopped: live.stopped ?? false }).stage
  }
  async #watch(id: string): Promise<void> {
    await this.ports.watches?.watch(this.ports.project.path, id)
    if (!this.#watched.has(id)) this.#states.set(id, this.#stageOf(id))
    this.#watched.delete(id); this.#watched.add(id)
    while (this.#watched.size > 64) { const first = this.#watched.values().next().value!; this.#watched.delete(first); this.#states.delete(first) }
  }
  async #personHolds(id: string): Promise<boolean> {
    const control = this.ports.control, root = this.ports.project.path
    if (control?.current) {
      if (control.current(root).chats.some(chat => chat.id === id && chat.holder === 'person')) return true
      control.assertDispatch?.(root, id)
      return false
    }
    return await control?.holder(root, id) === 'person'
  }
  /** Metadata-only authority for private chat notifications; no transcript is loaded. */
  async canRead(id: string): Promise<boolean> {
    try { await this.#target(id, true); await this.#gate({ method: 'lead/chat/read', params: { id } }); if (await this.#personHolds(id)) return false; return true }
    catch { return false }
  }
  /** A reconnect baseline contains state only and never replays transcript data. */
  async activities(): Promise<readonly LeadChatActivity[]> {
    await this.#ready
    const root = this.ports.project.path
    const tracked = this.ports.watches ? await this.ports.watches.read(root) : [...this.#watched]
    const activities: LeadChatActivity[] = []
    for (const id of tracked.slice(-64)) {
      try {
        await this.#target(id, false); await this.#gate({ method: 'lead/chat/read', params: { id } })
        if (this.ports.project.path !== root) return []
        if (await this.#personHolds(id)) continue
        activities.push(await this.#activity(id))
      } catch { /* Withdrawn, archived and removed watches disclose no identity. */ }
    }
    return activities
  }
  /** Only followed chats emit, and only on state transitions. No token output or
   * transcript bytes cross this notification path. Persisted watches survive restarts. */
  changed(runtime: RuntimeId, session: SessionId, turn?: Turn): Promise<void> {
    // Capture while the host is handling this event. A fast turn may complete
    // before asynchronous file/scope checks return; its two transitions still matter.
    const id = `${runtime}:${session}`, state = this.#stateOf(id)
    const incidents = this.incidents, ready = this.#ready, root = this.ports.project.path
    const observationRevision = incidents?.observationRevision(id)
    const superseded = () => incidents?.observationRevision(id) !== observationRevision
    const terminal = turn?.status === 'interrupted' || turn && turn.status !== 'inProgress' && !turn.error
    const stage = this.#stageOf(id, !terminal)
    if (turn?.status === 'interrupted' || turn?.status === 'completed' && !turn.error) incidents?.invalidateRetry(id)
    const changed = this.#changes.then(async () => {
      try {
        await ready
        if (this.ports.project.path !== root) return
        const tracked = this.ports.watches ? await this.ports.watches.read(this.ports.project.path) : [...this.#watched]
        if (!tracked.includes(id)) return
        if (await this.#personHolds(id)) return
        await this.#target(id, false); await this.#gate({ method: 'lead/chat/read', params: { id } })
        if (this.ports.project.path !== root || superseded()) return
        if (turn && incidents) {
          const raw = turn.error
          const code = ['auth', 'credits', 'rateLimit', 'versionGate', 'sandboxDenied', 'network', 'interrupted', 'runtimeUnavailable', 'protocol', 'unknown'].includes(raw?.code ?? '') ? raw!.code as AgentError['code'] : 'unknown'
          const error = raw ? { ...raw, code } : (turn.status === 'failed' ? { code: 'unknown' as const, message: 'The turn failed.' } : null)
          if (turn.status === 'interrupted') await incidents.stop(id, () => !superseded())
          else if (error || turn.status !== 'inProgress') await incidents.ended(id, String(turn.id), error,
            error?.code === 'rateLimit' ? await this.ports.recovery!.limits(id) : null, () => !superseded())
        }
        if (state !== 'waiting' && (incidents?.waiting(id) || incidents?.get(id)?.state === 'asked')) return
        if (await this.#personHolds(id)) return
        this.ports.control?.assertDispatch?.(this.ports.project.path, id)
        if (this.#states.get(id) === stage) return
        this.#states.set(id, stage)
        while (this.#states.size > 64) this.#states.delete(this.#states.keys().next().value!)
        this.ports.publish?.({ id, project: this.ports.project.path, state, stage })
      } catch { this.#states.delete(id) }
      finally {
        // Capturing a terminal turn revoked its timer/claim before any await.
        // A withdrawn observation must also retire the durable waiting record.
        if (terminal && !superseded() && incidents?.waiting(id)) await incidents.stop(id, () => !superseded())
      }
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
            !finalAdmission && attempt.id !== attemptId && attempt.phase === 'started' && attempt.dispatched && !this.#queuedMutations.has(attempt.id))))
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

  #mutate<T>(call: LeadPermissionCall, effectId: string | undefined, work: (admit: (id?: string) => Promise<void>, effectStarted: () => void, attemptId: string) => Promise<T>): Promise<T> {
    // Only an already accepted durable call counts as queued. Admission still
    // rechecks its record inside the tail before crossing any effect boundary.
    const summary = JSON.stringify(summarizeLeadArguments(call.params))
    const generation = this.#effectGeneration
    const accepted = [...this.ports.state().attempts.values()].find(attempt => (effectId === undefined || attempt.id === effectId) &&
      attempt.method === call.method && attempt.kind === 'mutation' && attempt.phase === 'started' && attempt.dispatched && attempt.effect === 'allow' &&
      !attempt.recoveryReported && !this.#consumed.has(attempt.id) && !this.#queuedMutations.has(attempt.id) && JSON.stringify(attempt.arguments) === summary)
    const queued = accepted?.id ?? null
    if (queued) this.#queuedMutations.add(queued)
    const dispatched = () => { if (queued) this.#queuedMutations.delete(queued) }
    const task = this.#tail.then(async () => {
      // A model cannot bypass journaling with a raw private socket call, or replay
      // a durable attempt. Summary matching is an audit constraint; the actual
      // params are independently scoped and policy-checked at every dispatch.
      const current = queued === null ? undefined : this.ports.state().attempts.get(queued)
      if (!current || current.phase !== 'started' || !current.dispatched || current.effect !== 'allow' || current.recoveryReported ||
        this.#consumed.has(current.id) || generation !== this.#effectGeneration) refuse('Lead chat requires one unconsumed durable allow attempt.')
      const id = current!.id, selected = { ...this.ports.project }
      const admit = async (target?: string) => {
        if (generation !== this.#effectGeneration) refuse('Lead chat effects were stopped.')
        if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
        const params = call.params as { id?: string }
        if (target ?? params.id) await this.#target((target ?? params.id)!, false)
        await this.#gate(call, id)
        const current = this.ports.state().attempts.get(id)
        if (!current || current.phase !== 'started' || !current.dispatched || current.effect !== 'allow' || current.recoveryReported) refuse('Lead chat admission changed.')
      }
      // Consume before admission can refuse: a no-effect receipt must never
      // coexist with a replay that later crosses the effect boundary.
      this.#consumed.add(id)
      // Retained journal attempts bound the replay set as the journal compacts.
      for (const previous of this.#consumed) if (!this.ports.state().attempts.has(previous)) this.#consumed.delete(previous)
      let effectStarted = false
      try {
        await admit()
        return await work(admit, () => { effectStarted = true; dispatched() }, id)
      } catch (error) {
        // Only this host's exact dispatch callback can cross the boundary. An
        // agent error, error text or child response cannot prove absence of effects.
        if (!effectStarted) this.ports.noteDispatchNotStarted(id)
        throw error
      }
    })
    const result = task.finally(dispatched)
    this.#tail = result.catch(() => {})
    return result
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
        state: live.waiting ? 'waiting' : this.incidents?.waiting(id) || live.running ? 'running' : 'idle', stage: this.#stageOf(id), updatedAt: summary.updatedAt }
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
  #envelope(text: string): string { return leadMessageEnvelope(leadDisplayName(this.ports.state().name), text) }
  /** The person messages a start comes from: the ones it quotes, or the latest that was not an option's answer. */
  #quoteIds(params: HostParams<'lead/chat/start'>): readonly string[] {
    if (params.quote !== undefined) return params.quote
    const messages = this.ports.state().messages
    for (let index = messages.length - 1; index >= 0; index--) {
      const person = messages[index]!
      if (person.role !== 'user') continue
      const previous = messages[index - 1]
      const options = previous?.role === 'assistant' ? previous.ask?.options ?? previous.proactive?.options : undefined
      if (options?.some(option => option.label === person.text)) continue
      return [person.id]
    }
    return []
  }
  #startText(params: HostParams<'lead/chat/start'>): string | { readonly problem: string } {
    const messages = this.ports.state().messages
    const people = messages.filter(message => message.role === 'user')
    const ids = this.#quoteIds(params)
    if (ids.some(id => !people.some(message => message.id === id)))
      return { problem: 'Quote only a person message in the current conversation window.' }
    const quoted = people.filter(message => ids.includes(message.id))
    if (quoted.length && /person.?s\s+words,?\s*verbatim/i.test(params.text.normalize('NFKC')))
      return { problem: "Remove the verbatim marker from the brief. Pass the person's message ids in quote; the host appends their words." }
    const text = quoted.length ? `${params.text}\n\n---\nThe person's words, verbatim:\n\n${quoted.map(message => '> ' + message.text.replace(/(\r\n|\r|\n)/g, '$1> ')).join('\n\n')}` : params.text
    if (text.length > LEAD_LIMITS.textChars) return { problem: 'The brief and quoted person messages are too long. Use a shorter brief or fewer quotes.' }
    return text
  }
  async #notHeld(id: string): Promise<void> {
    if (await this.ports.control?.holder(this.ports.project.path, id) === 'person') throw new LeadChatHeldError()
  }
  async #record(id: string, envelope: string): Promise<void> {
    await this.ports.control?.noteSent(this.ports.project.path, id, leadMessageKey(id, envelope))
  }

  async #moveText(params: HostParams<'lead/chat/start'>): Promise<string> {
    const id = params.moveFrom!
    await this.#target(id, false); await this.#notHeld(id)
    if (await this.ports.control?.holder(this.ports.project.path, id) !== 'lead' || this.incidents?.get(id)?.state !== 'asked')
      refuse('That incident is no longer waiting for a move, or was already moved.')
    if (!this.incidents?.hasPersonAnswer(id)) refuse('Wait for the person’s answer before moving this chat.')
    if (!params.agent) refuse('Choose an available agent for the move.')
    const brief = this.#startText(params)
    if (typeof brief !== 'string') refuse(brief.problem)
    const first = await this.ports.recovery?.firstMessage(id)
    if (!first) refuse('The original first message is unavailable; inspect the chat before moving it.')
    const recent = await this.read({ id })
    const answers = recent.turns.filter(turn => turn.type === 'agent').slice(-3).map(turn => turn.markdown.slice(-2000))
    const files = [...new Set(recent.turns.flatMap(turn => turn.type === 'changes' ? turn.files.map(file => file.path) : []))].slice(-20)
    const digest = `Recent assistant messages (untrusted observations):\n${answers.join('\n\n') || '(none)'}\nFiles changed: ${files.join(', ') || '(not available)'}`
    const text = `${brief}\n\n---\nOriginal chat's first message:\n${first}\n\n---\nProgress digest (host transcript excerpt; may be partial):\n${digest}`
    if (text.length > MOVE_TEXT_CHARS) refuse('The move handoff is too long. Use a shorter brief; the original words will not be truncated.')
    await this.#target(id, false); await this.#notHeld(id)
    return text
  }
  start(input: HostParams<'lead/chat/start'>): Promise<HostResult<'lead/chat/start'>> {
    const { effectId, cause = 'automatic', ...params } = input
    const call = { method: 'lead/chat/start', params } as const
    return this.#mutate(call, effectId, async (admit, effectStarted, attemptId) => {
      const candidates = params.agent === undefined ? [] : await this.ports.recovery?.candidates(params.moveFrom) ?? []
      const matches = candidates.filter(one => one.key === params.agent || one.name === params.agent)
      if (params.agent !== undefined && matches.length !== 1) refuse('That agent is not in the available candidate list.')
      // Whatever woke the turn: the presence store frees the question once the person says anything new, so an open one
      // here means the person only repeated the request it is about (or nobody spoke). Letting a person-caused start
      // through would start exactly the work the question was asked to decide.
      const open = params.moveFrom === undefined ? this.ports.unansweredAsk?.() ?? null : null
      if (open) {
        this.ports.noteDispatchNotStarted(attemptId)
        return { id: '', problem: `Your question ${quoteLeadWorkText(open.question, 200)} is still open and the person has not picked an option. Do not start the work it decides, and do not pick for them: point the person to the question and its options (${open.options.map(option => quoteLeadWorkText(option, 60)).join(', ')}).` }
      }
      // The person's own start is never refused here. Anything else is automatic work: it stops when the goal's time has
      // run out, and it waits at the cap, for a reason the Lead is handed back as the tool result.
      if (cause === 'automatic') {
        const refusal = await this.ports.deadlinePassed?.() ? 'The time for this goal has run out, so no new work starts for it. Tell the person, and ask whether to extend it.'
          : await this.ports.slots?.admit('automatic').then(verdict => verdict.ok ? null : verdict.reason)
        if (refusal) { this.ports.noteDispatchNotStarted(attemptId); return { id: '', problem: refusal } }
      }
      const text = params.moveFrom ? await this.#moveText(params) : this.#startText(params)
      if (typeof text !== 'string') {
        this.ports.noteDispatchNotStarted(attemptId)
        return { id: '', problem: text.problem }
      }
      // The duplicate guard reads the ledger before anything is created, so a refusal starts nothing.
      const claim = this.ports.ledger ? await this.ports.ledger.claim({ title: params.text, quotes: this.#quoteIds(params), cause,
        ...(params.ledgerItem !== undefined ? { ledgerItem: params.ledgerItem } : {}), ...(params.moveFrom !== undefined ? { moveFrom: params.moveFrom } : {}) }) : undefined
      if (claim && 'problem' in claim) {
        this.ports.noteDispatchNotStarted(attemptId)
        // The existing item rides the refusal, so the Lead can name it and offer to continue it.
        return { id: '', problem: claim.problem, ...(claim.item ? { ledgerItem: claim.item } : {}) }
      }
      try {
        // Claim first, then pace, then create: a refused duplicate never reads usage, and the fallback retry inside
        // #create runs under this one claim.
        const paced = params.agent === undefined && !params.moveFrom ? await this.ports.pacing?.choose().catch(() => null) ?? null : null
        const agent = matches[0]?.agent ?? matches[0]?.key ?? paced?.agent
        // The slot is taken at once before the chat is made, so two starts at the same moment cannot both pass the cap.
        const hold = this.ports.slots ? this.ports.slots.hold(cause) : { release: () => {} }
        if (hold === null) { this.ports.noteDispatchNotStarted(attemptId); return { id: '', problem: this.ports.slots!.reasons.cap } }
        let result: Awaited<ReturnType<LeadChats['start']>>
        try {
          result = await this.#create(params, call, text, agent, paced, admit, effectStarted, attemptId)
          if (result.id && !result.problem) await this.ports.slots?.mark(result.id, cause).catch(() => {})
        } finally { hold.release() }
        if (claim && result.id) return { ...result, ledgerItem: await this.ports.ledger!.started(claim, result.id) }
        return result
      } finally { if (claim) this.ports.ledger!.release(claim) }
    })
  }
  async #create(params: Omit<HostParams<'lead/chat/start'>, 'effectId'>, call: { readonly method: 'lead/chat/start'; readonly params: Omit<HostParams<'lead/chat/start'>, 'effectId'> },
    text: string, agent: string | undefined, paced: { readonly agent: string; readonly label: string } | null, admit: (id?: string) => Promise<void>, effectStarted: () => void, attemptId: string): Promise<HostResult<'lead/chat/start'>> {
    {
      const envelope = this.#envelope(text)
      await this.ports.control?.assertCanStart?.(this.ports.project.path)
      let createdId: string | undefined, moveClaimed = false, creationStarted = false, firstMessageStarted = false
      const scope = this.#liveScope(call, attemptId, () => createdId)
      try {
        // A chat the Lead starts never inherits a permission the person picked for their own chats (Bypass and the like).
        const begin = (chosen: string | undefined) => this.ports.work.startInProject({ text, cautious: true, ...(chosen ? { agent: chosen } : {}) }, this.ports.project.path, async id => {
          createdId = id
          await admit(id)
          if (params.moveFrom) {
            await this.#target(params.moveFrom, false); await this.#notHeld(params.moveFrom)
            if (!this.incidents?.hasPersonAnswer(params.moveFrom)) refuse('Wait for the person’s answer before moving this chat.')
            if (this.incidents?.get(params.moveFrom)?.state !== (moveClaimed ? 'moved' : 'asked')) refuse('That incident was already moved or stopped.')
          }
          if (!id && agent && params.agent !== undefined && !(await this.ports.recovery!.candidates(params.moveFrom)).some(one => (one.agent ?? one.key) === agent)) refuse('That agent is no longer available.')
          if (params.moveFrom && !moveClaimed) { await this.incidents!.claimMove(params.moveFrom); moveClaimed = true }
          // Recorded before the first message leaves, so the transcript can vouch for it on first render.
          if (id) { await this.#watch(id); await this.#record(id, envelope); await admit(id); await this.#notHeld(id) }
        }, () => { creationStarted = true; effectStarted() }, scope, [deskContextContent(envelope)], () => { firstMessageStarted = true })
        let result = await begin(agent)
        // A paced pick is only a preference: one that vanished before anything was created gives way to the desk default.
        let usedPaced = paced !== null
        if (paced && !result.id && result.problem && !createdId && !creationStarted) { result = await begin(undefined); usedPaced = false }
        if (params.moveFrom && result.problem && !firstMessageStarted) {
          if (moveClaimed) await this.incidents!.releaseMove(params.moveFrom)
          return { id: '', problem: `The move did not start.${result.id ? ' An empty chat was kept on the desk.' : ''} The original chat is unchanged; ask the person before trying again.` }
        }
        if (params.moveFrom && result.id) {
          // Creation is already an effect: always hand its identity back, even if persistence is temporarily unavailable.
          try { await this.incidents!.moved(params.moveFrom, result.id) }
          catch {
            this.ports.recovery?.problem?.('The moved chat was created, but its recovery receipt could not be saved.')
            try { await this.incidents!.moved(params.moveFrom, result.id) } catch { /* The durable move claim still prevents another creation. */ }
          }
        } else if (params.moveFrom && moveClaimed && !createdId) await this.incidents!.releaseMove(params.moveFrom)
        return paced && usedPaced && result.id && !result.problem ? { ...result, account: paced.label } : result
      } catch (error) {
        if (params.moveFrom && moveClaimed && !createdId && !creationStarted) await this.incidents!.releaseMove(params.moveFrom)
        throw error
      }
    }
  }
  /** The host stage the work ledger reads for a linked chat; null once the desk no longer holds it. */
  workState(id: string): LeadWorkLinkState | null {
    const at = id.indexOf(':')
    if (at <= 0) return null
    const runtime = runtimeId(id.slice(0, at)), session = sessionId(id.slice(at + 1))
    const summary = this.ports.index.get(runtime, session)
    if (!summary) return null
    if (this.incidents?.get(id)?.state === 'asked') return { stage: 'you-blocked', reason: 'failed' }
    const live = this.ports.live(runtime, session), recovering = this.incidents?.waiting(id) ?? false
    return leadStage({ kind: 'session', archived: summary.archived === true, waiting: live.approvalWaiting ?? live.waiting, running: recovering || live.running,
      failed: recovering ? false : live.failed ?? false, queuePaused: live.queuePaused ?? false, queued: live.queued ?? false, stopped: live.stopped ?? false })
  }
  send(input: HostParams<'lead/chat/send'>, currentRetry?: () => boolean, retryStarted?: () => void, retryBusy?: () => void): Promise<HostResult<'lead/chat/send'>> {
    const { effectId, cause = 'automatic', ...params } = input
    const call = { method: 'lead/chat/send', params } as const
    const envelope = this.#envelope(params.text)
    return this.#mutate(call, effectId, async (admit, effectStarted, attemptId) => {
      // Work the Lead sends on its own stops with the goal's time; a message the person caused is always delivered.
      if (cause === 'automatic' && await this.ports.deadlinePassed?.()) {
        this.ports.noteDispatchNotStarted(attemptId)
        throw Object.assign(new Error('The time for this goal has run out.'), { wireCode: 'leadDeadline' })
      }
      // A message into a chat is work too: while the Lead's question is open, nothing it decides is sent, whatever woke the
      // turn. The presence store has already freed the question if the person said anything new since.
      const open = params.retryAt === undefined ? this.ports.unansweredAsk?.() ?? null : null
      if (open) {
        this.ports.noteDispatchNotStarted(attemptId)
        throw Object.assign(new Error(`Your question ${quoteLeadWorkText(open.question, 200)} is still open. Send nothing it decides; point the person to it.`), { wireCode: 'leadAskOpen' })
      }
      if (params.retryAt === 'reset') {
        await admit(); await this.#notHeld(params.id)
        if (!this.incidents) refuse('Chat recovery is unavailable.')
        if (!await this.incidents!.beginRetry(params.id, true)) refuse('A reset retry needs the person’s answer first.')
        effectStarted(); return { queued: true }
      }
      let beganRetry = false, started = false, dispatched = false
      let unconfirmed: (() => Promise<void>) | undefined
      const renewal: { lease: Awaited<ReturnType<LeadChatIncidents['beginRetry']>> } = { lease: null }
      const settle = async () => {
        if (dispatched) return
        if (renewal.lease) { if (started) await renewal.lease.stop(); else await renewal.lease.rollback() }
        else if (currentRetry && started && currentRetry()) await this.incidents?.stop(params.id)
      }
      const discard = () => { void settle().catch(() => this.ports.recovery?.problem?.('The dropped chat retry could not be settled.')) }
      if (currentRetry && !currentRetry()) refuse('That recovery retry was cancelled.')
      if (currentRetry && this.ports.recovery?.busy?.(params.id)) { retryBusy?.(); throw new LeadChatBusyError() }
      const admission = this.#liveScope(call, attemptId, () => params.id, currentRetry)
      const scope: DispatchAdmission<string> = Object.assign(async (cwd: string) => {
        try { await admission(cwd) } catch (error) { await settle(); throw error }
      }, {
        assertDispatch: () => { try { admission.assertDispatch?.() } catch (error) { discard(); throw error } },
        dispatchStarted: () => {
          dispatched = true
          if (renewal.lease || currentRetry) unconfirmed = this.incidents?.unconfirmedReceipt(params.id, currentRetry, !!renewal.lease)
        },
        dispatchUnconfirmed: () => unconfirmed?.() ?? Promise.resolve(),
        queueRemoved: discard,
        dispatchRefused: discard,
      })
      try {
        return await this.ports.work.sessionSend(params, async () => {
          await admit(); await this.#notHeld(params.id); await this.#watch(params.id); await this.#record(params.id, envelope); await admit(); await this.#notHeld(params.id)
          if (currentRetry && !currentRetry()) refuse('That recovery retry was cancelled.')
          if (currentRetry && this.ports.recovery?.busy?.(params.id)) { retryBusy?.(); throw new LeadChatBusyError() }
          if (!currentRetry && !beganRetry) { renewal.lease = await this.incidents?.beginRetry(params.id) ?? null; beganRetry = true }
        }, () => { started = true; effectStarted(); retryStarted?.() }, scope, [deskContextContent(envelope)])
      } catch (error) { await settle(); throw error }
    })
  }
  stop(input: HostParams<'lead/chat/stop'>): Promise<HostResult<'lead/chat/stop'>> {
    const { effectId, ...params } = input
    const call = { method: 'lead/chat/stop', params } as const
    return this.#mutate(call, effectId, async (admit, effectStarted, attemptId) => {
      // Stop may return early for an idle chat, before PhoneWork calls admission.
      await this.#notHeld(params.id)
      await this.incidents?.stop(params.id)
      // Marked once the stop is admitted and before it lands, so the ledger never reads the Lead's own stop as the
      // person's, and a refused stop marks nothing.
      return this.ports.work.stop(params, async () => { await admit(); await this.#notHeld(params.id); await this.ports.ledger?.leadStopped?.(params.id).catch(() => {}) },
        effectStarted, this.#liveScope(call, attemptId, () => params.id))
    })
  }

  #liveScope(call: LeadPermissionCall, attemptId: string, target: () => string | undefined, currentRetry?: () => boolean): DispatchAdmission<string> {
    const selected = { ...this.ports.project }
    const requestGoal = this.ports.state().budget?.logicalGoalId ?? null
    const generation = this.#effectGeneration
    const assertCurrentRequest = () => {
      if (call.method !== 'lead/chat/stop' && (this.ports.state().budget?.logicalGoalId ?? null) !== requestGoal)
        refuse('The Lead request changed. Cancel this queued reply and send a new message.')
      if (generation !== this.#effectGeneration) refuse('Lead chat effects were stopped.')
    }
    // An accepted queue item outlives its journal attempt. Keep its pinned
    // scope and current policy checks, without requiring an unfinished attempt.
    return Object.assign(async (cwd: string) => {
      assertCurrentRequest()
      if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
      const id = target()
      if (!id) refuse('The chat identity is unavailable.')
      if (currentRetry && !currentRetry()) refuse('That recovery retry was cancelled.')
      await this.#target(id!, false)
      try { if (await realpath(cwd) !== selected.path) refuse('That session is outside the Lead project scope.') }
      catch { refuse('That session is outside the Lead project scope.') }
      await this.#target(id!, false)
      if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
      // Queue drains run independently of the mutation tail. Healthy concurrent
      // dispatch is not recovery; every unresolved effect and live policy fence is.
      await this.#gate(call, attemptId, true)
      await this.#notHeld(id!)
      const source = (call.params as { moveFrom?: string }).moveFrom
      if (source) { await this.#target(source, false); await this.#notHeld(source); if (!this.incidents?.hasPersonAnswer(source)) refuse('Wait for the person’s answer before moving this chat.') }
      assertCurrentRequest()
    }, { assertDispatch: () => {
      assertCurrentRequest()
      if (currentRetry && !currentRetry()) refuse('That recovery retry was cancelled.')
      if (this.ports.project.path !== selected.path || this.ports.project.id !== selected.id) refuse('Lead project scope changed.')
      const id = target()
      if (!id) refuse('The chat identity is unavailable.')
      this.ports.control?.assertDispatch?.(selected.path, id!)
      const source = (call.params as { moveFrom?: string }).moveFrom
      if (source) this.ports.control?.assertDispatch?.(selected.path, source)
      if (call.method !== 'lead/chat/stop' && (this.ports.managementAvailable?.() === false || ['stopped', 'accepted', 'declined'].includes(this.ports.state().phase) || (this.ports.state().budget?.logicalGoalId ?? null) !== requestGoal)) refuse('Lead management stopped or changed before dispatch.')
    } })
  }
}
