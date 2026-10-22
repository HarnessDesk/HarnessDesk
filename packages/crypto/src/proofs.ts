import { concat, utf8, type Bytes } from './bytes.js'

/** Messages a key signs to prove it is held. Each has its own prefix so a signature has one purpose. */
export const relayDeskProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-relay-1/desk\0'), utf8(deskId), utf8('\0'), utf8(challenge))

export const webDeskProofMessage = (deskId: string, challenge: string): Bytes =>
  concat(utf8('hd-web-1/desk\0'), utf8(deskId), utf8('\0'), utf8(challenge))

export const handshakeDeskMessage = (th: Bytes): Bytes => concat(utf8('hd-e2ee-1/desk\0'), th)
export const handshakeDeviceMessage = (th: Bytes): Bytes => concat(utf8('hd-e2ee-1/device\0'), th)
