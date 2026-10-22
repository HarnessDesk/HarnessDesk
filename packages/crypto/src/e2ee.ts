import { concat, readU64be, sha256, u64be, utf8, fromUtf8, type Bytes } from './bytes.js'
import { ephemeralFromSeed, generateEphemeral, idBytesFromPub, verifyEd25519, type EphemeralKey, type SigningIdentity } from './keys.js'
import { handshakeDeskMessage } from './proofs.js'
import { randomBytes } from './bytes.js'

export const FRAME_HELLO = 0x01
export const FRAME_READY = 0x02
export const FRAME_DATA = 0x10
export const E2EE_VERSION = 1
export const HELLO_LENGTH = 50
export const READY_LENGTH = 114
/** Plaintext kind byte: a UTF-8 JSON application message. */
export const KIND_JSON = 0x01
const MAX_FRAMES_PER_SESSION = 2n ** 32n

export type E2eeErrorCode = 'format' | 'version' | 'desk-signature' | 'desk-mismatch' | 'counter' | 'decrypt' | 'exhausted'

export class E2eeError extends Error {
  constructor(readonly code: E2eeErrorCode, message?: string) {
    super(message ?? `e2ee: ${code}`)
  }
}

export interface HandshakeOptions {
  /** Test vectors only: fixed ephemeral key and nonce. */
  readonly seeds?: { readonly ephemeral: Bytes; readonly nonce: Bytes }
}

async function ephemeralFor(opts?: HandshakeOptions): Promise<{ eph: EphemeralKey; nonce: Bytes }> {
  if (opts?.seeds) return { eph: await ephemeralFromSeed(opts.seeds.ephemeral), nonce: opts.seeds.nonce }
  return { eph: await generateEphemeral(), nonce: randomBytes(16) }
}

const transcriptHash = (deskIdBytes: Bytes, hello: Bytes, readyUnsigned: Bytes): Promise<Bytes> =>
  sha256(utf8('hd-e2ee-1\0'), deskIdBytes, hello, readyUnsigned)

async function hkdf(sharedSecret: Bytes, salt: Bytes, info: string, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, key, bytes * 8))
}

async function deriveSession(role: 'phone' | 'desk', shared: Bytes, th: Bytes): Promise<Session> {
  const [kP2D, kD2P, sid] = await Promise.all([
    hkdf(shared, th, 'hd-e2ee-1 p2d', 32),
    hkdf(shared, th, 'hd-e2ee-1 d2p', 32),
    hkdf(shared, th, 'hd-e2ee-1 sid', 8),
  ])
  const importKey = (raw: Bytes) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const [p2d, d2p] = await Promise.all([importKey(kP2D), importKey(kD2P)])
  return new Session(role === 'phone' ? p2d : d2p, role === 'phone' ? d2p : p2d, sid, th)
}

/**
 * One encrypted session. Counters are per direction and must arrive exactly in order.
 *
 * `seal` takes its counter before it first awaits, so calls made together get consecutive counters and never
 * share one; send the frames in the order the calls were made. `open` is serialized: calls queue behind each
 * other, so a frame is opened at most once and frames given together are checked in the order given.
 */
export class Session {
  #sendCounter = 0n
  #recvCounter = 0n
  #opening: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    private readonly sid: Bytes,
    /** The handshake transcript hash; the phone signs it to authenticate itself. */
    readonly th: Bytes,
  ) {}

  get sent(): bigint { return this.#sendCounter }
  get received(): bigint { return this.#recvCounter }

  async seal(body: Bytes, kind: number = KIND_JSON): Promise<Bytes> {
    if (this.#sendCounter >= MAX_FRAMES_PER_SESSION) throw new E2eeError('exhausted')
    // Reserved before the first await: a concurrent call must see the next value, not this one.
    const counter = u64be(this.#sendCounter)
    this.#sendCounter += 1n
    const header = concat(Uint8Array.of(FRAME_DATA), counter)
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: concat(new Uint8Array(4), counter), additionalData: concat(header, this.sid), tagLength: 128 },
      this.sendKey,
      concat(Uint8Array.of(kind), body),
    ))
    return concat(header, ct)
  }

  sealJson(value: unknown): Promise<Bytes> {
    return this.seal(utf8(JSON.stringify(value)))
  }

  /**
   * Throws on any failure. A frame that fails to open does not advance the counter, so the session stays usable;
   * a caller that treats any failure as fatal, as the protocol does, closes and re-handshakes. Calls are
   * serialized, so the same frame cannot open twice.
   */
  open(frame: Bytes): Promise<{ kind: number; body: Bytes }> {
    const result = this.#opening.then(() => this.#openOne(frame))
    this.#opening = result.catch(() => undefined)
    return result
  }

  async #openOne(frame: Bytes): Promise<{ kind: number; body: Bytes }> {
    if (frame.length < 1 + 8 + 16 + 1 || frame[0] !== FRAME_DATA) throw new E2eeError('format')
    const counter = readU64be(frame, 1)
    if (counter !== this.#recvCounter) throw new E2eeError('counter', `expected ${this.#recvCounter}, got ${counter}`)
    const header = frame.subarray(0, 9)
    let plain: Bytes
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: concat(new Uint8Array(4), frame.subarray(1, 9)), additionalData: concat(header, this.sid), tagLength: 128 },
        this.recvKey,
        frame.subarray(9),
      ))
    } catch {
      throw new E2eeError('decrypt')
    }
    this.#recvCounter += 1n
    return { kind: plain[0]!, body: plain.subarray(1) }
  }

  async openJson(frame: Bytes): Promise<unknown> {
    const { kind, body } = await this.open(frame)
    if (kind !== KIND_JSON) throw new E2eeError('format', 'unexpected plaintext kind')
    try { return JSON.parse(fromUtf8(body)) } catch { throw new E2eeError('format', 'not JSON') }
  }
}

export interface PhoneHandshake {
  readonly hello: Bytes
  /** Verifies the desk's signature against the key pinned from the QR, then derives the session. */
  finish(ready: Bytes): Promise<Session>
}

/** Phone side. `deskPub` is the key pinned from the QR; nothing from the network can replace it. */
export async function startPhoneHandshake(deskPub: Bytes, opts?: HandshakeOptions): Promise<PhoneHandshake> {
  const deskIdBytes = await idBytesFromPub(deskPub)
  const { eph, nonce } = await ephemeralFor(opts)
  const hello = concat(Uint8Array.of(FRAME_HELLO, E2EE_VERSION), eph.pub, nonce)
  return {
    hello,
    async finish(ready) {
      if (ready.length !== READY_LENGTH || ready[0] !== FRAME_READY) throw new E2eeError('format')
      if (ready[1] !== E2EE_VERSION) throw new E2eeError('version')
      const unsigned = ready.subarray(0, READY_LENGTH - 64)
      const th = await transcriptHash(deskIdBytes, hello, unsigned)
      if (!(await verifyEd25519(deskPub, ready.subarray(READY_LENGTH - 64), handshakeDeskMessage(th)))) throw new E2eeError('desk-signature')
      let shared: Bytes
      try { shared = await eph.agree(ready.subarray(2, 34)) } catch { throw new E2eeError('format', 'bad desk key') }
      return deriveSession('phone', shared, th)
    },
  }
}

/** Desk side: answer a HELLO. Returns the READY frame to send and the session to use after it. */
export async function acceptHandshake(hello: Bytes, desk: SigningIdentity, opts?: HandshakeOptions): Promise<{ ready: Bytes; session: Session }> {
  if (hello.length !== HELLO_LENGTH || hello[0] !== FRAME_HELLO) throw new E2eeError('format')
  if (hello[1] !== E2EE_VERSION) throw new E2eeError('version')
  const deskIdBytes = await idBytesFromPub(desk.pub)
  const { eph, nonce } = await ephemeralFor(opts)
  const unsigned = concat(Uint8Array.of(FRAME_READY, E2EE_VERSION), eph.pub, nonce)
  const th = await transcriptHash(deskIdBytes, hello, unsigned)
  const sig = await desk.sign(handshakeDeskMessage(th))
  let shared: Bytes
  try { shared = await eph.agree(hello.subarray(2, 34)) } catch { throw new E2eeError('format', 'bad phone key') }
  return { ready: concat(unsigned, sig), session: await deriveSession('desk', shared, th) }
}
