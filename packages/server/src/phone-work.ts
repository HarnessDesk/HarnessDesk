import type { DispatchAdmission } from './dispatch-admission.js'
import type { LeadChatControl, UserContent, ModelInfo, PhoneAgentChoice, PhoneModelChoice } from '@harnessdesk/protocol'
import {
  findOption, recommendedOptionValues, refuseOptionValue, runtimeId, sessionId as makeSessionId, wireCodeOf, type ConfigOption, type OptionValue, type Approval, type HostParams, type HostResult, type PhoneApprovalState, type PhoneWorkCapabilities, type PhoneWorkSnapshot,
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
  /** Cancel a host-owned recovery wait; no native interrupt capability is needed. */
  readonly cancelRecovery?: (id: string) => Promise<boolean>
  /** Host-only provenance, never supplied by the phone. */
  readonly chatControl?: (id: string, cwd: string) => Promise<LeadChatControl | undefined>
  readonly workspace: Pick<PhoneWorkspace, 'workItems' | 'workUsage' | 'workSessions'>
  /** What the desk is called to the phone that paired with it. */
  readonly deskName: () => string
  readonly home: string | null
  readonly seatName: (runtime: RuntimeId) => string | null
  /** Index membership; archives are readable only when explicitly requested. */
  readonly isOwn: (runtime: RuntimeId, id: SessionId, includeArchived?: boolean) => boolean
  readonly summary: (runtime: RuntimeId, id: SessionId) => SessionSummary | null
  /** Scoped callers validate the same raw transcript's cwd before display-path normalization. */
  readonly read: (runtime: RuntimeId, id: SessionId, admitCwd?: DispatchAdmission<string>) => Promise<Session>
  /** What this host holds of a conversation right now. */
  readonly live: (runtime: RuntimeId, id: SessionId) => { readonly running: boolean; readonly pending: readonly Approval[]; readonly cwd: string | null; readonly queued?: number }
  readonly respond: (params: HostParams<'approval/respond'>) => Promise<void>
  readonly defaultRuntime: () => RuntimeId | null
  /** Runtimes that can start a session now or on demand, in the desk's stable order. */
  readonly readyRuntimes: () => readonly RuntimeId[]
  /** Admitted project roots, with no caller-supplied path and no per-chat folder the host made for a no-folder chat. */
  readonly projectRoots: () => readonly string[]
  readonly projectName?: (root: string) => string | null
  readonly canDelete?: (runtime: RuntimeId) => boolean
  readonly canInterrupt: (runtime: RuntimeId) => boolean
  readonly models: (runtime: RuntimeId) => Promise<readonly ModelInfo[]>
  /** A runtime's models only if the desk already holds them or the runtime is running; null rather than start it. */
  readonly knownModels: (runtime: RuntimeId) => Promise<readonly ModelInfo[] | null>
  readonly newSessionValues: (runtime: RuntimeId, cwd?: string, choices?: PhoneStartChoices) => Promise<Readonly<Record<string, OptionValue>>>
  /** Host-only receipts: invoke after preflight, immediately before the actual
   * allocation, queue mutation, send or interrupt. Never take these from wire data. */
  readonly create: (params: HostParams<'session/create'>, effectStarted?: () => void) => Promise<HostResult<'session/create'>>
  readonly send: (params: HostParams<'turn/send'>, admitCwd?: DispatchAdmission<string>, effectStarted?: () => void) => Promise<void>
  readonly queue: (params: HostParams<'turn/queue'>, admit?: () => Promise<void>, effectStarted?: () => void, admitCwd?: DispatchAdmission<string>) => Promise<HostResult<'turn/queue'>>
  readonly interrupt: (params: HostParams<'turn/interrupt'>, effectStarted?: () => void, admitCwd?: DispatchAdmission<string>) => Promise<void>
  /** Whether a piece of text could hold a secret. */
  readonly hasSecret: (text: string) => boolean
  readonly now: () => number
  /** Wraps a Team the Lead started once its result is accepted; throws, in words, what keeps it on the desk. */
  readonly wrapTeam?: (team: string) => Promise<void>
}

/** The controls the desk honours for a phone so far. The rest are left false, and the phone leaves them out. */
const CAPABILITIES: PhoneWorkCapabilities = {
  startSession: true, startTeam: false, reply: true, stop: true, delete: false, rename: true, archive: true, pin: true, chooseModel: false, chooseAgent: false,
  choosePermissions: false, attach: false, undo: false, decide: true,
}

const AGENTS = 8
/** How long a snapshot waits for another agent's models, and how long a failed read is not retried. */
const AGENT_MODELS_WAIT = 2_000, AGENT_MODELS_RETRY = 60_000
/** The longest agent id a phone start can name (the wire's own bound). */
const AGENT_ID = 120
const REMEMBER_DECISIONS = 200
const SHOW_DECISIONS = 20
const DECISION_TTL = 24 * 60 * 60 * 1000

/** A refusal the phone shows as it is. */
export class PhoneWorkRefusal extends Error {}

const refuse = (message: string): never => { throw new PhoneWorkRefusal(message) }

type PhoneStartChoices = Pick<HostParams<'workspace/session/start'>, 'model' | 'effort'>

/** The phone has one step above high; use the highest step the runtime declares. */
const effortId = (levels: readonly { readonly id: string }[], effort: NonNullable<PhoneStartChoices['effort']>): string | undefined => {
  if (effort !== 'extra') return levels.find(level => level.id === effort)?.id
  const high = levels.findIndex(level => level.id === 'high')
  return levels.filter((level, index) => (high >= 0 && index > high && !/^(none|minimal|low|medium|high)$/.test(level.id)) || /^(xhigh|max|ultra|extra)$/.test(level.id)).at(-1)?.id
}

const modelChoices = (models: readonly ModelInfo[]): PhoneModelChoice[] => models.filter(model => !model.hidden).map(model => ({
  id: model.id, name: scrub(model.displayName, 60), hint: scrub(model.description ?? '', 200),
  efforts: (['low', 'medium', 'high', 'extra'] as const).filter(effort => effortId(model.reasoningLevels, effort) !== undefined),
  fast: model.supportsFast === true,
}))

/** Saved desk picks and current adapter recommendations, validated before allocation. */
export async function phoneSessionValues(
  runtime: RuntimeId, cwd: string | undefined, preferences: Readonly<Record<string, unknown>>,
  resolve: (params: HostParams<'runtime/sessionDefaults'>) => Promise<readonly ConfigOption[]>,
  choices: PhoneStartChoices = {},
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
  if (choices.model !== undefined) {
    for (const option of base) if (selector(option) || option.category === 'thought_level') delete saved[option.id]
    const model = base.find(option => option.category === 'model')
    if (!model || refuseOptionValue(model, choices.model)) return refuse('That model is not available on this desk.')
    saved[model.id] = choices.model
  }
  if (choices.effort !== undefined) for (const option of base) if (option.category === 'thought_level') delete saved[option.id]
  const savedSelectors = Object.fromEntries(Object.entries(saved).filter(([id]) => base.some(option => option.id === id && selector(option))))
  validate(savedSelectors, base)
  const selectors = Object.fromEntries(Object.entries(recommendedOptionValues(base))
    .filter(([id]) => base.some(option => option.id === id && selector(option) && !(choices.model !== undefined && option.category === '_profile'))))
  // A saved profile owns its model, just as it does in the desktop composer.
  if (base.some(option => option.category === '_profile' && Boolean(saved[option.id]) && !option.disabled)) {
    for (const option of base) if (option.category === 'model') delete selectors[option.id]
  }
  Object.assign(selectors, savedSelectors)
  const declared = Object.keys(selectors).length ? await read(selectors) : base
  validate(selectors, declared, true)
  if (choices.effort !== undefined) {
    const option = declared.find(option => option.category === 'thought_level' && option.type === 'select')
    const value = option?.type === 'select' ? effortId(option.choices.map(choice => ({ id: choice.value })), choices.effort) : undefined
    if (!option || !value || refuseOptionValue(option, value)) return refuse('That effort is not available for this model.')
    saved[option.id] = value
  }
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
    const refusal = new PhoneWorkRefusal(scrub(error instanceof Error ? error.message : '', 200) || 'The desk could not do that.')
    if (wireCodeOf(error) === 'historyUnavailable') Object.assign(refusal, { wireCode: 'historyUnavailable' })
    throw refusal
  }
}

export class PhoneWork {
  readonly #ports: PhoneWorkPorts
  /** What the phone answered lately, so a thread read after the answer still shows it. In memory only. */
  readonly #decided = new Map<string, { turn: PhoneApprovalTurn; session: string; at: number }>()

  constructor(ports: PhoneWorkPorts) { this.#ports = ports }

  /** When another agent's model read last failed, so a snapshot does not ask it again every poke. In memory only. */
  readonly #modelsFailed = new Map<string, number>()

  /** The agents a phone may start on: the default (which a start without an agent uses anyway), then the ready ones the desk knows, capped. */
  #agents(runtime: RuntimeId | null): RuntimeId[] {
    const startable = (one: RuntimeId) => this.#ports.seatName(one) !== null && String(one).length <= AGENT_ID
    const ready = [...new Set(this.#ports.readyRuntimes())].filter(one => one !== runtime && startable(one))
    return (runtime !== null && startable(runtime) ? [runtime, ...ready] : ready).slice(0, AGENTS)
  }

  /** The exact workspace-start roster, shared by host recovery candidate reads. */
  startableAgents(): readonly RuntimeId[] { return this.#agents(this.#ports.defaultRuntime()) }

  /** Another agent's models as the desk holds them, never by starting it, given up on after a short wait. */
  async #knownModels(one: RuntimeId): Promise<readonly ModelInfo[]> {
    const key = String(one), failed = this.#modelsFailed.get(key)
    if (failed !== undefined && this.#ports.now() - failed < AGENT_MODELS_RETRY) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    // Not unref'd: a snapshot is waiting on this timer, so it must hold the loop open until the wait ends.
    const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), AGENT_MODELS_WAIT) })
    try {
      const models = await Promise.race([this.#ports.knownModels(one), late])
      // A read that hangs is treated like one that failed, so the next pokes do not wait on it too.
      if (models === 'late') { this.#modelsFailed.set(key, this.#ports.now()); return [] }
      this.#modelsFailed.delete(key)
      return models ?? []
    }
    catch { this.#modelsFailed.set(key, this.#ports.now()); return [] }
    finally { clearTimeout(timer) }
  }

  async snapshot(): Promise<PhoneWorkSnapshot> {
    const runtime = this.#ports.defaultRuntime()
    const ids = this.#agents(runtime)
    const reads = [...new Set(runtime ? [runtime, ...ids] : ids)]
    // Only the default agent is started for its models; a snapshot never starts any other agent.
    const read = (one: RuntimeId) => one === runtime ? this.#ports.models(one) : this.#knownModels(one)
    const [items, usage, catalogues] = await Promise.all([this.#ports.workspace.workItems(), this.#ports.workspace.workUsage(),
      Promise.all(reads.map(one => read(one).then(modelChoices).catch((): PhoneModelChoice[] => [])))])
    const choices = new Map(reads.map((one, index) => [one, catalogues[index]!]))
    const models = runtime ? choices.get(runtime)! : []
    const agents: PhoneAgentChoice[] = ids.map(id => ({ id: String(id), name: scrub(this.#ports.seatName(id) ?? '', 60) || 'Agent', models: choices.get(id)!, ...(id === runtime ? { default: true as const } : {}) }))
    let projects: string[] = []
    try { projects = [...this.#projectNames()].filter(([, roots]) => roots.length === 1).map(([name]) => name).sort().slice(0, 50) } catch { /* Unreadable admission metadata is not a project choice. */ }
    return {
      deskName: scrub(this.#ports.deskName(), 60) || 'Desk',
      items, projects,
      ...(usage ? { usage } : {}),
      models, agents, flows: [], commands: [],
      capabilities: { ...CAPABILITIES, delete: ids.some(id => this.#ports.canDelete?.(id) === true), chooseModel: models.length > 0, chooseAgent: agents.length > 1 },
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

  async sessionRename(params: HostParams<'workspace/session/rename'>, handler: (params: HostParams<'session/setTitle'>) => Promise<HostResult<'session/setTitle'>>) {
    const { runtime, session } = this.#target(params.id)
    return guarded(() => handler({ runtime, sessionId: session, title: params.title }))
  }

  async sessionArchive(params: HostParams<'workspace/session/archive'>, handler: (params: HostParams<'session/archive'>) => Promise<HostResult<'session/archive'>>) {
    const { runtime, session } = this.#target(params.id, !params.archived)
    return guarded(() => handler({ runtime, sessionId: session, archived: params.archived }))
  }

  async sessionPin(params: HostParams<'workspace/session/pin'>, handler: (params: HostParams<'session/pin'>) => Promise<HostResult<'session/pin'>>) {
    const { runtime, session } = this.#target(params.id)
    return guarded(() => handler({ runtime, sessionId: session, pinned: params.pinned }))
  }

  async sessionDelete(params: HostParams<'workspace/session/delete'>, handler: (params: HostParams<'session/delete'>) => Promise<HostResult<'session/delete'>>) {
    const { runtime, session } = this.#target(params.id, true)
    return guarded(() => handler({ runtime, sessionId: session }))
  }

  async threadRead(params: { id: string }, admit?: DispatchAdmission<string>): Promise<PhoneWorkThread> {
    const { runtime, session, key } = this.#target(params.id, true)
    const read = await guarded(() => this.#ports.read(runtime, session, admit))
    await admit?.(read.cwd)
    this.#target(params.id, true)
    const live = this.#ports.live(runtime, session)
    const summary = this.#ports.summary(runtime, session)
    const now = this.#ports.now()
    const decided = [...this.#decided.values()]
      .filter(one => one.session === key && now - one.at < DECISION_TTL)
      .slice(-SHOW_DECISIONS).map(one => one.turn)
      .filter(turn => !live.pending.some(approval => String(approval.id) === turn.id))
    const control = await this.#ports.chatControl?.(key, read.cwd)
    this.#target(params.id, true)
    return buildThread({
      ...(control ? { leadControl: control } : {}),
      id: key, session: read, running: live.running, pending: live.pending,
      project: summary?.repo ? folderName(summary.repo.root) : null, title: summary?.title, decided,
    }, this.#context(runtime))
  }

  sessionsList(params: HostParams<'workspace/sessions/list'>): HostResult<'workspace/sessions/list'> {
    return this.#ports.workspace.workSessions(params)
  }

  /** Scrub before comparing, so every advertised name round-trips and redaction cannot hide an ambiguity. */
  #projectNames(): Map<string, string[]> {
    const names = new Map<string, string[]>()
    for (const root of new Set(this.#ports.projectRoots())) {
      const name = scrub(this.#ports.projectName?.(root) ?? folderName(root) ?? '', 60)
      if (!name) continue
      const roots = names.get(name) ?? []
      roots.push(root)
      names.set(name, roots)
    }
    return names
  }

  async sessionStart(params: HostParams<'workspace/session/start'>): Promise<HostResult<'workspace/session/start'>> {
    let cwd: string | undefined
    if (params.project !== undefined) {
      const matches = this.#projectNames().get(params.project) ?? []
      if (matches.length === 0) return refuse('That project is not available on this desk.')
      if (matches.length > 1) return refuse('More than one project has that name. Start it on the desk.')
      cwd = matches[0]!
    }
    return this.startInProject(params, cwd)
  }

  /** Host-owned exact project root. `input` is a host-only envelope override, never phone params. Without `agent` it starts on the default runtime. */
  async startInProject(params: { text: string; agent?: string } & PhoneStartChoices, cwd?: string, admit?: (id?: string) => Promise<void>, effectStarted?: () => void, admitCwd?: DispatchAdmission<string>, input?: readonly UserContent[], firstMessageStarted?: () => void): Promise<HostResult<'workspace/session/start'>> {
    const preferred = this.#ports.defaultRuntime()
    const runtime = params.agent === undefined ? preferred : this.#agents(preferred).find(one => String(one) === params.agent) ?? null
    if (runtime === null && params.agent !== undefined) return { id: '', problem: 'That agent is not available on this desk. Refresh and try again.' }
    if (runtime === null) return refuse('No agent is available to start a session.')
    return guarded(async () => {
      const choices: PhoneStartChoices = { ...(params.model !== undefined ? { model: params.model } : {}), ...(params.effort !== undefined ? { effort: params.effort } : {}) }
      let values: Readonly<Record<string, OptionValue>>
      try {
        if (choices.model !== undefined && !modelChoices(await this.#ports.models(runtime)).some(model => model.id === choices.model)) {
          return { id: '', problem: 'That model is not available on this desk. Refresh the model list and try again.' }
        }
        values = await this.#ports.newSessionValues(runtime, cwd, choices)
      }
      catch (error) {
        if (choices.model !== undefined || choices.effort !== undefined) return { id: '', problem: scrub(error instanceof Error ? error.message : '', 200) || 'Those model choices are no longer available.' }
        throw error
      }
      await admit?.()
      const session = await this.#ports.create({ runtime, options: { ...(cwd ? { cwd } : {}), ...(Object.keys(values).length ? { options: values } : {}) } }, effectStarted)
      const id = `${runtime}:${session.id}`
      let started = false
      try {
        await admit?.(id)
        await this.#ports.send({ runtime, sessionId: session.id, input: input ?? [{ type: 'text', text: params.text }] }, admitCwd, () => { started = true; firstMessageStarted?.() })
      }
      catch {
        if (!started) return { id, problem: 'The session was created, but its first message did not start. The original work has not moved.' }
        // The runtime may have accepted the prompt before losing its reply.
        // Keep its identity and history; the phone opens it with the draft.
        return { id, problem: 'The session was created, but its first message could not be confirmed. Check the conversation before sending again.' }
      }
      return { id }
    })
  }

  async sessionSend(params: HostParams<'workspace/session/send'>, admit?: () => Promise<void>, effectStarted?: () => void, admitCwd?: DispatchAdmission<string>, input?: readonly UserContent[]): Promise<HostResult<'workspace/session/send'>> {
    const { runtime, session } = this.#target(params.id)
    const result = await guarded(() => this.#ports.queue({ runtime, sessionId: session, input: input ?? [{ type: 'text', text: params.text }] }, admit, effectStarted, admitCwd))
    return result.sent ? {} : { queued: true }
  }

  async stop(params: HostParams<'workspace/stop'>, admit?: () => Promise<void>, effectStarted?: () => void, admitCwd?: DispatchAdmission<string>): Promise<HostResult<'workspace/stop'>> {
    const { runtime, session } = this.#target(params.id)
    let cancelledRecovery = false
    if (this.#ports.cancelRecovery) { await admit?.(); cancelledRecovery = await this.#ports.cancelRecovery(params.id) }
    const live = this.#ports.live(runtime, session)
    if (!live.running && cancelledRecovery) return live.queued ? { queued: true } : {}
    if (!this.#ports.canInterrupt(runtime)) return refuse('This agent cannot stop a session from the phone.')
    if (!live.running) return live.queued ? { queued: true } : {}
    await admit?.()
    this.#target(params.id)
    await guarded(() => this.#ports.interrupt({ runtime, sessionId: session }, effectStarted, admitCwd))
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

  /** Wraps a Team the person accepted through the Lead. Answers `{}`; the wrapped Team arrives on the `workspace` topic. */
  async teamWrap(params: { team: string }): Promise<Record<string, never>> {
    const wrap = this.#ports.wrapTeam
    if (!wrap) return refuse('Wrap this Team on the desk.')
    await guarded(() => wrap(params.team))
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
