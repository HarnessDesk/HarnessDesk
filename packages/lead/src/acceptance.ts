import { parseLeadAcceptanceContract, type LeadAcceptanceContract, type LeadAssertionResult, type LeadBudgetEvent } from '@harnessdesk/protocol'

interface Fact { readonly id: string; readonly revision: string; readonly observedAt: number }
/** Normalized from fresh desk reads by the injected evidence reader, never from
 * Messages proposals. A revision is the subject commit, not the Flow source digest. */
export interface LeadAcceptanceEvidence {
  readonly project: LeadAcceptanceContract['project']
  readonly runId: string
  readonly contractDigest: string
  readonly revision: string
  readonly observedAt: number
  readonly complete: boolean
  readonly spendComplete: boolean
  readonly spend?: Extract<LeadBudgetEvent, { type: 'observe' }>
  readonly checks: readonly (Fact & { readonly assertionId: string; readonly exit: number | null; readonly timedOut: boolean; readonly dirty: boolean; readonly counted: boolean })[]
  readonly reviews: readonly (Fact & { readonly assertionId: string; readonly verdict: string; readonly complete: boolean })[]
  readonly findingsComplete: boolean
  readonly findings: readonly { readonly id: string; readonly revision: string; readonly blocking: boolean; readonly resolved: boolean }[]
  readonly diffs: readonly (Fact & { readonly assertionId: string; readonly dirty: boolean })[]
}
export interface LeadAcceptanceResult {
  readonly status: 'reviewed' | 'failed' | 'unknown'
  readonly assertions: readonly LeadAssertionResult[]
}
export const evaluateLeadAcceptance = (value: LeadAcceptanceContract, evidence: LeadAcceptanceEvidence,
  options: { readonly now: number; readonly freshnessMs: number; readonly revision: number }): LeadAcceptanceResult => {
  const contract = parseLeadAcceptanceContract(value), { now, freshnessMs, revision } = options
  const fresh = (at: number) => Number.isSafeInteger(now) && Number.isSafeInteger(freshnessMs) && freshnessMs >= 0 &&
    Number.isSafeInteger(at) && at >= 0 && at <= now && now - at <= freshnessMs
  const compatible = evidence.contractDigest === contract.digest && evidence.project.id === contract.project.id &&
    evidence.project.path === contract.project.path && evidence.revision.length > 0 && fresh(evidence.observedAt) &&
    evidence.complete === true && evidence.spendComplete === true
  const valid = (fact: Fact) => compatible && fact.revision === evidence.revision && fresh(fact.observedAt)
  const assertions = contract.assertions.map((assertion): LeadAssertionResult => {
    let status: LeadAssertionResult['status'] = 'unknown'
    let refs: LeadAssertionResult['evidence'] = []
    if (compatible) {
      if (assertion.kind === 'check') {
        const facts = evidence.checks.filter(fact => fact.assertionId === assertion.id)
        if (facts.length && facts.every(valid)) {
          status = facts.every(fact => fact.exit === 0 && !fact.timedOut && !fact.dirty && fact.counted === true) ? 'passed' : 'failed'
          refs = facts.map(fact => ({ kind: 'check', id: fact.id, revision: fact.revision }))
        }
      } else if (assertion.kind === 'review') {
        const facts = evidence.reviews.filter(fact => fact.assertionId === assertion.id)
        if (facts.length && facts.every(fact => valid(fact) && fact.complete === true)) {
          status = facts.every(fact => fact.verdict === 'approve') ? 'passed' : 'failed'
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
      reason: status === 'passed' ? null : status === 'failed' ? 'Recorded evidence failed' : 'Fresh complete evidence is required' }
  })
  // A model cannot omit the gates from its plan and obtain vacuous acceptance.
  const gates = ['check', 'review', 'blocking-findings'].every(kind => contract.assertions.some(assertion => assertion.kind === kind))
  return { status: assertions.some(assertion => assertion.status === 'failed') ? 'failed' :
    compatible && gates && assertions.every(assertion => assertion.status === 'passed') ? 'reviewed' : 'unknown', assertions }
}
