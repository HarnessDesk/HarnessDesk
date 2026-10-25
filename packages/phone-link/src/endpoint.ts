import { FirstPhoneMessage, PhoneToDesk, CloseCode } from '@harnessdesk/contract'
import {
  E2eeError, HELLO_LENGTH, FRAME_HELLO, acceptHandshake, b64u, fromB64u, generatePushKey, handshakeDeviceMessage, handshakeEnrollMessage,
  idFromPub, verifyEd25519, type Session,
} from '@harnessdesk/crypto'
import type { DeskIdentity } from './identity.js'
import { PHONE_TIERS, type Device, type DeviceRegistry, type PhoneTier } from './registry.js'
import type { EventRing, RingEvent } from './ring.js'

/** What a phone may ask for and hear, each with the tier it takes. The desk decides this, never the cloud. */
export interface PhonePolicy {
  readonly methods: Readonly<Record<string, PhoneTier>>
  readonly topics: Readonly<Record<string, PhoneTier>>
  /** Tiers a phone gets when its owner allows it without choosing. */
  readonly defaultTiers: readonly PhoneTier[]
}

export interface Enrollment {
  readonly name: string
  readonly devicePub: string
  readonly deviceId: string
}

export interface EndpointDeps {
  readonly identity: DeskIdentity
  readonly registry: DeviceRegistry
  readonly ring: EventRing
  readonly policy: PhonePolicy
  /** Runs one allowed request. Throws `PhoneCallError` to give the phone a code. */
  call(method: string, params: unknown, device: Device): Promise<unknown>
  /** Asks the person at the desk. Resolves the tiers granted, or null when the answer is no. */
  confirm(enrollment: Enrollment): Promise<readonly PhoneTier[] | null>
  now(): number
  readonly handshakeMs?: number
  readonly authMs?: number
  readonly maxInFlight?: number
  onFailure?(reason: string): void
  onAuthenticated?(device: Device): void
}

export interface EndpointTransport {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
}

/** A refusal the phone should read: a short stable code and a sentence. */
export class PhoneCallError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

type Stage = 'hello' | 'auth' | 'open' | 'closed'

/**
 * One phone's encrypted session with this desk, the same over the LAN socket and the relay.
 * The first frame is the handshake, the first message inside it proves who the phone is, and nothing else is
 * answered until it has.
 */
export class PhoneEndpoint {
  #stage: Stage = 'hello'
  #session: Session | null = null
  #device: Device | null = null
  #queue: Promise<void> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | null = null
  #liveFrom = 0
  #inFlight = 0
  #queuedFrames = 0
  #queuedBytes = 0
  #confirming = false

  constructor(private readonly deps: EndpointDeps, private readonly transport: EndpointTransport) {
    this.#arm(deps.handshakeMs ?? 10_000, 'no handshake')
  }

  get device(): Device | null { return this.#device }
  get open(): boolean { return this.#stage === 'open' }
  get closed(): boolean { return this.#stage === 'closed' }

  /** One binary frame from the phone. Frames are taken one at a time, in the order they arrived. */
  receive(frame: Uint8Array): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.#confirming || this.#queuedFrames >= 32 || frame.byteLength > 1_048_576 - this.#queuedBytes) {
      this.#close(CloseCode.BAD_FRAME, 'frames cannot wait here')
      return Promise.resolve()
    }
    this.#queuedFrames++; this.#queuedBytes += frame.byteLength
    this.#queue = this.#queue.then(() => this.#take(frame)).catch(error => this.#fail(error)).finally(() => {
      this.#queuedFrames--; this.#queuedBytes -= frame.byteLength
    })
    return this.#queue
  }

  /** A new event for this phone, if it is signed in and allowed to hear the topic. */
  deliver(event: RingEvent): void {
    if (this.#stage !== 'open' || event.seq <= this.#liveFrom) return
    this.#sendEvent(event)
  }

  /** End the session with a code the phone understands (4423: this phone was removed). */
  kick(code: number, reason: string): void { this.#close(code, reason) }

  dispose(): void {
    this.#stage = 'closed'
    this.#disarm()
  }

  async #take(frame: Uint8Array): Promise<void> {
    if (this.#stage === 'closed') return
    if (this.#stage === 'hello') return this.#hello(frame)
    const session = this.#session!
    const message = await session.openJson(frame as Uint8Array<ArrayBuffer>)
    if (this.closed) return
    if (this.#stage === 'auth') return this.#first(message)
    return this.#message(message)
  }

  async #hello(frame: Uint8Array): Promise<void> {
    if (frame.length !== HELLO_LENGTH || frame[0] !== FRAME_HELLO) throw new E2eeError('format')
    const { ready, session } = await acceptHandshake(frame as Uint8Array<ArrayBuffer>, this.deps.identity.key)
    if (this.closed) return
    this.#session = session
    this.#stage = 'auth'
    this.transport.send(ready)
    this.#arm(this.deps.authMs ?? 10_000, 'no sign-in')
  }

  async #first(raw: unknown): Promise<void> {
    const parsed = FirstPhoneMessage.safeParse(raw)
    if (!parsed.success) return this.#refuse(CloseCode.BAD_FRAME, 'expected auth or enroll')
    const { registry, ring } = this.deps
    const th = this.#session!.th
    if (parsed.data.t === 'auth') {
      const id = parsed.data.dev
      if (registry.isRevoked(id)) return this.#refuse(CloseCode.REVOKED, 'this phone was removed')
      const device = registry.get(id)
      if (!device) return this.#refuse(CloseCode.UNAUTHORIZED, 'unknown phone')
      const proven = await verifyEd25519(fromB64u(device.pub), fromB64u(parsed.data.sig), handshakeDeviceMessage(th))
      if (!proven) return this.#refuse(CloseCode.UNAUTHORIZED, 'bad signature')
      await registry.touch(id, this.deps.now())
      if (this.closed) return
      this.#device = registry.get(id)
      this.#signedIn()
      await this.#send({ t: 'auth.ok', epoch: ring.epoch, seq: ring.seq })
      return
    }
    const devicePub = fromB64u(parsed.data.devicePub)
    const proven = await verifyEd25519(devicePub, fromB64u(parsed.data.sig), handshakeEnrollMessage(th))
    if (this.closed) return
    if (!proven) return this.#refuse(CloseCode.UNAUTHORIZED, 'bad enrollment signature')
    if (!registry.takeOffer(parsed.data.secret, this.deps.now())) return this.#refuse(CloseCode.UNAUTHORIZED, 'pairing code not accepted')
    if (registry.full) return this.#refuse(CloseCode.UNAUTHORIZED, 'this desk has the most phones it allows')
    const deviceId = await idFromPub(devicePub)
    // Waiting here is the point: the phone has shown a valid code, and a person decides whether it is theirs.
    this.#disarm()
    this.#confirming = true
    const tiers = await this.deps.confirm({ name: parsed.data.name, devicePub: parsed.data.devicePub, deviceId })
    this.#confirming = false
    if (this.closed) return
    if (tiers === null) return this.#refuse(CloseCode.UNAUTHORIZED, 'the person at the desk said no')
    const pushKey = generatePushKey()
    const device: Device = {
      id: deviceId, pub: parsed.data.devicePub, name: parsed.data.name,
      tiers: PHONE_TIERS.filter(tier => tiers.includes(tier)), pushKey: b64u(pushKey), kid: 1,
      createdAt: this.deps.now(), lastSeenAt: this.deps.now(),
    }
    await registry.add(device)
    if (this.closed) return
    this.#device = device
    this.#signedIn()
    await this.#send({ t: 'enroll.ok', deviceId, pushKey: device.pushKey, kid: device.kid, epoch: ring.epoch, seq: ring.seq })
  }

  #signedIn(): void {
    this.#disarm()
    this.#stage = 'open'
    // Events after this point arrive live; a phone that wants the ones it missed before it asks to resume.
    this.#liveFrom = this.deps.ring.seq
    this.deps.onAuthenticated?.(this.#device!)
  }

  async #message(raw: unknown): Promise<void> {
    if (typeof raw === 'object' && raw !== null && (raw as { t?: unknown }).t === 'ping') return this.#send({ t: 'pong' })
    const parsed = PhoneToDesk.safeParse(raw)
    if (!parsed.success) return this.#close(CloseCode.BAD_FRAME, 'unrecognised message')
    const message = parsed.data
    if (message.t === 'resume') return this.#resume(message.epoch, message.after)
    if (message.t !== 'req') return this.#close(CloseCode.BAD_FRAME, 'unexpected message')
    // Answer in the background: a slow call must not hold up the next frame, or a heartbeat.
    if (this.#inFlight >= (this.deps.maxInFlight ?? 32)) {
      return this.#send({ t: 'res', id: message.id, ok: false, error: { code: 'busy', message: 'Too many requests are waiting.' } })
    }
    this.#inFlight++
    void this.#request(message.id, message.method, message.params).finally(() => { this.#inFlight-- })
  }

  async #request(id: string, method: string, params: unknown): Promise<void> {
    const refuse = (code: string, text: string) => this.#send({ t: 'res', id, ok: false, error: { code, message: text } })
    const device = this.deps.registry.get(this.#device!.id)
    // A removal that landed while the request waited wins.
    if (!device) return void refuse('revoked', 'This phone was removed.')
    const tier = Object.hasOwn(this.deps.policy.methods, method) ? this.deps.policy.methods[method] : undefined
    if (tier === undefined) return void refuse('notOnPhoneSurface', 'That is not something a phone can ask for.')
    if (!device.tiers.includes(tier)) return void refuse('tierNotGranted', 'This phone was not allowed to do that.')
    try {
      const result = await this.deps.call(method, params, device)
      await this.#send({ t: 'res', id, ok: true, result: result ?? null })
    } catch (error) {
      const code = error instanceof PhoneCallError ? error.code : typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'methodFailed'
      await this.#send({ t: 'res', id, ok: false, error: { code, message: String(error instanceof Error ? error.message : error).slice(0, 500) } })
    }
  }

  async #resume(epoch: string, after: number): Promise<void> {
    const { ring } = this.deps
    const read = ring.read(epoch, after, this.#liveFrom)
    if (!read.ok) return this.#send({ t: 'resume.reset', epoch: ring.epoch })
    await this.#send({ t: 'resume.ok', epoch: ring.epoch, from: after + 1, to: this.#liveFrom })
    for (const event of read.events) this.#sendEvent(event)
  }

  #sendEvent(event: RingEvent): void {
    const device = this.#device && this.deps.registry.get(this.#device.id)
    if (!device) return
    const tier = Object.hasOwn(this.deps.policy.topics, event.topic) ? this.deps.policy.topics[event.topic] : undefined
    if (tier === undefined || !device.tiers.includes(tier)) return
    void this.#send({ t: 'evt', epoch: this.deps.ring.epoch, seq: event.seq, topic: event.topic, data: event.data })
  }

  async #send(message: unknown): Promise<void> {
    if (this.#stage === 'closed' || !this.#session) return
    try { this.transport.send(await this.#session.sealJson(message)) } catch (error) { this.#fail(error) }
  }

  async #refuse(code: number, reason: string): Promise<void> {
    this.deps.onFailure?.(reason)
    await this.#send({ t: 'error', code, message: reason })
    this.#close(code, reason)
  }

  #fail(error: unknown): void {
    this.deps.onFailure?.(error instanceof E2eeError ? error.code : 'error')
    this.#close(CloseCode.BAD_FRAME, error instanceof E2eeError ? error.code : 'bad frame')
  }

  #close(code: number, reason: string): void {
    if (this.#stage === 'closed') return
    this.#stage = 'closed'
    this.#disarm()
    this.transport.close(code, reason.slice(0, 120))
  }

  #arm(ms: number, reason: string): void {
    this.#disarm()
    this.#timer = setTimeout(() => this.#close(CloseCode.UNAUTHORIZED, reason), ms)
    this.#timer.unref()
  }

  #disarm(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}
