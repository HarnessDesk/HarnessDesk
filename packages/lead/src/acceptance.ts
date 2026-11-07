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
  /** Host classification: runner-only trouble may wait for the existing check action. */
  readonly checksCouldNotRun?: boolean
  readonly checksReadyForReview?: boolean
  readonly checksToRerun?: readonly string[]
  readonly assertions: readonly LeadAssertionResult[]
}
/** Closed host policy: prose outside backtick code must support an unqualified yes. */
export const LEAD_HEDGE_PHRASES = Object.freeze([
  'should work', 'looks fine', 'looks good to me but', 'probably', 'not sure',
  'untested', "didn't run", 'did not run', "couldn't verify", 'could not verify',
] as const)
const hedge = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${LEAD_HEDGE_PHRASES.map(phrase =>
  phrase === "didn't run" || phrase === 'did not run' ? `${phrase}(?=\\s+(?:the|it|them|tests|checks|this|that)\\b)` : phrase).join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
const hedged = (text: string) => hedge.test(text.replace(/\u2019/g, "'")
  .replace(/^ {0,3}```[^`\r\n]*\r?\n[\s\S]*?^ {0,3}```[ \t]*\r?$/gm, ' ')
  .replace(/^ {0,3}~~~[^\r\n]*\r?\n[\s\S]*?^ {0,3}~~~[ \t]*\r?$/gm, ' ')
  .replace(/(?<!`)(`{1,2})(?!`)[^\r\n]*?(?<!`)\1(?!`)/g, ' ')
  // A bounded past-tense statement about an earlier attempt is not this verdict.
  .replace(/\b(?:an?|the) (?:earlier|previous|old) (?:draft|version|revision|implementation|branch) probably (?:was|were|had|raced|failed|caused|missed|used|left|contained)\b/gi,
    historical => historical.replace(/probably/i, '')))

/** Identify evidence to refresh separately from actual failed assertions. */
export const leadAssertionsToRerun = (result: LeadAcceptanceResult): string[] => result.assertions
  .filter(assertion => assertion.status === 'errored' || assertion.status === 'no-evidence' || assertion.status === 'unknown')
  .map(assertion => assertion.assertionId)
/** The repair brief keeps verdict failures separate from checks that could not run. */
export const leadRepairInput = (result: LeadAcceptanceResult) => ({
  failed: result.assertions.filter(assertion => assertion.status === 'failed').map(({ assertionId, reason }) => ({ assertionId, reason })),
  errored: result.erroredChecks ?? result.assertions.filter(assertion => assertion.status === 'errored').map(assertion => assertion.assertionId),
})
/** Host-owned per-run data appended to the repair card, never interpolated into Flow YAML. */
/**
 * The result's "how to verify" line: the commits the passing checks and the review read, so the person can check the
 * work themselves. Read from the evidence alone; a result whose evidence names no commit gets no line.
 */
export const leadVerifyLine = (assertions: readonly LeadAssertionResult[]): string | null => {
  const commits = [...new Set(assertions.flatMap(result => result.evidence)
    .filter(ref => (ref.kind === 'check' || ref.kind === 'review') && /^[0-9a-f]{7,64}$/i.test(ref.revision))
    .map(ref => ref.revision.slice(0, 7)))]
  if (!commits.length) return null
  const at = commits.length === 1 ? `commit ${commits[0]}` : `commits ${commits.slice(0, -1).join(', ')} and ${commits.at(-1)}`
  return `How to verify: run the project's required checks at ${at}. The review read the same ${commits.length === 1 ? 'commit' : 'commits'}.`
}

/** A result card's summary: its fixed sentence, then the "how to verify" line when the evidence names a commit. */
export const leadResultSummary = (sentence: string, assertions: readonly LeadAssertionResult[]): string =>
  [sentence, leadVerifyLine(assertions)].filter(Boolean).join('\n')

export const LEAD_REPAIR_INSTRUCTIONS = 'Fix only the failed assertions listed; leave the passed behavior alone. After a new commit, run all declared required checks again at that revision before independent review.'
export const leadRepairDetail = (result: LeadAcceptanceResult): string =>
  `Repair input: ${JSON.stringify(leadRepairInput(result))}`
export const leadAcceptanceObservation = (result: LeadAcceptanceResult, actions: readonly LeadAction[] = []): string => {
  const rerun = [...new Set([...(result.checksToRerun ?? []), ...actions.filter(action => action.kind === 'check').map(action => action.name)])]
  return `Assertion verdicts: ${JSON.stringify(result.assertions.map(({ assertionId: _, ...verdict }) => verdict))}.` +
    (result.assertions.some(assertion => assertion.reason === 'hedged-approval')
      ? ' The reviewer approved without confirming it. Re-run the review step on the same revision; do not send a code repair for a hedged approval.' : '') +
    (result.checksCouldNotRun ? ' Re-run these checks; they did not fail, they could not run. Do not start a repair round for runner trouble.' : '') +
    (rerun.length || result.checksCouldNotRun ? ` Re-read stale or incomplete evidence first. Ask the person once through the existing check action${rerun.length ? `: ${JSON.stringify(rerun)}` : ''}.` : '')
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
          if (facts.every(fact => fact.verdict === 'approve') && facts.some(fact => hedged(fact.text ?? ''))) { status = 'failed'; reason = 'hedged-approval' }
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
  const checkResults = assertions.filter(result => contract.assertions.some(assertion => assertion.id === result.assertionId && assertion.kind === 'check'))
  const reviewResults = assertions.filter(result => contract.assertions.some(assertion => assertion.id === result.assertionId && assertion.kind === 'review'))
  const reviewKnown = reviewResults.length > 0 && reviewResults.every(result => result.status === 'passed' || result.status === 'failed' && result.reason !== 'hedged-approval')
  const otherGatesPassed = assertions.every(result => checkResults.includes(result) || reviewResults.includes(result) || result.status === 'passed')
  const checksCouldNotRun = checkResults.some(result => result.status === 'errored' || result.status === 'no-evidence') &&
    checkResults.every(result => result.status === 'passed' || result.status === 'errored' || result.status === 'no-evidence') &&
    reviewKnown && otherGatesPassed
  const checksReadyForReview = checkResults.length > 0 && checkResults.every(result => result.status === 'passed') && reviewKnown && otherGatesPassed
  const rerunIds = new Set(leadAssertionsToRerun({ status: 'unknown', assertions }))
  const checksToRerun = [...erroredChecks].filter(name => evidence.checks.some(check => check.name === name))
  for (const check of evidence.checks) if (check.name && rerunIds.has(check.assertionId) && !checksToRerun.includes(check.name)) checksToRerun.push(check.name)
  return { erroredChecks: [...erroredChecks], checksCouldNotRun, checksReadyForReview, checksToRerun, status: assertions.some(assertion => assertion.status === 'failed') ? 'failed' :
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
