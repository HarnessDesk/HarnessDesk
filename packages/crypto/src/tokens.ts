import { b64u, concat, fromB64u, fromUtf8, utf8, type Bytes } from './bytes.js'
import { verifyEd25519, type SigningIdentity } from './keys.js'

const TOKEN_CONTEXT = utf8('hd-token-1\0')

export class TokenError extends Error {
  constructor(readonly reason: 'format' | 'kid' | 'signature' | 'expired' | 'not-yet') {
    super(`token rejected: ${reason}`)
  }
}

/** A key set for verification: key id -> raw Ed25519 public key. Several entries allow rotation. */
export type TokenKeys = Readonly<Record<string, Bytes>>

/**
 * `base64url(payloadJSON) "." base64url(signature)`. The payload must carry `kid` and `exp` (unix seconds).
 * The signature covers a fixed context string followed by the exact payload bytes.
 */
export async function signToken<T extends { kid: string; exp: number }>(claims: T, signer: SigningIdentity): Promise<string> {
  const payload = utf8(JSON.stringify(claims))
  const sig = await signer.sign(concat(TOKEN_CONTEXT, payload))
  return `${b64u(payload)}.${b64u(sig)}`
}

/** Returns the parsed claims. The caller validates their shape (`typ`, ids) with its own schema. */
export async function verifyToken(token: string, keys: TokenKeys, nowSeconds: number, leewaySeconds = 60): Promise<Record<string, unknown>> {
  const dot = token.indexOf('.')
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) throw new TokenError('format')
  let payload: Bytes
  let sig: Bytes
  let claims: unknown
  try {
    payload = fromB64u(token.slice(0, dot))
    sig = fromB64u(token.slice(dot + 1))
    claims = JSON.parse(fromUtf8(payload))
  } catch {
    throw new TokenError('format')
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new TokenError('format')
  const c = claims as Record<string, unknown>
  if (typeof c.kid !== 'string' || typeof c.exp !== 'number') throw new TokenError('format')
  const pub = Object.hasOwn(keys, c.kid) ? keys[c.kid] : undefined
  if (!pub) throw new TokenError('kid')
  if (!(await verifyEd25519(pub, sig, concat(TOKEN_CONTEXT, payload)))) throw new TokenError('signature')
  if (c.exp + leewaySeconds < nowSeconds) throw new TokenError('expired')
  if (typeof c.iat === 'number' && c.iat - leewaySeconds > nowSeconds) throw new TokenError('not-yet')
  return c
}
