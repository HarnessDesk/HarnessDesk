import {
  CLIENT_METHODS, CLIENT_PROTOCOL, sessionKey,
  type ClientMethodName, type ClientTier, type FindingRunView, type FlowExecution, type GoalActivity,
  type HostParams, type HostResult, type HostToClient, type Intent, type TeamState,
  type SeatActivity, type FindingRoundPublication, type Approval, type GoalView, type RuntimeId, type SessionId, type WireNotification, type WireRequest,
} from '@harnessdesk/protocol'

import type { ClientSnapshot, ClientWaitingItem } from './views/snapshot.js'
export type { ClientSnapshot } from './views/snapshot.js'

/** Transport adapters exchange parsed wire envelopes; listeners return a detach function. */
export interface ClientTransport {
  send(message: WireRequest): void
  onMessage(listener: (message: HostToClient) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}
export class WireCallError extends Error {
  override readonly name = 'WireCallError'
  constructor(readonly code: string, message: string, readonly details: string | null = null, readonly data?: unknown) { super(message) }
}
type EventBase = { readonly v: 1; readonly at: string }
type WaitingItem = ClientWaitingItem
/** Stable version-1 observation vocabulary. Unknown future event types may be ignored. */
export type ClientEvent = EventBase & (
  | { readonly type: 'hello'; readonly desk: HostResult<'client/hello'>['desk']; readonly hostVersion: string; readonly protocolVersion: number; readonly tiers: readonly ClientTier[] }
  | { readonly type: 'run.changed'; readonly run: string; readonly team: string; readonly flow: string; readonly state: FlowExecution['state']; readonly round: number | null; readonly reason: string | null; readonly revision?: string; readonly continues?: string }
  | { readonly type: 'card.changed'; readonly team: string; readonly card: number; readonly role: string | null; readonly state: Intent['state']; readonly outcome: string | null; readonly title: string; readonly seat?: string; readonly since?: number }
  | { readonly type: 'seat.changed'; readonly team: string; readonly seat: string; readonly role: string | null; readonly card: number | null; readonly state: SeatActivity['state']; readonly doing: SeatActivity['doing']; readonly since?: number }
  | ({ readonly type: 'review.changed'; readonly team: string; readonly run: string } & FindingRoundPublication)
  | { readonly type: 'team.changed'; readonly team: string; readonly activity: GoalActivity | null; readonly sentence: string }
  | ({ readonly type: 'waiting' | 'waiting.cleared' } & WaitingItem)
  | { readonly type: 'notice'; readonly team: string | null; readonly text: string }
  | { readonly type: 'gap'; readonly reason: string }
  | { readonly type: 'end'; readonly reason: 'interrupted' | 'until' | 'desk-closed' | 'error' }
)
export interface Client {
  /** Updated to the latest successful handshake after reconnecting. */
  readonly hello: HostResult<'client/hello'>
  call<M extends ClientMethodName>(method: M, params: HostParams<M>, options?: { deadlineMs?: number }): Promise<HostResult<M>>
  /** Unstable raw wire notifications, buffered in arrival order. */
  notifications(): AsyncIterable<WireNotification>
  /** Buffered observation stream; consume once. It never delays calls or raw notifications. */
  events(): AsyncIterable<ClientEvent>
  /** Wait for the current baseline and its review reads; repeat after a gap. */
  synced(): Promise<void>
  /** Detached plain-data copy of the held subscription state. */
  snapshot(): ClientSnapshot
  close(): void
}
export interface ConnectOptions {
  readonly transport: () => Promise<ClientTransport>
  readonly client: HostParams<'client/hello'>['client']
  readonly subscribe?: HostParams<'client/subscribe'>
}

/** Unbounded ordered queues deliberately isolate transport progress from consumers. */
class Queue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private readers: { resolve(value: IteratorResult<T>): void; reject(error: WireCallError): void }[] = []
  private failure: WireCallError | undefined
  private ended = false
  push(value: T) {
    if (this.ended) return
    const reader = this.readers.shift()
    if (reader) reader.resolve({ done: false, value })
    else this.values.push(value)
  }
  end(error?: WireCallError) {
    this.ended = true
    this.failure = error
    for (const reader of this.readers.splice(0)) {
      if (error) reader.reject(error)
      else reader.resolve({ done: true, value: undefined })
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! })
      if (this.ended) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve, reject) => this.readers.push({ resolve, reject }))
    } }
  }
}

/** `approval:<runtime>:<session>:<approval id>`, each part percent-encoded: ids are opaque and may hold `:`, and two approvals must never share one. */
const approvalWaitingId = (runtime: string, session: string, approval: string): string =>
  `approval:${[runtime, session, approval].map(encodeURIComponent).join(':')}`

type EventBody = ClientEvent extends infer E ? E extends EventBase ? Omit<E, keyof EventBase> : never : never
class Observation {
  private teams = new Map<string, GoalView>()
  private seats = new Map<string, SeatActivity>()
  private approvals = new Map<string, { runtime: RuntimeId; sessionId: SessionId; approval: Approval }>()
  private reviews = new Map<string, FindingRoundPublication[]>()
  private runs = new Map<string, FlowExecution>()
  private boards = new Map<string, TeamState>()
  private runValues = new Map<string, string>()
  private cardValues = new Map<string, string>()
  private teamValues = new Map<string, string>()
  private seatValues = new Map<string, string>()
  private reviewValues = new Map<string, string>()
  private waiting = new Map<string, WaitingItem>()
  constructor(private topics: ReadonlySet<string>, private readonly emit: (event: EventBody) => void) {}
  subscribe(subscription: HostParams<'client/subscribe'> | undefined) { this.topics = new Set(subscription?.topics ?? []) }
  reset() {
    this.teams.clear(); this.seats.clear(); this.approvals.clear(); this.reviews.clear()
    this.runs.clear(); this.boards.clear(); this.runValues.clear(); this.cardValues.clear(); this.teamValues.clear(); this.seatValues.clear(); this.reviewValues.clear(); this.waiting.clear()
  }
  snapshot(): ClientSnapshot {
    return structuredClone({
      teams: [...this.teams.values()].map(view => ({ ...view, board: this.boards.get(view.board.id) ?? view.board })),
      runs: [...this.runs.values()], boards: [...this.boards.values()], seats: [...this.seats.values()],
      waiting: [...this.waiting.values()], approvals: [...this.approvals.values()], reviews: [...this.reviews].map(([run, rounds]) => ({ run, rounds })),
    })
  }
  private changed(cache: Map<string, string>, id: string, value: unknown): boolean {
    const key = JSON.stringify(value)
    if (cache.get(id) === key) return false
    cache.set(id, key)
    return true
  }
  private teamOf(runtime: string, session: string): string | null {
    for (const board of this.boards.values()) if (board.members.includes(sessionKey(runtime, session))) return board.id
    return null
  }
  private setWaiting(item: WaitingItem) {
    if (!this.topics.has('waiting')) return
    if (JSON.stringify(this.waiting.get(item.id)) === JSON.stringify(item)) return
    this.waiting.set(item.id, item)
    this.emit({ type: 'waiting', ...item })
  }
  private clearWaiting(id: string) {
    const item = this.waiting.get(id)
    if (!item) return
    this.waiting.delete(id)
    this.emit({ type: 'waiting.cleared', ...item })
  }
  private personWaiting() {
    if (!this.topics.has('waiting')) return
    const live = new Set<string>()
    for (const board of this.boards.values()) for (const card of board.intents) {
      if (!card.role || card.state === 'done' || card.state === 'abandoned') continue
      const addressed = [...this.runs.values()].some(run => run.goal === board.id && run.state === 'running' &&
        run.document.flow.roles.some(role => role.id === card.role && role.kind === 'person') &&
        run.rounds.some(round => round.role === card.role && round.state !== 'closed' && round.cards.includes(card.id)))
      if (!addressed) continue
      const id = `card:${board.id}:${card.id}`
      live.add(id)
      this.setWaiting({ id, team: board.id, kind: 'card', card: card.id, summary: card.title })
    }
    for (const item of this.waiting.values()) if (item.kind === 'card' && !live.has(item.id)) this.clearWaiting(item.id)
  }
  review(view: FindingRunView) {
    if (!this.topics.has('reviews')) return
    this.reviews.set(view.run, [...view.rounds])
    for (const round of view.rounds) {
      if (this.changed(this.reviewValues, JSON.stringify([view.run, round.round]), [round.state, round.reason, round.pr, round.cards])) {
        this.emit({ type: 'review.changed', team: view.goal, run: view.run, ...round })
      }
    }
  }
  accept(notification: WireNotification) {
    switch (notification.method) {
      case 'flow/execution-changed': {
        const run = notification.params.execution
        this.runs.set(run.id, run)
        const round = run.rounds.at(-1)?.n ?? null
        if (this.topics.has('runs') && this.changed(this.runValues, run.id, [run.state, round, run.reason, run.revision ?? null, run.continues ?? null])) {
          this.emit({ type: 'run.changed', run: run.id, team: run.goal, flow: run.document.flow.name, state: run.state, round, reason: run.reason,
            ...(run.revision != null ? { revision: run.revision } : {}), ...(run.continues != null ? { continues: run.continues } : {}) })
        }
        this.personWaiting()
        break
      }
      case 'team/changed': {
        const board = notification.params.state
        this.boards.set(board.id, board)
        if (this.topics.has('cards')) for (const card of board.intents) {
          const seat = card.claim ? `${card.claim.runtime}:${card.claim.sessionId}` : undefined
          const since = card.state === 'claimed' ? card.claim?.at : undefined
          if (this.changed(this.cardValues, `${board.id}:${card.id}`, [card.state, card.outcome ?? null, seat, since])) {
            this.emit({ type: 'card.changed', team: board.id, card: card.id, role: card.role ?? null, state: card.state,
              outcome: card.outcome ?? null, title: card.title,
              ...(seat !== undefined ? { seat } : {}), ...(since !== undefined ? { since } : {}) })
          }
        }
        this.personWaiting()
        break
      }
      case 'seat/activity': {
        this.seats.set(JSON.stringify([notification.params.goal, notification.params.seat]), notification.params)
        const { goal, seat, role, card, state, doing, since } = notification.params
        if (this.topics.has('seats') && this.changed(this.seatValues, JSON.stringify([goal, seat]), [state, doing, card, role])) {
          this.emit({ type: 'seat.changed', team: goal, seat, role, card, state, doing, ...(since !== undefined ? { since } : {}) })
        }
        break
      }
      case 'goal/changed': {
        this.teams.set(notification.params.view.goal.id, notification.params.view)
        const { goal, activity, board } = notification.params.view
        this.boards.set(board.id, board)
        if (this.topics.has('teams') && this.changed(this.teamValues, goal.id, [activity, goal.sentence])) {
          this.emit({ type: 'team.changed', team: goal.id, activity, sentence: goal.sentence })
        }
        this.personWaiting()
        break
      }
      case 'goal/activity': {
        const { goal, activity, sentence } = notification.params
        const view = this.teams.get(goal)
        if (view) this.teams.set(goal, { ...view, activity, goal: { ...view.goal, sentence } })
        if (this.topics.has('teams') && this.changed(this.teamValues, goal, [activity, sentence])) this.emit({ type: 'team.changed', team: goal, activity, sentence })
        break
      }
      case 'event': {
        const { runtime, event } = notification.params
        if (event.type === 'approval/requested') {
          const item = event.approval
          const id = approvalWaitingId(runtime, item.sessionId, item.id)
          this.approvals.set(id, { runtime, sessionId: item.sessionId, approval: item })
          const summary = item.type === 'permission' ? item.summary : item.type === 'userInput' ? item.questions.map(q => q.question).join('\n') :
            item.type === 'elicitation' ? item.message : item.type === 'command' ? item.command : item.reason ?? 'File changes'
          this.setWaiting({ id, team: this.teamOf(runtime, item.sessionId),
            kind: item.type === 'userInput' || item.type === 'elicitation' ? 'question' : 'approval', seat: `${runtime}:${item.sessionId}`, summary })
        } else if (event.type === 'approval/resolved') {
          const id = approvalWaitingId(runtime, event.sessionId, event.approvalId)
          this.approvals.delete(id)
          this.clearWaiting(id)
        }
        break
      }
      case 'person/notice': {
        if (!this.topics.has('notices')) break
        const notice = notification.params.notice
        this.emit({ type: 'notice', team: this.teamOf(notice.from.runtime, notice.from.sessionId), text: [notice.title, notice.body].filter(Boolean).join('\n') })
        break
      }
    }
  }
}

export async function connect(options: ConnectOptions): Promise<Client> {
  const events = new Queue<ClientEvent>(), notifications = new Queue<WireNotification>()
  const emit = (event: EventBody) => events.push({ v: 1, at: new Date().toISOString(), ...event } as ClientEvent)
  const observation = new Observation(new Set(), emit)
  // Proposals never become observation/reconnect state until their wire acknowledgement.
  let acknowledgedSubscription: HostParams<'client/subscribe'> | undefined
  let transport: ClientTransport | null = null
  let hello: HostResult<'client/hello'>
  let nextId = 1, generation = 0
  let baselineRemaining: number | null = null, subscriptionSetup = true, synchronized = false
  let reviewPending = 0
  let streamError: WireCallError | undefined
  const syncWaiters = new Set<{ resolve(): void; reject(error: WireCallError): void }>()
  const settleSync = (error?: WireCallError) => {
    for (const waiter of syncWaiters) { if (error) waiter.reject(error); else waiter.resolve() }
    syncWaiters.clear()
  }
  const synced = (): Promise<void> => {
    if (ended) return streamError ? Promise.reject(streamError) : Promise.resolve()
    if (synchronized) return Promise.resolve()
    return new Promise((resolve, reject) => syncWaiters.add({ resolve, reject }))
  }
  const checkSync = () => {
    if (ended || !ready || subscriptionSetup || baselineRemaining !== 0) return
    if (!reviewReady) startReviews()
    if (reviewPending !== 0) return
    synchronized = true
    settleSync()
  }
  // Only bootstrap passes delay synchronization; later live refreshes keep streaming.
  // A superseded pass cannot delay or complete the current subscription.
  const beginSyncReview = () => {
    const epoch = reviewEpoch
    let completed = false
    reviewPending++
    return () => {
      if (completed || epoch !== reviewEpoch) return
      completed = true
      reviewPending--
      checkSync()
    }
  }
  const trackReview = (work: () => Promise<void>) => {
    const complete = beginSyncReview()
    void work().finally(complete)
  }
  let ended = false, ready = false, reconnecting = false, readyToReconnect = false
  let detach: (() => void)[] = []
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let wakeRetry: (() => void) | undefined
  const pending = new Map<number, {
    resolve(value: unknown): void
    reject(error: WireCallError): void
    timer: ReturnType<typeof setTimeout>
    acknowledged?: (value: unknown) => void
  }>()
  const failCalls = () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new WireCallError('disconnected', 'The desk connection was lost.')) }
    pending.clear()
  }
  const drop = () => {
    synchronized = false; baselineRemaining = null; subscriptionSetup = true
    invalidateReviews()
    ready = false
    transport = null
    for (const off of detach.splice(0)) off()
    failCalls()
  }
  const finish = (reason: 'interrupted' | 'desk-closed' | 'error', error?: WireCallError) => {
    if (ended) return
    ended = true
    streamError = error
    settleSync(error)
    const current = transport
    drop()
    clearTimeout(retryTimer); wakeRetry?.()
    emit({ type: 'end', reason }); events.end(error); notifications.end(error)
    current?.close()
  }
  const lose = (current: ClientTransport) => {
    if (ended || transport !== current) return
    drop()
    current.close()
    if (readyToReconnect && !reconnecting) void reconnect()
  }
  const deadlineError = (method: ClientMethodName) => new WireCallError('deadline', `The desk did not answer ${method} before its deadline.`)
  const request = <M extends ClientMethodName>(method: M, params: HostParams<M>, deadlineAt = Date.now() + 30_000,
    hooks: { acknowledged?: (value: unknown) => void; uncertain?: () => void } = {}): Promise<HostResult<M>> => {
    const current = transport
    if (!current || ended) return Promise.reject(new WireCallError('disconnected', 'The desk is disconnected.'))
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return Promise.reject(deadlineError(method))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(deadlineError(method))
        hooks.uncertain?.()
      }, remaining)
      pending.set(id, { resolve: value => resolve(value as HostResult<M>), reject, timer, acknowledged: hooks.acknowledged })
      try { current.send({ id, method, params }) }
      catch (error) {
        clearTimeout(timer); pending.delete(id)
        reject(error instanceof WireCallError ? error : new WireCallError('disconnected', error instanceof Error ? error.message : String(error)))
        hooks.uncertain?.()
      }
    })
  }
  const refusal = (method: ClientMethodName): WireCallError | undefined => {
    // Runtime checking complements the exported allowlist type for JavaScript callers.
    if (!Object.hasOwn(CLIENT_METHODS, method)) return new WireCallError('notOnClientSurface', `The client surface does not include ${method}.`)
    if (!ready || ended) return new WireCallError('disconnected', 'The desk is disconnected.')
    if (!hello.methods.includes(method)) return new WireCallError('deskTooOld', `This desk does not offer ${method}; update the desk.`)
    return undefined
  }
  // Review reads share the acknowledged projection, never a proposed selection.
  let reviewEpoch = 0, reviewReady = false
  const knownRuns = new Map<string, string>()
  const reviewTeams = new Map<string, { running: boolean; queued: boolean; discover: boolean; sync: (() => void)[] }>()
  const invalidatedTeams = new Set<string>()
  const invalidateReviews = () => {
    reviewEpoch++; reviewReady = false; reviewPending = 0
    knownRuns.clear(); reviewTeams.clear(); invalidatedTeams.clear()
  }
  const reviewsSelected = () => acknowledgedSubscription?.topics.includes('reviews') === true
  const reviewGuard = () => {
    const epoch = reviewEpoch, mine = generation, current = transport
    return () => !ended && ready && reviewEpoch === epoch && generation === mine && transport === current && reviewsSelected()
  }
  const reviewNotice = (team: string | null, error: unknown) => emit({ type: 'notice', team, text: error instanceof Error ? error.message : String(error) })
  const reviewCall = <M extends ClientMethodName>(method: M, params: HostParams<M>) => {
    const refused = refusal(method)
    return refused ? Promise.reject(refused) : request(method, params)
  }
  const refreshTeam = (team: string, discover: boolean, synchronize = false) => {
    if (!reviewsSelected()) return
    if (!reviewReady) { invalidatedTeams.add(team); return }
    const scope = acknowledgedSubscription?.scope
    if (scope?.team !== undefined && scope.team !== team) return
    const runTeam = scope?.run !== undefined ? knownRuns.get(scope.run) : undefined
    if (runTeam !== undefined && runTeam !== team) return
    let work = reviewTeams.get(team)
    if (!work) { work = { running: false, queued: false, discover: false, sync: [] }; reviewTeams.set(team, work) }
    if (synchronize) work.sync.push(beginSyncReview())
    work.queued = true; work.discover ||= discover
    if (work.running) return
    work.running = true
    const active = reviewGuard(), batch = work
    void (async () => {
      try {
        while (active() && batch.queued) {
          const synchronizing = batch.sync.splice(0)
          try {
            const discover = batch.discover
            batch.queued = false; batch.discover = false
            if (discover && scope?.run && !knownRuns.has(scope.run)) {
              try {
                const execution = await reviewCall('flow/execution', { run: scope.run })
                if (!active()) return
                if (execution.id === scope.run && execution.goal === team) {
                  knownRuns.set(execution.id, team)
                  observation.accept({ method: 'flow/execution-changed', params: { execution } })
                }
              } catch (error) { if (active()) reviewNotice(team, error) }
            }
            if (discover && !scope?.run) {
              try {
                const runs = await reviewCall('flow/executions', { team, ...(scope?.project ? { project: scope.project } : {}), active: false })
                if (!active()) return
                for (const run of runs) if (run.team === team) knownRuns.set(run.id, team)
              } catch (error) { if (active()) reviewNotice(team, error) }
            }
            for (const [run, goal] of knownRuns) {
              if (!active()) return
              if (goal !== team || scope?.run !== undefined && scope.run !== run) continue
              try {
                const view = await reviewCall('finding/run', { goal, run })
                if (!active()) return
                observation.review(view)
              } catch (error) { if (active()) reviewNotice(team, error) }
            }
          } finally { for (const complete of synchronizing) complete() }
        }
      } finally {
        batch.running = false
        for (const complete of batch.sync.splice(0)) complete()
      }
    })()
  }
  const accept = (notification: WireNotification) => {
    observation.accept(notification)
    if (notification.method === 'flow/execution-changed') {
      const run = notification.params.execution, fresh = !knownRuns.has(run.id)
      knownRuns.set(run.id, run.goal)
      if (fresh) refreshTeam(run.goal, false)
    } else if (notification.method === 'finding/changed') refreshTeam(notification.params.goal, true)
  }
  const startReviews = () => {
    reviewReady = true
    if (!reviewsSelected()) return
    const teams = new Set(knownRuns.values())
    for (const team of invalidatedTeams) teams.add(team)
    for (const team of teams) refreshTeam(team, invalidatedTeams.has(team), true)
    invalidatedTeams.clear()
    const scope = acknowledgedSubscription?.scope
    if (scope?.run) return // Its exact execution was read with the caller's deadline.
    const active = reviewGuard()
    trackReview(async () => {
      try {
        const runs = await reviewCall('flow/executions', { ...(scope?.team ? { team: scope.team } : {}), ...(scope?.project ? { project: scope.project } : {}), active: false })
        if (!active()) return
        const added = new Set<string>()
        for (const run of runs) {
          if (knownRuns.has(run.id)) continue
          knownRuns.set(run.id, run.team); added.add(run.team)
        }
        for (const team of added) refreshTeam(team, false, true)
      } catch (error) { if (active()) reviewNotice(scope?.team ?? null, error) }
    })
  }
  const subscribe = async (params: HostParams<'client/subscribe'>, deadlineAt: number, boundary: string | null) => {
    const refused = refusal('client/subscribe')
    if (refused) throw refused
    const next = { topics: [...params.topics], ...(params.scope ? { scope: { ...params.scope } } : {}) }
    const current = transport!, mine = generation
    const result = await request('client/subscribe', next, deadlineAt, {
      acknowledged: value => {
        const count = (value as { baseline?: unknown } | null)?.baseline
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          throw new WireCallError('deskTooOld', 'This desk does not report subscription baseline counts; update the desk.')
        }
        synchronized = false; baselineRemaining = count; subscriptionSetup = true
        acknowledgedSubscription = next
        invalidateReviews()
        observation.reset()
        observation.subscribe(next)
        if (boundary) emit({ type: 'gap', reason: boundary })
      },
      // A late ACK could otherwise relabel new-scope notifications with the old scope.
      uncertain: () => lose(current),
    })
    try {
      if (next.scope?.run) {
        const readRefused = refusal('flow/execution')
        if (readRefused) throw readRefused
        const execution = await request('flow/execution', { run: next.scope.run }, deadlineAt)
        // A concurrent newer ACK or reconnect has already replaced this projection.
        if (acknowledgedSubscription === next && transport === current && generation === mine) {
          accept({ method: 'flow/execution-changed', params: { execution } })
        }
      }
    } finally {
      if (acknowledgedSubscription === next && transport === current && generation === mine && !ended) { subscriptionSetup = false; checkSync() }
    }
    return result
  }
  const call: Client['call'] = async (method, params, settings) => {
    const deadlineAt = Date.now() + (settings?.deadlineMs ?? 30_000)
    const refused = refusal(method)
    if (refused) throw refused
    if (method !== 'client/subscribe') return request(method, params, deadlineAt)
    return await subscribe(params as HostParams<'client/subscribe'>, deadlineAt, 'subscription-changed') as HostResult<typeof method>
  }
  const open = async (reconnected: boolean) => {
    const current = await options.transport()
    if (ended) { current.close(); return }
    const mine = ++generation
    transport = current
    detach = [current.onMessage(message => {
      if (ended || generation !== mine || transport !== current) return
      if ('method' in message) {
        notifications.push(message)
        if (message.method === 'host/shutdown') { finish('desk-closed'); return }
        accept(message)
        if (baselineRemaining !== null && baselineRemaining > 0) baselineRemaining--
        checkSync()
      } else {
        const call = pending.get(message.id)
        if (!call) return
        clearTimeout(call.timer); pending.delete(message.id)
        if (message.ok) {
          // The door sends its baseline immediately after its response, not after our await.
          try { call.acknowledged?.(message.result) }
          catch (error) {
            const failure = error instanceof WireCallError ? error : new WireCallError('badRequest', String(error))
            call.reject(failure); finish('error', failure); return
          }
          call.resolve(message.result)
        } else call.reject(new WireCallError(message.error.code, message.error.message, message.error.details ?? null, message.error.data))
      }
    }), current.onClose(() => {
      if (ended || transport !== current) return
      drop()
      if (readyToReconnect && !reconnecting) void reconnect()
    })]
    try {
      hello = await request('client/hello', { client: options.client, protocol: CLIENT_PROTOCOL })
      if (hello.protocolVersion !== CLIENT_PROTOCOL) throw new WireCallError('incompatible', 'The client and desk speak different protocol versions.')
      ready = true
      readyToReconnect = true
      if (!reconnected) emit({ type: 'hello', desk: hello.desk, hostVersion: hello.hostVersion, protocolVersion: hello.protocolVersion, tiers: hello.tiers })
      const selection = reconnected ? acknowledgedSubscription : options.subscribe
      if (selection) await subscribe(selection, Date.now() + 30_000, reconnected ? 'disconnected' : null)
      else {
        if (reconnected) { observation.reset(); emit({ type: 'gap', reason: 'disconnected' }) }
        baselineRemaining = 0; subscriptionSetup = false; checkSync()
      }
    } catch (error) {
      if (transport === current) { drop(); current.close() }
      throw error
    }
  }
  const reconnect = async () => {
    reconnecting = true
    let delay = 50
    while (!ended) {
      await new Promise<void>(resolve => { wakeRetry = resolve; retryTimer = setTimeout(resolve, delay) })
      wakeRetry = undefined
      if (ended) break
      try { await open(true); if (ready) break }
      catch (error) {
        // Retry connection loss/absence, not a desk's explicit protocol or permission refusal.
        if (error instanceof WireCallError && !['disconnected', 'deadline', 'noDesk'].includes(error.code)) { finish('error', error); break }
      }
      delay = Math.min(delay * 2, 1000)
    }
    reconnecting = false
  }
  try { await open(false) }
  catch (error) { finish('interrupted'); throw error }
  return { get hello() { return hello }, call, events: () => events, notifications: () => notifications, synced, snapshot: () => observation.snapshot(), close: () => finish('interrupted') }
}
