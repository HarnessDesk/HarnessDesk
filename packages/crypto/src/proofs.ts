import { concat, utf8, type Bytes } from './bytes.js'

/** Messages a key signs to prove it is held. Each has its own prefix so a signature has one purpose. */
export const relayDeskProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-relay-1/desk\0'), utf8(deskId), utf8('\0'), utf8(challenge))

export const webDeskProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-web-1/desk\0'), utf8(deskId), utf8('\0'), utf8(challenge))

/** Registering a desk with an account: a session proof must never double as one, so this has its own prefix. */
export const webDeskRegisterProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-web-1/register\0'), utf8(deskId), utf8('\0'), utf8(challenge))

export const handshakeDeskMessage = (th: Bytes): Bytes => concat(utf8('hd-e2ee-1/desk\0'), th)
export const handshakeDeviceMessage = (th: Bytes): Bytes => concat(utf8('hd-e2ee-1/device\0'), th)
/** A phone enrolling its key signs this; it is not the message a returning device signs to authenticate. */
export const handshakeEnrollMessage = (th: Bytes): Bytes => concat(utf8('hd-e2ee-1/enroll\0'), th)

/** Browser approval uses a separate proof domain from session creation and registration. */
export const webDeskLinkProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-web-1/link\0'), utf8(deskId), utf8('\0'), utf8(challenge))
