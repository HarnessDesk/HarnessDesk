import { z } from 'zod'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding, in its one canonical spelling: the unused low bits of the last character are zero. */
const b64uOfBytes = (bytes: number) => {
  const chars = Math.ceil((bytes * 8) / 6)
  const spare = chars * 6 - bytes * 8
  return z.string().length(chars).regex(/^[A-Za-z0-9_-]+$/).refine(
    (s) => spare === 0 || ALPHABET.indexOf(s[chars - 1]!) % (1 << spare) === 0,
    { message: 'not the canonical base64url spelling' },
  )
}

export const DeskId = b64uOfBytes(16)
export const DeviceId = b64uOfBytes(16)
export const PublicKey = b64uOfBytes(32)
export const Signature = b64uOfBytes(64)
export const Secret16 = b64uOfBytes(16)
export const Secret32 = b64uOfBytes(32)
export const Nonce12 = b64uOfBytes(12)
export const Challenge = z.string().min(40).max(64).regex(/^[A-Za-z0-9_-]+$/)
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/)
export const Name = z.string().trim().min(1).max(80)
export const UnixSeconds = z.number().int().nonnegative()

export type DeskId = z.infer<typeof DeskId>
export type DeviceId = z.infer<typeof DeviceId>
