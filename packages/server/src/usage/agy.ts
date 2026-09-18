import { existsSync } from 'node:fs'
import { devNull, homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageLane, UsageSource } from '@harnessdesk/protocol'

import { runForOutput, type RunResult } from '../installs/run.js'
import { whichOnPath } from '../installs/which.js'
import { WINDOW_MINUTES, type MeterReading, type UsageMeter } from './meter.js'

/**
 * What Antigravity has left, as its own CLI reports it.
 *
 * The ACP server the desk runs puts no quota on the wire and keeps its Google
 * token in a keychain item only its own binary may read, so neither of those
 * is a road. The `agy` CLI answers the question itself: `/usage` is one of the
 * commands its print mode runs without a model turn, and with
 * `--output-format json` it hands back the structured payload it draws —
 * Google's `v1internal:retrieveUserQuotaSummary`, a weekly limit per group of
 * models. Measured on agy 1.2.5 and 1.2.6, 2026-09-17: ~2.5 s, `num_turns: 0`,
 * no conversation made.
 *
 * Two flags keep the read from being anything more than a read. Every run of
 * agy checks for a new release and installs it in place — the first probe of
 * this very command moved the development machine from 1.2.5 to 1.2.6 — and
 * `AGY_CLI_DISABLE_AUTO_UPDATE=true` is the switch agy itself reads for that.
 * The word, not a digit: with `1` agy still spawned its background updater
 * (measured on 1.2.6; `true` logs "Auto-update disabled via environment
 * variable" and checks it before its fifteen-minute throttle). And
 * every run writes a log file of ~20 KB into agy's own folder, which a meter
 * refreshed after every turn would pile up by the hundred; `--log-file` sends
 * it to the null device instead.
 *
 * **It is the CLI's sign-in, not the server's.** agy and the ACP server each
 * sign in on their own (see the known-agents note), and nothing either one
 * exposes says which Google account it is, so the desk cannot tell whether
 * these figures are the agent's. The reading says so (`unverified`), and the
 * service files it beside the report rather than in its lanes: the Dashboard
 * draws it under agy's name, and readiness, alerts and every other surface
 * that decides whether the agent can run never see it. Signed out, or not
 * installed, the meter is silent.
 */

const COMMAND = 'agy'
/** Where agy's own installer puts it, for a desk that has not read the login PATH yet. */
const INSTALLED = '.local/bin/agy'
const TIMEOUT_MS = 20_000
const STALE_AFTER_MS = 5 * 60_000
/**
 * A finished turn refreshes its agent, and a flow can finish one every few
 * seconds. Each read is a process start and a request to Google, so a reading
 * younger than this is answered again — with its own time, not ours.
 */
const MIN_INTERVAL_MS = 60_000
/** Whose figures these are, as the Dashboard names them. */
const WHOSE = 'agy CLI sign-in'

interface QuotaBucket {
  readonly id?: string
  readonly name?: string
  readonly description?: string
  readonly window?: string
  readonly remaining_fraction?: number
  readonly remaining_amount?: number
  readonly disabled?: boolean
  readonly reset_time?: string
}

interface QuotaGroup {
  readonly name?: string
  readonly description?: string
  readonly buckets?: readonly QuotaBucket[]
}

interface QuotaSummary {
  readonly description?: string
  readonly buckets?: readonly QuotaBucket[]
  readonly groups?: readonly QuotaGroup[]
}

interface PrintResult {
  readonly status?: string
  readonly error?: string
  readonly command?: { readonly name?: string; readonly data?: QuotaSummary }
}

const WINDOWS: Readonly<Record<string, number>> = {
  daily: WINDOW_MINUTES.daily,
  weekly: WINDOW_MINUTES.weekly,
  monthly: WINDOW_MINUTES.monthly,
}

const parseDate = (value: string | undefined): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** "weekly" is the source's own word for the window; a person reads "Weekly". */
const labelOf = (bucket: QuotaBucket): string => {
  const window = typeof bucket.window === 'string' ? bucket.window.trim() : ''
  if (window !== '') return window.charAt(0).toUpperCase() + window.slice(1)
  return typeof bucket.name === 'string' && bucket.name.trim() !== '' ? bucket.name.trim() : 'Limit'
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const laneOf = (bucket: QuotaBucket, scope: string | null, index: number): UsageLane | null => {
  // A bucket Google marks disabled is not a limit this account runs into.
  if (bucket.disabled === true) return null
  const fraction =
    typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)
      ? Math.min(1, Math.max(0, bucket.remaining_fraction))
      : null
  const window = typeof bucket.window === 'string' ? bucket.window.trim().toLowerCase() : ''
  const id =
    typeof bucket.id === 'string' && bucket.id.trim() !== ''
      ? bucket.id.trim()
      : [scope ? slug(scope) : null, window || null].filter(Boolean).join(':') || `bucket-${index}`
  return {
    id,
    label: labelOf(bucket),
    scope,
    usedPercent: fraction === null ? 0 : (1 - fraction) * 100,
    windowMinutes: WINDOWS[window] ?? null,
    // A window nobody has drawn on yet has not started: Google answers a
    // reset of "now plus a week", and it moves on every read (measured: three
    // reads, three times). A full bucket's reset is therefore no date at all.
    resetsAt: fraction === 1 ? null : parseDate(bucket.reset_time),
    // `remaining_amount` is a count with no total beside it — not a share of
    // anything — so a bucket that gives only that says nothing we can draw.
    usageKnown: fraction !== null,
  }
}

/**
 * One lane per bucket. A bucket inside a group is scoped to that group's
 * models — "Gemini Models", "Claude and GPT models" — and one at the top level
 * belongs to the whole account.
 */
export const agyLanes = (summary: QuotaSummary): UsageLane[] => {
  const lanes: UsageLane[] = []
  const seen = new Set<string>()
  const add = (lane: UsageLane | null) => {
    if (!lane || seen.has(lane.id)) return
    seen.add(lane.id)
    lanes.push(lane)
  }
  for (const bucket of summary.buckets ?? []) add(laneOf(bucket, null, lanes.length))
  for (const group of summary.groups ?? []) {
    const scope = typeof group.name === 'string' && group.name.trim() !== '' ? group.name.trim() : null
    for (const bucket of group.buckets ?? []) add(laneOf(bucket, scope, lanes.length))
  }
  return lanes
}

/**
 * agy's own words for "no session", and nothing broader.
 *
 * Measured on 1.2.6 with its ADC route forced and no credentials: the JSON
 * said only "authentication failed or timed out", which a timeout can say
 * too, and stderr said `Error: authentication required. Run 'agy' to log
 * in.` — the sentence Google's headless docs promise for a run that is not
 * signed in. The other two are the binary's own for a session that has
 * lapsed. A failure that merely mentions authentication — a 503 from the
 * sign-in service, a proxy asking for credentials — is an error: logged, and
 * the last reading stands beside it rather than being forgotten.
 */
const SIGNED_OUT: readonly RegExp[] = [
  /^Error: authentication required\. Run '[^']+' to log in\b/m,
  /\bstored credentials are expired or revoked\b/,
  /\bYou are not logged into Antigravity\b/,
]

const signedOut = (said: string): boolean => SIGNED_OUT.some((pattern) => pattern.test(said))

export interface AgyMeterOptions {
  /** The CLI to run; found on PATH, then where agy's installer puts it, when absent. */
  readonly command?: string
  readonly run?: (command: string, args: readonly string[]) => Promise<RunResult>
  readonly now?: () => number
}

export class AgyMeter implements UsageMeter {
  readonly id = 'antigravity-account'
  readonly source: UsageSource = { kind: 'api', label: 'from the agy CLI' }
  readonly #command: string | undefined
  readonly #run: (command: string, args: readonly string[]) => Promise<RunResult>
  readonly #now: () => number
  #last: MeterReading | null = null

  constructor(options: AgyMeterOptions = {}) {
    this.#command = options.command
    this.#run =
      options.run ??
      ((command, args) =>
        runForOutput(command, args, { timeoutMs: TIMEOUT_MS, env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } }))
    this.#now = options.now ?? Date.now
  }

  /** agy keeps no quota on disk; the figure exists only when asked for. */
  watchPaths(): readonly string[] {
    return []
  }

  async read(): Promise<MeterReading | null> {
    if (this.#last && this.#now() - this.#last.fetchedAt < MIN_INTERVAL_MS) return this.#last
    const command = this.#command ?? locate()
    if (command === null) return null

    const result = await this.#run(command, ['--print', '/usage', '--output-format', 'json', '--log-file', devNull])
    if (result.timedOut) throw new Error(`agy /usage did not answer within ${TIMEOUT_MS / 1000} s`)

    const printed = parse(result.stdout)
    if (printed === null || printed.status !== 'SUCCESS') {
      // The telling line is on stderr, not in the JSON, so both are read.
      if (signedOut([printed?.error ?? '', result.stderr].join('\n'))) return this.#forget()
      if (printed === null) {
        const said = firstLine(result.stderr) ?? firstLine(result.stdout)
        throw new Error(`agy /usage answered something that is not its JSON${said ? `: ${said}` : ''}`)
      }
      const said = printed.error ?? firstLine(result.stderr) ?? `status ${printed.status ?? 'missing'}`
      throw new Error(`agy /usage failed: ${said}`)
    }

    const lanes = agyLanes(printed.command?.data ?? {})
    if (lanes.length === 0) return this.#forget()

    const spent = lanes.find((entry) => entry.usageKnown !== false && entry.usedPercent >= 100)
    this.#last = {
      account: null,
      plan: null,
      lanes,
      credits: null,
      reached: spent?.id ?? null,
      fetchedAt: this.#now(),
      staleAfterMs: STALE_AFTER_MS,
      unverified: WHOSE,
    }
    return this.#last
  }

  #forget(): null {
    this.#last = null
    return null
  }
}

/** PATH first, because that is the copy the person runs; the installer's place second. */
const locate = (): string | null => {
  const found = whichOnPath(COMMAND)
  if (found !== null) return found
  const installed = join(homedir(), INSTALLED)
  return process.platform !== 'win32' && existsSync(installed) ? installed : null
}

/**
 * The JSON agy prints is one object on stdout. Anything else — a banner, an
 * update notice — is tolerated only before it, so the object is read from the
 * first brace.
 */
const parse = (stdout: string): PrintResult | null => {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try {
    const value = JSON.parse(stdout.slice(start)) as unknown
    return value !== null && typeof value === 'object' ? (value as PrintResult) : null
  } catch {
    return null
  }
}

const firstLine = (text: string): string | null => {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  return line ?? null
}
