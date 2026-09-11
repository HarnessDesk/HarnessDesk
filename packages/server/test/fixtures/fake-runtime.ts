import {
  findOption,
  itemId,
  refuseOptionValue,
  runtimeId,
  sessionId,
  turnId,
  type AccountStatus,
  type AgentEvent,
  type AgentRuntime,
  type AgentSession,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type BackgroundTask,
  type ConfigOption,
  type FileEntry,
  type FileMatch,
  type FileMetadata,
  type ListSessionsQuery,
  type LoginStart,
  type ModelInfo,
  type OptionValue,
  type Page,
  type RateLimits,
  type RuntimeFiles,
  type RuntimeHealth,
  type RuntimeId,
  type RuntimeProcess,
  type RuntimeProcesses,
  type RuntimeTasks,
  type RuntimeCapabilities,
  type RuntimeInfo,
  type Session,
  type SessionDeletion,
  type SessionId,
  type SessionOptions,
  type SessionSettings,
  type SessionSummary,
  type TurnId,
  type Unsubscribe,
  type UserContent,
} from '@harnessdesk/protocol'

/**
 * An in-memory `AgentRuntime` for host tests.
 *
 * Exists to prove the host is genuinely runtime-agnostic: if these tests pass
 * without Codex anywhere in scope, the abstraction is real.
 */

export const FAKE_RUNTIME_ID = runtimeId('fake')

const SETTINGS: SessionSettings = {
  cwd: '/w',
  model: 'fake-1',
}

/**
 * The fake's controls. Deliberately unlike Codex's: a model, a tone, and a
 * toggle. If the host or the renderer only works for options shaped like
 * Codex's, these are what break.
 */
const defaultValues = (): Record<string, OptionValue> => ({
  model: 'fake-1',
  tone: 'plain',
  uppercase: false,
})

const optionsFor = (values: Readonly<Record<string, OptionValue>>): ConfigOption[] => [
  {
    type: 'select',
    id: 'model',
    category: 'model',
    label: 'Model',
    currentValue: String(values['model']),
    choices: [
      { value: 'fake-1', label: 'Fake One' },
      { value: 'fake-2', label: 'Fake Two', description: 'Slower, wordier.' },
    ],
  },
  {
    type: 'select',
    id: 'tone',
    category: 'other',
    label: 'Tone',
    currentValue: String(values['tone']),
    choices: [
      { value: 'plain', label: 'Plain' },
      { value: 'cheerful', label: 'Cheerful', risk: 'elevated' },
    ],
  },
  {
    type: 'boolean',
    id: 'uppercase',
    category: 'other',
    label: 'Shout',
    currentValue: Boolean(values['uppercase']),
  },
]

/**
 * An in-memory filesystem view, so a test can tell the runtime's reader from
 * the host's own: nothing in here exists on disk.
 */
export class FakeFiles implements RuntimeFiles {
  readonly calls: string[] = []
  readonly tree: Record<string, string> = {
    '/w/README.md': 'from the fake runtime',
    '/w/src/a.ts': 'a',
    '/elsewhere/secret.txt': 'should never be readable through the host',
  }

  async search(roots: readonly string[], query: string, limit: number): Promise<readonly FileMatch[]> {
    this.calls.push(`search ${roots.join(',')} ${query}`)
    return Object.keys(this.tree)
      .filter((path) => roots.some((root) => path.startsWith(`${root}/`)) && path.includes(query))
      .slice(0, limit)
      .map((path) => ({ path, relativePath: path.slice(roots[0]!.length + 1), score: 1 }))
  }

  async read(path: string): Promise<Uint8Array> {
    this.calls.push(`read ${path}`)
    const content = this.tree[path]
    if (content === undefined) throw new Error(`fake: no such file ${path}`)
    return new TextEncoder().encode(content)
  }

  async list(path: string): Promise<readonly FileEntry[]> {
    this.calls.push(`list ${path}`)
    const prefix = `${path.replace(/\/$/, '')}/`
    const names = new Set(
      Object.keys(this.tree)
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length).split('/')[0]!),
    )
    return [...names].map((name) => ({
      name,
      kind: Object.keys(this.tree).some((entry) => entry.startsWith(`${prefix}${name}/`)) ? 'directory' : 'file',
    }))
  }

  async stat(path: string): Promise<FileMetadata> {
    return { kind: path in this.tree ? 'file' : 'directory', isSymlink: false, modifiedAt: null }
  }

  async watch(): Promise<Unsubscribe> {
    return () => {}
  }
}

/**
 * An in-memory "process": echoes stdin back with a prefix, reports resizes,
 * exits on kill. Enough to prove the host keeps a terminal alive across a
 * client reload and relays bytes both ways.
 */
class FakeProcess implements RuntimeProcess {
  readonly #output = new Set<(stream: 'stdout' | 'stderr', data: Uint8Array) => void>()
  readonly #exit = new Set<(code: number) => void>()
  exited: number | null = null
  readonly sessionUsed: SessionId | undefined

  constructor(command: readonly string[], session: SessionId | undefined) {
    this.sessionUsed = session
    queueMicrotask(() => this.#emit(`$ ${command.join(' ')}\n`))
  }

  #emit(text: string): void {
    for (const listener of this.#output) listener('stdout', new TextEncoder().encode(text))
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.exited !== null) throw new Error('exited')
    this.#emit(`echo:${new TextDecoder().decode(data)}`)
  }

  async resize(size: { rows: number; cols: number }): Promise<void> {
    this.#emit(`[${size.rows}x${size.cols}]`)
  }

  async kill(): Promise<void> {
    if (this.exited !== null) return
    this.exited = 130
    for (const listener of this.#exit) listener(130)
  }

  onOutput(listener: (stream: 'stdout' | 'stderr', data: Uint8Array) => void): Unsubscribe {
    this.#output.add(listener)
    return () => this.#output.delete(listener)
  }

  onExit(listener: (code: number) => void): Unsubscribe {
    this.#exit.add(listener)
    return () => this.#exit.delete(listener)
  }
}

export class FakeRuntime implements AgentRuntime {
  readonly files = new FakeFiles()
  readonly spawned: FakeProcess[] = []
  readonly processes: RuntimeProcesses = {
    spawn: async (options) => {
      const process = new FakeProcess(options.command, options.session)
      this.spawned.push(process)
      return process
    },
  }
  /**
   * Background tasks, driven by the test rather than by any agent. Enough of
   * `RuntimeTasks` to exercise the host end to end: a list that can be
   * pushed, a stop that reports whether it knew the id, and a clear that
   * leaves running work alone.
   */
  readonly tasks: RuntimeTasks & {
    put(session: string, tasks: readonly BackgroundTask[]): void
  } = {
    put: (session: string, tasks: readonly BackgroundTask[]) => {
      this.taskLists.set(session, tasks)
      this.emit({ type: 'session/tasks', sessionId: sessionId(session), tasks })
    },
    list: async (session: SessionId) => this.taskLists.get(session) ?? [],
    stop: async (session: SessionId, taskId: string) => {
      const held = this.taskLists.get(session) ?? []
      if (!held.some((task) => task.id === taskId && task.state === 'running')) return false
      this.tasks.put(
        session,
        held.map((task) =>
          task.id === taskId ? { ...task, state: 'stopped' as const, stoppable: false, endedAt: 1 } : task,
        ),
      )
      return true
    },
    clear: async (session: SessionId) => {
      const held = this.taskLists.get(session) ?? []
      this.taskLists.set(session, held.filter((task) => task.state === 'running'))
    },
  }
  readonly taskLists = new Map<string, readonly BackgroundTask[]>()

  #listeners = new Set<(event: AgentEvent) => void>()
  #healthListeners = new Set<(health: RuntimeHealth) => void>()
  #health: RuntimeHealth = { state: 'unavailable', reason: 'unknown', message: 'not started' }
  #counter = 0
  readonly sessions = new Map<string, FakeSession>()
  /** Turn ids the test asked to leave running, so interrupt has something to do. */
  readonly history: SessionSummary[] = []

  /**
   * A second instance of the same fake, for the account-slot tests: an agent
   * whose accounts are separate runtimes needs two runtimes to be an agent
   * with two accounts.
   */
  constructor(
    identity: {
      id?: RuntimeId
      name?: string
      /** Overrides, for suites that need a runtime that cannot do something. */
      capabilities?: Partial<RuntimeCapabilities>
      /** Shared with any other fake given the same string; see `AgentRuntime.sessionStore`. */
      sessionStore?: string
      /** What `getAccount` calls this identity, so two accounts can be told apart. */
      accountLabel?: string
    } = {},
  ) {
    this.info = {
      ...this.info,
      id: identity.id ?? FAKE_RUNTIME_ID,
      name: identity.name ?? 'Fake Runtime',
      ...(identity.capabilities
        ? { capabilities: { ...this.info.capabilities, ...identity.capabilities } }
        : {}),
    }
    this.sessionStore = identity.sessionStore ?? null
    this.accountLabel = identity.accountLabel ?? 'API key'
  }

  readonly sessionStore: string | null
  readonly accountLabel: string

  readonly info: RuntimeInfo = {
    id: FAKE_RUNTIME_ID,
    name: 'Fake Runtime',
    version: '1.0.0',
    // Deliberately not 'responses': proves route compatibility is asked of
    // the runtime rather than assumed OpenAI-shaped.
    supportedWireProtocols: ['fakewire'],
    capabilities: {
      resume: true,
      fork: true,
      steer: true,
      interrupt: true,
      listHistory: true,
      searchHistory: true,
      imageInput: false,
      mcp: false,
      skills: false,
      plans: true,
      reasoning: true,
      // A local runtime with no account: exactly the case that catches a shell
      // assuming every runtime has credits and a login command.
      metered: false,
      account: false,
      goals: false,
      undo: false,
      compaction: false,
      memory: false,
      review: false,
      extensionStore: false,
      hooks: false,
      pluginTools: false,
      instructions: false,
      backgroundTasks: true,
      archiveHistory: true,
  nameHistory: true,
      deleteHistory: true,
    },
    presentation: {
      name: 'Fake Runtime',
      tagline: 'An in-memory runtime used by the host tests.',
    },
  }

  async start(): Promise<void> {
    if (this.accountNeedsStart) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs))
    }
    this.#started = true
    this.#setHealth({ state: 'ready' })
  }

  async dispose(): Promise<void> {
    this.#listeners.clear()
    this.#healthListeners.clear()
  }

  health(): RuntimeHealth {
    return this.#health
  }

  onHealthChange(listener: (health: RuntimeHealth) => void): Unsubscribe {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  /** Lets a test drive health transitions, e.g. to simulate a crash. */
  setHealth(health: RuntimeHealth): void {
    this.#setHealth(health)
  }

  #setHealth(health: RuntimeHealth): void {
    this.#health = health
    for (const listener of this.#healthListeners) listener(health)
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [
      {
        id: 'fake-1',
        displayName: 'Fake One',
        reasoningLevels: [],
        supportsImages: false,
        isDefault: true,
      },
      { id: 'fake-2', displayName: 'Fake Two', reasoningLevels: [], supportsImages: false },
    ]
  }

  /** One runtime-wide toggle, so the runtime-scope path is exercised too. */
  verboseLogs = false

  async listOptions(): Promise<readonly ConfigOption[]> {
    return [
      {
        type: 'boolean',
        id: 'verboseLogs',
        category: 'other',
        label: 'Verbose logs',
        currentValue: this.verboseLogs,
      },
    ]
  }

  /**
   * Pre-session defaults: the same deliberately un-Codex-shaped list a live
   * session declares, at its starting values. Keeping the fake on this path
   * is what proves the composer's pre-session controls are option-driven
   * rather than Codex-driven.
   */
  async defaultSessionOptions(
    _cwd?: string,
    values?: Readonly<Record<string, OptionValue>>,
  ): Promise<readonly ConfigOption[]> {
    const merged = defaultValues()
    for (const [key, value] of Object.entries(values ?? {})) {
      const option = findOption(optionsFor(merged), key)
      if (!option) throw new Error(`fake runtime has no session option ${key}`)
      const refusal = refuseOptionValue(option, value)
      if (refusal) throw new Error(refusal)
      merged[key] = value
    }
    return optionsFor(merged)
  }

  async setOption(id: string, value: OptionValue): Promise<void> {
    const option = findOption(await this.listOptions(), id)
    if (!option) throw new Error(`fake runtime has no option ${id}`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    this.verboseLogs = value as boolean
    this.emit({ type: 'runtime/options', runtime: FAKE_RUNTIME_ID, options: await this.listOptions() })
  }

  /**
   * Sign-in, scripted. The fake has no account by default (`capabilities.account`
   * is false) but can still be asked; a test flips `signInDriveable` to prove
   * the host relays whatever the runtime offers without naming it.
   */
  signInDriveable = false
  readonly logins: string[] = []
  readonly cancelled: string[] = []
  loggedOut = false
  /**
   * Refuses to say anything about its account until it has been started.
   *
   * What Codex actually does: its app-server answers neither `account/read`
   * nor `account/login/start` between spawn and ready, and says so
   * ("Cannot call account/read: app-server is starting"). A fake that always
   * answers cannot catch a caller that asks too early.
   */
  accountNeedsStart = false
  #started = false
  /**
   * How long `start` takes when `accountNeedsStart` is set.
   *
   * Not zero, and not a microtask: a real agent's start spawns a process and
   * exchanges an `initialize`, so anything that only awaits the promise chain
   * would find the fake already started and prove nothing.
   */
  startDelayMs = 20

  async getAccount(): Promise<AccountStatus> {
    if (this.accountNeedsStart && !this.#started) {
      throw new Error('Cannot call account/read: fake runtime is starting')
    }
    return {
      accounts: this.loggedOut ? [] : [{ kind: 'apiKey', label: this.accountLabel }],
      signInMethods: this.signInDriveable
        ? [{ id: 'fake-browser', label: 'Sign in with Fake', flow: 'browser' }]
        : [],
    }
  }

  async login(method: string): Promise<LoginStart> {
    if (this.accountNeedsStart && !this.#started) {
      throw new Error('Cannot call account/login/start: fake runtime is starting')
    }
    if (!this.signInDriveable) throw new Error('fake runtime cannot sign in')
    this.logins.push(method)
    return { type: 'browser', loginId: `login-${this.logins.length}`, url: 'https://fake.example/auth' }
  }

  // `this.info.id`, not the constant: a second account is a second fake with
  // an id of its own, and an event signed with the primary's id is one the
  // host would route to the wrong row. Nothing exercises it today; a test
  // that cancels a login on a second account would have found it the hard
  // way.
  async cancelLogin(loginId: string): Promise<void> {
    this.cancelled.push(loginId)
    this.emit({
      type: 'account/loginCompleted',
      runtime: this.info.id,
      loginId,
      success: false,
      error: 'cancelled',
    })
  }

  async logout(): Promise<void> {
    this.loggedOut = true
    this.emit({ type: 'account/changed', runtime: this.info.id })
  }

  async getRateLimits(): Promise<RateLimits | null> {
    return { hasCredits: true, unlimited: false, balance: 42 }
  }

  /** Threads this runtime archived itself, when it declares an archive. */
  readonly archived = new Set<string>()
  /** Names this runtime was asked to keep, when it declares it keeps them. */
  readonly titles: string[] = []

  async listSessions(query?: ListSessionsQuery): Promise<Page<SessionSummary>> {
    // A runtime with no archive of its own answers everything and lets the
    // host's marks decide, which is the path the ACP adapters take.
    if (!this.info.capabilities.archiveHistory) return { data: this.history, nextCursor: null }
    const only = query?.archived === 'only'
    return {
      data: this.history.filter((entry) => this.archived.has(String(entry.id)) === only),
      nextCursor: null,
    }
  }

  async searchSessions(query: string): Promise<Page<SessionSummary>> {
    return {
      data: this.history.filter((entry) => (entry.preview ?? '').includes(query)),
      nextCursor: null,
    }
  }

  /**
   * What the *store* says about a session, as opposed to what the live session
   * knows. Backends are behind whoever watched the events — a turn still
   * running is not in here yet, and one that just ended may not be either — so
   * a test scripts the lag it wants to reproduce.
   */
  readonly stored = new Map<string, Session['turns']>()

  /** What `readSession` throws instead of answering, for failure plumbing. */
  readFailure: Error | null = null

  /** A transcript read carries no controls, as a runtime's history read does not. */
  async readSession(id: SessionId): Promise<Session> {
    if (this.readFailure) throw this.readFailure
    const live = this.sessions.get(id)
    if (live) {
      const { options: _options, settings: _settings, ...transcript } = live.snapshot()
      const stored = this.stored.get(id)
      return stored ? { ...transcript, turns: stored, itemsLoaded: true } : transcript
    }
    const stored = this.stored.get(id)
    /* This runtime's own store, which is `history` — the rows `listSessions`
       answers with. A read is answered from it the way a real agent answers
       from the transcript on disk: with that conversation's folder and name,
       not with an invented one. It used to answer `/w` for every id including
       ones it had never issued, which made a phantom conversation read as a
       real one working somewhere else — a fixture that is not smaller than
       the real thing but differently shaped, and a test written against it
       proves the wrong sentence. */
    const known = this.history.find((entry) => entry.id === id)
    if (stored || known || this.minted.has(String(id))) {
      return {
        id,
        runtime: FAKE_RUNTIME_ID,
        cwd: known?.cwd ?? this.minted.get(String(id)) ?? '/w',
        ...(known?.title !== undefined ? { title: known.title } : {}),
        status: { type: 'idle' },
        createdAt: known?.createdAt ?? 0,
        updatedAt: known?.updatedAt ?? 0,
        turns: stored ?? [],
        itemsLoaded: true,
      }
    }
    // Every real agent refuses an id it has no record of, and the host's own
    // "there is no such conversation" paths depend on it doing so.
    throw new Error(`Fake Runtime has no record of conversation ${String(id)}.`)
  }

  async archiveSession(id: SessionId, archived: boolean): Promise<void> {
    if (!this.info.capabilities.archiveHistory) throw new Error('no archive of its own')
    if (archived) this.archived.add(String(id))
    else this.archived.delete(String(id))
  }

  /**
   * Every id this runtime has issued, whether or not it is still holding one.
   *
   * The agent's *store*, as far as reading goes. `history` is the listing
   * surface and a test fills it deliberately; this is the quieter fact that
   * an agent which minted a conversation still has it — across its own
   * restart, which clears `sessions` but does not make the conversation stop
   * existing. Without it `readSession` refused an id `resumeSession` would
   * happily have answered, which is a shape no real agent has.
   *
   * The value is the folder it works in, because that is the fact a read is
   * asked for and inventing one is how a fixture starts proving the wrong
   * sentence: a conversation created in the test's workspace read back as
   * living in `/w`, and the room refused it for being in another project.
   */
  readonly minted = new Map<string, string>()

  /** Session ids this runtime was asked to delete, in order. */
  readonly deleted: string[] = []

  async deleteSession(id: SessionId): Promise<SessionDeletion> {
    if (!this.info.capabilities.deleteHistory) throw new Error('cannot delete')
    this.deleted.push(String(id))
    this.minted.delete(String(id))
    const at = this.history.findIndex((entry) => entry.id === id)
    if (at >= 0) this.history.splice(at, 1)
    this.archived.delete(String(id))
    return { disposition: 'removed', removed: 1 }
  }

  /** What the host handed the last createSession, for route-resolution tests. */
  lastCreateOptions: SessionOptions | null = null

  async createSession(options: SessionOptions): Promise<AgentSession> {
    this.lastCreateOptions = options
    this.#counter += 1
    const id = sessionId(`fake-session-${this.#counter}`)
    const values = defaultValues()
    if (options.model) values['model'] = options.model
    for (const [key, value] of Object.entries(options.options ?? {})) {
      const option = findOption(optionsFor(values), key)
      if (!option) throw new Error(`fake runtime has no option ${key}`)
      const refusal = refuseOptionValue(option, value)
      if (refusal) throw new Error(refusal)
      values[key] = value
    }
    const session = new FakeSession(this, id, { cwd: options.cwd, model: String(values['model']) }, values)
    this.sessions.set(id, session)
    this.minted.set(String(id), options.cwd)
    this.emit({ type: 'session/started', session: session.snapshot() })
    return session
  }

  /** What `resumeSession` throws instead of answering, for failure plumbing. */
  resumeFailure: Error | null = null

  /** How many times a resume was actually asked for, for the callers that share one. */
  resumes = 0

  async resumeSession(id: SessionId): Promise<AgentSession> {
    this.resumes += 1
    if (this.resumeFailure) throw this.resumeFailure
    const existing = this.sessions.get(id)
    if (existing) return existing
    const session = new FakeSession(this, id, SETTINGS, defaultValues())
    this.sessions.set(id, session)
    if (!this.minted.has(String(id))) this.minted.set(String(id), SETTINGS.cwd)
    this.emit({ type: 'session/started', session: session.snapshot() })
    return session
  }

  async forkSession(id: SessionId): Promise<AgentSession> {
    return this.createSession({ cwd: this.sessions.get(id)?.settings().cwd ?? '/w' })
  }
}

export class FakeSession implements AgentSession {
  #settings: SessionSettings
  #turn = 0
  #activeTurn: TurnId | null = null
  #pendingApproval: { id: ApprovalId; resolve: (decision: ApprovalDecision) => void } | null = null
  title: string | null = null
  readonly decisions: ApprovalDecision[] = []

  #values: Record<string, OptionValue>

  constructor(
    private readonly host: FakeRuntime,
    readonly id: SessionId,
    settings: SessionSettings,
    values: Record<string, OptionValue>,
  ) {
    this.#settings = settings
    this.#values = values
  }

  options(): readonly ConfigOption[] {
    return optionsFor(this.#values)
  }

  async setOption(id: string, value: OptionValue): Promise<void> {
    const option = findOption(this.options(), id)
    if (!option) throw new Error(`fake session has no option ${id}`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    this.#values = { ...this.#values, [id]: value }
    if (id === 'model') {
      this.#settings = { ...this.#settings, model: String(value) }
      this.host.emit({ type: 'session/settings', sessionId: this.id, settings: this.#settings })
    }
    this.host.emit({ type: 'session/options', sessionId: this.id, options: this.options() })
  }

  get runtime(): typeof FAKE_RUNTIME_ID {
    return FAKE_RUNTIME_ID
  }

  settings(): SessionSettings {
    return this.#settings
  }

  snapshot(): Session {
    return {
      id: this.id,
      runtime: FAKE_RUNTIME_ID,
      title: this.title,
      cwd: this.#settings.cwd,
      status: { type: this.#activeTurn ? 'active' : 'idle' },
      createdAt: 0,
      updatedAt: 0,
      settings: this.#settings,
      options: this.options(),
      turns: [],
      itemsLoaded: true,
    }
  }

  /**
   * How long the agent takes to accept a message. Zero by default; a test
   * that needs the window between "sent" and "the turn has started" to be
   * wide enough to land a second request in sets it.
   */
  sendDelayMs = 0
  /** Thrown by the next `send`, once — a turn the agent never accepted. */
  sendFailure: Error | null = null

  async send(input: readonly UserContent[]): Promise<TurnId> {
    if (this.sendFailure) {
      const failure = this.sendFailure
      this.sendFailure = null
      throw failure
    }
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs))
    this.#turn += 1
    const id = turnId(`fake-turn-${this.#turn}`)
    this.#activeTurn = id
    this.host.emit({
      type: 'turn/started',
      sessionId: this.id,
      turn: { id, items: [], status: 'inProgress' },
    })
    const first = input[0]
    this.host.emit({
      type: 'item/started',
      sessionId: this.id,
      turnId: id,
      item: { id: itemId(`u-${this.#turn}`), type: 'userMessage', content: [...input] },
    })
    this.host.emit({
      type: 'item/started',
      sessionId: this.id,
      turnId: id,
      item: { id: itemId(`a-${this.#turn}`), type: 'assistantMessage', text: '' },
    })
    this.host.emit({
      type: 'item/delta',
      sessionId: this.id,
      turnId: id,
      itemId: itemId(`a-${this.#turn}`),
      delta: {
        kind: 'assistantText',
        text: first?.type === 'text' ? `echo: ${first.text}` : 'echo',
      },
    })
    return id
  }

  /** Completes the turn. Tests call this so timing is deterministic. */
  finish(): void {
    if (!this.#activeTurn) return
    const id = this.#activeTurn
    this.#activeTurn = null
    this.host.emit({
      type: 'turn/completed',
      sessionId: this.id,
      turn: { id, items: [], status: 'completed' },
    })
  }

  /** Ends the turn badly — a rate limit, a dead backend — with its own words. */
  fail(message: string): void {
    if (!this.#activeTurn) return
    const id = this.#activeTurn
    this.#activeTurn = null
    this.host.emit({
      type: 'turn/completed',
      sessionId: this.id,
      turn: { id, items: [], status: 'failed', error: { message } },
    })
  }

  /** Raises an approval and returns a promise that settles when it is answered. */
  askApproval(id: ApprovalId): Promise<ApprovalDecision> {
    const approval: Approval = {
      id,
      sessionId: this.id,
      requestedAt: Date.now(),
      type: 'command',
      command: 'rm -rf build',
      cwd: '/w',
      actions: [],
      options: [
        { id: 'opt-0', label: 'Allow', intent: 'approve' },
        { id: 'opt-1', label: 'Deny', intent: 'deny' },
      ],
    }
    return new Promise((resolve) => {
      this.#pendingApproval = { id, resolve }
      this.host.emit({ type: 'approval/requested', approval })
    })
  }

  async steer(input: readonly UserContent[]): Promise<void> {
    if (!this.#activeTurn) throw new Error('no turn is currently running')
    const first = input[0]
    this.host.emit({
      type: 'item/delta',
      sessionId: this.id,
      turnId: this.#activeTurn,
      itemId: itemId(`a-${this.#turn}`),
      delta: { kind: 'assistantText', text: first?.type === 'text' ? ` +${first.text}` : '' },
    })
  }

  async interrupt(): Promise<void> {
    if (!this.#activeTurn) throw new Error('no turn is currently running')
    const id = this.#activeTurn
    this.#activeTurn = null
    this.host.emit({
      type: 'turn/completed',
      sessionId: this.id,
      turn: { id, items: [], status: 'interrupted' },
    })
  }

  async respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const pending = this.#pendingApproval
    if (!pending || pending.id !== id) throw new Error(`No approval is pending with id ${id}`)
    this.#pendingApproval = null
    this.decisions.push(decision)
    this.host.emit({
      type: 'approval/resolved',
      sessionId: this.id,
      approvalId: id,
      resolution: { outcome: 'decided', decision },
    })
    pending.resolve(decision)
  }

  async updateSettings(patch: Partial<SessionSettings>): Promise<void> {
    if (patch.model !== undefined) await this.setOption('model', patch.model)
    this.#settings = { ...this.#settings, ...patch }
    this.host.emit({ type: 'session/settings', sessionId: this.id, settings: this.#settings })
  }

  async setTitle(title: string): Promise<void> {
    this.title = title
    this.host.titles.push(title)
    this.host.emit({ type: 'session/title', sessionId: this.id, title })
  }

  async close(): Promise<void> {
    this.host.emit({ type: 'session/closed', sessionId: this.id })
  }
}
