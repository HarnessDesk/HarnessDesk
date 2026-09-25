import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageSource } from '@harnessdesk/protocol'

import type { MeterReading, UsageMeter } from './meter.js'

/**
 * What a Cline account has left, from the session Cline's own CLI holds.
 *
 * Cline keeps its sign-in in `<data>/settings/providers.json` — the `cline`
 * provider's `auth` block, an access token (already prefixed `workos:`) and
 * when it expires — and its account screen asks two things of Cline's API
 * with it (`apps/cli/src/tui/cline-account.ts`, measured on 3.0.62): who the
 * user is (`/api/v1/users/me`, which names their organizations and which one
 * is active) and the balance of whichever account is billed — the active
 * organization's, else the user's own. Balances are micro-dollars.
 *
 * **The token is used while it is valid and never refreshed.** Refreshing it
 * rotates the refresh token, and a desk that did so without writing the new
 * pair back — which it must never do to another application's file — would
 * sign Cline out. Cline refreshes it whenever it runs, including every turn
 * the desk sends it, so the reading after a turn is a live one; after that
 * the last reading stands with its own age rather than vanishing.
 */

const SETTINGS = join('settings', 'providers.json')
const API = 'https://api.cline.bot'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 5 * 60_000
/** A token this close to expiring is treated as expired; the request would race it. */
const EXPIRY_MARGIN_MS = 30_000
const MICRO = 1_000_000

interface Envelope<T> {
  readonly success?: boolean
  readonly error?: string
  readonly data?: T
}

interface ClineUser {
  readonly id?: string
  readonly email?: string
  readonly organizations?: readonly {
    readonly organizationId?: string
    readonly name?: string
    readonly active?: boolean
  }[]
}

interface ClineSession {
  readonly token: string
  readonly expiresAt: number | null
  readonly accountId: string | null
}

/** The `cline` provider's session, when the file holds a usable one. */
export const clineSession = (text: string): ClineSession | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const auth = (parsed as { providers?: { cline?: { settings?: { auth?: Record<string, unknown> } } } })?.providers
    ?.cline?.settings?.auth
  const token = typeof auth?.['accessToken'] === 'string' ? auth['accessToken'].trim() : ''
  if (token === '') return null
  const expiresAt = typeof auth?.['expiresAt'] === 'number' && Number.isFinite(auth['expiresAt']) ? auth['expiresAt'] : null
  const accountId = typeof auth?.['accountId'] === 'string' && auth['accountId'] !== '' ? auth['accountId'] : null
  return { token, expiresAt, accountId }
}

export interface ClineMeterOptions {
  /** `providers.json`; defaults to Cline's own data folder, which `CLINE_DATA_DIR` or `CLINE_DIR` moves. */
  readonly settingsPath?: string
  /** The environment the agent runs with, for those two and `CLINE_API_BASE_URL`. */
  readonly env?: NodeJS.ProcessEnv
  readonly apiBase?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class ClineMeter implements UsageMeter {
  readonly id = 'cline-account'
  readonly source: UsageSource = { kind: 'api', label: "from Cline's account API" }
  readonly #path: string
  readonly #api: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  #last: { reading: MeterReading; accountId: string | null } | null = null

  constructor(options: ClineMeterOptions = {}) {
    const env = options.env ?? process.env
    this.#path = options.settingsPath ?? join(clineDataDir(env), SETTINGS)
    this.#api = (options.apiBase ?? env['CLINE_API_BASE_URL']?.trim() ?? API).replace(/\/+$/, '') || API
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** Cline rewrites the file each time it refreshes the token — the moment a live read becomes possible. */
  watchPaths(): readonly string[] {
    return [this.#path]
  }

  async read(): Promise<MeterReading | null> {
    let text: string
    try {
      text = await readFile(this.#path, 'utf8')
    } catch {
      return this.#forget()
    }
    const session = clineSession(text)
    if (session === null) return this.#forget()

    // Another account now: what was read for the last one is not this one's.
    if (this.#last && this.#last.accountId !== session.accountId) this.#last = null
    if (session.expiresAt !== null && session.expiresAt - EXPIRY_MARGIN_MS <= this.#now()) {
      return this.#last?.reading ?? null
    }

    const user = await this.#get<ClineUser>('/api/v1/users/me', session.token)
    if (user === null || typeof user.id !== 'string' || user.id === '') return this.#forget()
    const organization = user.organizations?.find((candidate) => candidate.active === true && candidate.organizationId)
    const balance = await this.#get<{ balance?: number }>(
      organization?.organizationId
        ? `/api/v1/organizations/${encodeURIComponent(organization.organizationId)}/balance`
        : `/api/v1/users/${encodeURIComponent(user.id)}/balance`,
      session.token,
    )
    if (balance === null || typeof balance.balance !== 'number' || !Number.isFinite(balance.balance)) {
      return this.#forget()
    }

    const remaining = balance.balance / MICRO
    const reading: MeterReading = {
      account: typeof user.email === 'string' && user.email !== '' ? user.email : null,
      // The organization a balance belongs to is the plan it is spent under.
      plan: organization?.name ?? null,
      lanes: [],
      credits: { remaining, unit: 'USD', unlimited: false },
      reached: remaining <= 0 ? 'credits' : null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
    this.#last = { reading, accountId: session.accountId }
    return reading
  }

  #forget(): null {
    this.#last = null
    return null
  }

  /**
   * Null for every answer that means "nothing to report for this account" —
   * signed out, token revoked. Only a genuinely unexpected status is thrown,
   * and so logged.
   */
  async #get<T>(path: string, token: string): Promise<T | null> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#api}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      throw new Error(`Cline usage could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) throw new Error(`Cline usage could not be read: HTTP ${response.status}`)
    let body: Envelope<T>
    try {
      body = (await response.json()) as Envelope<T>
    } catch {
      return null
    }
    if (body.success === false) return null
    return body.data ?? null
  }
}

/**
 * Cline's own rule (`resolveClineDataDir`): `CLINE_DATA_DIR`, else
 * `<CLINE_DIR or ~/.cline>/data` — `~` being the row's own `HOME` when it has
 * one, not the desk's (review round 5).
 */
const clineDataDir = (env: NodeJS.ProcessEnv): string => {
  const explicit = env['CLINE_DATA_DIR']?.trim()
  if (explicit) return explicit
  return join(env['CLINE_DIR']?.trim() || join(env['HOME']?.trim() || homedir(), '.cline'), 'data')
}
