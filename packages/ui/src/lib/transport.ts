import {
  isNotification,
  type AgentEvent,
  type HostMethodName,
  type HostParams,
  type HostResult,
  type HostToClient,
  type RuntimeId,
  type WireError,
  type WireNotification,
} from '@harnessdesk/protocol'

/**
 * The renderer's side of the wire protocol.
 *
 * Reconnects on its own, because a host restart during development — or an
 * Electron window waking from sleep — should not require the user to reload.
 * Requests issued while disconnected queue rather than reject, so the UI does
 * not have to guard every call site.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface TransportEvents {
  onEvent(runtime: RuntimeId, event: AgentEvent): void
  onNotification(notification: WireNotification): void
  onStatus(status: ConnectionStatus): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

const MAX_BACKOFF_MS = 10_000
const QUEUE_LIMIT = 200

export class Transport {
  #socket: WebSocket | null = null
  #nextId = 0
  #pending = new Map<number, Pending>()
  #queue: string[] = []
  #status: ConnectionStatus = 'closed'
  #attempt = 0
  #closed = false
  #reconnectTimer: number | null = null

  constructor(
    private readonly url: string,
    private readonly handlers: TransportEvents,
  ) {}

  get status(): ConnectionStatus {
    return this.#status
  }

  connect(): void {
    this.#closed = false
    this.#open()
  }

  close(): void {
    this.#closed = true
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer)
    this.#socket?.close()
    this.#socket = null
    this.#setStatus('closed')
  }

  request<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    const id = ++this.#nextId
    const frame = JSON.stringify({ id, method, params })
    return new Promise<HostResult<M>>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      if (this.#socket?.readyState === WebSocket.OPEN) {
        this.#socket.send(frame)
        return
      }
      if (this.#queue.length >= QUEUE_LIMIT) {
        this.#pending.delete(id)
        reject(new Error('Too many requests are queued while the host is unreachable.'))
        return
      }
      this.#queue.push(frame)
    })
  }

  #open(): void {
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new WebSocket(this.url)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#setStatus('open')
      const queued = this.#queue
      this.#queue = []
      for (const frame of queued) socket.send(frame)
    })

    socket.addEventListener('message', (event) => {
      let message: HostToClient
      try {
        message = JSON.parse(String(event.data)) as HostToClient
      } catch {
        return
      }
      if (isNotification(message)) {
        if (message.method === 'event') this.handlers.onEvent(message.params.runtime, message.params.event)
        this.handlers.onNotification(message)
        return
      }
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(rejectionFor(message.error))
    })

    socket.addEventListener('close', () => {
      this.#socket = null
      if (this.#closed) return
      // In-flight requests cannot be answered by a socket that is gone; failing
      // them is better than leaving spinners forever.
      const pending = [...this.#pending.values()]
      this.#pending.clear()
      for (const entry of pending) {
        entry.reject(new Error('The connection to HarnessDesk was lost.'))
      }
      this.#scheduleReconnect()
    })

    socket.addEventListener('error', () => socket.close())
  }

  #scheduleReconnect(): void {
    this.#attempt += 1
    const backoff = Math.min(300 * 2 ** (this.#attempt - 1), MAX_BACKOFF_MS)
    this.#setStatus('reconnecting')
    this.#reconnectTimer = window.setTimeout(() => this.#open(), backoff)
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.handlers.onStatus(status)
  }
}

/**
 * A failed request as something a caller can both show and act on.
 *
 * The sentence is what a banner needs. The code is what a *choice* needs: a
 * conversation that is open elsewhere can still be copied, and the only way
 * for the interface to know it is looking at that failure rather than any
 * other is a name the host put on it. Reading English to decide would break
 * the first time either sentence was improved.
 */
export const rejectionFor = (error: WireError): Error =>
  Object.assign(new Error(sentenceOf(error)), { code: error.code })

/**
 * A failed request as one sentence.
 *
 * The host sends the message and, when the agent gave one, the detail behind
 * it. A banner reading "Internal error" is not something a user can act on;
 * the same banner ending in why it failed is.
 */
export const sentenceOf = (error: WireError): string => {
  const details = error.details?.trim()
  if (!details || details === error.message) return error.message
  return `${error.message} — ${details}`
}

/**
 * Builds the socket URL from the page URL.
 *
 * The host hands the renderer its token as a query parameter at load time; the
 * desktop shell does the same when it creates the window.
 */
export const transportUrl = (): string => {
  const page = new URL(window.location.href)
  const token = page.searchParams.get('token') ?? ''
  const protocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${page.host}/ws?token=${encodeURIComponent(token)}`
}
