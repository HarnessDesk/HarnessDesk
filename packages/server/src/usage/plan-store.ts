import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PlanAccountEntry, PlanBudgetEntry, PlanEntry, PlanFeeEntry, PlanSetInput, RuntimeId } from '@harnessdesk/protocol'

import { asRecord, asText } from '../flow.js'

/**
 * What a person set for one account's plan fee and key budget:
 * `~/.harnessdesk/plans.json`.
 *
 * Design: `docs/usage-dashboard.md`'s pricing paragraph — "a wrong price is
 * worse than no price" — applies here exactly as it does to the model-rate
 * overlay (`ledger/pricing.ts`): nothing here is ever guessed. Every entry was
 * a person's own click, `source` is always `'user'`, and a vendor-reported fee
 * (should a reader ever have one) wins over this file entirely (merged in
 * `usage/service.ts`, never here).
 *
 * Keyed by runtime plus a stable account key. An email-shaped account is
 * hashed before it is ever written — this file is read back by the same
 * process that already knows the plaintext account from the runtime itself,
 * so nothing is lost, and a backup or a `cat` of this file never hands out an
 * address.
 *
 * A file that cannot be read as a whole is never written over — the
 * `seating.json` pattern (`agent-seating-file.ts`): hand-edited or corrupted,
 * what is in it is somebody's, and a refusal names where and why rather than
 * silently starting over. Writes are write-temp-then-rename, the same as
 * every other file the host owns.
 */

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Never the raw email on disk — a stable, one-way stand-in for it. */
export const accountKeyFor = (account: string): string => {
  const trimmed = account.trim()
  if (EMAIL_LIKE.test(trimmed)) {
    return `sha256:${createHash('sha256').update(trimmed.toLowerCase()).digest('hex')}`
  }
  return trimmed
}

const rowKey = (runtime: string, account: string): string => `${runtime}:${accountKeyFor(account)}`

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const unreadable = (error: unknown): string => `it could not be read: ${messageOf(error)}`

const CURRENCY = /^[A-Z]{3}$/

const isFiniteAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const validateCurrency = (value: unknown): string => {
  const text = asText(value)
  if (!text || !CURRENCY.test(text)) throw new Error(`the currency must be a three-letter code, not ${JSON.stringify(value)}`)
  return text
}

/** Validated fee input to a stored entry, `setAt` filled in here. */
const feeEntry = (
  input: { readonly amount: number; readonly currency: string; readonly period: 'month' | 'year' },
  now: number,
): PlanFeeEntry => {
  if (!isFiniteAmount(input.amount)) throw new Error(`a plan price must be a positive number, not ${JSON.stringify(input.amount)}`)
  if (input.period !== 'month' && input.period !== 'year') throw new Error(`a plan price's period must be "month" or "year", not ${JSON.stringify(input.period)}`)
  return { amount: input.amount, currency: validateCurrency(input.currency), period: input.period, source: 'user', setAt: now }
}

const budgetEntry = (input: { readonly amount: number; readonly currency: string }, now: number): PlanBudgetEntry => {
  if (!isFiniteAmount(input.amount)) throw new Error(`a budget must be a positive number, not ${JSON.stringify(input.amount)}`)
  return { amount: input.amount, currency: validateCurrency(input.currency), period: 'month', setAt: now }
}

/** One stored row as it reads back, or why it does not. */
const parseRow = (value: unknown): PlanEntry | null => {
  const record = asRecord(value)
  if (!record) return null
  const entry: { fee?: PlanFeeEntry | null; budget?: PlanBudgetEntry | null } = {}
  if ('fee' in record && record['fee'] !== undefined && record['fee'] !== null) {
    const fee = asRecord(record['fee'])
    if (!fee || typeof fee['amount'] !== 'number' || typeof fee['currency'] !== 'string' || (fee['period'] !== 'month' && fee['period'] !== 'year')) return null
    entry.fee = {
      amount: fee['amount'],
      currency: fee['currency'],
      period: fee['period'],
      source: 'user',
      setAt: typeof fee['setAt'] === 'number' ? fee['setAt'] : 0,
    }
  }
  if ('budget' in record && record['budget'] !== undefined && record['budget'] !== null) {
    const budget = asRecord(record['budget'])
    if (!budget || typeof budget['amount'] !== 'number' || typeof budget['currency'] !== 'string') return null
    entry.budget = {
      amount: budget['amount'],
      currency: budget['currency'],
      period: 'month',
      setAt: typeof budget['setAt'] === 'number' ? budget['setAt'] : 0,
    }
  }
  return entry
}

export interface PlanStoreOptions {
  readonly now?: () => number
}

export class PlanStore {
  #writes: Promise<unknown> = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly options: PlanStoreOptions = {},
  ) {}

  #now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async #readRaw(): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return {}
      throw new Error(`${this.path} was not read: ${unreadable(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`${this.path} was not read: it is not JSON: ${messageOf(error)}`)
    }
    const record = asRecord(parsed)
    if (!record) throw new Error(`${this.path} was not read: it is not an object of account keys to plan entries`)
    return record
  }

  /** Every stored entry, by runtime and account key — the account itself is not recoverable from a hashed row. */
  async read(): Promise<readonly PlanAccountEntry[]> {
    const raw = await this.#readRaw()
    const rows: PlanAccountEntry[] = []
    for (const [key, value] of Object.entries(raw)) {
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      const runtime = key.slice(0, separator) as RuntimeId
      const account = key.slice(separator + 1)
      const entry = parseRow(value)
      if (entry) rows.push({ runtime, account, entry })
    }
    return rows
  }

  /** The stored entry for one account, keyed the same way `set` writes it. */
  async entryFor(runtime: string, account: string): Promise<PlanEntry | null> {
    const raw = await this.#readRaw()
    const value = raw[rowKey(runtime, account)]
    return value === undefined ? null : parseRow(value)
  }

  /**
   * Sets — or, given `null`, clears — one account's fee and/or budget.
   * `undefined` leaves that field exactly as stored. Refused whole when the
   * file cannot be read as a whole, so a hand-edit is never silently lost.
   */
  set(input: PlanSetInput): Promise<PlanEntry> {
    const run = async (): Promise<PlanEntry> => {
      const now = this.#now()
      const raw = await this.#readRaw()
      const key = rowKey(input.runtime, input.account)
      const existing = parseRow(raw[key]) ?? {}
      const next: { fee?: PlanFeeEntry | null; budget?: PlanBudgetEntry | null } = { ...existing }

      if (input.fee === null) delete next.fee
      else if (input.fee !== undefined) next.fee = feeEntry(input.fee, now)

      if (input.budget === null) delete next.budget
      else if (input.budget !== undefined) next.budget = budgetEntry(input.budget, now)

      const hasFee = next.fee !== undefined
      const hasBudget = next.budget !== undefined
      const nextRaw = { ...raw }
      if (hasFee || hasBudget) nextRaw[key] = next
      else delete nextRaw[key]

      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(nextRaw, null, 2)}\n`)
      await rename(temp, this.path)
      return next
    }
    const current = this.#writes.then(run, run)
    this.#writes = current.catch(() => undefined)
    return current
  }
}
