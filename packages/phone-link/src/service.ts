import { randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CloseCode, encodePairingOffer, type PairingOffer } from '@harnessdesk/contract'
import { b64u } from '@harnessdesk/crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { PhoneEndpoint, type EndpointTransport, type Enrollment, type PhonePolicy } from './endpoint.js'
import { loadOrCreateDeskIdentity, type DeskIdentity } from './identity.js'
import { DeviceRegistry, PHONE_TIERS, type Device, type PhoneTier } from './registry.js'
import type { RelayAttachment } from './relay.js'
import { EventRing } from './ring.js'

export interface PhoneLinkOptions {
  /** Where the desk key and the device list live. */
  readonly dir: string
  readonly policy: PhonePolicy
  readonly call: (method: string, params: unknown, device: Device) => Promise<unknown>
  /** The interface to listen on. The default reaches the local network; `127.0.0.1` keeps it on this machine. */
  readonly host?: string
  /** 0 picks a free port. */
  readonly port?: number
  /** The name a phone shows for this desk. */
  readonly name?: string
  /** Put `127.0.0.1` in the pairing code, for a simulator on this machine. */
  readonly includeLoopback?: boolean
  readonly now?: () => number
  /** How long "Allow this phone?" waits for a person before it counts as no. */
  readonly confirmTimeoutMs?: number
  readonly maxSockets?: number
  readonly log?: (message: string, fields?: Record<string, unknown>) => void
}

export interface PendingEnrollment extends Enrollment {
  readonly id: string
  readonly requestedAt: number
}

/** How a phone is reaching this desk right now: on the same network, or through the account's relay. */
export type PhoneRoute = 'nearby' | 'account'

/** What the account adds to a pairing code so a phone away from this network can still pair. */
export interface AccountOffer {
  readonly invite: string
  /** The account service's origin. */
  readonly api: string
  /** The relay's origin. */
  readonly relay: string
  /** Epoch milliseconds: the invite's own expiry, which can come before the code's. */
  readonly expiresAt: number
}

export interface PairingCode {
  readonly url: string
  readonly offer: PairingOffer
  readonly expiresAt: number
}

export type PhoneLinkChange = 'devices' | 'pending'

const PATH = '/phone'
const FAILURES_PER_MINUTE = 10
/** Remotes whose refusals are counted at once; the oldest goes first past it. */
const MAX_FAILURE_REMOTES = 1024

/**
 * The LAN half of the phone link. It listens for phones, runs each through the encrypted session, and keeps
 * the person in the loop for anything new: a phone that shows a valid pairing code still waits for "Allow this
 * phone?". Nothing here depends on the cloud.
 */
export class PhoneLinkService {
  #closed = false
  readonly #draining = new Set<Promise<void>>()
  readonly #endpoints = new Set<PhoneEndpoint>()
  readonly #sockets = new Map<PhoneEndpoint, WebSocket>()
  readonly #routes = new Map<PhoneEndpoint, PhoneRoute>()
  readonly #pending = new Map<string, PendingEnrollment & { settle(tiers: readonly PhoneTier[] | null): void }>()
  readonly #listeners = new Set<(change: PhoneLinkChange) => void>()
  readonly #failures = new Map<string, { count: number; resetAt: number }>()

  private constructor(
    readonly identity: DeskIdentity,
    readonly registry: DeviceRegistry,
    readonly ring: EventRing,
    private readonly wss: WebSocketServer,
    readonly port: number,
    private readonly options: PhoneLinkOptions,
  ) {}

  static async start(options: PhoneLinkOptions): Promise<PhoneLinkService> {
    const identity = await loadOrCreateDeskIdentity(options.dir)
    const registry = await DeviceRegistry.open(join(options.dir, 'phone-devices.json'))
    const ring = new EventRing()
    // A paired phone remembers the port, so a desk asked for any port goes back to its last one when it is free.
    const saved = join(options.dir, 'phone-port.json')
    const last = options.port ? null : await readFile(saved, 'utf8').then(text => {
      const port: unknown = (JSON.parse(text) as { port?: unknown } | null)?.port
      return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null
    }).catch(() => null)
    const listen = async (port: number): Promise<WebSocketServer> => {
      const wss = new WebSocketServer({ host: options.host ?? '0.0.0.0', port, path: PATH, maxPayload: 1_048_576 })
      await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', error => { wss.close(); reject(error) }) })
      return wss
    }
    const wss = last && Number.isInteger(last) && last > 0 && last < 65536
      ? await listen(last).catch(() => listen(0)) : await listen(options.port ?? 0)
    const address = wss.address()
    if (typeof address !== 'object' || address === null) throw new Error('The phone link did not bind to a port.')
    if (!options.port && address.port !== last) {
      try {
        const temporary = `${saved}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify({ port: address.port }), { mode: 0o600 })
        await rename(temporary, saved)
      } catch (error) { wss.close(); throw error }
    }
    const service = new PhoneLinkService(identity, registry, ring, wss, address.port, options)
    wss.on('connection', (socket, request) => service.#accept(socket, request.socket.remoteAddress ?? 'unknown'))
    return service
  }

  get deskId(): string { return this.identity.id }
  get deskPub(): string { return this.identity.pub }
  get name(): string { return this.options.name ?? hostname() }
  #now(): number { return (this.options.now ?? Date.now)() }

  onChange(listener: (change: PhoneLinkChange) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  devices(): readonly Device[] { return this.registry.list() }
  pending(): readonly PendingEnrollment[] { return [...this.#pending.values()].map(({ settle: _settle, ...request }) => request) }

  /** The addresses a phone on the same network can reach this desk at. */
  lanAddresses(): { host: string; port: number }[] {
    const hosts: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) hosts.push(entry.address)
    }
    if (this.options.includeLoopback === true) hosts.push('127.0.0.1')
    return hosts.slice(0, 8).map(host => ({ host, port: this.port }))
  }

  /**
   * A new pairing code: single-use, short-lived, carrying the desk's public key for the phone to pin. With an account
   * offer it also carries a one-time invite, so a phone away from this network can pair through the relay; the phone
   * still has to show the code's secret, and the person still answers "Allow this phone?".
   */
  createPairingCode(ttlSeconds = 600, account?: AccountOffer): PairingCode {
    // The desk holds the secret no longer than the code says, so a code past the invite's end is refused here too.
    const now = this.#now()
    const deadline = account ? Math.min(now + ttlSeconds * 1000, account.expiresAt) : now + ttlSeconds * 1000
    const issued = this.registry.issueOffer(Math.max(0, Math.floor(deadline / 1000) * 1000 - now), now)
    const expiresAt = issued.expiresAt
    const offer: PairingOffer = {
      v: 1, deskPub: this.identity.pub, name: this.name.slice(0, 80) || 'Desk', enroll: b64u(issued.secret),
      ...(account ? { invite: account.invite, api: account.api, relay: account.relay } : {}),
      lan: this.lanAddresses(), exp: Math.floor(expiresAt / 1000),
    }
    return { url: encodePairingOffer(offer), offer, expiresAt }
  }

  /** How a paired phone is connected now, or null when it is not. The same network wins over the relay. */
  routeOf(deviceId: string): PhoneRoute | null {
    let found: PhoneRoute | null = null
    for (const [endpoint, route] of this.#routes) {
      if (!endpoint.open || endpoint.device?.id !== deviceId) continue
      if (route === 'nearby') return route
      found = route
    }
    return found
  }

  /**
   * One phone the relay has announced. It runs the same encrypted session as a phone on this network, and must prove
   * the key the account linked; the relay carries its frames and can read none of them.
   */
  attachRelay(conn: number, dev: string, transport: EndpointTransport): RelayAttachment {
    if (this.#closed) {
      transport.close(1001, 'desk-closed')
      return { receive: () => {}, gone: () => {} }
    }
    const remote = `relay:${dev}`
    const failures = this.#failures.get(remote)
    if (failures && failures.resetAt > this.#now() && failures.count >= FAILURES_PER_MINUTE) {
      transport.close(CloseCode.RATE_LIMITED, 'too many attempts')
      return { receive: () => {}, gone: () => {} }
    }
    const endpoint = this.#endpoint(remote, transport, 'account', dev)
    return {
      receive: frame => void endpoint.receive(frame),
      gone: () => this.#gone(endpoint),
    }
  }

  /** Answer "Allow this phone?". An id that is no longer waiting is ignored. */
  allow(id: string, tiers: readonly PhoneTier[] = this.options.policy.defaultTiers): boolean {
    return this.#settle(id, PHONE_TIERS.filter(tier => tiers.includes(tier)))
  }
  deny(id: string): boolean { return this.#settle(id, null) }

  async setTiers(deviceId: string, tiers: readonly PhoneTier[]): Promise<boolean> {
    const device = await this.registry.setTiers(deviceId, tiers)
    if (device) this.#changed('devices')
    return device !== null
  }

  /** Forget a phone and end its sessions now. */
  async revoke(deviceId: string): Promise<boolean> {
    const device = await this.registry.revoke(deviceId, this.#now())
    if (!device) return false
    for (const endpoint of this.#endpoints) if (endpoint.device?.id === deviceId) endpoint.kick(CloseCode.REVOKED, 'this phone was removed')
    this.#changed('devices')
    return true
  }

  /** Number an event and hand it to every phone that may hear it. */
  publish(topic: string, data: unknown): void {
    const event = this.ring.append(topic, data)
    for (const endpoint of this.#endpoints) endpoint.deliver(event)
  }

  /**
   * Whether a phone that is signed in right now may hear a topic, so a producer that is costly to run can wait until
   * somebody is there to read it.
   */
  listening(topic: string): boolean {
    const tier = Object.hasOwn(this.options.policy.topics, topic) ? this.options.policy.topics[topic] : undefined
    if (tier === undefined) return false
    return [...this.#endpoints].some(endpoint => endpoint.device !== null && endpoint.open && (this.registry.get(endpoint.device.id)?.tiers.includes(tier) ?? false))
  }

  /** Stop admission immediately, even while already-admitted controls still drain. */
  seal(): void {
    this.#closed = true
    for (const id of [...this.#pending.keys()]) this.#settle(id, null)
    for (const socket of this.wss.clients) socket.close(1001, 'desk-closed')
    for (const endpoint of [...this.#endpoints]) this.#gone(endpoint)
  }

  async close(): Promise<void> {
    this.seal()
    await new Promise<void>((resolve, reject) => this.wss.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' && error.message !== 'The server is not running') reject(error)
      else resolve()
    }))
    while (this.#draining.size) await Promise.allSettled([...this.#draining])
    await this.registry.idle()
  }

  #accept(socket: WebSocket, remote: string): void {
    if (this.#closed) return void socket.close(1001, 'desk-closed')
    const limit = this.options.maxSockets ?? 16
    if (this.#sockets.size >= limit) return void socket.close(CloseCode.RATE_LIMITED, 'busy')
    const failures = this.#failures.get(remote)
    if (failures && failures.resetAt > this.#now() && failures.count >= FAILURES_PER_MINUTE) return void socket.close(CloseCode.RATE_LIMITED, 'too many attempts')
    const endpoint = this.#endpoint(remote, {
      send: bytes => { if (socket.readyState === socket.OPEN) socket.send(bytes) },
      close: (code, reason) => { try { socket.close(code, reason) } catch { socket.terminate() } },
    }, 'nearby')
    this.#sockets.set(endpoint, socket)
    socket.on('message', (data, isBinary) => {
      if (!isBinary) return void endpoint.kick(CloseCode.BAD_FRAME, 'binary frames only')
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      void endpoint.receive(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
    const gone = () => this.#gone(endpoint)
    socket.on('close', gone)
    socket.on('error', gone)
  }

  #endpoint(remote: string, transport: EndpointTransport, route: PhoneRoute, expectDevice?: string): PhoneEndpoint {
    const endpoint: PhoneEndpoint = new PhoneEndpoint({
      identity: this.identity, registry: this.registry, ring: this.ring, policy: this.options.policy,
      call: this.options.call, now: () => this.#now(), ...(expectDevice === undefined ? {} : { expectDevice }),
      confirm: enrollment => this.#ask(enrollment),
      onFailure: reason => { this.#noteFailure(remote); this.options.log?.('phone link refused', { reason, route }) },
      onAuthenticated: device => { this.options.log?.('phone signed in', { device: device.id, route }); this.#changed('devices') },
    }, transport)
    this.#endpoints.add(endpoint)
    this.#routes.set(endpoint, route)
    return endpoint
  }

  #gone(endpoint: PhoneEndpoint): void {
    if (!this.#endpoints.delete(endpoint)) return
    const signedIn = endpoint.device !== null
    endpoint.dispose()
    const draining = endpoint.idle()
    this.#draining.add(draining)
    void draining.finally(() => this.#draining.delete(draining)).catch(() => {})
    this.#sockets.delete(endpoint)
    this.#routes.delete(endpoint)
    // The window shows how each phone is connected, so a phone leaving is a change too.
    if (signedIn) this.#changed('devices')
  }

  #noteFailure(remote: string): void {
    const now = this.#now()
    const current = this.#failures.get(remote)
    if (!current || current.resetAt <= now) {
      // Remotes are whatever the network or the relay names, so the count is pruned rather than left to grow.
      if (this.#failures.size >= MAX_FAILURE_REMOTES) {
        for (const [key, entry] of this.#failures) if (entry.resetAt <= now) this.#failures.delete(key)
        if (this.#failures.size >= MAX_FAILURE_REMOTES) this.#failures.delete(this.#failures.keys().next().value!)
      }
      this.#failures.set(remote, { count: 1, resetAt: now + 60_000 })
    } else current.count++
  }

  #ask(enrollment: Enrollment): Promise<readonly PhoneTier[] | null> {
    const id = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => this.#settle(id, null), this.options.confirmTimeoutMs ?? 120_000)
      timer.unref()
      this.#pending.set(id, {
        ...enrollment, id, requestedAt: this.#now(),
        settle: tiers => { clearTimeout(timer); resolve(tiers) },
      })
      this.#changed('pending')
    })
  }

  #settle(id: string, tiers: readonly PhoneTier[] | null): boolean {
    const request = this.#pending.get(id)
    if (!request) return false
    this.#pending.delete(id)
    request.settle(tiers)
    this.#changed('pending')
    return true
  }

  #changed(change: PhoneLinkChange): void {
    for (const listener of this.#listeners) {
      try { listener(change) } catch (error) { this.options.log?.('phone link listener failed', { error: String(error) }) }
    }
  }
}
