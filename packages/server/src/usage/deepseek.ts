import type { UsageSource } from '@harnessdesk/protocol'
import { readKeyValue, secretSourcePath, type AcpSecretSource } from '@harnessdesk/adapter-acp'

import { MeterAuthError, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What a DeepSeek API-key account has left, from DeepSeek's own prepaid
 * balance endpoint.
 *
 * DeepSeek Harness ("DSH") authenticates with a provider key rather than a
 * browser sign-in (`agent-registry.ts`'s `dsh` entry): `DEEPSEEK_API_KEY`,
 * in the environment it starts with, else its own store —
 * `${DSH_HOME:-~/.dsh}/.credentials.yaml`, the file its "Models" page
 * writes, or a `.env` beside it. Those file sources are the registry's own
 * `alsoAt` list for the `dsh` template (`agent-registry.ts`), handed in
 * rather than hard-coded here, and read through `readKeyValue` from
 * `@harnessdesk/adapter-acp` — the same reader `whereSecretLives`/`readsKey`
 * use to answer *presence*, so "key found" and "key read" can never point at
 * two different files. This meter is the one place the value itself is
 * read, and only to put it in an `Authorization` header; it is never
 * logged, stored beyond the read that used it, or echoed into a report (the
 * report carries a balance, never the key).
 *
 * The desk's own stored copy of the key — the broker's, when the person put
 * one there — is asked fresh on every read through `key`, never resolved
 * once and kept: the same way a spawn resolves a stored secret at the
 * moment it builds a process's environment (`adapter-acp/runtime.ts`), so a
 * key stored after this meter was built, or cleared from the broker, is
 * honoured on the very next read rather than needing a restart.
 *
 * `GET https://api.deepseek.com/user/balance`
 * (https://api-docs.deepseek.com/api/get-user-balance), `Authorization:
 * Bearer <key>`: `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }`. A prepaid
 * balance, so it maps to `credits`, never a lane —
 * `billing.kinds: ['balance']`. An account can have more than one currency
 * funded (CNY and USD both topped up); those are never summed — this picks
 * the one currency to show (USD preferred, since the rest of this screen is
 * USD-denominated; otherwise the first the source lists) rather than
 * inventing a combined figure across two currencies that are not
 * fungible. `is_available: false` means the account cannot spend even
 * though a number remains — treated as "out", same as a balance at or
 * below zero.
 */

const API = 'https://api.deepseek.com/user/balance'
const TIMEOUT_MS = 8_000
const STALE_AFTER_MS = 5 * 60_000
const SECRET_ENV = 'DEEPSEEK_API_KEY'
/** RFC 7230 `token` characters — what a header value can carry at all. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

interface DeepSeekBalanceInfo {
  readonly currency?: string
  readonly total_balance?: string
}

interface DeepSeekBalanceBody {
  readonly is_available?: boolean
  readonly balance_infos?: readonly DeepSeekBalanceInfo[]
}

export interface DeepSeekBalance {
  readonly remaining: number
  readonly unit: string
  readonly available: boolean
}

/**
 * The one currency this reports, out of however many the account has
 * funded — never a sum across them. `null` when the response names none,
 * or the chosen one has no readable number.
 */
export const deepSeekBalance = (body: DeepSeekBalanceBody): DeepSeekBalance | null => {
  const infos = body.balance_infos ?? []
  if (infos.length === 0) return null
  const chosen = infos.find((info) => info.currency === 'USD') ?? infos[0]!
  if (!chosen.currency) return null
  const remaining = Number(chosen.total_balance)
  if (!Number.isFinite(remaining)) return null
  return { remaining, unit: chosen.currency, available: body.is_available !== false }
}

export interface DeepSeekMeterOptions {
  readonly env?: NodeJS.ProcessEnv
  /**
   * The desk's own stored copy of this row's secret, asked fresh on every
   * `read()` rather than resolved once at construction — the broker's
   * `resolveSecret`, wired the same way the spawn path calls it. `undefined`
   * when the broker holds nothing for this row, never a cached "no".
   */
  readonly key?: () => string | undefined
  /**
   * The other places DSH keeps this key, in its own precedence order — the
   * registry's own `alsoAt` list for the `dsh` template (`agent-registry.ts`),
   * handed in by the wiring rather than hard-coded here.
   */
  readonly alsoAt?: readonly AcpSecretSource[]
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class DeepSeekMeter implements UsageMeter {
  readonly id = 'deepseek-balance'
  readonly source: UsageSource = { kind: 'api', label: "from DeepSeek's own API" }
  readonly #env: NodeJS.ProcessEnv
  readonly #keyFn: (() => string | undefined) | undefined
  readonly #alsoAt: readonly AcpSecretSource[]
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  constructor(options: DeepSeekMeterOptions = {}) {
    this.#env = options.env ?? process.env
    this.#keyFn = options.key
    this.#alsoAt = options.alsoAt ?? []
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
  }

  /** DSH rewrites its store when its own Models page changes the key. */
  watchPaths(): readonly string[] {
    return this.#alsoAt.map((source) => secretSourcePath(source, this.#env))
  }

  async read(): Promise<MeterReading | null> {
    const key = this.#key()
    if (!key) return null
    if (!PRINTABLE_ASCII.test(key)) {
      throw new Error('DeepSeek balance could not be read: the stored key is not a usable value.')
    }

    let response: Response
    try {
      response = await this.#fetch(API, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (cause) {
      throw new Error(`DeepSeek balance could not be read: network error (${cause instanceof Error ? cause.name : 'unknown'})`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new MeterAuthError('DeepSeek balance: sign in, or check the API key')
    }
    if (!response.ok) throw new Error(`DeepSeek balance could not be read: HTTP ${response.status}`)

    let body: DeepSeekBalanceBody
    try {
      body = (await response.json()) as DeepSeekBalanceBody
    } catch {
      return null
    }
    const balance = deepSeekBalance(body)
    if (!balance) return null

    return {
      account: null,
      plan: null,
      lanes: [],
      credits: { remaining: balance.remaining, unit: balance.unit, unlimited: false },
      reached: !balance.available || balance.remaining <= 0 ? 'credits' : null,
      // A prepaid balance, never a rolling window or an included allowance.
      billing: { kinds: ['balance'] },
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
  }

  /** The desk's own stored copy, then the row's environment, then DSH's own store — its own precedence order. */
  #key(): string | null {
    const resolved = this.#keyFn?.()?.trim()
    if (resolved) return resolved
    const fromEnv = this.#env[SECRET_ENV]?.trim()
    if (fromEnv) return fromEnv
    for (const source of this.#alsoAt) {
      const value = readKeyValue(source, SECRET_ENV, this.#env)
      if (value) return value
    }
    return null
  }
}
