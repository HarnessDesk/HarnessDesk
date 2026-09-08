import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

import { requireCodex, type CodexInstallation } from './discovery.js'
import { CodexError, CodexRpcError } from './errors.js'
import { NdjsonDecoder, encodeLine } from './framing.js'
import type { CodexMethod, CodexParams, CodexResult } from './methods.js'
import type {
  ClientInfo,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from './generated/index.js'

/**
 * Owns one `codex app-server` process and speaks its JSON-RPC dialect.
 *
 * Everything about the transport lives here: framing, id correlation, timeouts,
 * crash detection, restart. Layers above see a typed `request` and an event
 * stream, and never a process.
 *
 * Transport choice is deliberate. Codex also offers a WebSocket listener, but
 * OpenAI marks it experimental, and stdio keeps process ownership, credential
 * boundaries, and lifecycle on our side of the wire.
 */

export type Unsubscribe = () => void

export type ConnectionState =
  | { readonly type: 'stopped' }
  | { readonly type: 'starting' }
  | { readonly type: 'ready'; readonly installation: CodexInstallation; readonly info: InitializeResponse }
  | { readonly type: 'restarting'; readonly attempt: number; readonly reason: string }
  | { readonly type: 'failed'; readonly error: CodexError }

export interface CodexLogger {
  debug?(message: string, details?: unknown): void
  info?(message: string, details?: unknown): void
  warn?(message: string, details?: unknown): void
  error?(message: string, details?: unknown): void
}

export interface CodexAppServerOptions {
  readonly clientInfo: ClientInfo
  /** Skip discovery and use this binary. */
  readonly binaryPath?: string | null
  /** Overrides `CODEX_HOME`; leave unset so Codex uses the user's real `~/.codex`. */
  readonly codexHome?: string | null
  /** `-c key=value` pairs applied to every session this process serves. */
  readonly configOverrides?: readonly string[]
  readonly experimentalApi?: boolean
  /** Notification methods to suppress at the source, to cut chatter we ignore. */
  readonly optOutNotifications?: readonly string[]
  readonly requestTimeoutMs?: number
  readonly maxRestarts?: number
  readonly logger?: CodexLogger
  readonly env?: Readonly<Record<string, string>>
}

/** Responder handed to server-request listeners; exactly one call takes effect. */
export interface ServerRequestResponder {
  respond(result: unknown): void
  fail(code: number, message: string, data?: unknown): void
}

interface PendingRequest {
  readonly method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESTARTS = 5
const RESTART_BASE_DELAY_MS = 500
const RESTART_MAX_DELAY_MS = 15_000

export class CodexAppServer {
  #child: ChildProcessWithoutNullStreams | null = null
  #installation: CodexInstallation | null = null
  #state: ConnectionState = { type: 'stopped' }
  #nextId = 0
  #pending = new Map<number, PendingRequest>()
  #decoder: NdjsonDecoder
  #notificationListeners = new Set<(notification: ServerNotification) => void>()
  #serverRequestListeners = new Set<
    (request: ServerRequest, responder: ServerRequestResponder) => void
  >()
  #stateListeners = new Set<(state: ConnectionState) => void>()
  #logListeners = new Set<(line: string) => void>()
  #restarts = 0
  /** Set while `stop()` is unwinding, so exit handling does not try to restart. */
  #shuttingDown = false
  #startPromise: Promise<void> | null = null

  constructor(private readonly options: CodexAppServerOptions) {
    this.#decoder = new NdjsonDecoder({
      onMalformedLine: (line, error) =>
        this.options.logger?.warn?.('app-server wrote an unparsable stdout line', {
          line: line.slice(0, 512),
          error: String(error),
        }),
    })
  }

  get state(): ConnectionState {
    return this.#state
  }

  get installation(): CodexInstallation | null {
    return this.#installation
  }

  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  onNotification(listener: (notification: ServerNotification) => void): Unsubscribe {
    this.#notificationListeners.add(listener)
    return () => this.#notificationListeners.delete(listener)
  }

  onServerRequest(
    listener: (request: ServerRequest, responder: ServerRequestResponder) => void,
  ): Unsubscribe {
    this.#serverRequestListeners.add(listener)
    return () => this.#serverRequestListeners.delete(listener)
  }

  /** Raw stderr, which is where Codex writes its tracing output. */
  onLog(listener: (line: string) => void): Unsubscribe {
    this.#logListeners.add(listener)
    return () => this.#logListeners.delete(listener)
  }

  /** Idempotent: concurrent callers share one startup. */
  async start(): Promise<void> {
    if (this.#state.type === 'ready') return
    if (this.#startPromise) return this.#startPromise
    this.#startPromise = this.#startOnce().finally(() => {
      this.#startPromise = null
    })
    return this.#startPromise
  }

  async #startOnce(): Promise<void> {
    this.#shuttingDown = false
    this.#setState({ type: 'starting' })
    try {
      const installation = await requireCodex(this.options.binaryPath ?? null)
      this.#installation = installation
      await this.#spawnAndHandshake(installation)
      this.#restarts = 0
    } catch (error) {
      const wrapped =
        error instanceof CodexError
          ? error
          : new CodexError('spawnFailed', `Could not start codex app-server: ${String(error)}`)
      // Unless a stop is what ended it: `stop()` has already set the state
      // that is true, and `failed` over the top of it would show an agent
      // somebody deliberately stopped as one that is broken.
      if (!this.#shuttingDown) this.#setState({ type: 'failed', error: wrapped })
      throw wrapped
    }
  }

  async #spawnAndHandshake(installation: CodexInstallation): Promise<void> {
    /*
      The last gate before the process exists, and welded to the spawn for the
      reason `CodexRuntime.#spawnServer` gives: a guard a few lines above a
      spawn is sized for the awaits that are there today.

      Both callers ask the machine a question before they get here, and the
      answer arrives long after the question. `#startOnce` awaits
      `requireCodex`; `#restart` awaits a backoff and then `requireCodex`, and
      it guards after the backoff but not after the lookup. So a `stop()` —
      the app quitting, most often — could land in either gap, take a
      `#child` that was still null, return at once believing there was nothing
      to end, and leave the woken start to spawn an app-server, and every MCP
      server Codex launches behind it, into a shutdown that had already
      finished. One check here covers both, and whatever calls this next.

      `#shuttingDown` is the right question rather than a new flag of its own:
      `stop()` sets it as its first statement, before it can yield, and
      `#startOnce` clears it at the top of every deliberate start — so a stop
      that overtakes a start wins, and a restart that follows one is not
      refused.
    */
    if (this.#shuttingDown) {
      throw new CodexError('notRunning', 'The app-server was stopped while it was starting.')
    }
    const args = ['app-server']
    for (const override of this.options.configOverrides ?? []) args.push('-c', override)

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env }
    if (this.options.codexHome) env['CODEX_HOME'] = this.options.codexHome

    const child = spawn(installation.path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }) as ChildProcessWithoutNullStreams

    this.#child = child
    this.#decoder.reset()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length === 0) continue
        for (const listener of this.#logListeners) listener(line)
      }
    })
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (error) => {
      this.options.logger?.error?.('app-server process error', { error: String(error) })
    })
    // A write after the app-server has gone is EPIPE on its stdin, which an
    // unheard stream raises as an uncaught exception in the host.
    child.stdin.on('error', (error) => {
      this.options.logger?.warn?.('app-server stdin', { error: String(error) })
    })

    // A spawn failure surfaces as an `error` event rather than a rejection, so
    // race the handshake against it instead of assuming the pipe is live.
    const spawned = Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => {
        throw new CodexError('spawnFailed', `Failed to spawn ${installation.path}: ${String(error)}`)
      }),
    ])
    await spawned

    const info = await this.#call<'initialize'>(
      'initialize',
      {
        clientInfo: this.options.clientInfo,
        capabilities: {
          experimentalApi: this.options.experimentalApi ?? true,
          requestAttestation: false,
          optOutNotificationMethods: [...(this.options.optOutNotifications ?? [])],
        },
      },
      { timeoutMs: 30_000 },
    )

    this.#write({ method: 'initialized', params: undefined })
    this.#setState({ type: 'ready', installation, info })
    this.options.logger?.info?.('codex app-server ready', {
      version: installation.version,
      codexHome: info.codexHome,
    })
  }

  async stop(): Promise<void> {
    this.#shuttingDown = true
    const child = this.#child
    this.#child = null
    this.#rejectAllPending(new CodexError('notRunning', 'app-server is shutting down'))
    this.#setState({ type: 'stopped' })
    if (!child || child.exitCode !== null) return

    child.stdin.end()
    const exited = once(child, 'exit')
    // Give it a moment to drain, then escalate rather than leaking the process.
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }

  /** Sends a request and resolves with its typed result. */
  request<M extends CodexMethod>(
    method: M,
    params: CodexParams<M>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<CodexResult<M>> {
    if (this.#state.type !== 'ready') {
      return Promise.reject(
        new CodexError('notRunning', `Cannot call ${method}: app-server is ${this.#state.type}`),
      )
    }
    return this.#call(method, params, options)
  }

  #call<M extends CodexMethod>(
    method: M,
    params: CodexParams<M>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<CodexResult<M>> {
    const id = ++this.#nextId
    const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<CodexResult<M>>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      }

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new CodexError('timeout', `${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        entry.timer.unref?.()
      }

      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new CodexError('cancelled', `${method} was cancelled before it was sent`))
          return
        }
        options.signal.addEventListener(
          'abort',
          () => {
            const found = this.#pending.get(id)
            if (!found) return
            this.#pending.delete(id)
            if (found.timer) clearTimeout(found.timer)
            reject(new CodexError('cancelled', `${method} was cancelled`))
          },
          { once: true },
        )
      }

      this.#pending.set(id, entry)
      try {
        this.#write({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        if (entry.timer) clearTimeout(entry.timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Fire-and-forget notification. */
  notify(method: string, params: unknown): void {
    this.#write({ method, params })
  }

  #write(message: unknown): void {
    const child = this.#child
    if (!child || child.stdin.destroyed) {
      throw new CodexError('notRunning', 'app-server stdin is not writable')
    }
    child.stdin.write(encodeLine(message))
  }

  #onStdout(chunk: string): void {
    let messages: unknown[]
    try {
      messages = this.#decoder.push(chunk)
    } catch (error) {
      this.options.logger?.error?.('app-server framing error', { error: String(error) })
      this.#decoder.reset()
      return
    }
    for (const message of messages) this.#dispatch(message)
  }

  #dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const record = message as Record<string, unknown>
    const hasId = typeof record['id'] === 'number' || typeof record['id'] === 'string'
    const hasMethod = typeof record['method'] === 'string'

    if (hasId && !hasMethod) {
      this.#resolveResponse(record)
      return
    }
    if (hasId && hasMethod) {
      this.#handleServerRequest(record)
      return
    }
    if (hasMethod) {
      const notification = record as unknown as ServerNotification
      for (const listener of this.#notificationListeners) {
        try {
          listener(notification)
        } catch (error) {
          this.options.logger?.error?.('notification listener threw', { error: String(error) })
        }
      }
    }
  }

  #resolveResponse(record: Record<string, unknown>): void {
    const id = Number(record['id'])
    const entry = this.#pending.get(id)
    if (!entry) {
      // Late response to something we already timed out or cancelled.
      this.options.logger?.debug?.('dropping response for unknown request id', { id })
      return
    }
    this.#pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)

    const error = record['error']
    if (error !== undefined && error !== null) {
      const shape = error as { code?: number; message?: string; data?: unknown }
      entry.reject(
        new CodexRpcError(
          shape.code ?? -1,
          shape.message ?? `${entry.method} failed`,
          shape.data,
        ),
      )
      return
    }
    entry.resolve(record['result'])
  }

  #handleServerRequest(record: Record<string, unknown>): void {
    const id = record['id']
    let answered = false
    const responder: ServerRequestResponder = {
      respond: (result) => {
        if (answered) return
        answered = true
        try {
          this.#write({ id, result })
        } catch (error) {
          this.options.logger?.warn?.('could not answer server request', { error: String(error) })
        }
      },
      fail: (code, message, data) => {
        if (answered) return
        answered = true
        try {
          this.#write({ id, error: { code, message, data } })
        } catch (error) {
          this.options.logger?.warn?.('could not answer server request', { error: String(error) })
        }
      },
    }

    if (this.#serverRequestListeners.size === 0) {
      // Silence is worse than a refusal: an unanswered approval hangs the turn.
      responder.fail(-32601, 'No handler is registered for server-initiated requests')
      return
    }
    for (const listener of this.#serverRequestListeners) {
      try {
        listener(record as unknown as ServerRequest, responder)
      } catch (error) {
        this.options.logger?.error?.('server request listener threw', { error: String(error) })
        responder.fail(-32603, 'Client handler failed')
      }
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const reason = `app-server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
    this.#child = null
    this.#rejectAllPending(new CodexError('crashed', reason))

    if (this.#shuttingDown) {
      this.#setState({ type: 'stopped' })
      return
    }

    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS
    if (this.#restarts >= maxRestarts) {
      this.#setState({
        type: 'failed',
        error: new CodexError('crashed', `${reason}; giving up after ${maxRestarts} restarts`),
      })
      return
    }

    this.#restarts += 1
    this.#setState({ type: 'restarting', attempt: this.#restarts, reason })
    void this.#restart()
  }

  async #restart(): Promise<void> {
    const backoff = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** (this.#restarts - 1),
      RESTART_MAX_DELAY_MS,
    )
    this.options.logger?.warn?.('restarting codex app-server', {
      attempt: this.#restarts,
      backoffMs: backoff,
    })
    await delay(backoff)
    if (this.#shuttingDown) return
    try {
      const installation = this.#installation ?? (await requireCodex(this.options.binaryPath ?? null))
      this.#installation = installation
      await this.#spawnAndHandshake(installation)
    } catch (error) {
      const wrapped =
        error instanceof CodexError
          ? error
          : new CodexError('spawnFailed', `Restart failed: ${String(error)}`)
      // As above: a shutdown that overtook the restart is not a failed restart.
      if (!this.#shuttingDown) this.#setState({ type: 'failed', error: wrapped })
    }
  }

  #rejectAllPending(error: CodexError): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  #setState(state: ConnectionState): void {
    this.#state = state
    for (const listener of this.#stateListeners) {
      try {
        listener(state)
      } catch (error) {
        this.options.logger?.error?.('state listener threw', { error: String(error) })
      }
    }
  }
}
