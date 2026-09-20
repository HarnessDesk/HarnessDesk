import type { CheckRun, Evidence, Freshness } from './evidence.js'

type CheckFact = Extract<Evidence, { kind: 'check' }>

export const isCurrent = (freshness: Freshness): boolean => freshness.state === 'fresh' || freshness.state === 'final'

export const checkPassed = (fact: CheckFact): boolean => fact.exit === 0 && !fact.timedOut

export type CiVerdict = 'passed' | 'failed' | 'cancelled' | 'running' | 'skipped'

/** Summarize a forge's checks without treating cancellation or skipping as success. */
export const ciVerdict = (checks: readonly CheckRun[]): CiVerdict => {
  if (checks.some((one) => one.state === 'failed')) return 'failed'
  if (checks.some((one) => one.state === 'cancelled')) return 'cancelled'
  if (checks.some((one) => one.state === 'pending')) return 'running'
  return checks.some((one) => one.state === 'passed') ? 'passed' : 'skipped'
}
