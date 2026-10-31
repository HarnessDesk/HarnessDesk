import { createHash } from 'node:crypto'
import type { LeadBudgetState } from '@harnessdesk/protocol'

export interface LeadSecondLookBlocker {
  readonly kind: 'pull-request' | 'issue'
  readonly repository: string
  readonly number: number
}
export interface LeadSecondLookStop {
  readonly logicalGoalId: string
  readonly runId: string
  /** Durable host stop identity, not a new id on each poll. */
  readonly stopId: string
  readonly kind: 'blocked' | 'done'
  readonly said: string
  readonly at: number
  /** Supplied only when the host can bind a named blocker to this run's repository. */
  readonly blocker?: LeadSecondLookBlocker
}
export interface LeadSecondLookInput {
  readonly stop: LeadSecondLookStop
  readonly now: number
  readonly approved: boolean
  readonly budget: LeadBudgetState
  readonly runningWorker: boolean
  /** Journaled attempts, including failed dispatches, survive polling and restart. */
  readonly seen: readonly string[]
  readonly observedBlocker?: LeadSecondLookBlocker & {
    readonly state: 'open' | 'closed' | 'merged'
    readonly observedAt: number
    readonly changedAt?: number
  }
  readonly evidence?: {
    /** False when the host cannot prove its edit and check records cover this worker. */
    readonly complete: boolean
    readonly lastEditAt: number | null
    readonly requiredChecks: readonly {
      readonly name: string
      /** Completed runs only. Advisory runs prove an attempt but never satisfy acceptance. */
      readonly runs: readonly { readonly at: number }[]
    }[]
  }
}
export interface LeadSecondLookDecision {
  readonly key: string
  readonly action: 'restart' | 'steer'
  readonly said: string
  readonly found: string
  readonly did: string
  readonly message?: string
}

/** Shared by host attempt journaling and the wake gate; different logical goals never collide. */
export const leadSecondLookKey = (stop: Pick<LeadSecondLookStop, 'logicalGoalId' | 'runId' | 'stopId'>): string =>
  `second-look-${createHash('sha256').update(JSON.stringify([stop.logicalGoalId, stop.runId, stop.stopId])).digest('hex')}`

const time = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const prose = (value: string): string => Array.from(value.replace(/<[^>]*>/g, '').replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, 1_000).join('')
const sameBlocker = (left: LeadSecondLookBlocker, right: LeadSecondLookBlocker): boolean =>
  left.kind === right.kind && left.repository === right.repository && left.number === right.number

/** Read-only host decision. This grants no authority and performs no effect.
 * Before dispatch the caller must durably claim `key`, revalidate consent and
 * source, and use existing budget/round admission and worker steer paths.
 * Only a successful effect earns a visible card. Failure keeps today's stop.
 * The renderer must still sanitize every displayed fact as transcript content.
 */
export const decideLeadSecondLook = (input: LeadSecondLookInput): LeadSecondLookDecision | null => {
  const { stop, budget, now } = input, key = leadSecondLookKey(stop)
  if (!input.approved || input.seen.includes(key) || !time(now) || !time(stop.at) || stop.at > now ||
    !stop.logicalGoalId || !stop.runId || !stop.stopId || budget.stop || budget.spend !== 'known') return null
  const costs = [budget.leadUsdMicros, budget.workerUsdMicros, budget.reservedUsdMicros]
  if (costs.some(cost => !time(cost)) || !time(budget.caps.usdMicros) ||
    costs.reduce((sum, cost) => sum + cost, 0) >= budget.caps.usdMicros) return null
  const said = prose(stop.said)
  if (stop.kind === 'blocked') {
    const blocker = stop.blocker, observation = input.observedBlocker
    if (!blocker || !observation || !sameBlocker(blocker, observation) || !Number.isSafeInteger(blocker.number) || blocker.number < 1 ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(blocker.repository) || blocker.repository.length > 200 ||
      !time(observation.observedAt) || observation.observedAt < stop.at || observation.observedAt > now || now - observation.observedAt > 60_000 ||
      observation.changedAt !== undefined && (!time(observation.changedAt) || observation.changedAt > 8_640_000_000_000_000 || observation.changedAt > observation.observedAt) ||
      !time(budget.roundsAdmitted) || !time(budget.caps.rounds) || budget.roundsAdmitted >= budget.caps.rounds) return null
    const cleared = blocker.kind === 'pull-request' ? observation.state === 'merged' : observation.state === 'closed'
    if (!cleared) return null
    const clock = observation.changedAt === undefined ? '' : ` at ${new Date(observation.changedAt).toISOString().slice(11, 16)} UTC`
    return { key, action: 'restart', said, found: `#${blocker.number} ${observation.state}${clock}`,
      did: `Restarted, round ${budget.roundsAdmitted + 1} of ${budget.caps.rounds}` }
  }
  const evidence = input.evidence
  if (!input.runningWorker || !evidence?.complete || evidence.lastEditAt === null || !time(evidence.lastEditAt) ||
    evidence.lastEditAt > stop.at || !evidence.requiredChecks.length || evidence.requiredChecks.length > 64) return null
  for (const check of evidence.requiredChecks) {
    if (!check.name.trim() || check.name.length > 200 || /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(check.name) ||
      check.runs.length > 1_000 || check.runs.some(run => !time(run.at) || run.at > now)) return null
  }
  const missing = evidence.requiredChecks.find(check => !check.runs.some(run => run.at >= evidence.lastEditAt!))
  if (!missing) return null
  return { key, action: 'steer', said, found: `No ${missing.name} since the last edit`,
    did: 'Asked the worker to run the check and show the output',
    message: `Run ${missing.name} and show the output. This is advisory evidence; the required check still counts only when the person runs it.` }
}
