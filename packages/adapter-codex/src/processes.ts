import { randomUUID } from 'node:crypto'

import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'
import type {
  RuntimeProcess,
  RuntimeProcesses,
  SessionId,
  TerminalSize,
  Unsubscribe,
} from '@harnessdesk/protocol'

/**
 * How many exited processes stay addressable for output that arrives after
 * their response.
 *
 * The response is not the end of the output. `command/exec` answers when the
 * child exits, which is not when the child's stdout has drained, and nothing
 * in the protocol orders the response against that process's own
 * `command/exec/outputDelta`s — so a trailing chunk legally arrives after it.
 * Dropping the process at exit sends those bytes to a lookup miss in
 * `dispatch`, silently.
 *
 * A straggler follows its own response by a transport hop, so "until several
 * more processes have exited" is already far wider than the window that
 * matters. A count rather than a timer: it puts no wall-clock in a path the
 * tests have to reason about, and it bounds the map, which is the job
 * `#running.delete` was doing.
 */
const DRAIN_SLOTS = 8

/**
 * Sandboxed processes over `command/exec`.
 *
 * `command/exec` runs "in the server sandbox" — Codex's own words — with a
 * PTY when asked, stdin streaming, resize and terminate. Observed on 0.135.0
 * under `:read-only` it refused to touch even the working directory; under
 * `:workspace` it wrote there, refused the home directory, and had no
 * network. `process/spawn` is the other primitive and is documented as
 * running *without* a sandbox; a probe confirmed it can write to `~`. That
 * is why the terminal is built on this one, with the conversation's own
 * permission profile.
 *
 * The request's response is deferred until the process exits, so the RPC is
 * sent with no timeout and its settlement is the exit signal.
 */
export class CodexProcesses implements RuntimeProcesses {
  readonly #running = new Map<string, CodexProcess>()
  /** Exited processes, oldest first, still inside their drain window. */
  readonly #drained = new Map<string, CodexProcess>()

  constructor(
    private readonly server: CodexAppServer,
    /** The permission profile a conversation is on, so its terminal matches. */
    private readonly permissionsOf: (session: SessionId) => string | undefined,
  ) {}

  async spawn(options: {
    readonly cwd: string
    readonly command: readonly string[]
    readonly tty: boolean
    readonly size?: TerminalSize
    readonly session?: SessionId
  }): Promise<RuntimeProcess> {
    const processId = randomUUID()
    const process = new CodexProcess(this.server, processId, () => this.#retire(processId))
    // Registered before the request: output can arrive before the spawn
    // request is even acknowledged, since the response only comes at exit.
    this.#running.set(processId, process)
    const profile = options.session ? this.permissionsOf(options.session) : undefined
    const exit = this.server.request(
      'command/exec',
      {
        command: [...options.command],
        processId,
        cwd: options.cwd,
        tty: options.tty,
        streamStdin: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        disableOutputCap: true,
        ...(options.size ? { size: options.size } : {}),
        ...(profile ? { permissionProfile: profile } : {}),
      },
      { timeoutMs: 0 },
    )
    process.watch(exit)
    // A spawn that fails outright — bad cwd, refused command — rejects the
    // deferred response immediately; surface that as a spawn error rather
    // than a process that exited before it started.
    const started = await Promise.race([
      exit.then(() => 'exited' as const, (error: unknown) => ({ error })),
      new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), 150)),
    ])
    if (typeof started === 'object') {
      // A rejected response has already run `watch`'s handler, which retired
      // this into the drain window; nothing will ever be sent to a process
      // that never started, so drop it from both maps rather than let it
      // hold a slot.
      this.#forget(processId)
      throw started.error instanceof Error ? started.error : new Error(String(started.error))
    }
    return process
  }

  /** Called by the runtime for every `command/exec/outputDelta`. */
  dispatch(notification: CodexProtocol.v2.CommandExecOutputDeltaNotification): void {
    const process =
      this.#running.get(notification.processId) ?? this.#drained.get(notification.processId)
    process?.output(notification)
  }

  /** The app-server is gone; every process with it. */
  abandon(): void {
    // `lost()` retires each one, so iterate a snapshot rather than the map.
    for (const process of [...this.#running.values()]) process.lost()
    // Nothing can arrive from a server that is gone, so every drain window is
    // over at once.
    for (const process of this.#drained.values()) process.release()
    this.#running.clear()
    this.#drained.clear()
  }

  /** A process exited: keep it addressable for its drain window. */
  #retire(processId: string): void {
    const process = this.#running.get(processId)
    if (!process) return
    this.#running.delete(processId)
    this.#drained.set(processId, process)
    while (this.#drained.size > DRAIN_SLOTS) {
      const oldest = this.#drained.keys().next()
      if (oldest.done) break
      this.#drained.get(oldest.value)?.release()
      this.#drained.delete(oldest.value)
    }
  }

  /** Nothing will ever be routed here again; drop it from both maps. */
  #forget(processId: string): void {
    const process = this.#running.get(processId) ?? this.#drained.get(processId)
    this.#running.delete(processId)
    this.#drained.delete(processId)
    process?.release()
  }
}

class CodexProcess implements RuntimeProcess {
  readonly #outputListeners = new Set<(stream: 'stdout' | 'stderr', data: Uint8Array) => void>()
  readonly #exitListeners = new Set<(exitCode: number) => void>()
  /**
   * Output that arrived before anyone listened. `spawn` deliberately holds
   * its caller for up to 150ms to distinguish a refusal from a process, and
   * a fast command says everything it will ever say inside that window —
   * without this buffer, `echo` exits 0 with its words dropped on the floor.
   * Flushed to the first listener, in order, even after exit.
   */
  #pending: { stream: 'stdout' | 'stderr'; data: Uint8Array }[] | null = []
  #exited: number | null = null

  constructor(
    private readonly server: CodexAppServer,
    private readonly processId: string,
    private readonly onDone: () => void,
  ) {}

  watch(exit: Promise<CodexProtocol.v2.CommandExecResponse>): void {
    exit.then(
      (response) => this.#finish(response.exitCode),
      () => this.#finish(-1),
    )
  }

  output(notification: CodexProtocol.v2.CommandExecOutputDeltaNotification): void {
    const data = Buffer.from(notification.deltaBase64, 'base64')
    if (this.#pending) {
      this.#pending.push({ stream: notification.stream, data })
      return
    }
    for (const listener of this.#outputListeners) listener(notification.stream, data)
  }

  lost(): void {
    this.#finish(-1)
  }

  #finish(exitCode: number): void {
    if (this.#exited !== null) return
    this.#exited = exitCode
    this.onDone()
    for (const listener of this.#exitListeners) listener(exitCode)
    // Exit fires once, and `onExit` replays it to a late subscriber out of
    // `#exited`, so the exit set is dead weight the moment it has run. The
    // output set is not: a delta can still arrive after the response that
    // ended this process, and `#pending`'s contract above promises the first
    // listener gets the bytes "even after exit". Clearing it here is what
    // broke that promise. Output listeners are released by `release()`
    // instead, when the drain window closes.
    this.#exitListeners.clear()
  }

  /**
   * The drain window is over: no delta can be routed here again, so let go of
   * the caller's closures. Called only by `CodexProcesses`, which is the last
   * thing naming this process — so the listener set never outlives the
   * registry entry.
   */
  release(): void {
    this.#outputListeners.clear()
    this.#pending = null
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#exited !== null) throw new Error('The process has exited.')
    await this.server.request('command/exec/write', {
      processId: this.processId,
      deltaBase64: Buffer.from(data).toString('base64'),
    })
  }

  async resize(size: TerminalSize): Promise<void> {
    if (this.#exited !== null) return
    await this.server.request('command/exec/resize', { processId: this.processId, size })
  }

  async kill(): Promise<void> {
    if (this.#exited !== null) return
    await this.server.request('command/exec/terminate', { processId: this.processId })
  }

  onOutput(listener: (stream: 'stdout' | 'stderr', data: Uint8Array) => void): Unsubscribe {
    this.#outputListeners.add(listener)
    if (this.#pending) {
      const backlog = this.#pending
      this.#pending = null
      for (const entry of backlog) listener(entry.stream, entry.data)
    }
    return () => this.#outputListeners.delete(listener)
  }

  onExit(listener: (exitCode: number) => void): Unsubscribe {
    if (this.#exited !== null) {
      listener(this.#exited)
      return () => {}
    }
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }
}
