import { parseLeadAcceptanceContract, type LeadAcceptanceContract, type LeadAction, type LeadAssertionResult, type LeadBudgetEvent } from '@harnessdesk/protocol'

interface Fact { readonly id: string; readonly revision: string; readonly observedAt: number; readonly complete?: boolean }
/** Normalized from fresh desk reads by the injected evidence reader, never from
 * Messages proposals. A revision is the subject commit, not the Flow source digest. */
export interface LeadAcceptanceEvidence {
  readonly personActions?: readonly LeadAction[]
  readonly project: LeadAcceptanceContract['project']
  readonly runId: string
  readonly contractDigest: string
  readonly revision: string
  readonly observedAt: number
  readonly complete: boolean
  readonly spendComplete: boolean
  readonly spend?: Extract<LeadBudgetEvent, { type: 'observe' }>
  readonly checks: readonly (Fact & { readonly assertionId: string; readonly name?: string; readonly exit: number | null; readonly timedOut: boolean; readonly dirty: boolean; readonly counted: boolean })[]
  readonly reviews: readonly (Fact & { readonly assertionId: string; readonly verdict: string; readonly complete: boolean; readonly text?: string })[]
  readonly findingsComplete: boolean
  readonly findings: readonly { readonly id: string; readonly revision: string; readonly blocking: boolean; readonly resolved: boolean }[]
  readonly diffs: readonly (Fact & { readonly assertionId: string; readonly dirty: boolean })[]
}
export interface LeadAcceptanceResult {
  readonly status: 'reviewed' | 'failed' | 'unknown'
  /** Named runner errors survive an aggregate assertion's simultaneous negative verdict. */
  readonly erroredChecks?: readonly string[]
  readonly assertions: readonly LeadAssertionResult[]
}
/** Closed host policy: prose outside backtick code must support an unqualified yes. */
export const LEAD_HEDGE_PHRASES = Object.freeze([
  'should work', 'looks fine', 'looks good to me but', 'probably', 'i think', 'seems to', 'might', 'not sure',
  'untested', "didn't run", 'did not run', "couldn't verify", 'could not verify',
] as const)
const hedge = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${LEAD_HEDGE_PHRASES.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
const hedged = (text: string) => hedge.test(text.replace(/(`+)[\s\S]*?\1(?!`)/g, ' '))

/** Missing/stale evidence needs observation or a check action, never a code repair. */
export const leadAssertionsToRerun = (result: LeadAcceptanceResult): string[] => result.assertions
  .filter(assertion => assertion.status === 'errored' || assertion.status === 'no-evidence' || assertion.status === 'unknown')
  .map(assertion => assertion.assertionId)
/** The repair brief keeps verdict failures separate from checks that could not run. */
export const leadRepairInput = (result: LeadAcceptanceResult) => ({
  failed: result.assertions.filter(assertion => assertion.status === 'failed').map(({ assertionId, reason }) => ({ assertionId, reason })),
  errored: result.erroredChecks ?? result.assertions.filter(assertion => assertion.status === 'errored').map(assertion => assertion.assertionId),
})
/** Host-owned per-run data appended to the repair card, never interpolated into Flow YAML. */
export const leadRepairDetail = (result: LeadAcceptanceResult): string =>
  `Fix only the failed assertions listed; leave the passed ones. Re-run only the failed and errored checks.\nRepair input: ${JSON.stringify(leadRepairInput(result))}`
export const leadAcceptanceObservation = (result: LeadAcceptanceResult): string => {
  const rerun = [...new Set([...leadAssertionsToRerun(result), ...(result.erroredChecks ?? [])])]
  return `Assertion verdicts: ${JSON.stringify(result.assertions)}.` + (rerun.length
    ? ` Re-run these checks; they did not fail, they could not run. Re-read stale or incomplete evidence first. Ask the person once through the existing check action: ${JSON.stringify(rerun)}. Do not start a repair round for these assertions.` : '')
}
export const evaluateLeadAcceptance = (value: LeadAcceptanceContract, evidence: LeadAcceptanceEvidence,
  options: { readonly now: number; readonly freshnessMs: number; readonly revision: number }): LeadAcceptanceResult => {
  const contract = parseLeadAcceptanceContract(value), { now, freshnessMs, revision } = options
  const fresh = (at: number) => Number.isSafeInteger(now) && Number.isSafeInteger(freshnessMs) && freshnessMs >= 0 &&
    Number.isSafeInteger(at) && at >= 0 && at <= now && now - at <= freshnessMs
  const compatible = evidence.contractDigest === contract.digest && evidence.project.id === contract.project.id &&
    evidence.project.path === contract.project.path && evidence.revision.length > 0 && fresh(evidence.observedAt) &&
    evidence.complete === true && evidence.spendComplete === true
  const valid = (fact: Fact) => compatible && fact.complete !== false && fact.revision === evidence.revision && fresh(fact.observedAt)
  const erroredChecks = new Set<string>()
  const assertions = contract.assertions.map((assertion): LeadAssertionResult => {
    const facts = assertion.kind === 'check' ? evidence.checks.filter(fact => fact.assertionId === assertion.id)
      : assertion.kind === 'review' ? evidence.reviews.filter(fact => fact.assertionId === assertion.id)
      : assertion.kind === 'diff' ? evidence.diffs.filter(fact => fact.assertionId === assertion.id) : evidence.findings
    let status: LeadAssertionResult['status'] = facts.length || assertion.kind === 'blocking-findings' && evidence.findingsComplete ? 'unknown' : 'no-evidence'
    let reason: string | null = null
    let refs: LeadAssertionResult['evidence'] = []
    if (compatible) {
      if (assertion.kind === 'check') {
        const facts = evidence.checks.filter(fact => fact.assertionId === assertion.id)
        if (facts.length && facts.every(valid)) {
          for (const fact of facts) if (fact.timedOut || fact.exit === null) erroredChecks.add(fact.name ?? assertion.id)
          // A real negative verdict wins over a simultaneous runner error.
          const failed = facts.filter(fact => !fact.timedOut && fact.exit !== null && (fact.exit !== 0 || fact.dirty || fact.counted !== true))
          status = failed.length ? 'failed'
            : facts.some(fact => fact.timedOut || fact.exit === null) ? 'errored' : 'passed'
          if (failed.some(fact => fact.name)) reason = `Recorded evidence failed: ${failed.map(fact => fact.name ?? fact.id).join(', ')}`
          refs = facts.map(fact => ({ kind: 'check', id: fact.id, revision: fact.revision }))
        }
      } else if (assertion.kind === 'review') {
        const facts = evidence.reviews.filter(fact => fact.assertionId === assertion.id)
        if (facts.length && facts.every(fact => valid(fact) && fact.complete === true)) {
          status = facts.every(fact => fact.verdict === 'approve') ? 'passed' : 'failed'
          if (facts.some(fact => fact.verdict === 'approve' && hedged(fact.text ?? ''))) { status = 'failed'; reason = 'hedged-approval' }
          refs = facts.map(fact => ({ kind: 'review', id: fact.id, revision: fact.revision }))
        }
      } else if (assertion.kind === 'blocking-findings') {
        if (evidence.findingsComplete === true && evidence.findings.every(fact => fact.revision === evidence.revision)) {
          status = evidence.findings.some(fact => fact.blocking && !fact.resolved) ? 'failed' : 'passed'
          refs = evidence.findings.map(fact => ({ kind: 'finding', id: fact.id, revision: fact.revision }))
        }
      } else {
        const facts = evidence.diffs.filter(fact => fact.assertionId === assertion.id)
        if (facts.length && facts.every(valid)) {
          status = facts.some(fact => fact.dirty) ? 'failed' : 'passed'
          refs = facts.map(fact => ({ kind: 'diff', id: fact.id, revision: fact.revision }))
        }
      }
    }
    return { assertionId: assertion.id, status, revision, contractRevision: contract.revision, evidence: refs,
      reason: reason ?? (status === 'passed' ? null : status === 'failed' ? 'Recorded evidence failed'
        : status === 'errored' ? 'The check could not produce a verdict'
        : status === 'no-evidence' ? 'No fact was recorded for this assertion' : 'Recorded facts require fresh complete evidence') }
  })
  // A model cannot omit the gates from its plan and obtain vacuous acceptance.
  const gates = ['check', 'review', 'blocking-findings'].every(kind => contract.assertions.some(assertion => assertion.kind === kind))
  return { erroredChecks: [...erroredChecks], status: assertions.some(assertion => assertion.status === 'failed') ? 'failed' :
    compatible && gates && assertions.every(assertion => assertion.status === 'passed') ? 'reviewed' : 'unknown', assertions }
}

/** Stable identity of the recorded evidence behind a publication card. Clocks
 * and accounting refreshes do not change it; a new review/check/finding does. */
export const leadPublicationEvidenceRevision = (evidence: LeadAcceptanceEvidence): string => JSON.stringify({
  revision: evidence.revision,
  checks: evidence.checks.map(({ observedAt: _, ...fact }) => fact),
  reviews: evidence.reviews.map(({ observedAt: _, ...fact }) => fact),
  findings: evidence.findings,
  diffs: evidence.diffs.map(({ observedAt: _, ...fact }) => fact),
})
