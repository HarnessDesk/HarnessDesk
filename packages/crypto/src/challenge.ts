import { b64u, concat, fromB64u, randomBytes, timingSafeEqual, u32be, type Bytes } from './bytes.js'

/**
 * A stateless challenge: `nonce(16) || exp(u32) || HMAC-SHA256(key, nonce || exp)[0..16]`.
 * Anyone holding the key can check it without storing anything; it expires on its own.
 */
async function mac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)).slice(0, 16)
}

export async function makeChallenge(key: Bytes, nowSeconds: number, ttlSeconds = 60): Promise<{ challenge: string; expiresAt: number }> {
  const expiresAt = Math.floor(nowSeconds) + ttlSeconds
  const body = concat(randomBytes(16), u32be(expiresAt))
  return { challenge: b64u(concat(body, await mac(key, body))), expiresAt }
}

export async function checkChallenge(key: Bytes, challenge: string, nowSeconds: number): Promise<boolean> {
  let raw: Bytes
  try { raw = fromB64u(challenge) } catch { return false }
  if (raw.length !== 36) return false
  const body = raw.slice(0, 20)
  if (!timingSafeEqual(raw.slice(20), await mac(key, body))) return false
  const exp = new DataView(raw.buffer, raw.byteOffset + 16, 4).getUint32(0, false)
  return exp >= nowSeconds
}
