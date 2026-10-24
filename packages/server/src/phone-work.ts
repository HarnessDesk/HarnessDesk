import {
  runtimeId, sessionId as makeSessionId, type Approval, type HostParams, type PhoneApprovalState, type PhoneWorkCapabilities, type PhoneWorkSnapshot,
  type PhoneWorkThread, type RuntimeId, type Session, type SessionId, type SessionSummary,
} from '@harnessdesk/protocol'
import { assessApproval, buildThread, type PhoneApprovalTurn, type ThreadContext } from './phone-thread.js'
import { folderName, scrub } from './phone-redact.js'
import type { PhoneWorkspace } from './phone-workspace.js'

/**
 * The phone's own view of the desk: one snapshot of the work, one conversation, and the single thing a phone may do
 * to it so far, which is to answer an approval. It composes the projections in `phone-workspace.ts` and
 * `phone-thread.ts` and owns nothing of the desk's: every read goes through a port and every answer is the window's
 * own `approval/respond`, so a held ceiling or a stopped question is honoured the same way.
 */

export interface PhoneWorkPorts {
  readonly workspace: Pick<PhoneWorkspace, 'workItems' | 'workUsage'>
  /** What the desk is called to the phone that paired with it. */
  readonly deskName: () => string
  readonly home: string | null
  readonly seatName: (runtime: RuntimeId) => string | null
  /** One of the person's own open conversations, as the sessions list shows them. */
  readonly isOwn: (runtime: RuntimeId, id: SessionId) => boolean
  readonly summary: (runtime: RuntimeId, id: SessionId) => SessionSummary | null
  readonly read: (runtime: RuntimeId, id: SessionId) => Promise<Session>
  /** What this host holds of a conversation right now. */
  readonly live: (runtime: RuntimeId, id: SessionId) => { readonly running: boolean; readonly pending: readonly Approval[]; readonly cwd: string | null }
  readonly respond: (params: HostParams<'approval/respond'>) => Promise<void>
  /** Whether a piece of text could hold a secret. */
  readonly hasSecret: (text: string) => boolean
  readonly now: () => number
}

/** The controls the desk honours for a phone so far. The rest are left false, and the phone leaves them out. */
const CAPABILITIES: PhoneWorkCapabilities = {
  startSession: false, startTeam: false, reply: false, stop: false, delete: false, chooseModel: false,
  choosePermissions: false, attach: false, undo: false, decide: true,
}

const REMEMBER_DECISIONS = 200
const SHOW_DECISIONS = 20
const DECISION_TTL = 24 * 60 * 60 * 1000

/** A refusal the phone shows as it is. */
export class PhoneWorkRefusal extends Error {}

const refuse = (message: string): never => { throw new PhoneWorkRefusal(message) }

/**
 * A failure from the desk, said to the phone without whatever the desk's own error carried: a message from a
 * file system or an agent can name a path or an account, so it goes through the same scrub as any other text.
 */
const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try { return await work() } catch (error) {
    if (error instanceof PhoneWorkRefusal) throw error
    throw new PhoneWorkRefusal(scrub(error instanceof Error ? error.message : '', 200) || 'The desk could not do that.')
  }
}

export class PhoneWork {
  readonly #ports: PhoneWorkPorts
  /** What the phone answered lately, so a thread read after the answer still shows it. In memory only. */
  readonly #decided = new Map<string, { turn: PhoneApprovalTurn; session: string; at: number }>()

  constructor(ports: PhoneWorkPorts) { this.#ports = ports }

  async snapshot(): Promise<PhoneWorkSnapshot> {
    const [items, usage] = await Promise.all([this.#ports.workspace.workItems(), this.#ports.workspace.workUsage()])
    return {
      deskName: scrub(this.#ports.deskName(), 60) || 'Desk',
      items,
      ...(usage ? { usage } : {}),
      models: [], flows: [], commands: [],
      capabilities: CAPABILITIES,
      threads: [],
    }
  }

  #context(runtime: RuntimeId): ThreadContext {
    return { home: this.#ports.home, seat: this.#ports.seatName(runtime) ?? 'Agent', hasSecret: this.#ports.hasSecret }
  }

  /** "<agent>:<session>" to a conversation of the person's own that this desk can show. */
  #target(id: string): { runtime: RuntimeId; session: SessionId; key: string } {
    const at = id.indexOf(':')
    if (at <= 0 || at === id.length - 1 || id.length > 300) return refuse('That is not a session this desk can show.')
    const runtime = runtimeId(id.slice(0, at)), session = makeSessionId(id.slice(at + 1))
    if (this.#ports.seatName(runtime) === null || !this.#ports.isOwn(runtime, session)) return refuse('That is not a session this desk can show.')
    return { runtime, session, key: `${runtime}:${session}` }
  }

  async threadRead(params: { id: string }): Promise<PhoneWorkThread> {
    const { runtime, session, key } = this.#target(params.id)
    const read = await guarded(() => this.#ports.read(runtime, session))
    const live = this.#ports.live(runtime, session)
    const summary = this.#ports.summary(runtime, session)
    const now = this.#ports.now()
    const decided = [...this.#decided.values()]
      .filter(one => one.session === key && now - one.at < DECISION_TTL)
      .slice(-SHOW_DECISIONS).map(one => one.turn)
      .filter(turn => !live.pending.some(approval => String(approval.id) === turn.id))
    return buildThread({
      id: key, session: read, running: live.running, pending: live.pending,
      project: summary?.repo ? folderName(summary.repo.root) : null, title: summary?.title, decided,
    }, this.#context(runtime))
  }

  /**
   * Answers one approval for a phone. "Once" picks the approval's plain allow, "session" its option scoped to the
   * session and nothing wider, and a deny its deny. What cannot be read on a phone, and what only the desk can
   * answer, is refused rather than guessed.
   */
  async approvalDecide(params: { id: string; session: string; allow: boolean; scope?: 'once' | 'session' }): Promise<Record<string, never>> {
    const { runtime, session, key } = this.#target(params.session)
    const held = this.#ports.live(runtime, session)
    const approval = held.pending.find(one => String(one.id) === params.id)
    if (!approval) return refuse('That request is not waiting any more.')
    const assessed = assessApproval(approval, held.cwd, this.#context(runtime))
    if (!assessed) return refuse('The agent asked a question. Answer it on the desk.')
    const scope = params.scope ?? 'once'
    if (scope === 'session' && !params.allow) return refuse('Only an allow can last for the session.')

    let option, state: PhoneApprovalState
    if (!params.allow) {
      option = assessed.options.deny
      state = 'denied'
      if (!option) return refuse('This request cannot be declined from a phone.')
    } else {
      if (!assessed.readable) return refuse('This request is too long or too sensitive to read on a phone. Decide it on the desk.')
      if (scope === 'session') {
        // A request the phone calls high risk never carries the grant, so a message that asks for it anyway is refused.
        option = assessed.turn.sessionGrant ? assessed.options.session : undefined
        state = 'allowedForSession'
        if (!option) return refuse('This request cannot be allowed for the whole session from a phone.')
      } else {
        option = assessed.options.once
        state = 'allowed'
        if (!option) return refuse('This request cannot be allowed once from a phone.')
      }
    }

    await guarded(() => this.#ports.respond({ runtime, sessionId: session, approvalId: approval.id, decision: { type: 'option', optionId: option.id } }))
    this.#remember(key, { ...assessed.turn, state })
    return {}
  }

  #remember(session: string, turn: PhoneApprovalTurn): void {
    const id = `${session}\u0000${turn.id}`
    this.#decided.delete(id)
    this.#decided.set(id, { turn, session, at: this.#ports.now() })
    while (this.#decided.size > REMEMBER_DECISIONS) this.#decided.delete(this.#decided.keys().next().value!)
  }
}

/**
 * Keeps phones that are listening up to date without a poll: when something that shows in the snapshot may have
 * changed it rebuilds the snapshot, once a moment, and publishes it if it differs from the last one it published.
 * While no phone is listening it does nothing, so a desk with no phone pays for none of this.
 */
export interface WorkspaceFeedOptions {
  readonly build: () => Promise<PhoneWorkSnapshot>
  readonly publish: (snapshot: PhoneWorkSnapshot) => void
  readonly listening: () => boolean
  readonly delayMs?: number
  readonly onError?: (error: unknown) => void
}

export class WorkspaceFeed {
  readonly #options: WorkspaceFeedOptions
  #timer: ReturnType<typeof setTimeout> | null = null
  #building = false
  #again = false
  #last: string | null = null
  #disposed = false

  constructor(options: WorkspaceFeedOptions) { this.#options = options }

  /** Something that shows in the snapshot may have changed. */
  poke(): void {
    if (this.#disposed || this.#timer || !this.#options.listening()) return
    this.#timer = setTimeout(() => { this.#timer = null; void this.#run() }, this.#options.delayMs ?? 1000)
    this.#timer.unref?.()
  }

  async #run(): Promise<void> {
    if (this.#disposed) return
    if (this.#building) { this.#again = true; return }
    this.#building = true
    try {
      if (!this.#options.listening()) return
      const snapshot = await this.#options.build()
      const text = JSON.stringify(snapshot)
      if (text !== this.#last && !this.#disposed && this.#options.listening()) {
        this.#last = text
        this.#options.publish(snapshot)
      }
    } catch (error) {
      this.#options.onError?.(error)
    } finally {
      this.#building = false
      if (this.#again) { this.#again = false; this.poke() }
    }
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
