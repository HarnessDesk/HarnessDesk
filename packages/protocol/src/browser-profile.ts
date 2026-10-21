import { runtimeId, sessionId, type RuntimeId, type SessionId } from './ids.js'

/** A reversible identity: neither folders, branch names nor account display names own a browser. */
export function sessionBrowserProfile(runtime: RuntimeId | string, session: SessionId | string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([runtime, session]))
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `session-${encoded}`
}

/** Decode only the canonical encoding, so an alternate spelling cannot allocate another partition. */
export function browserProfileSession(profile: string): { runtime: RuntimeId; sessionId: SessionId } | null {
  if (!/^session-[A-Za-z0-9_-]+$/.test(profile) || profile.endsWith('\n')) return null
  try {
    const binary = atob(profile.slice('session-'.length).replaceAll('-', '+').replaceAll('_', '/'))
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))))
    if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null
    const [runtime, id] = value as [string, string]
    return sessionBrowserProfile(runtime, id) === profile ? { runtime: runtimeId(runtime), sessionId: sessionId(id) } : null
  } catch { return null }
}

/** Syntax only. The host separately authorizes the session or retained lane before desktop use. */
export const isBrowserProfile = (profile: unknown): profile is string => typeof profile === 'string' &&
  ((!profile.endsWith('\n') && /^lane-[A-Za-z0-9-]{1,100}$/.test(profile)) || browserProfileSession(profile) !== null)

/** A filesystem component: Electron lowercases partitions, and filesystems cap component lengths. */
export const browserProfileStorageName = (profile: string): string =>
  profile.startsWith('session-') ? `session-${sha256(new TextEncoder().encode(profile))}` : profile

// SHA-256 (FIPS 180-4), kept synchronous so a webview's partition is known before it mounts.
// The protocol package has no dependencies or Node APIs. Differential tests cover Node's crypto implementation.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))
const sha256 = (input: Uint8Array): string => {
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  bytes.set(input)
  bytes[input.length] = 0x80
  const data = new DataView(bytes.buffer)
  data.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000))
  data.setUint32(bytes.length - 4, input.length * 8)
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = data.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!, y = words[index - 2]!
      const low = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const high = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      words[index] = words[index - 16]! + low + words[index - 7]! + high
    }
    let a = hash[0]!, b = hash[1]!, c = hash[2]!, d = hash[3]!, e = hash[4]!, f = hash[5]!, g = hash[6]!, h = hash[7]!
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const first = (h + sum1 + choose + SHA256_K[index]! + words[index]!) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (sum0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0
      d = c; c = b; b = a; a = (first + second) >>> 0
    }
    const next = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < hash.length; index++) hash[index] = hash[index]! + next[index]!
  }
  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('')
}
