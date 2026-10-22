import { z } from 'zod'

export const CloseCode = {
  BAD_FRAME: 4400,
  UNAUTHORIZED: 4401,
  DESK_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  REPLACED: 4409,
  FRAME_TOO_LARGE: 4413,
  REVOKED: 4423,
  RATE_LIMITED: 4429,
  UNAVAILABLE: 4503,
} as const
export type CloseCodeName = keyof typeof CloseCode
export type CloseCodeValue = (typeof CloseCode)[CloseCodeName]

/** Codes that mean "stop trying" rather than "reconnect". */
export const PERMANENT_CLOSE_CODES: readonly number[] = [CloseCode.UNAUTHORIZED, CloseCode.REVOKED]

export const RelayLimits = {
  maxFrameBytes: 1_048_576,
  maxPhonesPerDesk: 8,
  /** Token bucket per socket. */
  frameBurst: 200,
  framesPerSecond: 100,
  challengeTtlSeconds: 60,
  phoneTicketTtlSeconds: 300,
  deskTokenTtlSeconds: 3600,
  tokenLeewaySeconds: 60,
} as const

export const RelayHeaders = {
  challenge: 'x-hd-challenge',
  proof: 'x-hd-proof',
  /** Set by the Worker for the room; always stripped from client requests. */
  role: 'x-hd-role',
  device: 'x-hd-device',
} as const

export const HEARTBEAT_PING = 'ping'
export const HEARTBEAT_PONG = 'pong'

const Conn = z.number().int().min(0).max(0xffffffff)

/** relay -> desk, JSON text. */
export const RelayToDesk = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), maxPhones: z.number().int(), maxFrame: z.number().int() }),
  z.object({ t: z.literal('open'), conn: Conn, dev: z.string() }),
  z.object({ t: z.literal('gone'), conn: Conn, code: z.number().int() }),
])
export type RelayToDesk = z.infer<typeof RelayToDesk>

/** desk -> relay, JSON text. */
export const DeskToRelay = z.discriminatedUnion('t', [
  z.object({ t: z.literal('close'), conn: Conn, code: z.number().int().min(4000).max(4999), reason: z.string().max(120).optional() }),
])
export type DeskToRelay = z.infer<typeof DeskToRelay>

/** Binary frames on the desk socket: `conn (u32 big-endian) || payload`. */
export function encodeDeskFrame(conn: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + payload.length)
  new DataView(out.buffer).setUint32(0, conn >>> 0, false)
  out.set(payload, 4)
  return out
}

export function decodeDeskFrame(frame: Uint8Array<ArrayBuffer>): { conn: number; payload: Uint8Array<ArrayBuffer> } | null {
  if (frame.length < 4) return null
  const conn = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  return { conn, payload: frame.subarray(4) }
}
