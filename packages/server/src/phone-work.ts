import {
  findOption, recommendedOptionValues, refuseOptionValue, runtimeId, sessionId as makeSessionId, type ConfigOption, type OptionValue, type Approval, type HostParams, type HostResult, type PhoneApprovalState, type PhoneWorkCapabilities, type PhoneWorkSnapshot,
  type PhoneWorkThread, type RuntimeId, type Session, type SessionId, type SessionSummary,
} from '@harnessdesk/protocol'
import { assessApproval, buildThread, type PhoneApprovalTurn, type ThreadContext } from './phone-thread.js'
import { folderName, scrub } from './phone-redact.js'
import type { PhoneWorkspace } from './phone-workspace.js'

/**
 * The phone's view of the desk and its ordinary session controls. It composes the projections in
 * `phone-workspace.ts` and `phone-thread.ts` and owns nothing of the desk's: narrow ports dispatch the window's
 * existing methods, so permissions, held ceilings, lifecycle and approval rules remain the host's.
 */

export interface PhoneWorkPorts {
  readonly workspace: Pick<PhoneWorkspace, 'workItems' | 'workUsage' | 'workSessions'>
  /** What the desk is called to the phone that paired with it. */
  readonly deskName: () => string
  readonly home: string | null
  readonly seatName: (runtime: RuntimeId) => string | null
  /** Index membership; archives are readable only when explicitly requested. */
  readonly isOwn: (runtime: RuntimeId, id: SessionId, includeArchived?: boolean) => boolean
  readonly summary: (runtime: RuntimeId, id: SessionId) => SessionSummary | null
  readonly read: (runtime: RuntimeId, id: SessionId) => Promise<Session>
  /** What this host holds of a conversation right now. */
  readonly live: (runtime: RuntimeId, id: SessionId) => { readonly running: boolean; readonly pending: readonly Approval[]; readonly cwd: string | null; readonly queued?: number }
  readonly respond: (params: HostParams<'approval/respond'>) => Promise<void>
  readonly defaultRuntime: () => RuntimeId | null
  /** Admitted project roots, with no caller-supplied path. */
  readonly projectRoots: () => readonly string[]
  readonly projectName?: (root: string) => string | null
  readonly canInterrupt: (runtime: RuntimeId) => boolean
  readonly newSessionValues: (runtime: RuntimeId, cwd?: string) => Promise<Readonly<Record<string, OptionValue>>>
  readonly create: (params: HostParams<'session/create'>) => Promise<HostResult<'session/create'>>
  readonly send: (params: HostParams<'turn/send'>) => Promise<void>
  readonly queue: (params: HostParams<'turn/queue'>) => Promise<HostResult<'turn/queue'>>
  readonly interrupt: (params: HostParams<'turn/interrupt'>) => Promise<void>
  /** Whether a piece of text could hold a secret. */
  readonly hasSecret: (text: string) => boolean
  readonly now: () => number
}

/** The controls the desk honours for a phone so far. The rest are left false, and the phone leaves them out. */
const CAPABILITIES: PhoneWorkCapabilities = {
  startSession: true, startTeam: false, reply: true, stop: true, delete: false, chooseModel: false,
  choosePermissions: false, attach: false, undo: false, decide: true,
}

const REMEMBER_DECISIONS = 200
const SHOW_DECISIONS = 20
const DECISION_TTL = 24 * 60 * 60 * 1000

/** A refusal the phone shows as it is. */
export class PhoneWorkRefusal extends Error {}

const refuse = (message: string): never => { throw new PhoneWorkRefusal(message) }

/** Saved desk picks and current adapter recommendations, validated before allocation. */
export async function phoneSessionValues(
  runtime: RuntimeId, cwd: string | undefined, preferences: Readonly<Record<string, unknown>>,
  resolve: (params: HostParams<'runtime/sessionDefaults'>) => Promise<readonly ConfigOption[]>,
): Promise<Readonly<Record<string, OptionValue>>> {
  const drafts = preferences['draftValues']
  const raw = drafts && typeof drafts === 'object' && !Array.isArray(drafts)
    ? (drafts as Record<string, unknown>)[runtime] : undefined
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    return refuse('Saved new-session choices need attention in Settings on the desk.')
  }
  const saved: Record<string, OptionValue> = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'boolean') return refuse('Saved new-session choices need attention in Settings on the desk.')
    saved[id] = value
  }
  const read = (values: Readonly<Record<string, OptionValue>>) => resolve({ runtime,
    ...(cwd ? { cwd } : {}), ...(Object.keys(values).length ? { values } : {}) })
  const selector = (option: ConfigOption) => option.category === 'model' || option.category === '_profile'
  const validate = (values: Readonly<Record<string, OptionValue>>, options: readonly ConfigOption[], applied = false) => {
    for (const [id, value] of Object.entries(values)) {
      const option = findOption(options, id)
      if (!option || refuseOptionValue(option, value) || (applied && option.currentValue !== value)) {
        refuse('Saved new-session choices need attention in Settings on the desk.')
      }
    }
  }
  const base = await read({})
  const savedSelectors = Object.fromEntries(Object.entries(saved).filter(([id]) => base.some(option => option.id === id && selector(option))))
  validate(savedSelectors, base)
  const selectors = Object.fromEntries(Object.entries(recommendedOptionValues(base))
    .filter(([id]) => base.some(option => option.id === id && selector(option))))
  // A saved profile owns its model, just as it does in the desktop composer.
  if (base.some(option => option.category === '_profile' && Boolean(saved[option.id]) && !option.disabled)) {
    for (const option of base) if (option.category === 'model') delete selectors[option.id]
  }
  Object.assign(selectors, savedSelectors)
  const declared = Object.keys(selectors).length ? await read(selectors) : base
  validate(selectors, declared, true)
  const dependentSaved = Object.fromEntries(Object.entries(saved).filter(([id]) => !(id in savedSelectors)))
  validate(dependentSaved, declared)
  const dependentRecommendations = (options: readonly ConfigOption[]) => Object.fromEntries(
    Object.entries(recommendedOptionValues(options)).filter(([id]) => !options.some(option => option.id === id && selector(option))))
  // Recommendations dependent on a model/profile are read only after those
  // selectors resolve. An old model's effort must never ride a new model.
  let values = { ...selectors, ...dependentRecommendations(declared), ...dependentSaved }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Object.keys(values).length === 0) return values
    const options = await read(values)
    validate(values, options, true)
    const next = { ...selectors, ...dependentRecommendations(options), ...dependentSaved }
    if (Object.keys(next).length === Object.keys(values).length && Object.entries(next).every(([id, value]) => values[id] === value)) return values
    values = next
  }
  return refuse('New-session choices changed while starting. Try again on the desk.')
}

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
  #target(id: string, includeArchived = false): { runtime: RuntimeId; session: SessionId; key: string } {
    const at = id.indexOf(':')
    if (at <= 0 || at === id.length - 1 || id.length > 300) return refuse('That is not a session this desk can show.')
    const runtime = runtimeId(id.slice(0, at)), session = makeSessionId(id.slice(at + 1))
    if (this.#ports.seatName(runtime) === null || !this.#ports.isOwn(runtime, session, includeArchived)) return refuse('That is not a session this desk can show.')
    return { runtime, session, key: `${runtime}:${session}` }
  }

  async threadRead(params: { id: string }): Promise<PhoneWorkThread> {
    const { runtime, session, key } = this.#target(params.id, true)
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

  sessionsList(params: HostParams<'workspace/sessions/list'>): HostResult<'workspace/sessions/list'> {
    return this.#ports.workspace.workSessions(params)
  }

  async sessionStart(params: HostParams<'workspace/session/start'>): Promise<HostResult<'workspace/session/start'>> {
    const runtime = this.#ports.defaultRuntime()
    if (runtime === null) return refuse('No agent is available to start a session.')
    let cwd: string | undefined
    if (params.project !== undefined) {
      const matches = [...new Set(this.#ports.projectRoots())].filter(root => (this.#ports.projectName?.(root) ?? folderName(root)) === params.project)
      if (matches.length === 0) return refuse('That project is not available on this desk.')
      if (matches.length > 1) return refuse('More than one project has that name. Start it on the desk.')
      cwd = matches[0]!
    }
    return guarded(async () => {
      const values = await this.#ports.newSessionValues(runtime, cwd)
      const session = await this.#ports.create({ runtime, options: { ...(cwd ? { cwd } : {}), ...(Object.keys(values).length ? { options: values } : {}) } })
      const id = `${runtime}:${session.id}`
      try { await this.#ports.send({ runtime, sessionId: session.id, input: [{ type: 'text', text: params.text }] }) }
      catch {
        // The runtime may have accepted the prompt before losing its reply.
        // Keep its identity and history; the phone opens it with the draft.
        return { id, problem: 'The session was created, but its first message could not be confirmed. Check the conversation before sending again.' }
      }
      return { id }
    })
  }

  async sessionSend(params: HostParams<'workspace/session/send'>): Promise<HostResult<'workspace/session/send'>> {
    const { runtime, session } = this.#target(params.id)
    const result = await guarded(() => this.#ports.queue({ runtime, sessionId: session, input: [{ type: 'text', text: params.text }] }))
    return result.sent ? {} : { queued: true }
  }

  async stop(params: HostParams<'workspace/stop'>): Promise<HostResult<'workspace/stop'>> {
    const { runtime, session } = this.#target(params.id)
    if (!this.#ports.canInterrupt(runtime)) return refuse('This agent cannot stop a session from the phone.')
    if (!this.#ports.live(runtime, session).running) return this.#ports.live(runtime, session).queued ? { queued: true } : {}
    await guarded(() => this.#ports.interrupt({ runtime, sessionId: session }))
    return this.#ports.live(runtime, session).queued ? { queued: true } : {}
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
  #invalidated = false
  #disposed = false

  constructor(options: WorkspaceFeedOptions) { this.#options = options }

  /** Something that shows in the snapshot may have changed. */
  poke(invalidate = false): void {
    if (invalidate) this.#invalidated = true
    if (this.#disposed || this.#timer || !this.#options.listening()) return
    this.#timer = setTimeout(() => { this.#timer = null; void this.#run() }, this.#options.delayMs ?? 1000)
    this.#timer.unref?.()
  }

  async #run(): Promise<void> {
    if (this.#disposed) return
    if (this.#building) { this.#again = true; return }
    this.#building = true
    let invalidated = false
    try {
      if (!this.#options.listening()) return
      invalidated = this.#invalidated
      this.#invalidated = false
      const snapshot = await this.#options.build()
      const text = JSON.stringify(snapshot)
      if ((invalidated || text !== this.#last) && !this.#disposed && this.#options.listening()) {
        this.#options.publish(snapshot)
        this.#last = text
      }
    } catch (error) {
      this.#invalidated ||= invalidated
      this.#again = true
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
