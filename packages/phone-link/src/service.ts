import { randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CloseCode, encodePairingOffer, type PairingOffer } from '@harnessdesk/contract'
import { b64u } from '@harnessdesk/crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { PhoneEndpoint, type Enrollment, type PhonePolicy } from './endpoint.js'
import { loadOrCreateDeskIdentity, type DeskIdentity } from './identity.js'
import { DeviceRegistry, PHONE_TIERS, type Device, type PhoneTier } from './registry.js'
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

export interface PairingCode {
  readonly url: string
  readonly offer: PairingOffer
  readonly expiresAt: number
}

export type PhoneLinkChange = 'devices' | 'pending'

const PATH = '/phone'
const FAILURES_PER_MINUTE = 10

/**
 * The LAN half of the phone link. It listens for phones, runs each through the encrypted session, and keeps
 * the person in the loop for anything new: a phone that shows a valid pairing code still waits for "Allow this
 * phone?". Nothing here depends on the cloud.
 */
export class PhoneLinkService {
  readonly #endpoints = new Set<PhoneEndpoint>()
  readonly #sockets = new Map<PhoneEndpoint, WebSocket>()
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

  /** A new pairing code: single-use, short-lived, carrying the desk's public key for the phone to pin. */
  createPairingCode(ttlSeconds = 600): PairingCode {
    const { secret, expiresAt } = this.registry.issueOffer(ttlSeconds * 1000, this.#now())
    const offer: PairingOffer = {
      v: 1, deskPub: this.identity.pub, name: this.name.slice(0, 80) || 'Desk', enroll: b64u(secret),
      lan: this.lanAddresses(), exp: Math.floor(expiresAt / 1000),
    }
    return { url: encodePairingOffer(offer), offer, expiresAt }
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

  async close(): Promise<void> {
    for (const id of [...this.#pending.keys()]) this.#settle(id, null)
    for (const socket of this.wss.clients) socket.close(1001, 'desk-closed')
    for (const endpoint of this.#endpoints) endpoint.dispose()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
  }

  #accept(socket: WebSocket, remote: string): void {
    const limit = this.options.maxSockets ?? 16
    if (this.#sockets.size >= limit) return void socket.close(CloseCode.RATE_LIMITED, 'busy')
    const failures = this.#failures.get(remote)
    if (failures && failures.resetAt > this.#now() && failures.count >= FAILURES_PER_MINUTE) return void socket.close(CloseCode.RATE_LIMITED, 'too many attempts')
    const endpoint: PhoneEndpoint = new PhoneEndpoint({
      identity: this.identity, registry: this.registry, ring: this.ring, policy: this.options.policy,
      call: this.options.call, now: () => this.#now(),
      confirm: enrollment => this.#ask(enrollment),
      onFailure: reason => { this.#noteFailure(remote); this.options.log?.('phone link refused', { reason }) },
      onAuthenticated: device => { this.options.log?.('phone signed in', { device: device.id }); this.#changed('devices') },
    }, {
      send: bytes => { if (socket.readyState === socket.OPEN) socket.send(bytes) },
      close: (code, reason) => { try { socket.close(code, reason) } catch { socket.terminate() } },
    })
    this.#endpoints.add(endpoint)
    this.#sockets.set(endpoint, socket)
    socket.on('message', (data, isBinary) => {
      if (!isBinary) return void endpoint.kick(CloseCode.BAD_FRAME, 'binary frames only')
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      void endpoint.receive(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
    const gone = () => { endpoint.dispose(); this.#endpoints.delete(endpoint); this.#sockets.delete(endpoint) }
    socket.on('close', gone)
    socket.on('error', gone)
  }

  #noteFailure(remote: string): void {
    const now = this.#now()
    const current = this.#failures.get(remote)
    if (!current || current.resetAt <= now) this.#failures.set(remote, { count: 1, resetAt: now + 60_000 })
    else current.count++
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
