import { z } from 'zod'
import { Challenge, DeskId, DeviceId, Name, PublicKey, Signature, UnixSeconds, Nonce12, Base64Url } from './ids.js'

export const ApiErrorCode = z.enum([
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'gone', 'rate_limited', 'too_large', 'unavailable', 'internal',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCode>

export const ApiError = z.object({ error: z.object({ code: ApiErrorCode, message: z.string() }) })
export type ApiError = z.infer<typeof ApiError>

export const Health = z.object({ ok: z.literal(true) })

// ---- desks -----------------------------------------------------------------------------------
export const RegisterDeskRequest = z.object({ deskPub: PublicKey, name: Name })
export const RegisterDeskResponse = z.object({ deskId: DeskId })
export const ListDesksResponse = z.object({ desks: z.array(z.object({ deskId: DeskId, name: Name })) })

export const DeskChallengeResponse = z.object({ challenge: Challenge, expiresAt: UnixSeconds })
export const DeskSessionRequest = z.object({ deskPub: PublicKey, challenge: Challenge, sig: Signature })
export const DeskSessionResponse = z.object({ deskToken: z.string(), expiresAt: UnixSeconds, relayUrl: z.string() })

// ---- invites and links -----------------------------------------------------------------------
export const CreateInviteResponse = z.object({ inviteId: z.string(), token: z.string().min(16).max(128), expiresAt: UnixSeconds })
export const RedeemInviteRequest = z.object({ token: z.string().min(16).max(128), deviceId: DeviceId, devicePub: PublicKey, deviceName: Name })
export const RedeemInviteResponse = z.object({ deskId: DeskId, name: Name })

export const TicketRequest = z.object({ deskId: DeskId, deviceId: DeviceId })
export const TicketResponse = z.object({ ticket: z.string(), expiresAt: UnixSeconds, relayUrl: z.string() })

export const RevokeLinkRequest = z.object({ deskId: DeskId, deviceId: DeviceId })
export const Ok = z.object({ ok: z.literal(true) })

// ---- push ------------------------------------------------------------------------------------
export const RegisterPushRequest = z.object({
  deviceId: DeviceId,
  apnsToken: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
  env: z.enum(['sandbox', 'production']),
  bundleId: z.string().min(3).max(155).regex(/^[A-Za-z0-9.-]+$/),
})

export const SendPushRequest = z.object({
  deviceId: DeviceId,
  kid: z.number().int().min(1),
  nonce: Nonce12,
  /** base64url of AES-GCM ciphertext+tag; at most 2048 bytes of plaintext + 16 tag. */
  ciphertext: Base64Url.min(1).max(Math.ceil(((2048 + 16) * 4) / 3) + 4),
  priority: z.enum(['high', 'low']).default('high'),
  collapse: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
})
export const SendPushResponse = z.object({
  status: z.enum(['sent', 'unregistered', 'throttled', 'rejected']),
  apnsId: z.string().optional(),
})

/** The largest sealed push body, in UTF-8 bytes of its JSON. packages/crypto holds the same number as PUSH_PLAINTEXT_MAX. */
export const PUSH_PLAINTEXT_MAX_BYTES = 2048

/** The decrypted push body, defined here so the desk and the Notification Service Extension agree. */
export const PushPlaintext = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(64),
  ts: UnixSeconds,
  kind: z.enum(['needs-you', 'done', 'stuck', 'message']),
  title: z.string().max(80),
  body: z.string().max(240),
  card: z.string().max(64).optional(),
  deep: z.string().max(200).optional(),
}).refine((p) => new TextEncoder().encode(JSON.stringify(p)).length <= PUSH_PLAINTEXT_MAX_BYTES, {
  // Field lengths count characters, but the cap is bytes: a control character is six bytes once escaped.
  message: 'push body is larger than it can be sealed',
})
export type PushPlaintext = z.infer<typeof PushPlaintext>

/** The custom `hd` member of the APNs payload. */
export const PushEnvelope = z.object({ v: z.literal(1), kid: z.number().int(), n: Nonce12, c: Base64Url })
export const APNS_MAX_PAYLOAD_BYTES = 4096
