import { CloseCode, HEARTBEAT_PING, HEARTBEAT_PONG, RelayHeaders, RelayLimits, RelayToDesk, decodeDeskFrame, encodeDeskFrame } from '@harnessdesk/contract'
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

/**
 * Thrown by `credentials` when the account names no relay this desk can use. That is the account's answer rather than
 * a failure, so the link goes back to off instead of retrying against an account that will keep giving it.
 */
export class RelayUnavailableError extends Error {
  override readonly name = 'RelayUnavailableError'
}

/** One phone on the relay, as the phone link sees it. */
export interface RelayAttachment {
  receive(frame: Uint8Array): void
  gone(): void
}

/**
 * What the window shows beside Reachable from your phone. `connecting` covers the first few failures too, so a Mac
 * waking up or changing networks does not flash a warning; `unreachable` is the warning. The last three mean the
 * desk stopped trying on purpose and will not come back by itself, and so does `off` while Reachable is on: the account
 * named no relay this desk can use.
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
  readonly stableMs?: number
  readonly closeGraceMs?: number
  readonly readyMs?: number
  readonly framesPerSecond?: number
}

/** Failures in a row before the window says it cannot reach HarnessDesk. */
const QUIET_FAILURES = 3
/** Unanswered heartbeats in a row before a socket that looks open is taken for dead. */
const MISSED_HEARTBEATS = 3
const BASE_BACKOFF_MS = 1000
/** How long a socket has to stay up before its drop counts as a fresh start rather than one more failure. */
const STABLE_MS = 30_000
/** How long an open socket has to say `ready` before it is taken for a room that will never let this desk in. */
const READY_MS = 15_000
/** Frames waiting for the relay's rate before the phone whose frame does not fit is let go. */
const MAX_QUEUED_FRAMES = 4096
/** Under the relay's meter, with room for its pings and control messages on the same socket. */
const PACED_FRAMES_PER_SECOND = Math.floor(RelayLimits.framesPerSecond * 0.9)
const PACED_BURST = RelayLimits.frameBurst / 2

/** Close codes that end the relay on purpose: the window says why, and nothing retries until the person acts. */
const STOPS: ReadonlyMap<number, RelayState> = new Map([[CloseCode.REPLACED, 'replaced'], [CloseCode.REVOKED, 'refused']])

/**
 * The desk's one outbound socket to its relay room. Each phone the relay announces gets the same encrypted session
 * as a phone on the LAN, so the relay carries frames it cannot read. The socket comes back after a drop, with full
 * jitter between attempts; a revoked desk, or another copy of this desk taking the room, stops it instead.
 */
export class RelayLink {
  readonly #options: RelayLinkOptions
  #state: RelayState = 'off'
  #running = false
  /** The open socket and everything that belongs to it; a late event from an older socket finds it gone. */
  #live: Live | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #failures = 0
  #refusals = 0
  #generation = 0

  constructor(options: RelayLinkOptions) { this.#options = options }

  get state(): RelayState { return this.#state }
  /** Connections the relay has open for phones right now. */
  get phones(): number { return this.#live?.phones.size ?? 0 }

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
      if (error instanceof RelayUnavailableError && this.#current(generation)) {
        this.#running = false
        return this.#set('off')
      }
      return this.#retry(generation)
    }
    let proof: string
    try { proof = await credentials.prove(challenge) } catch { return this.#retry(generation) }
    if (!this.#current(generation)) return
    const socket = new WebSocket(`${credentials.url}/v1/desk/${credentials.deskId}`, {
      headers: { authorization: `Bearer ${credentials.token}`, [RelayHeaders.challenge]: challenge, [RelayHeaders.proof]: proof },
      maxPayload: RelayLimits.maxFrameBytes + 4, handshakeTimeout: 10_000, followRedirects: false,
    })
    socket.binaryType = 'nodebuffer'
    const live = new Live(socket, this.#options.framesPerSecond ?? PACED_FRAMES_PER_SECOND)
    this.#live = live
    const end = (code: number) => {
      // Teardown already let this socket's phones go; only the socket still in use decides what happens next.
      if (this.#live !== live) return
      this.#live = null
      live.end()
      if (!this.#current(generation)) return
      const stop = STOPS.get(code)
      if (stop) {
        this.#options.log?.('relay stopped', { code })
        this.#running = false
        return this.#set(stop)
      }
      if (code === CloseCode.UNAUTHORIZED) return this.#refused(generation)
      // A socket that stayed up a while starts the backoff over; one that drops right after `ready` keeps climbing it.
      if (live.readyAt !== null && Date.now() - live.readyAt >= (this.#options.stableMs ?? STABLE_MS)) this.#failures = 0
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
      if (!this.#current(generation) || this.#live !== live) return void socket.close(1000, 'desk stopped')
      this.#startHeartbeat(live)
      // A socket that answers pings but never says `ready` would hold the link at connecting for good.
      live.readyTimer = setTimeout(() => {
        if (live.readyAt !== null || this.#live !== live) return
        this.#options.log?.('relay never said ready')
        live.socket.terminate()
      }, this.#options.readyMs ?? READY_MS)
      live.readyTimer.unref()
    })
    socket.on('message', (data, isBinary) => {
      if (this.#live !== live || !this.#current(generation)) return
      live.missed = 0
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      if (isBinary) return this.#frame(live, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      this.#control(live, bytes.toString('utf8'))
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

  #control(live: Live, text: string): void {
    if (text === HEARTBEAT_PONG) return
    let message: RelayToDesk
    try {
      const parsed = RelayToDesk.safeParse(JSON.parse(text))
      if (!parsed.success) return void this.#options.log?.('relay sent a message this desk does not know')
      message = parsed.data
    } catch { return void this.#options.log?.('relay sent text that is not JSON') }
    if (message.t === 'ready') {
      this.#refusals = 0
      live.readyAt = Date.now()
      live.maxPhones = Math.max(1, Math.min(message.maxPhones, RelayLimits.maxPhonesPerDesk))
      live.maxFrame = Math.max(1024, Math.min(message.maxFrame, RelayLimits.maxFrameBytes))
      return this.#set('connected')
    }
    if (message.t === 'gone') {
      const phone = live.phones.get(message.conn)
      live.phones.delete(message.conn)
      live.forget(message.conn)
      return phone?.gone()
    }
    const conn = message.conn
    if (live.phones.has(conn)) return
    if (live.phones.size >= live.maxPhones) return live.closePhone(conn, CloseCode.RATE_LIMITED, 'too many phones')
    // The phone link may refuse while it attaches, before there is an attachment to hold; the relay is told either way.
    let closed = false
    // The desk's own close follows what it already sent, so a sealed refusal still reaches the phone ahead of it; a
    // phone let go for sending too much loses what is still waiting.
    const close = (code: number, reason: string, dropQueued = false) => {
      if (closed) return
      closed = true
      const phone = live.phones.get(conn)
      live.phones.delete(conn)
      if (dropQueued) live.forget(conn)
      live.closePhoneAfterSends(conn, code, reason)
      phone?.gone()
    }
    const transport: EndpointTransport = {
      send: bytes => {
        if (closed || this.#live !== live) return
        // The relay closes the whole desk socket over a frame larger than it allows, so only this phone is let go.
        if (bytes.length + 4 > live.maxFrame) return close(CloseCode.FRAME_TOO_LARGE, 'message too large', true)
        if (!live.send(conn, encodeDeskFrame(conn, bytes))) close(CloseCode.RATE_LIMITED, 'too much to send', true)
      },
      close: (code, reason) => close(code, reason),
    }
    const attachment = this.#options.attach(conn, message.dev, transport)
    if (!closed) live.phones.set(conn, attachment)
  }

  #frame(live: Live, bytes: Uint8Array): void {
    const frame = decodeDeskFrame(bytes as Uint8Array<ArrayBuffer>)
    // A frame for a phone that has gone was in flight when it went; the relay has already been told.
    if (frame) live.phones.get(frame.conn)?.receive(frame.payload)
  }

  /**
   * The relay answers `ping` itself. A socket that stops answering is probed again rather than torn down at the first
   * silence, so one lost frame on a flaky network does not drop every phone.
   */
  #startHeartbeat(live: Live): void {
    live.missed = 0
    live.heartbeat = setInterval(() => {
      if (live.socket.readyState !== WebSocket.OPEN) return
      if (live.missed >= MISSED_HEARTBEATS) {
        this.#options.log?.('relay stopped answering')
        live.socket.terminate()
        return
      }
      live.missed++
      live.socket.send(HEARTBEAT_PING)
    }, this.#options.heartbeatMs ?? 20_000)
    live.heartbeat.unref()
  }

  #teardown(code: number, reason: string): void {
    const live = this.#live
    this.#live = null
    if (!live) return
    live.end()
    try { live.socket.close(code, reason) } catch { live.socket.terminate() }
    // A socket whose peer has gone can wait a long time for its close frame; this one is finished either way.
    setTimeout(() => live.socket.terminate(), this.#options.closeGraceMs ?? 5000).unref()
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}

/** One relay socket: its phones, its heartbeat, its limits and its send pacing, all ended together. */
class Live {
  readonly phones = new Map<number, RelayAttachment>()
  heartbeat: ReturnType<typeof setInterval> | null = null
  readyTimer: ReturnType<typeof setTimeout> | null = null
  missed = 0
  readyAt: number | null = null
  maxPhones: number = RelayLimits.maxPhonesPerDesk
  maxFrame: number = RelayLimits.maxFrameBytes
  readonly #queue: ({ conn: number; frame: Uint8Array } | { conn: number; close: { code: number; reason: string } })[] = []
  #tokens: number
  #filled = Date.now()
  #drain: ReturnType<typeof setTimeout> | null = null

  constructor(readonly socket: WebSocket, private readonly perSecond: number) { this.#tokens = PACED_BURST }

  /**
   * The relay meters each socket, and a desk over its rate loses the socket and every phone on it. Frames past the
   * rate wait here, in order, so a resume or a long reply arrives late rather than ending the connection.
   */
  send(conn: number, frame: Uint8Array): boolean {
    if (this.#queue.length === 0 && this.#take()) { this.#write(frame); return true }
    if (this.#queue.length >= MAX_QUEUED_FRAMES) return false
    this.#queue.push({ conn, frame })
    this.#schedule()
    return true
  }

  /** Closes a phone once the frames already queued for it have gone out, in their order. */
  closePhoneAfterSends(conn: number, code: number, reason: string): void {
    if (!this.#queue.some(queued => queued.conn === conn)) return this.closePhone(conn, code, reason)
    this.#queue.push({ conn, close: { code, reason } })
  }

  /** A phone that has gone sends nothing more. */
  forget(conn: number): void {
    for (let i = this.#queue.length - 1; i >= 0; i--) if (this.#queue[i]!.conn === conn) this.#queue.splice(i, 1)
  }

  /** Control messages are not metered by frame count; they go straight out. */
  closePhone(conn: number, code: number, reason: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    const bounded = code >= 4000 && code <= 4999 ? code : CloseCode.PEER_DROPPED
    this.socket.send(JSON.stringify({ t: 'close', conn, code: bounded, reason: reason.slice(0, 120) }))
  }

  end(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    if (this.#drain) clearTimeout(this.#drain)
    this.#drain = null
    this.#queue.length = 0
    const phones = [...this.phones.values()]
    this.phones.clear()
    for (const phone of phones) phone.gone()
  }

  #take(): boolean {
    const now = Date.now()
    this.#tokens = Math.min(PACED_BURST, this.#tokens + (now - this.#filled) * this.perSecond / 1000)
    this.#filled = now
    if (this.#tokens < 1) return false
    this.#tokens--
    return true
  }

  #write(frame: Uint8Array): void { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame) }

  #schedule(): void {
    if (this.#drain) return
    this.#drain = setTimeout(() => {
      this.#drain = null
      while (this.#queue.length > 0) {
        const next = this.#queue[0]!
        if ('close' in next) { this.#queue.shift(); this.closePhone(next.conn, next.close.code, next.close.reason); continue }
        if (!this.#take()) break
        this.#queue.shift()
        this.#write(next.frame)
      }
      if (this.#queue.length > 0) this.#schedule()
    }, Math.ceil(1000 / this.perSecond))
    this.#drain.unref()
  }
}
