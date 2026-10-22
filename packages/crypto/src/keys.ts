import { b64u, concat, fromB64u, sha256, type Bytes } from './bytes.js'

const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const X25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

/** An Ed25519 identity: a desk's or a phone's long-term key. */
export interface SigningIdentity {
  readonly pub: Bytes
  sign(message: Bytes): Promise<Bytes>
  /** PKCS#8 DER, for storing the key. Every identity this package creates is extractable. */
  exportPkcs8(): Promise<Bytes>
}

// The relay runtime's and Node's type libraries describe exportKey and the X25519 algorithm differently; these two
// helpers keep the rest of the file valid under both.
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey }
type PublicJwk = { x?: string }

async function exportRaw(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer)
}

async function publicOfPrivate(key: CryptoKey): Promise<Bytes> {
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as PublicJwk
  if (!jwk.x) throw new Error('key has no public part')
  return fromB64u(jwk.x)
}

async function identityFrom(priv: CryptoKey, pub: Bytes): Promise<SigningIdentity> {
  return {
    pub,
    sign: async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', priv, m)),
    exportPkcs8: async () => new Uint8Array((await crypto.subtle.exportKey('pkcs8', priv)) as ArrayBuffer),
  }
}

export async function generateSigningIdentity(): Promise<SigningIdentity> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as KeyPair
  return identityFrom(pair.privateKey, await exportRaw(pair.publicKey))
}

export async function signingIdentityFromPkcs8(pkcs8: Bytes): Promise<SigningIdentity> {
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign'])
  // PKCS#8 carries only the seed; the public half comes from the JWK export.
  return identityFrom(priv, await publicOfPrivate(priv))
}

/** Deterministic identity from a 32-byte seed. Used for test vectors and tests. */
export async function signingIdentityFromSeed(seed: Bytes): Promise<SigningIdentity> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes')
  return signingIdentityFromPkcs8(concat(ED25519_PKCS8_PREFIX, seed))
}

export async function verifyEd25519(pub: Bytes, signature: Bytes, message: Bytes): Promise<boolean> {
  if (pub.length !== 32 || signature.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, signature, message)
  } catch {
    return false
  }
}

/** An X25519 key pair for one handshake. */
export interface EphemeralKey {
  readonly pub: Bytes
  /** Raw shared secret with a peer's public key. Rejects an all-zero result (low-order peer key). */
  agree(peerPub: Bytes): Promise<Bytes>
}

export async function generateEphemeral(): Promise<EphemeralKey> {
  const pair = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as KeyPair
  return ephemeralFrom(pair.privateKey, await exportRaw(pair.publicKey))
}

/** Deterministic ephemeral from a 32-byte seed. Test vectors only. */
export async function ephemeralFromSeed(seed: Bytes): Promise<EphemeralKey> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes')
  const priv = await crypto.subtle.importKey('pkcs8', concat(X25519_PKCS8_PREFIX, seed), 'X25519', true, ['deriveBits'])
  return ephemeralFrom(priv, await publicOfPrivate(priv))
}

function ephemeralFrom(priv: CryptoKey, pub: Bytes): EphemeralKey {
  return {
    pub,
    async agree(peerPub) {
      if (peerPub.length !== 32) throw new Error('bad peer key')
      const peer = await crypto.subtle.importKey('raw', peerPub, 'X25519', false, [])
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer } as never, priv, 256))
      if (bits.every((b) => b === 0)) throw new Error('degenerate shared secret')
      return bits
    },
  }
}

/** The self-certifying id of a desk or device: first 16 bytes of SHA-256 of the public key. */
export async function idBytesFromPub(pub: Bytes): Promise<Bytes> {
  return (await sha256(pub)).slice(0, 16)
}

export async function idFromPub(pub: Bytes): Promise<string> {
  return b64u(await idBytesFromPub(pub))
}
