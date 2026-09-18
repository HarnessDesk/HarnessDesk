import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageCredits, UsageSource } from '@harnessdesk/protocol'

import { runForOutput, type RunResult } from '../installs/run.js'
import { whichOnPath } from '../installs/which.js'
import type { MeterReading, UsageMeter } from './meter.js'

/**
 * What an Amp account has left, as Amp itself reports it.
 *
 * The ACP adapter the desk runs (`amp-acp`) passes no usage on, and Amp keeps
 * nothing on disk to read: the balance lives on Amp's server. The `amp` CLI
 * asks for it — `amp usage`, "Show your current Amp usage and credit balance" —
 * and prints a short report the server writes. Measured on the 2026-09-14
 * build, signed in with individual credits:
 *
 *     Signed in as someone@example.com
 *     **Individual credits:** $10 remaining (set up auto-reload …) - https://ampcode.com/settings
 *
 * There is no JSON form, so this reads exactly two things from it — who is
 * signed in, and each `**<name>:** $<amount> remaining` line — and says
 * nothing when neither is there, rather than guessing at a line it has not
 * seen. The report is the server's words, not the CLI's (they are not in the
 * binary), so a new kind of balance arrives as a new line of the same shape.
 *
 * **A changed report reads as silence, on purpose.** If Amp rewords the line,
 * the card goes back to "not metered" rather than showing a figure guessed
 * from a line nobody has seen — the risk taken is that a format change is
 * quiet, and the test on a report with no balance line is what keeps that true.
 * Where a report ever carries more than one balance line, the first is the one
 * shown: it is the report's own order, and nothing in it says which one pays.
 *
 * **Sparingly.** The report says account lookups share a limit of 60 requests
 * an hour with the thread lookups Amp itself makes, so a reading is kept for
 * ten minutes and never re-asked within five, however many turns finish.
 * Measured: running it wrote nothing to Amp's log and left the binary as it
 * was — no update rides along, unlike `agy`.
 */

const COMMAND = 'amp'
/** Where Amp's installer puts it, for a desk that has not read the login PATH yet. */
const INSTALLED = '.amp/bin/amp'
const TIMEOUT_MS = 20_000
const STALE_AFTER_MS = 10 * 60_000
const MIN_INTERVAL_MS = 5 * 60_000

/** `**Individual credits:** $10 remaining` — the name, and the dollars. */
const BALANCE = /^\s*\*\*([^*\n]+?):\*\*\s*\$([\d,]+(?:\.\d+)?)\s+remaining\b/m
const SIGNED_IN = /^\s*Signed in as\s+(\S+)/m
/** Amp's words for an account it has no key for — silence, not a failure. */
const SIGNED_OUT = /\b(log ?in|sign(?:ed)? ?in|api key|not authenticated|unauthori[sz]ed)\b/i

export interface AmpBalance {
  readonly account: string | null
  /** The report's own name for the balance: "Individual credits". */
  readonly label: string
  readonly remaining: number
}

/** Null when the report carries no balance line; see the module comment. */
export const ampBalance = (report: string): AmpBalance | null => {
  const match = BALANCE.exec(report)
  if (!match) return null
  const remaining = Number((match[2] ?? '').replaceAll(',', ''))
  if (!Number.isFinite(remaining)) return null
  return {
    account: SIGNED_IN.exec(report)?.[1] ?? null,
    label: (match[1] ?? '').trim(),
    remaining,
  }
}

export interface AmpMeterOptions {
  /** The CLI to run; found on PATH, then where Amp's installer puts it, when absent. */
  readonly command?: string
  readonly run?: (command: string, args: readonly string[]) => Promise<RunResult>
  readonly now?: () => number
}

export class AmpMeter implements UsageMeter {
  readonly id = 'amp-account'
  readonly source: UsageSource = { kind: 'api', label: 'from Amp' }
  readonly #command: string | undefined
  readonly #run: (command: string, args: readonly string[]) => Promise<RunResult>
  readonly #now: () => number
  #last: MeterReading | null = null

  constructor(options: AmpMeterOptions = {}) {
    this.#command = options.command
    this.#run = options.run ?? ((command, args) => runForOutput(command, args, { timeoutMs: TIMEOUT_MS }))
    this.#now = options.now ?? Date.now
  }

  /** The balance exists only on Amp's server. */
  watchPaths(): readonly string[] {
    return []
  }

  async read(): Promise<MeterReading | null> {
    if (this.#last && this.#now() - this.#last.fetchedAt < MIN_INTERVAL_MS) return this.#last
    const command = this.#command ?? locate()
    if (command === null) return null

    const result = await this.#run(command, ['usage', '--no-color'])
    if (result.timedOut) throw new Error(`amp usage did not answer within ${TIMEOUT_MS / 1000} s`)
    const balance = ampBalance(result.stdout)
    if (balance === null) {
      const said = `${result.stderr}\n${result.stdout}`.trim()
      if (!result.ok && said !== '' && !SIGNED_OUT.test(said)) {
        throw new Error(`amp usage failed: ${said.split('\n')[0]}`)
      }
      // Signed out, or a report with no balance in it: nothing to say.
      this.#last = null
      return null
    }

    const credits: UsageCredits = { remaining: balance.remaining, unit: 'USD', unlimited: false }
    this.#last = {
      account: balance.account,
      plan: null,
      lanes: [],
      credits,
      reached: balance.remaining <= 0 ? 'credits' : null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
    }
    return this.#last
  }
}

/** PATH first, because that is the copy the person runs; the installer's place second. */
const locate = (): string | null => {
  const found = whichOnPath(COMMAND)
  if (found !== null) return found
  const installed = join(homedir(), INSTALLED)
  return process.platform !== 'win32' && existsSync(installed) ? installed : null
}
