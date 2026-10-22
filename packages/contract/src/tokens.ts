import { z } from 'zod'
import { DeskId, DeviceId, PublicKey, UnixSeconds } from './ids.js'

export const DeskTokenClaims = z.object({
  typ: z.literal('desk'),
  kid: z.string().min(1).max(32),
  desk: DeskId,
  /** The desk's public key, so the relay can check a key proof without a database. */
  dpk: PublicKey,
  acct: z.string().min(1).max(64),
  iat: UnixSeconds,
  exp: UnixSeconds,
})
export type DeskTokenClaims = z.infer<typeof DeskTokenClaims>

export const PhoneTicketClaims = z.object({
  typ: z.literal('phone'),
  kid: z.string().min(1).max(32),
  desk: DeskId,
  dev: DeviceId,
  acct: z.string().min(1).max(64),
  iat: UnixSeconds,
  exp: UnixSeconds,
})
export type PhoneTicketClaims = z.infer<typeof PhoneTicketClaims>
