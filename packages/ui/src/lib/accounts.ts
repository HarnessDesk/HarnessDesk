import type { Account, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

/**
 * The account is the unit, not the agent.
 *
 * Two Codex accounts are two rows everywhere — sidebar, composer, header
 * strip, menu bar — and what tells them apart is a nickname you set and a ring
 * colour, never the brand mark, which stays the agent's. The mark answers
 * "which runtime is this"; a user-chosen picture would destroy that answer at
 * 22px, which is why there is a ring rather than an avatar upload.
 */

export const TINTS = ['blue', 'green', 'amber', 'violet', 'rose'] as const
export type Tint = (typeof TINTS)[number]

export interface AccountPrefs {
  /** What you call it. Empty or absent falls back to the identity itself. */
  readonly nickname?: string
  readonly tint?: Tint
}

/** Every account's preferences, keyed by `accountKey`. */
export type AccountPrefsMap = Readonly<Record<string, AccountPrefs>>

/**
 * A stable name for one account.
 *
 * Built from the runtime plus the runtime's own two fields rather than from
 * an index: a list that reorders itself must not rename everybody's accounts.
 * Session ids are unique only per agent, so the runtime has to be in the key
 * — the same reasoning as session keys.
 */
export const accountKey = (runtime: RuntimeId, account: Account): string =>
  `${runtime}:${account.kind}:${account.label}`

/**
 * The ring an account gets before anyone picks one.
 *
 * Derived from the key so it is stable across restarts and so two accounts of
 * one agent almost never open in the same colour — which is the whole point of
 * the ring. A tiny string hash is enough; nothing here needs to be uniform.
 */
export const defaultTint = (key: string): Tint => {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return TINTS[Math.abs(hash) % TINTS.length] as Tint
}

export const tintOf = (key: string, prefs: AccountPrefsMap): Tint =>
  prefs[key]?.tint ?? defaultTint(key)

/**
 * What to call this account on screen.
 *
 * A nickname wins. Without one, an email is cut at the @ — "olivia@acme.dev"
 * is an identity, "olivia" is a name — and anything else is shown as the
 * runtime wrote it.
 */
export const accountName = (account: Account, prefs: AccountPrefs | undefined): string => {
  const nickname = prefs?.nickname?.trim()
  if (nickname) return nickname
  const email = account.email ?? (account.label.includes('@') ? account.label : null)
  if (email) return email.slice(0, email.indexOf('@'))
  return account.label
}

/** The line under the name: who it really is, and on what plan. */
export const accountIdentity = (account: Account): string =>
  [account.email ?? account.label, account.planType].filter(Boolean).join(' · ')

/**
 * Where this account's credential home is, shortened for display.
 *
 * Codex keeps one credential in `~/.codex/auth.json`, so two accounts cannot
 * share it: each extra one runs over a home of its own, which mirrors the real
 * home in symlinks so the sessions stay shared and only the credential is
 * apart. The host says where that is; this only shortens it.
 */
export const credentialHome = (info: RuntimeInfo): string | null => {
  const home = info.slot?.home ?? info.presentation.configLocation ?? null
  return home === null ? null : home.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

/**
 * The ring one runtime wears, wherever it is drawn.
 *
 * The account's own tint where there is an account, so a member row, its name
 * card, the sidebar seat and the composer all light the same colour — which is
 * what the ring is *for*. Where there is no account yet, a hash of the runtime
 * id: a rail of five members all in one fixed colour tells the reader nothing,
 * and telling them apart is the entire job.
 */
export const runtimeTint = (
  runtime: RuntimeId,
  accounts: Readonly<Partial<Record<RuntimeId, { readonly accounts: readonly Account[] }>>>,
  prefs: AccountPrefsMap,
): Tint => {
  const account = accounts[runtime]?.accounts[0]
  return account ? tintOf(accountKey(runtime, account), prefs) : defaultTint(runtime)
}

/**
 * What to call a runtime in a list that may hold several of one agent.
 *
 * With one account the agent's own name is the answer and nothing is appended
 * — "OpenAI Codex". With two, the name alone names neither, so the account
 * rides along: "OpenAI Codex · olivia". Derived here rather than sent by the
 * host, because the nickname that wins is a preference the host never sees.
 */
export const runtimeLabel = (
  info: RuntimeInfo,
  runtimes: readonly RuntimeInfo[],
  accounts: Readonly<Partial<Record<RuntimeId, { readonly accounts: readonly Account[] }>>>,
  prefs: AccountPrefsMap,
): string => {
  const agent = info.slot?.agent
  if (!agent) return info.name
  const siblings = runtimes.filter((entry) => entry.slot?.agent === agent)
  if (siblings.length < 2) return info.name
  const account = accounts[info.id]?.accounts[0]
  if (!account) return `${info.name} \u00b7 not signed in`
  return `${info.name} \u00b7 ${accountName(account, prefs[accountKey(info.id, account)])}`
}

/**
 * Which agent a runtime belongs to.
 *
 * Every account of one agent answers the same key, and an agent with one
 * account answers its own id — so this is safe to compare against anything
 * that stored a runtime id before accounts existed.
 */
export const agentKey = (info: RuntimeInfo): RuntimeId => info.slot?.agent ?? info.id

/** The same, for a runtime known only by id — a session summary's, say. */
export const agentKeyOf = (runtime: RuntimeId, runtimes: readonly RuntimeInfo[]): RuntimeId => {
  const info = runtimes.find((entry) => entry.id === runtime)
  return info ? agentKey(info) : runtime
}

/**
 * One entry per agent, however many accounts it holds, in the runtime list's
 * own order so nothing jumps. `info` is the agent's original account.
 */
export const agentGroups = (
  runtimes: readonly RuntimeInfo[],
): { info: RuntimeInfo; siblings: readonly RuntimeInfo[] }[] => {
  const groups: { info: RuntimeInfo; siblings: RuntimeInfo[] }[] = []
  for (const info of runtimes) {
    const key = agentKey(info)
    const existing = groups.find((group) => agentKey(group.info) === key)
    if (existing) existing.siblings.push(info)
    else groups.push({ info, siblings: [info] })
  }
  return groups
}

/**
 * Where this agent's credential comes from, in two or three words.
 *
 * The page's whole claim is that an agent either signs in through its own
 * flow or is handed a key from here, and until now that was a paragraph at
 * the top rather than something you could see per agent. Read from the
 * methods the runtime declares, so an agent that declares nothing gets no
 * badge instead of a guess — and neither does one with no account to get,
 * which its own row already says in full.
 */
export const connectionLabel = (
  info: RuntimeInfo,
  methods: readonly { readonly flow: string }[],
): string | null => {
  if (!info.capabilities.account || methods.length === 0) return null
  const key = methods.some((method) => method.flow === 'apiKey')
  const flow = methods.some((method) => method.flow === 'browser' || method.flow === 'deviceCode')
  if (key && flow) return 'Sign-in or key'
  if (key) return 'API key'
  if (flow) return 'Browser sign-in'
  return 'Its own CLI'
}
