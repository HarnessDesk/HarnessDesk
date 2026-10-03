import {
  CLIENT_METHODS, CLIENT_PROTOCOL, sessionKey,
  type ClientMethodName, type ClientTier, type FlowExecution, type GoalActivity,
  type HostParams, type HostResult, type HostToClient, type Intent, type TeamState,
  type WireNotification, type WireRequest,
} from '@harnessdesk/protocol'

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
type WaitingItem = { readonly id: string; readonly team: string | null; readonly kind: 'card' | 'question' | 'approval'; readonly card?: number; readonly seat?: string; readonly summary: string }
/** Stable version-1 observation vocabulary. Unknown future event types may be ignored. */
export type ClientEvent = EventBase & (
  | { readonly type: 'hello'; readonly desk: HostResult<'client/hello'>['desk']; readonly hostVersion: string; readonly protocolVersion: number; readonly tiers: readonly ClientTier[] }
  | { readonly type: 'run.changed'; readonly run: string; readonly team: string; readonly flow: string; readonly state: FlowExecution['state']; readonly round: number | null; readonly reason: string | null }
  | { readonly type: 'card.changed'; readonly team: string; readonly card: number; readonly role: string | null; readonly state: Intent['state']; readonly outcome: string | null; readonly title: string; readonly seat?: string }
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

type EventBody = ClientEvent extends infer E ? E extends EventBase ? Omit<E, keyof EventBase> : never : never
class Observation {
  private runs = new Map<string, FlowExecution>()
  private boards = new Map<string, TeamState>()
  private runValues = new Map<string, string>()
  private cardValues = new Map<string, string>()
  private teamValues = new Map<string, string>()
  private waiting = new Map<string, WaitingItem>()
  constructor(private topics: ReadonlySet<string>, private readonly emit: (event: EventBody) => void) {}
  subscribe(subscription: HostParams<'client/subscribe'> | undefined) { this.topics = new Set(subscription?.topics ?? []) }
  reset() {
    this.runs.clear(); this.boards.clear(); this.runValues.clear(); this.cardValues.clear(); this.teamValues.clear(); this.waiting.clear()
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
  accept(notification: WireNotification) {
    switch (notification.method) {
      case 'flow/execution-changed': {
        const run = notification.params.execution
        this.runs.set(run.id, run)
        const round = run.rounds.at(-1)?.n ?? null
        if (this.topics.has('runs') && this.changed(this.runValues, run.id, [run.state, round, run.reason])) {
          this.emit({ type: 'run.changed', run: run.id, team: run.goal, flow: run.document.flow.name, state: run.state, round, reason: run.reason })
        }
        this.personWaiting()
        break
      }
      case 'team/changed': {
        const board = notification.params.state
        this.boards.set(board.id, board)
        if (this.topics.has('cards')) for (const card of board.intents) {
          if (this.changed(this.cardValues, `${board.id}:${card.id}`, [card.state, card.outcome ?? null])) {
            this.emit({ type: 'card.changed', team: board.id, card: card.id, role: card.role ?? null, state: card.state,
              outcome: card.outcome ?? null, title: card.title,
              ...(card.claim ? { seat: `${card.claim.runtime}:${card.claim.sessionId}` } : {}) })
          }
        }
        this.personWaiting()
        break
      }
      case 'goal/changed': {
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
        if (this.topics.has('teams') && this.changed(this.teamValues, goal, [activity, sentence])) this.emit({ type: 'team.changed', team: goal, activity, sentence })
        break
      }
      case 'event': {
        const { runtime, event } = notification.params
        if (event.type === 'approval/requested') {
          const item = event.approval
          const summary = item.type === 'permission' ? item.summary : item.type === 'userInput' ? item.questions.map(q => q.question).join('\n') :
            item.type === 'elicitation' ? item.message : item.type === 'command' ? item.command : item.reason ?? 'File changes'
          this.setWaiting({ id: `approval:${runtime}:${item.sessionId}:${item.id}`, team: this.teamOf(runtime, item.sessionId),
            kind: item.type === 'userInput' || item.type === 'elicitation' ? 'question' : 'approval', seat: `${runtime}:${item.sessionId}`, summary })
        } else if (event.type === 'approval/resolved') this.clearWaiting(`approval:${runtime}:${event.sessionId}:${event.approvalId}`)
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
  let ended = false, ready = false, reconnecting = false, readyToReconnect = false
  let detach: (() => void)[] = []
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let wakeRetry: (() => void) | undefined
  const pending = new Map<number, {
    resolve(value: unknown): void
    reject(error: WireCallError): void
    timer: ReturnType<typeof setTimeout>
    acknowledged?: () => void
  }>()
  const failCalls = () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new WireCallError('disconnected', 'The desk connection was lost.')) }
    pending.clear()
  }
  const drop = () => {
    ready = false
    transport = null
    for (const off of detach.splice(0)) off()
    failCalls()
  }
  const finish = (reason: 'interrupted' | 'desk-closed' | 'error', error?: WireCallError) => {
    if (ended) return
    ended = true
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
    hooks: { acknowledged?: () => void; uncertain?: () => void } = {}): Promise<HostResult<M>> => {
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
        reject(new WireCallError('disconnected', error instanceof Error ? error.message : String(error)))
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
  const subscribe = async (params: HostParams<'client/subscribe'>, deadlineAt: number, boundary: string | null) => {
    const refused = refusal('client/subscribe')
    if (refused) throw refused
    const next = { topics: [...params.topics], ...(params.scope ? { scope: { ...params.scope } } : {}) }
    const current = transport!, mine = generation
    const result = await request('client/subscribe', next, deadlineAt, {
      acknowledged: () => {
        acknowledgedSubscription = next
        observation.reset()
        observation.subscribe(next)
        if (boundary) emit({ type: 'gap', reason: boundary })
      },
      // A late ACK could otherwise relabel new-scope notifications with the old scope.
      uncertain: () => lose(current),
    })
    if (next.scope?.run) {
      const readRefused = refusal('flow/execution')
      if (readRefused) throw readRefused
      const execution = await request('flow/execution', { run: next.scope.run }, deadlineAt)
      // A concurrent newer ACK or reconnect has already replaced this projection.
      if (acknowledgedSubscription === next && transport === current && generation === mine) {
        observation.accept({ method: 'flow/execution-changed', params: { execution } })
      }
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
        observation.accept(message)
      } else {
        const call = pending.get(message.id)
        if (!call) return
        clearTimeout(call.timer); pending.delete(message.id)
        if (message.ok) {
          // The door sends its baseline immediately after its response, not after our await.
          call.acknowledged?.()
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
      else if (reconnected) { observation.reset(); emit({ type: 'gap', reason: 'disconnected' }) }
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
  return { get hello() { return hello }, call, events: () => events, notifications: () => notifications, close: () => finish('interrupted') }
}
