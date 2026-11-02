import { CloseCode, HEARTBEAT_PING, HEARTBEAT_PONG, RelayHeaders, RelayToDesk, decodeDeskFrame, encodeDeskFrame } from '@harnessdesk/contract'
import WebSocket from 'ws'
import type { EndpointTransport } from './endpoint.js'

/** What the account hands the relay for one connection. The desk key stays with the account: it only signs. */
export interface RelayCredentials {
  /** The relay's origin as the account service gave it, `wss://…`. */
  readonly url: string
  /** The desk's id on the account, which names its room. */
  readonly deskId: string
  readonly token: string
  /** Signs the relay's challenge with the desk key. Nothing else can be signed through it. */
  prove(challenge: string): Promise<string>
}

/** One phone on the relay, as the phone link sees it. */
export interface RelayAttachment {
  receive(frame: Uint8Array): void
  gone(): void
}

/**
 * What the window shows beside Reachable from your phone. `connecting` covers the first few failures too, so a Mac
 * waking up or changing networks does not flash a warning; `unreachable` is the warning. The last three mean the
 * desk stopped trying on purpose and will not come back by itself.
 */
export type RelayState = 'off' | 'connecting' | 'connected' | 'unreachable' | 'replaced' | 'refused'

export interface RelayLinkOptions {
  /** Fresh asks for a new desk session rather than the saved one. Throws when the desk cannot use its account. */
  credentials(fresh: boolean): Promise<RelayCredentials>
  /** Opens one phone's encrypted session over the relay. `dev` is the device the account linked; the phone must be it. */
  attach(conn: number, dev: string, transport: EndpointTransport): RelayAttachment
  onState?(state: RelayState): void
  log?(message: string, fields?: Record<string, unknown>): void
  /** For tests. */
  readonly fetch?: typeof fetch
  readonly random?: () => number
  readonly heartbeatMs?: number
  readonly maxBackoffMs?: number
}

/** Failures in a row before the window says it cannot reach HarnessDesk. */
const QUIET_FAILURES = 3
/** Unanswered heartbeats in a row before a socket that looks open is taken for dead. */
const MISSED_HEARTBEATS = 3
const BASE_BACKOFF_MS = 1000

/** Close codes that end the relay on purpose: the window says why, and nothing retries until the person acts. */
const STOPS: ReadonlyMap<number, RelayState> = new Map([[CloseCode.REPLACED, 'replaced'], [CloseCode.REVOKED, 'refused']])

/**
 * The desk's one outbound socket to its relay room. Each phone the relay announces gets the same encrypted session
 * as a phone on the LAN, so the relay carries frames it cannot read. The socket comes back after a drop, with full
 * jitter between attempts; a revoked desk, or another copy of this desk taking the room, stops it instead.
 */
export class RelayLink {
  readonly #options: RelayLinkOptions
  readonly #phones = new Map<number, RelayAttachment>()
  #state: RelayState = 'off'
  #running = false
  #socket: WebSocket | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #failures = 0
  #refusals = 0
  #missed = 0
  #maxPhones: number = 8
  #generation = 0

  constructor(options: RelayLinkOptions) { this.#options = options }

  get state(): RelayState { return this.#state }
  /** Connections the relay has open for phones right now. */
  get phones(): number { return this.#phones.size }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#failures = 0
    this.#refusals = 0
    this.#set('connecting')
    void this.#connect(++this.#generation)
  }

  stop(): void {
    this.#running = false
    ++this.#generation
    this.#clearTimer()
    this.#teardown(1000, 'desk stopped')
    this.#set('off')
  }

  #set(state: RelayState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState?.(state)
  }

  #current(generation: number): boolean { return this.#running && generation === this.#generation }

  async #connect(generation: number): Promise<void> {
    let credentials: RelayCredentials
    let challenge: string
    try {
      credentials = await this.#options.credentials(this.#refusals > 0)
      if (!this.#current(generation)) return
      challenge = await this.#challenge(credentials.url)
      if (!this.#current(generation)) return
    } catch (error) {
      this.#options.log?.('relay credentials failed', { error: error instanceof Error ? error.name : 'error' })
      return this.#retry(generation)
    }
    let proof: string
    try { proof = await credentials.prove(challenge) } catch { return this.#retry(generation) }
    if (!this.#current(generation)) return
    const socket = new WebSocket(`${credentials.url}/v1/desk/${credentials.deskId}`, {
      headers: { authorization: `Bearer ${credentials.token}`, [RelayHeaders.challenge]: challenge, [RelayHeaders.proof]: proof },
      maxPayload: 1_048_576 + 4, handshakeTimeout: 10_000, followRedirects: false,
    })
    socket.binaryType = 'nodebuffer'
    this.#socket = socket
    let ended = false
    const end = (code: number) => {
      if (ended) return
      ended = true
      if (this.#socket === socket) this.#socket = null
      this.#stopHeartbeat()
      this.#dropPhones()
      if (!this.#current(generation)) return
      const stop = STOPS.get(code)
      if (stop) {
        this.#options.log?.('relay stopped', { code })
        this.#running = false
        return this.#set(stop)
      }
      if (code === CloseCode.UNAUTHORIZED) return this.#refused(generation)
      this.#retry(generation)
    }
    // The relay answers a refused upgrade over HTTP, before there is a socket to carry a close code.
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      end(status === 401 || status === 403 ? CloseCode.UNAUTHORIZED : CloseCode.UNAVAILABLE)
      socket.terminate()
    })
    socket.on('open', () => {
      if (!this.#current(generation)) return void socket.close(1000, 'desk stopped')
      this.#startHeartbeat(socket)
    })
    socket.on('message', (data, isBinary) => {
      this.#missed = 0
      if (!this.#current(generation)) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      if (isBinary) return this.#frame(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      this.#control(socket, bytes.toString('utf8'))
    })
    socket.on('close', code => end(code))
    socket.on('error', () => end(CloseCode.PEER_DROPPED))
  }

  /** A fresh session once; a second refusal in a row means the account does not let this desk in, and it stops. */
  #refused(generation: number): void {
    if (!this.#current(generation)) return
    this.#refusals++
    if (this.#refusals >= 2) {
      this.#running = false
      return this.#set('refused')
    }
    this.#retry(generation)
  }

  async #challenge(relay: string): Promise<string> {
    const url = new URL('/v1/challenge', relay.replace(/^ws/, 'http'))
    const response = await (this.#options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`relay challenge answered ${response.status}`)
    const body = await response.json() as { challenge?: unknown }
    if (typeof body?.challenge !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(body.challenge)) throw new Error('relay challenge was not understood')
    return body.challenge
  }

  #retry(generation: number): void {
    if (!this.#current(generation)) return
    this.#failures++
    this.#set(this.#failures > QUIET_FAILURES ? 'unreachable' : 'connecting')
    const ceiling = Math.min(this.#options.maxBackoffMs ?? 300_000, BASE_BACKOFF_MS * 2 ** Math.min(this.#failures - 1, 20))
    const delay = Math.floor((this.#options.random ?? Math.random)() * ceiling)
    this.#clearTimer()
    this.#timer = setTimeout(() => { this.#timer = null; void this.#connect(generation) }, delay)
    this.#timer.unref()
  }

  #control(socket: WebSocket, text: string): void {
    if (text === HEARTBEAT_PONG) return
    let message: RelayToDesk
    try {
      const parsed = RelayToDesk.safeParse(JSON.parse(text))
      if (!parsed.success) return void this.#options.log?.('relay sent a message this desk does not know')
      message = parsed.data
    } catch { return void this.#options.log?.('relay sent text that is not JSON') }
    if (message.t === 'ready') {
      this.#failures = 0
      this.#refusals = 0
      this.#maxPhones = Math.max(1, Math.min(message.maxPhones, 8))
      return this.#set('connected')
    }
    if (message.t === 'gone') {
      const phone = this.#phones.get(message.conn)
      this.#phones.delete(message.conn)
      return phone?.gone()
    }
    if (this.#phones.has(message.conn)) return
    if (this.#phones.size >= this.#maxPhones) return this.#closePhone(socket, message.conn, CloseCode.RATE_LIMITED, 'too many phones')
    const conn = message.conn
    const transport: EndpointTransport = {
      send: bytes => { if (this.#socket === socket && socket.readyState === WebSocket.OPEN && this.#phones.has(conn)) socket.send(encodeDeskFrame(conn, bytes)) },
      close: (code, reason) => {
        const phone = this.#phones.get(conn)
        if (!phone) return
        this.#phones.delete(conn)
        this.#closePhone(socket, conn, code, reason)
        phone.gone()
      },
    }
    this.#phones.set(conn, this.#options.attach(conn, message.dev, transport))
  }

  #frame(bytes: Uint8Array): void {
    const frame = decodeDeskFrame(bytes as Uint8Array<ArrayBuffer>)
    // A frame for a phone that has gone was in flight when it went; the relay has already been told.
    if (frame) this.#phones.get(frame.conn)?.receive(frame.payload)
  }

  #closePhone(socket: WebSocket, conn: number, code: number, reason: string): void {
    if (socket.readyState !== WebSocket.OPEN) return
    const bounded = code >= 4000 && code <= 4999 ? code : CloseCode.PEER_DROPPED
    socket.send(JSON.stringify({ t: 'close', conn, code: bounded, reason: reason.slice(0, 120) }))
  }

  /**
   * The relay answers `ping` itself. A socket that stops answering is probed again rather than torn down at the first
   * silence, so one lost frame on a flaky network does not drop every phone.
   */
  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat()
    this.#missed = 0
    this.#heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (this.#missed >= MISSED_HEARTBEATS) {
        this.#options.log?.('relay stopped answering')
        socket.terminate()
        return
      }
      this.#missed++
      socket.send(HEARTBEAT_PING)
    }, this.#options.heartbeatMs ?? 20_000)
    this.#heartbeat.unref()
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  #dropPhones(): void {
    const phones = [...this.#phones.values()]
    this.#phones.clear()
    for (const phone of phones) phone.gone()
  }

  #teardown(code: number, reason: string): void {
    this.#stopHeartbeat()
    const socket = this.#socket
    this.#socket = null
    this.#dropPhones()
    if (socket) { try { socket.close(code, reason) } catch { socket.terminate() } }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
