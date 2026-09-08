import {
  emptyQueue,
  mergeRead,
  reduceSession,
  sessionKey,
  type AgentEvent,
  type AgentSession,
  type Approval,
  type ApprovalId,
  type BackgroundTask,
  type QueuedMessage,
  type RuntimeId,
  type Session,
  type SessionId,
  type SessionKey,
  type SessionQueue,
  type Turn,
  type TurnId,
  type UserContent,
} from '@harnessdesk/protocol'

/**
 * Authoritative session state on the host side.
 *
 * The renderer is a projection, not the source of truth: it can reload, crash,
 * or open a second window mid-turn, and must be able to rejoin without asking
 * the runtime to replay anything. So the host folds the event stream itself and
 * hands a late joiner the current state plus any approvals still waiting.
 */

export interface SessionRecord {
  session: Session
  readonly runtime: RuntimeId
  /** Present only while the session is attached to a live runtime handle. */
  live: AgentSession | null
  /**
   * The handle was lost to the agent restarting under it, not to anybody
   * closing the conversation — so it can be remade on the next use, the way
   * `Host#liveFor` remakes it for the user's own message.
   *
   * The team plane needs the distinction. A room member whose agent was
   * restarted for a catalogue refresh is still in the room and still
   * answers; a conversation the user stopped is not. Both have `live` null,
   * and reading only `live` made every idle member of every room vanish the
   * first time the window came back into focus — the rail said "Nobody
   * here yet" beside a sidebar drawing three members, and a post to the room
   * was refused with "Nothing is live on this board".
   */
  detached: boolean
  /**
   * Reopen attempts on a detached record that failed for a reason that may
   * pass — the agent was up and answered with something other than "gone".
   * Reset whenever a handle attaches, and on the next restart: a fresh
   * process deserves fresh tries. The team plane lets a member go once these
   * stack up; see `Host#teamLive`.
   */
  reopenRefusals: number
  /** Approvals that have been asked and not yet answered. */
  approvals: Map<string, Approval>
  /**
   * Turns this host watched start. A turn in here is ours: the agent's own
   * store may not have caught up with it, but we saw every item of it, so a
   * read that omits it is behind rather than right. A rollback is the one
   * thing that takes a turn out again.
   */
  readonly watched: Set<TurnId>
  /** Of those, the ones still running here. Empty means nothing is working. */
  readonly running: Set<TurnId>
  /**
   * Messages the user wrote while a turn was running, still waiting.
   *
   * Beside the session rather than inside it, for the same reason approvals
   * are: an adapter re-emitting a whole `Session` — a resume, a re-read —
   * must not be able to erase what the user has queued.
   */
  queue: SessionQueue
  /**
   * What the runtime says this conversation has running in the background.
   *
   * Held here so a reloading client gets it back without asking, and beside
   * the session rather than inside it for the same reason the queue is: an
   * adapter re-emitting a whole `Session` must not be able to erase it. The
   * runtime remains the owner — this is the last thing it said, never a
   * second registry that could disagree with it.
   */
  tasks: readonly BackgroundTask[]
}

/**
 * Queue limits. Small enough that a runaway sender — a plugin, later an agent
 * (docs/multi-agent.md) — cannot fill memory or spend a fortune of turns, and
 * far larger than anything a person types by hand.
 */
export const QUEUE_LIMIT = 25
export const QUEUE_CHAR_LIMIT = 100_000

const charsOf = (input: readonly UserContent[]): number =>
  input.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0)

/**
 * Records are keyed by `(runtime, id)`. Session ids are the runtime's own and
 * two runtimes may issue the same one, so an id alone never identifies a
 * conversation here or anywhere above.
 */
export class SessionRegistry {
  readonly #records = new Map<SessionKey, SessionRecord>()

  /**
   * Folds a read of a session — from a runtime's store, or the summary a
   * `session/started` carries — into what is held here.
   *
   * The read never wins outright: our turns and their items survive it
   * (`mergeRead`), and a turn the read calls in progress that nothing here is
   * driving is presented as stopped. The agent's process is our child, so a
   * turn we did not start cannot be running: it belonged to a session that
   * died with the app, and saying "working" about it would be a spinner that
   * never resolves.
   */
  upsert(session: Session, live: AgentSession | null): SessionRecord {
    const existing = this.#records.get(sessionKey(session.runtime, session.id))
    if (existing) {
      existing.session = mergeRead(existing.session, this.#settle(existing, session), (turn) =>
        existing.watched.has(turn.id),
      )
      if (live) {
        existing.live = live
        existing.detached = false
        existing.reopenRefusals = 0
      }
      return existing
    }
    const record: SessionRecord = {
      session,
      runtime: session.runtime,
      live,
      detached: false,
      reopenRefusals: 0,
      approvals: new Map(),
      watched: new Set(),
      running: new Set(),
      queue: emptyQueue(),
      tasks: [],
    }
    record.session = this.#settle(record, session)
    this.#records.set(sessionKey(session.runtime, session.id), record)
    return record
  }

  /** Rewrites what a read claims is running to what is actually running here. */
  #settle(record: SessionRecord, session: Session): Session {
    const stale = session.turns.some(
      (turn) => turn.status === 'inProgress' && !record.running.has(turn.id),
    )
    const claimsActive = session.status.type === 'active' && record.running.size === 0
    if (!stale && !claimsActive) return session
    const turns = session.turns.map((turn): Turn =>
      turn.status === 'inProgress' && !record.running.has(turn.id)
        ? { ...turn, status: 'interrupted' }
        : turn,
    )
    return {
      ...session,
      ...(claimsActive ? { status: { type: 'idle' as const } } : {}),
      turns,
    }
  }

  /**
   * Forgets the last `turns` turns, because the conversation itself dropped
   * them. Without this a later read that no longer lists them would have them
   * grafted back on as turns "the store had not caught up with".
   */
  forgetTurns(runtime: RuntimeId, id: SessionId, turns: number): void {
    const record = this.get(runtime, id)
    if (!record) return
    for (const turn of record.session.turns.slice(-turns)) {
      record.watched.delete(turn.id)
      record.running.delete(turn.id)
    }
  }

  get(runtime: RuntimeId, id: SessionId): SessionRecord | undefined {
    return this.#records.get(sessionKey(runtime, id))
  }

  delete(runtime: RuntimeId, id: SessionId): void {
    this.#records.delete(sessionKey(runtime, id))
  }

  all(): SessionRecord[] {
    return [...this.#records.values()]
  }

  /** Sessions in the shape a newly connected client should receive. */
  snapshot(): Session[] {
    return this.all().map((record) => record.session)
  }

  pendingApprovals(): Approval[] {
    return this.all().flatMap((record) => [...record.approvals.values()])
  }

  /** Every conversation that has something waiting, for a client that just connected. */
  queues(): { runtime: RuntimeId; sessionId: SessionId; queue: SessionQueue }[] {
    return this.all()
      .filter((record) => record.queue.messages.length > 0)
      .map((record) => ({
        runtime: record.runtime,
        sessionId: record.session.id,
        queue: record.queue,
      }))
  }

  /** Every conversation with background work, for a client that just connected. */
  tasks(): { runtime: RuntimeId; sessionId: SessionId; tasks: readonly BackgroundTask[] }[] {
    return this.all()
      .filter((record) => record.tasks.length > 0)
      .map((record) => ({
        runtime: record.runtime,
        sessionId: record.session.id,
        tasks: record.tasks,
      }))
  }

  // ---------------------------------------------------------------- the queue

  /**
   * Adds a message to the end of the queue.
   *
   * Refuses rather than silently dropping: the whole point of queueing is that
   * a typed message is never lost, so a full queue has to be an error the user
   * can see and act on, not a message that quietly disappears.
   */
  enqueue(record: SessionRecord, id: string, input: readonly UserContent[]): QueuedMessage {
    const queue = record.queue
    if (queue.messages.length >= QUEUE_LIMIT) {
      throw new Error(
        `${QUEUE_LIMIT} messages are already waiting for this conversation. Send or clear some first.`,
      )
    }
    const size = queue.messages.reduce((total, message) => total + charsOf(message.input), 0)
    if (size + charsOf(input) > QUEUE_CHAR_LIMIT) {
      throw new Error('The queue for this conversation is full. Send or clear some of it first.')
    }
    const message: QueuedMessage = { id, input, queuedAt: Date.now(), state: 'queued' }
    record.queue = { ...queue, messages: [...queue.messages, message] }
    return message
  }

  /** Removes one message. An id that is already gone is not an error — it left. */
  cancelQueued(record: SessionRecord, id: string): void {
    const messages = record.queue.messages.filter((message) => message.id !== id)
    // Emptying a paused queue resolves the pause: there is nothing left to hold.
    record.queue =
      messages.length === 0 ? emptyQueue() : { ...record.queue, messages }
  }

  /** Moves one message to `to`, clamped into range. Unknown ids do nothing. */
  moveQueued(record: SessionRecord, id: string, to: number): void {
    const messages = record.queue.messages.slice()
    const from = messages.findIndex((message) => message.id === id)
    if (from === -1) return
    const [message] = messages.splice(from, 1)
    if (!message) return
    messages.splice(Math.max(0, Math.min(to, messages.length)), 0, message)
    record.queue = { ...record.queue, messages }
  }

  clearQueue(record: SessionRecord): void {
    record.queue = emptyQueue()
  }

  /**
   * Stops the queue and says why. Called when a turn ends any way but cleanly:
   * delivering into a rate limit, a crashed agent, or a turn the user just
   * stopped would spend a turn on a guess about what they meant.
   */
  pauseQueue(record: SessionRecord, reason: string): void {
    if (record.queue.messages.length === 0) return
    record.queue = { ...record.queue, status: 'paused', reason }
  }

  resumeQueue(record: SessionRecord): void {
    record.queue = { ...record.queue, status: 'waiting', reason: null }
  }

  /** Marks the head as being handed to the runtime, so a client can show it going. */
  markSending(record: SessionRecord): QueuedMessage | null {
    const [head, ...rest] = record.queue.messages
    // A head already going is not handed out twice: the drain holds a lock,
    // and this is the belt to that braces.
    if (!head || head.state === 'sending') return null
    const sending: QueuedMessage = { ...head, state: 'sending' }
    record.queue = { ...record.queue, messages: [sending, ...rest] }
    return sending
  }

  /**
   * Folds one event into session state. The runtime is the one that emitted
   * the event — the host knows, the event does not say. Returns the affected
   * record so callers can react without a second lookup.
   */
  apply(runtime: RuntimeId, event: AgentEvent): SessionRecord | undefined {
    if (event.type === 'session/started') {
      return this.upsert(event.session, this.get(runtime, event.session.id)?.live ?? null)
    }

    if (event.type === 'approval/requested') {
      const record = this.get(runtime, event.approval.sessionId)
      record?.approvals.set(String(event.approval.id), event.approval)
      return record
    }

    if (event.type === 'approval/resolved') {
      const record = this.get(runtime, event.sessionId)
      record?.approvals.delete(String(event.approvalId))
      return record
    }

    // What is ours to keep, and what is genuinely running, is learnt here:
    // these two events are the only ones that can change either.
    if (event.type === 'turn/started') {
      const record = this.get(runtime, event.sessionId)
      record?.watched.add(event.turn.id)
      record?.running.add(event.turn.id)
    }
    if (event.type === 'turn/completed') {
      this.get(runtime, event.sessionId)?.running.delete(event.turn.id)
    }

    const target = sessionOf(event)
    if (!target) return undefined
    const record = this.get(runtime, target)
    if (!record) return undefined
    record.session = reduceSession(record.session, event)
    return record
  }

  /**
   * Drops live handles without discarding transcripts, e.g. on runtime
   * restart. Returns the conversations whose queue was held, which the host
   * has to tell its clients about — a queue that quietly stopped looks to the
   * user like a message that vanished.
   */
  detachAll(runtime: RuntimeId): SessionRecord[] {
    const held: SessionRecord[] = []
    for (const record of this.#records.values()) {
      if (record.runtime !== runtime) continue
      // Only a handle that was there can be lost to a restart. A conversation
      // already closed by the user stays closed.
      record.detached = record.live !== null || record.detached
      record.reopenRefusals = 0
      record.live = null
      record.approvals.clear()
      // The runtime restarted: whatever was in flight died with it, and the
      // next read must not be believed when it says otherwise.
      record.running.clear()
      record.session = this.#settle(record, record.session)
      // A detached session has no turn to wait for, so nothing would ever
      // drain the queue. Hold it rather than dropping it: the agent came back
      // once already, and the user's words are the thing worth keeping.
      this.pauseQueue(record, 'The agent stopped. Send this when it is back.')
      if (record.queue.status === 'paused') held.push(record)
    }
    return held
  }

  hasApproval(runtime: RuntimeId, id: SessionId, approval: ApprovalId): boolean {
    return this.get(runtime, id)?.approvals.has(String(approval)) ?? false
  }
}

const sessionOf = (event: AgentEvent): SessionId | undefined => {
  if ('sessionId' in event && event.sessionId) return event.sessionId
  if (event.type === 'session/started') return event.session.id
  return undefined
}
