import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageSource } from '@harnessdesk/protocol'

import { MeterAuthError, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What a DeepSeek API-key account has left, from DeepSeek's own prepaid
 * balance endpoint.
 *
 * DeepSeek Harness ("DSH") authenticates with a provider key rather than a
 * browser sign-in (`agent-registry.ts`'s `dsh` entry): `DEEPSEEK_API_KEY`,
 * in the environment it starts with, else its own store —
 * `${DSH_HOME:-~/.dsh}/.credentials.yaml`, the file its "Models" page
 * writes, or a `.env` beside it. Those are the same two files, in the same
 * order, `whereSecretLives`/`readsKey` in `@harnessdesk/adapter-acp` already
 * check for *presence* of a key; this reads the *value*, which that checker
 * deliberately never does — it exists only to answer "is a key already
 * there", never to hand the value anywhere. This meter is the one place that
 * value is read, and only to put it in an `Authorization` header; it is
 * never logged, stored beyond the read that used it, or echoed into a report
 * (the report carries a balance, never the key).
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
const CREDENTIALS_FILE = '.credentials.yaml'
const DOTENV_FILE = '.env'
const SECRET_ENV = 'DEEPSEEK_API_KEY'

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
   * The value the desk already resolved for this row — its own stored
   * credential, when the person put one there — ahead of the row's own
   * environment and its own files below. Never re-derived here: this meter
   * only ever receives it, the same way an agent's own process would.
   */
  readonly resolvedKey?: string | null
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class DeepSeekMeter implements UsageMeter {
  readonly id = 'deepseek-balance'
  readonly source: UsageSource = { kind: 'api', label: "from DeepSeek's own API" }
  readonly #env: NodeJS.ProcessEnv
  readonly #resolvedKey: string | null
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  readonly #credentialsPath: string
  readonly #dotenvPath: string

  constructor(options: DeepSeekMeterOptions = {}) {
    this.#env = options.env ?? process.env
    this.#resolvedKey = options.resolvedKey?.trim() || null
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    const home = dshHome(this.#env)
    this.#credentialsPath = join(home, CREDENTIALS_FILE)
    this.#dotenvPath = join(home, DOTENV_FILE)
  }

  /** DSH rewrites its store when its own Models page changes the key. */
  watchPaths(): readonly string[] {
    return [this.#credentialsPath, this.#dotenvPath]
  }

  async read(): Promise<MeterReading | null> {
    const key = await this.#key()
    if (!key) return null

    let response: Response
    try {
      response = await this.#fetch(API, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      throw new Error(`DeepSeek balance could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
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
  async #key(): Promise<string | null> {
    if (this.#resolvedKey) return this.#resolvedKey
    const fromEnv = this.#env[SECRET_ENV]?.trim()
    if (fromEnv) return fromEnv
    const fromYaml = await readValueFrom(this.#credentialsPath, 'yaml', SECRET_ENV)
    if (fromYaml) return fromYaml
    return readValueFrom(this.#dotenvPath, 'dotenv', SECRET_ENV)
  }
}

/** `${DSH_HOME:-~/.dsh}` — `~` being the row's own `HOME` when it has one, not the desk's. */
const dshHome = (env: NodeJS.ProcessEnv): string => {
  const explicit = env['DSH_HOME']?.trim()
  if (explicit) return explicit
  return join(env['HOME']?.trim() || homedir(), '.dsh')
}

/**
 * A key's value out of one of DSH's own files — the one thing
 * `readsKey` in `@harnessdesk/adapter-acp` deliberately does not do. Same
 * two shapes that checker matches: a YAML block mapping or DSH's own
 * one-line flow mapping (`{ DEEPSEEK_API_KEY: sk-… }`), and a plain
 * `KEY=value` `.env` line.
 */
const readValueFrom = async (path: string, format: 'yaml' | 'dotenv', key: string): Promise<string | null> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const pattern =
    format === 'yaml'
      ? new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*([^,}\\n]*)`, 'm')
      : new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm')
  const found = pattern.exec(text)
  if (!found) return null
  const value = found[1]!.trim().replace(/^['"]|['"]$/g, '').trim()
  return value.length > 0 && !value.startsWith('#') ? value : null
}
