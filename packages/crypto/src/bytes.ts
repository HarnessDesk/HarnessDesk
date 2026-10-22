/** Byte arrays backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export const utf8 = (s: string): Bytes => new Uint8Array(enc.encode(s))
export const fromUtf8 = (b: Bytes): string => dec.decode(b)

export function b64u(bytes: Bytes): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('bad base64url')
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  // One spelling per value: atob ignores the unused low bits of the last character, so re-encode and compare.
  if (b64u(out) !== text) throw new Error('bad base64url')
  return out
}

/**
 * A copy that is one whatever the input is. `Buffer.prototype.slice` is a view, not a copy, and a Node
 * socket hands over Buffers, so `.slice()` cannot be trusted to take the bytes.
 */
export const copyBytes = (b: Uint8Array): Bytes => new Uint8Array(b)

export function concat(...parts: Bytes[]): Bytes {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function u32be(n: number): Bytes {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, false)
  return b
}

export function u64be(n: bigint): Bytes {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, false)
  return b
}

export function readU64be(b: Bytes, offset = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(offset, false)
}

export function toHex(b: Bytes): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function fromHex(h: string): Bytes {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Length-independent-of-content comparison; false for different lengths. */
export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n))
}

export async function sha256(...parts: Bytes[]): Promise<Bytes> {
  const data = concat(...parts)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}
