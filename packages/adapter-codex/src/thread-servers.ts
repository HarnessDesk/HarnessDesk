import {
  CodexAppServer, CodexError,
  type CodexAppServerOptions, type CodexMethod, type CodexParams, type CodexResult,
  type CodexProtocol, type ServerRequestResponder, type Unsubscribe,
} from '@harnessdesk/codex'

interface Worker {
  readonly server: CodexAppServer
  readonly roots: Set<string>
  readonly threads: Set<string>
  readonly subscriptions: Unsubscribe[]
  opening: number
  stopping?: Promise<void>
}

/**
 * The control process never loads a conversation. Each new root gets a fresh
 * process, so releasing it can reclaim retained tools without stopping another
 * root. Forks also receive a fresh owner; delegated threads remain with their
 * root. All processes read the same agent-owned history and config.
 */
export class CodexThreadServers extends CodexAppServer {
  readonly #workers = new Set<Worker>()
  readonly #owners = new Map<string, Worker>()
  readonly #notifications = new Set<(notification: CodexProtocol.ServerNotification) => void>()
  readonly #requests = new Set<(request: CodexProtocol.ServerRequest, responder: ServerRequestResponder) => void>()
  readonly #logs = new Set<(line: string) => void>()
  readonly #busyListeners = new Set<(busy: boolean) => void>()
  readonly #testGroup: string | undefined
  readonly #testGenerationEnabled: boolean
  #generation = 0
  #stopped = true
  #epoch = 0

  constructor(options: CodexAppServerOptions, private readonly lost: (threads: readonly string[]) => void) {
    super(options)
    this.#testGroup = options.env?.['HARNESSDESK_CODEX_PROCESS_GROUP'] ?? process.env['HARNESSDESK_CODEX_PROCESS_GROUP']
    const initialGeneration = options.env?.['HARNESSDESK_CODEX_GENERATION'] ?? process.env['HARNESSDESK_CODEX_GENERATION']
    this.#testGenerationEnabled = initialGeneration !== undefined
    this.#generation = Number(initialGeneration ?? 0)
    super.onNotification((notification) => { for (const listener of this.#notifications) listener(notification) })
    super.onServerRequest((request, responder) => { for (const listener of this.#requests) listener(request, responder) })
    super.onLog((line) => { for (const listener of this.#logs) listener(line) })
    this.workerOptions = options
  }
  private readonly workerOptions: CodexAppServerOptions

  override onNotification(listener: (notification: CodexProtocol.ServerNotification) => void): Unsubscribe {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }
  override onServerRequest(listener: (request: CodexProtocol.ServerRequest, responder: ServerRequestResponder) => void): Unsubscribe {
    this.#requests.add(listener)
    return () => this.#requests.delete(listener)
  }
  override onLog(listener: (line: string) => void): Unsubscribe {
    this.#logs.add(listener)
    return () => this.#logs.delete(listener)
  }
  onBusyChange(listener: (busy: boolean) => void): Unsubscribe {
    this.#busyListeners.add(listener)
    return () => this.#busyListeners.delete(listener)
  }
  override async start(): Promise<void> {
    this.#stopped = false
    await super.start()
  }
  override async stop(): Promise<void> {
    this.#stopped = true
    this.#epoch++
    await Promise.all([...this.#workers].map((worker) => this.#stopWorker(worker)))
    await super.stop()
  }

  override async request<M extends CodexMethod>(method: M, params: CodexParams<M>, options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<CodexResult<M>> {
    // These verbs update process-local tool/config state. Shared files alone
    // do not reload the servers or skill settings of already open threads.
    if (method === 'config/mcpServer/reload' || method === 'skills/config/write' ||
      method === 'plugin/install' || method === 'plugin/uninstall' || method === 'mcpServer/oauth/login') {
      const workers = [...this.#workers].filter((worker) => worker.roots.size > 0 && !worker.stopping)
      const result = await super.request(method, params, options)
      await Promise.all(workers.map(async (worker) => {
        if (!worker.stopping) await worker.server.request(method, params, options)
      }))
      return result
    }
    const id = params && typeof params === 'object' && 'threadId' in params && typeof params.threadId === 'string'
      ? params.threadId : undefined
    const opening = method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork'
    let worker = id && method !== 'thread/fork' ? this.#owners.get(id) : undefined
    if (!opening && !worker) return super.request(method, params, options)
    if (this.#stopped || (opening && this.state.type !== 'ready')) throw new CodexError('notRunning', 'The runtime is not running.')
    // Every new root has a fresh owner; an existing root resumes on its owner.
    if (!worker) worker = this.#newWorker()
    if (opening) worker.opening++
    const epoch = this.#epoch
    try {
      await worker.server.start()
      if (this.#stopped || epoch !== this.#epoch || worker.stopping) {
        throw new CodexError('notRunning', opening
          ? 'The runtime stopped while opening the conversation.'
          : 'The conversation process stopped while handling the request.')
      }
      const result = await worker.server.request(method, params, options)
      if (this.#stopped || epoch !== this.#epoch || worker.stopping) {
        throw new CodexError('notRunning', opening
          ? 'The runtime stopped while opening the conversation.'
          : 'The conversation process stopped while handling the request.')
      }
      if (opening && result && typeof result === 'object' && 'thread' in result) {
        const thread = result.thread as CodexProtocol.v2.Thread
        worker.roots.add(thread.id)
        worker.threads.add(thread.id)
        this.#owners.set(thread.id, worker)
      }
      return result
    } finally {
      if (opening) {
        const wasBusy = this.busy
        worker.opening--
        this.#notifyBusyChange(wasBusy)
        if (worker.roots.size === 0 && worker.opening === 0) await this.#stopWorker(worker)
      }
    }
  }

  /** A handle stays bound to its process even after the same id reopens. */
  thread(id: string): { readonly server: CodexAppServer; readonly release: () => Promise<void> } {
    const worker = this.#owners.get(id)
    if (!worker) throw new CodexError('notRunning', 'The conversation process is no longer running.')
    return { server: worker.server, release: async () => {
      const wasBusy = this.busy
      worker.roots.delete(id)
      this.#notifyBusyChange(wasBusy)
      if (worker.roots.size === 0 && worker.opening === 0) await this.#stopWorker(worker)
    } }
  }

  get busy(): boolean {
    return [...this.#workers].some((worker) => worker.roots.size > 0 || worker.opening > 0)
  }

  #newWorker(): Worker {
    const generation = ++this.#generation
    const env: Record<string, string> = { ...this.workerOptions.env }
    if (this.#testGenerationEnabled && this.#testGroup !== undefined) {
      env['HARNESSDESK_CODEX_PROCESS_GROUP'] = this.#testGroup
      env['HARNESSDESK_CODEX_GENERATION'] = String(generation)
    }
    const worker: Worker = {
      server: new CodexAppServer({ ...this.workerOptions, maxRestarts: 0,
        ...(Object.keys(env).length > 0 ? { env } : {}) }),
      roots: new Set(), threads: new Set(), subscriptions: [], opening: 0,
    }
    this.#workers.add(worker)
    worker.subscriptions.push(
      worker.server.onNotification((notification) => {
        if (notification.method === 'thread/started') {
          const id = notification.params.thread.id
          worker.threads.add(id)
          this.#owners.set(id, worker)
        }
        for (const listener of this.#notifications) listener(notification)
      }),
      worker.server.onServerRequest((request, responder) => {
        // RPC request ids are unique only within one process. The responder
        // keeps the original id; the shared approval router sees this namespace.
        const scoped = { ...request, id: `${generation}/${request.id}` }
        for (const listener of this.#requests) listener(scoped, responder)
      }),
      worker.server.onLog((line) => { for (const listener of this.#logs) listener(line) }),
      worker.server.onStateChange((state) => {
        if (state.type !== 'failed' || worker.stopping) return
        this.lost([...worker.roots])
        void this.#stopWorker(worker)
      }),
    )
    return worker
  }

  #stopWorker(worker: Worker): Promise<void> {
    if (worker.stopping) return worker.stopping
    const wasBusy = this.busy
    // Unsubscribe before stopping: exit is local to these threads, never a
    // runtime-wide health change that would detach the other workers.
    for (const unsubscribe of worker.subscriptions) unsubscribe()
    for (const id of worker.threads) if (this.#owners.get(id) === worker) this.#owners.delete(id)
    worker.stopping = worker.server.stop().finally(() => {
      this.#workers.delete(worker)
      this.#notifyBusyChange(wasBusy)
    })
    return worker.stopping
  }

  #notifyBusyChange(wasBusy: boolean): void {
    const busy = this.busy
    if (busy === wasBusy) return
    for (const listener of this.#busyListeners) listener(busy)
  }
}
