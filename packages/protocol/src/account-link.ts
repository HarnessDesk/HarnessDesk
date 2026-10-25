/** Window-safe account link state. Deadlines and linkedAt are Unix milliseconds. No poll secret crosses the wire. */
export type AccountLinkState =
  | { readonly status: 'unavailable' | 'idle' | 'starting' | 'denied' | 'expired' }
  | { readonly status: 'waiting'; readonly userCode: string; readonly verifyUrl: string; readonly expiresAt: number }
  | { readonly status: 'linked'; readonly deskId: string; readonly linkedAt: number }
  | { readonly status: 'error'; readonly reason: string }
