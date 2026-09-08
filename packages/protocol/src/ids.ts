/**
 * Branded identifier types.
 *
 * These are structurally strings at runtime; the brands exist so a session id
 * cannot be silently passed where a turn id is expected. Construct them with the
 * helpers below at the boundary where an untyped string enters the system.
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Branded<string, 'SessionId'>
export type TurnId = Branded<string, 'TurnId'>
export type ItemId = Branded<string, 'ItemId'>
export type ApprovalId = Branded<string, 'ApprovalId'>
export type RuntimeId = Branded<string, 'RuntimeId'>

export const sessionId = (value: string): SessionId => value as SessionId
export const turnId = (value: string): TurnId => value as TurnId
export const itemId = (value: string): ItemId => value as ItemId
export const approvalId = (value: string): ApprovalId => value as ApprovalId
export const runtimeId = (value: string): RuntimeId => value as RuntimeId

/**
 * A conversation's identity across the whole app: which runtime, and which
 * session in it. Session ids are the runtime's own, and two runtimes may well
 * issue the same one — an ACP agent numbering from 1, say — so nothing above
 * the adapter keys a conversation by id alone.
 */
export type SessionKey = Branded<string, 'SessionKey'>

export const sessionKey = (runtime: RuntimeId | string, id: SessionId | string): SessionKey =>
  `${runtime}\u0000${id}` as SessionKey

/** The two halves back, for callers that need to address the runtime. */
export const splitSessionKey = (key: SessionKey): { runtime: RuntimeId; id: SessionId } => {
  const index = key.indexOf('\u0000')
  return { runtime: key.slice(0, index) as RuntimeId, id: key.slice(index + 1) as SessionId }
}
