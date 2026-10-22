import { z } from 'zod'
import { Name, PublicKey, Secret16, UnixSeconds } from './ids.js'

export const PairingOffer = z.object({
  v: z.literal(1),
  deskPub: PublicKey,
  name: Name,
  /** Known only to the QR holder and the desk. Never sent to the cloud. */
  enroll: Secret16,
  /** Present when the desk is signed in; routes the phone through the cloud. */
  invite: z.string().min(16).max(128).optional(),
  api: z.url().optional(),
  relay: z.string().regex(/^wss?:\/\//).optional(),
  lan: z.array(z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535) })).max(8).optional(),
  exp: UnixSeconds,
})
export type PairingOffer = z.infer<typeof PairingOffer>

export const PAIRING_SCHEME = 'harnessdesk://pair?c='

export function encodePairingOffer(offer: PairingOffer): string {
  const json = JSON.stringify(PairingOffer.parse(offer))
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return PAIRING_SCHEME + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodePairingOffer(url: string): PairingOffer {
  if (!url.startsWith(PAIRING_SCHEME)) throw new Error('not a pairing link')
  const text = url.slice(PAIRING_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('bad pairing link')
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return PairingOffer.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)))
}
