import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/**
 * The parent's handle on gateway processes.
 *
 * One gateway per model route, started when a conversation first chooses the
 * route and reused after. The provider key is written to the child's stdin
 * once and never appears in argv, the environment, or this process again —
 * the supervisor keeps only the loopback address and the per-gateway token.
 */

const CHILD_ENTRY = fileURLToPath(new URL('./child.js', import.meta.url))

export interface RunningGateway {
  readonly endpoint: string
  readonly token: string
}

interface Entry {
  readonly child: ChildProcess
  readonly gateway: RunningGateway
}

export interface GatewayLogger {
  info?(message: string, details?: unknown): void
  warn?(message: string, details?: unknown): void
}

export class GatewaySupervisor {
  readonly #running = new Map<string, Entry>()
  readonly #logger: GatewayLogger

  constructor(logger: GatewayLogger = {}) {
    this.#logger = logger
  }

  /**
   * The gateway for a route, started if need be. `resolveKey` is called only
   * when a fresh process must be configured — the single place a credential
   * value is ever read.
   */
  async ensure(
    routeId: string,
    options: {
      readonly upstream: string
      readonly model?: string
      readonly resolveKey: () => Promise<string>
    },
  ): Promise<RunningGateway> {
    const existing = this.#running.get(routeId)
    if (existing && existing.child.exitCode === null) return existing.gateway

    const token = randomBytes(24).toString('hex')
    const child = spawn(process.execPath, [CHILD_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    // The gateway takes its configuration on stdin and nothing after; if it
    // has already died, the pipe says EPIPE, which must not take the host —
    // and must not vanish either, because a gateway that never got its key
    // is the next thing somebody debugs.
    child.stdin!.on('error', (error) => this.#logger.warn?.('model gateway stdin', { routeId, error: error.message }))
    const apiKey = await options.resolveKey()
    child.stdin!.write(
      `${JSON.stringify({ upstream: options.upstream, apiKey, token, ...(options.model ? { model: options.model } : {}) })}\n`,
    )

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The model gateway did not start within 10s.')),
        10_000,
      )
      timer.unref?.()
      const lines = createInterface({ input: child.stdout! })
      lines.once('line', (line) => {
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(line) as { port?: number }
          if (typeof parsed.port === 'number' && parsed.port > 0) resolve(parsed.port)
          else reject(new Error(`gateway announced no port: ${line}`))
        } catch {
          reject(new Error(`gateway spoke something other than its port: ${line.slice(0, 120)}`))
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`The model gateway exited immediately (code ${code ?? 'signal'}).`))
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    child.on('exit', (code, signal) => {
      if (this.#running.get(routeId)?.child === child) this.#running.delete(routeId)
      this.#logger.warn?.('model gateway exited', { routeId, code, signal })
    })

    // The endpoint embeds the token as a path prefix so a keyless provider
    // configuration still authenticates; header auth works against it too.
    // No `/v1` here: the upstream base already carries whatever prefix the
    // provider uses, and callers append only the method path (`/responses`).
    const gateway: RunningGateway = { endpoint: `http://127.0.0.1:${port}/t/${token}`, token }
    this.#running.set(routeId, { child, gateway })
    this.#logger.info?.('model gateway ready', { routeId, endpoint: gateway.endpoint })
    return gateway
  }

  /** Stops the gateway for a route (after the route is edited or deleted). */
  stop(routeId: string): void {
    const entry = this.#running.get(routeId)
    if (!entry) return
    this.#running.delete(routeId)
    entry.child.stdin?.end()
  }

  async dispose(): Promise<void> {
    for (const [routeId] of this.#running) this.stop(routeId)
  }
}
