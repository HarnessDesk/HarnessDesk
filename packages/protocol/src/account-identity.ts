import type { TeamActor } from './team.js'

export interface AccountIdentity {
  readonly id?: string
  readonly nickname?: string | null
  readonly name?: string | null
  readonly email?: string | null
}

/** One display-name policy, including the existing address-privacy fallback. */
export const accountDisplayName = (account: AccountIdentity | null | undefined, hide = false): string | null => {
  const name = account?.nickname?.trim() || account?.name?.trim() || null
  if (!hide) return name || account?.email || null
  return name?.includes('@') ? name.slice(0, name.indexOf('@')) || null : name
}

/** Historical rows remain anonymous. Never borrow the currently signed-in person. */
export const roomUserIdentity = (actor: unknown): { readonly accountId: string; readonly name?: string } | null => {
  if (!actor || typeof actor !== 'object') return null
  const value = actor as Record<string, unknown>
  if (value['kind'] !== 'user' || typeof value['accountId'] !== 'string' || !value['accountId'].trim() || value['accountId'].length > 256) return null
  const name = typeof value['name'] === 'string' ? value['name'].trim() : ''
  return { accountId: value['accountId'], ...(name && name.length <= 80 && !name.includes('@') ? { name } : {}) }
}

/** The host alone supplies the account. No email, credential, or picture is recorded. */
export const accountUserActor = (account: AccountIdentity | undefined): Extract<TeamActor, { kind: 'user' }> => {
  const name = account?.nickname?.trim() || account?.name?.trim()
  const identity = roomUserIdentity({ kind: 'user', accountId: account?.id, name })
  return { kind: 'user', ...identity }
}
