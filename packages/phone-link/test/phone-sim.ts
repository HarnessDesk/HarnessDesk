import { decodePairingOffer, type PairingOffer } from '@harnessdesk/contract'
import {
  b64u, fromB64u, generateSigningIdentity, handshakeDeviceMessage, idFromPub, startPhoneHandshake, utf8,
  type Session, type SigningIdentity,
} from '@harnessdesk/crypto'
import WebSocket from 'ws'

/** A stand-in phone for the tests: the real one is the iOS app, which speaks the same bytes. */
export class PhoneSim {
  session: Session | null = null
  closed: { code: number; reason: string } | null = null
  readonly inbox: any[] = []
  #waiters: (() => void)[] = []
  #frames: Uint8Array<ArrayBuffer>[] = []
  #frameWaiters: (() => void)[] = []
  #socket: WebSocket | null = null

  private constructor(readonly key: SigningIdentity, readonly id: string, readonly offer: PairingOffer | null) {}

  static async create(key?: SigningIdentity, offer: PairingOffer | null = null): Promise<PhoneSim> {
    const identity = key ?? await generateSigningIdentity()
    return new PhoneSim(identity, await idFromPub(identity.pub), offer)
  }

  static fromCode(url: string): Promise<PhoneSim> { return PhoneSim.create(undefined, decodePairingOffer(url)) }

  get pub(): string { return b64u(this.key.pub) }

  async open(port: number, deskPub: string, host = '127.0.0.1'): Promise<void> {
    const socket = new WebSocket(`ws://${host}:${port}/phone`)
    this.#socket = socket
    socket.binaryType = 'nodebuffer'
    socket.on('message', data => {
      const frame = new Uint8Array(data as Buffer) as Uint8Array<ArrayBuffer>
      if (this.session === null) { this.#frames.push(frame); this.#frameWaiters.splice(0).forEach(f => f()); return }
      void this.session.openJson(frame as Uint8Array<ArrayBuffer>).then(message => {
        this.inbox.push(message); this.#waiters.splice(0).forEach(f => f())
      })
    })
    socket.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; this.#waiters.splice(0).forEach(f => f()); this.#frameWaiters.splice(0).forEach(f => f()) })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const handshake = await startPhoneHandshake(fromB64u(deskPub))
    socket.send(handshake.hello)
    while (this.#frames.length === 0) {
      if (this.closed) throw new Error(`closed before READY: ${this.closed.code}`)
      await new Promise<void>(resolve => this.#frameWaiters.push(resolve))
    }
    this.session = await handshake.finish(this.#frames.shift()!)
  }

  async send(message: unknown): Promise<void> {
    this.#socket!.send(await this.session!.sealJson(message))
  }

  sendRaw(bytes: Uint8Array): void { this.#socket!.send(bytes) }

  async enroll(secret: string, name = 'Test phone'): Promise<void> {
    await this.send({ t: 'enroll', secret, devicePub: this.pub, name })
  }

  async auth(): Promise<void> {
    const sig = await this.key.sign(handshakeDeviceMessage(this.session!.th))
    await this.send({ t: 'auth', dev: this.id, sig: b64u(sig) })
  }

  async next(match: (m: any) => boolean = () => true, ms = 3000): Promise<any> {
    const deadline = Date.now() + ms
    for (;;) {
      const at = this.inbox.findIndex(match)
      if (at >= 0) return this.inbox.splice(at, 1)[0]
      if (this.closed) throw new Error(`closed ${this.closed.code} ${this.closed.reason}`)
      if (Date.now() > deadline) throw new Error(`timed out; inbox ${JSON.stringify(this.inbox)}`)
      await new Promise<void>(resolve => { this.#waiters.push(resolve); setTimeout(resolve, 25) })
    }
  }

  async request(method: string, params?: unknown): Promise<any> {
    const id = Math.random().toString(36).slice(2)
    await this.send({ t: 'req', id, method, params })
    return this.next(m => m.t === 'res' && m.id === id)
  }

  async closedWith(ms = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + ms
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('did not close')
      await new Promise<void>(resolve => { this.#waiters.push(resolve); setTimeout(resolve, 25) })
    }
    return this.closed
  }

  close(): void { this.#socket?.close() }
  utf8 = utf8
}
