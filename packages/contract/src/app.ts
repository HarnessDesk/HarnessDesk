import { z } from 'zod'
import { DeviceId, Name, PublicKey, Secret16, Secret32, Signature } from './ids.js'

/**
 * Messages inside the encrypted session (plaintext kind 0x01, UTF-8 JSON).
 * The first one from the phone is `auth` or `enroll`; nothing else is answered before that.
 */
export const AuthMessage = z.object({ t: z.literal('auth'), dev: DeviceId, sig: Signature })
export const EnrollMessage = z.object({ t: z.literal('enroll'), secret: Secret16, devicePub: PublicKey, name: Name })
export const FirstPhoneMessage = z.discriminatedUnion('t', [AuthMessage, EnrollMessage])
export type FirstPhoneMessage = z.infer<typeof FirstPhoneMessage>

const Position = { epoch: z.string().min(1).max(64), seq: z.number().int().nonnegative() }

export const AuthOk = z.object({ t: z.literal('auth.ok'), ...Position })
export const EnrollOk = z.object({
  t: z.literal('enroll.ok'),
  deviceId: DeviceId,
  pushKey: Secret32,
  kid: z.number().int().min(1),
  ...Position,
})
export const ErrorMessage = z.object({ t: z.literal('error'), code: z.number().int(), message: z.string().max(200).optional() })

export const Request = z.object({ t: z.literal('req'), id: z.string().min(1).max(64), method: z.string().min(1).max(128), params: z.unknown().optional() })
export const Response = z.discriminatedUnion('ok', [
  z.object({ t: z.literal('res'), id: z.string(), ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ t: z.literal('res'), id: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string().max(500) }) }),
])
export const Event = z.object({ t: z.literal('evt'), ...Position, topic: z.string().min(1).max(64), data: z.unknown() })

export const Resume = z.object({ t: z.literal('resume'), epoch: z.string().min(1).max(64), after: z.number().int().nonnegative() })
export const ResumeOk = z.object({ t: z.literal('resume.ok'), epoch: z.string(), from: z.number().int(), to: z.number().int() })
export const ResumeReset = z.object({ t: z.literal('resume.reset'), epoch: z.string() })

export const DeskToPhone = z.union([AuthOk, EnrollOk, ErrorMessage, Response, Event, ResumeOk, ResumeReset])
export const PhoneToDesk = z.union([FirstPhoneMessage, Request, Resume])
export type DeskToPhone = z.infer<typeof DeskToPhone>
export type PhoneToDesk = z.infer<typeof PhoneToDesk>
