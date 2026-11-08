import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type PhoneTier = 'read' | 'run' | 'answer'
export const PHONE_TIERS: readonly PhoneTier[] = ['read', 'run', 'answer']

export interface Device {
  readonly id: string
  /** The device's Ed25519 public key, base64url. */
  readonly pub: string
  readonly name: string
  readonly tiers: readonly PhoneTier[]
  /** Key the desk seals this phone's push messages with; the service never has it. */
  readonly pushKey: string
  readonly kid: number
  readonly createdAt: number
  readonly lastSeenAt: number | null
}

interface Stored { readonly v: 1; readonly devices: readonly Device[]; readonly revoked: Readonly<Record<string, number>> }

/** The relay admits eight phones to a desk; the desk holds itself to the same number. */
export const MAX_DEVICES = 8

export class DeviceRegistry {
  #devices = new Map<string, Device>()
  #revoked = new Map<string, number>()
  #offers = new Map<string, number>()
  #write: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string) {}

  /** A file that exists but does not parse is an error: paired phones are never forgotten by starting over. */
  static async open(path: string): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(path)
    let text: string | null = null
    try { text = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The device list at ${path} could not be read.`, { cause: error })
    }
    if (text !== null) {
      let stored: Stored
      try { stored = JSON.parse(text) as Stored; if (stored.v !== 1 || !Array.isArray(stored.devices)) throw new Error('unexpected shape') } catch (error) {
        throw new Error(`The device list at ${path} is not valid, and was left as it is.`, { cause: error })
      }
      for (const device of stored.devices) registry.#devices.set(device.id, device)
      for (const [id, at] of Object.entries(stored.revoked ?? {})) registry.#revoked.set(id, at)
    }
    return registry
  }

  list(): readonly Device[] { return [...this.#devices.values()] }
  get(id: string): Device | null { return this.#devices.get(id) ?? null }
  isRevoked(id: string): boolean { return this.#revoked.has(id) }
  get full(): boolean { return this.#devices.size >= MAX_DEVICES }

  add(device: Device): Promise<void> {
    return this.#mutate((devices, revoked) => {
      if (devices.size >= MAX_DEVICES) throw new Error('This desk already has the most phones it allows.')
      devices.set(device.id, device)
      revoked.delete(device.id)
    })
  }

  /** The device is forgotten and its id remembered, so a phone that comes back is told it was removed. */
  revoke(id: string, now: number): Promise<Device | null> {
    return this.#mutate((devices, revoked) => {
      const device = devices.get(id)
      if (!device) return null
      devices.delete(id)
      revoked.set(id, now)
      return device
    })
  }

  touch(id: string, now: number): Promise<void> {
    return this.#mutate(devices => {
      const device = devices.get(id)
      if (device) devices.set(id, { ...device, lastSeenAt: now })
    })
  }

  setTiers(id: string, tiers: readonly PhoneTier[]): Promise<Device | null> {
    return this.#mutate(devices => {
      const device = devices.get(id)
      if (!device) return null
      const next = { ...device, tiers: [...new Set(tiers)] }
      devices.set(id, next)
      return next
    })
  }

  /** A single-use secret for one pairing code. It lives in memory only: a restart voids every code. */
  issueOffer(ttlMs: number, now: number): { secret: Uint8Array<ArrayBuffer>; expiresAt: number } {
    this.#sweepOffers(now)
    const secret = randomBytes(16)
    const expiresAt = now + ttlMs
    this.#offers.set(secret.toString('base64url'), expiresAt)
    return { secret: new Uint8Array(secret), expiresAt }
  }

  /** True once per secret, and only before it expires. */
  takeOffer(secret: string, now: number): boolean {
    this.#sweepOffers(now)
    let found: string | null = null
    for (const known of this.#offers.keys()) {
      const a = Buffer.from(known), b = Buffer.from(secret)
      if (a.length === b.length && timingSafeEqual(a, b)) found = known
    }
    if (found === null) return false
    this.#offers.delete(found)
    return true
  }

  get liveOffers(): number { return this.#offers.size }

  #sweepOffers(now: number): void {
    for (const [secret, expiresAt] of this.#offers) if (expiresAt <= now) this.#offers.delete(secret)
  }

  #mutate<T>(change: (devices: Map<string, Device>, revoked: Map<string, number>) => T): Promise<T> {
    const next = this.#write.then(async () => {
      const devices = new Map(this.#devices), revoked = new Map(this.#revoked)
      const result = change(devices, revoked)
      const body: Stored = { v: 1, devices: [...devices.values()], revoked: Object.fromEntries(revoked) }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(body), { mode: 0o600 })
      await rename(temporary, this.path)
      this.#devices = devices
      this.#revoked = revoked
      return result
    })
    this.#write = next.then(() => {}, () => {})
    return next
  }
}
