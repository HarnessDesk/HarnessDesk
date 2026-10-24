import { b64u, concat, fromB64u, fromUtf8, randomBytes, utf8, type Bytes } from './bytes.js'

/** Largest push plaintext. Base64 of this plus the APNs envelope stays under 4096 bytes. */
export const PUSH_PLAINTEXT_MAX = 2048

const aad = (deviceId: string, kid: number): Bytes => concat(utf8('hd-push-1\0'), utf8(deviceId), utf8('\0'), utf8(String(kid)))

export const generatePushKey = (): Bytes => randomBytes(32)

export interface SealedPush {
  readonly kid: number
  /** base64url, 12 bytes */
  readonly nonce: string
  /** base64url ciphertext with the GCM tag appended */
  readonly ciphertext: string
}

async function key(raw: Bytes, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage])
}

export async function sealPush(pushKey: Bytes, kid: number, deviceId: string, plaintext: Bytes, nonce: Bytes = randomBytes(12)): Promise<SealedPush> {
  if (plaintext.length > PUSH_PLAINTEXT_MAX) throw new Error('push plaintext too large')
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(deviceId, kid), tagLength: 128 }, await key(pushKey, 'encrypt'), plaintext))
  return { kid, nonce: b64u(nonce), ciphertext: b64u(ct) }
}

export async function openPush(pushKey: Bytes, deviceId: string, sealed: SealedPush): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(sealed.nonce), additionalData: aad(deviceId, sealed.kid), tagLength: 128 },
    await key(pushKey, 'decrypt'),
    fromB64u(sealed.ciphertext),
  ))
}

export const sealPushJson = (pushKey: Bytes, kid: number, deviceId: string, value: unknown): Promise<SealedPush> =>
  sealPush(pushKey, kid, deviceId, utf8(JSON.stringify(value)))

export async function openPushJson(pushKey: Bytes, deviceId: string, sealed: SealedPush): Promise<unknown> {
  return JSON.parse(fromUtf8(await openPush(pushKey, deviceId, sealed)))
}
