import { z } from 'zod'
import { Challenge, DeskId, DeviceId, Name, PublicKey, Signature, UnixSeconds } from './ids.js'

// The browser approves a short code; only the desk holds the polling secret and private key.
const PollSecret = z.string().min(32).max(64).regex(/^[A-Za-z0-9_-]+$/)
export const DeskLinkCodeRequest = z.object({ userCode: z.string().min(8).max(16) })
export const StartDeskLinkRequest = z.object({ deskPub: PublicKey, name: Name, challenge: Challenge, sig: Signature })
export const StartDeskLinkResponse = z.object({
  userCode: z.string(), pollSecret: PollSecret, verifyUrl: z.string().url(),
  expiresAt: UnixSeconds, intervalSeconds: z.number().int().positive(),
})
export const PollDeskLinkRequest = z.object({ pollSecret: PollSecret })
export const PollDeskLinkResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('approved'), deskId: DeskId }),
  z.object({ status: z.literal('denied') }),
])
export const LookupDeskLinkResponse = z.object({ name: Name, deskId: DeskId, expiresAt: UnixSeconds })
export const ApproveDeskLinkResponse = z.object({ deskId: DeskId, name: Name })

// Additive fields keep older profile responses readable. Nickname never replaces provider identity.
export const AccountProfile = z.object({
  id: z.string().min(1).max(256).optional(),
  nickname: Name.nullable().optional(),
  name: Name.nullable(), email: z.string().email().max(320).nullable(),
  pictureUrl: z.string().url().max(2048).refine((url) => new URL(url).protocol === 'https:').nullable(),
})
/** Null restores the provider name; no client-supplied account or provider fields are accepted. */
export const UpdateAccountProfileRequest = z.object({ nickname: Name.nullable() }).strict()
export const LinkedPhone = z.object({ deviceId: DeviceId, name: Name, lastSeenAt: UnixSeconds.nullable() })
export const DeskAccountResponse = z.object({
  account: AccountProfile,
  desk: z.object({ deskId: DeskId, name: Name }),
  phones: z.array(LinkedPhone),
})
export const RenameDeskRequest = z.object({ name: Name })
export const RenameDeskResponse = z.object({ deskId: DeskId, name: Name })
export const RevokeDeskRequest = z.object({ deskId: DeskId })
