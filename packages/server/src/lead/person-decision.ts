import { LEAD_REVIEWED_RESULT, leadReviewedResultSource, evaluateLeadAcceptance, leadPlanRuns, leadBudgetProjection, type LeadAcceptanceEvidence, type LeadJournal } from '@harnessdesk/lead'
import type { LeadAcceptanceContract, LeadAssertionResult, LeadCard, LeadCardDecision, LeadProject } from '@harnessdesk/protocol'
import { flowRevision } from '../flow-execution.js'
import type { Flows } from '../flows.js'
import type { Team } from '../team.js'
import { leadRefusal } from './controls.js'

interface PersonDecisionOptions {
  readonly journal: Pick<LeadJournal, 'state'>
  readonly project: LeadProject
  readonly now: () => number
  readonly flows: Pick<Flows, 'executionOf' | 'personCard' | 'storedRun'>
  readonly team: Pick<Team, 'stateFor' | 'intentAction' | 'flush'>
  readonly readEvidence: (runId: string) => Promise<LeadAcceptanceEvidence>
}
export const leadAssertionFacts = (assertions: readonly LeadAssertionResult[]) => JSON.stringify(assertions.map(({ assertionId, status, contractRevision, evidence }) => ({
  assertionId, status, contractRevision, evidence: [...evidence].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
})).sort((a, b) => a.assertionId.localeCompare(b.assertionId)))
/** Reads evidence afresh, then checks the live frozen Flow at the board's mutation boundary. */
const prepareLeadPersonGate = async (options: PersonDecisionOptions, card: Extract<LeadCard, { type: 'waiting' }>,
  decision: LeadCardDecision, contract: LeadAcceptanceContract, compareAssertions = true, answered = false) => {
  if (card.kind !== 'person' || !card.personCardId || !/^[1-9][0-9]*$/.test(card.personCardId)) throw leadRefusal('lead-worker-approval')
  const id = Number(card.personCardId), owned = options.journal.state.runs.find(run => run.runId === card.runId)
  if (!owned || !Number.isSafeInteger(id)) throw leadRefusal('lead-gate-changed')
  const outcome = decision.choice === 'accept' ? 'accepted' : 'declined'
  const check = () => {
    const state = options.journal.state, execution = options.flows.executionOf(owned.runId), board = options.team.stateFor(owned.teamId)
    const stored = options.flows.storedRun(owned.runId)
    const boundStep = state.steps.find(step => step.attemptId === owned.correlationId && step.state === 'started')
    const step = contract.steps.find(step => step.id === boundStep?.id)
    const intent = board.intents.find(intent => intent.id === id)
    const person = intent && options.flows.personCard(owned.teamId, intent)
    const budget = state.budget && leadBudgetProjection(state.budget, options.now())
    if (state.contract?.digest !== contract.digest || card.contractDigest !== contract.digest || state.recoveryBlocked || state.budget?.stop ||
      !state.runs.some(run => run.runId === owned.runId && run.teamId === owned.teamId) ||
      contract.project.id !== options.project.id || contract.project.path !== options.project.path || board.root !== options.project.path ||
      !execution || execution.id !== owned.runId || execution.goal !== owned.teamId || !answered && execution.state !== 'running' ||
      !step || step.flow !== LEAD_REVIEWED_RESULT.id || step.sourceRevision !== LEAD_REVIEWED_RESULT.revision ||
      !stored || stored.source !== leadReviewedResultSource ||
      execution.revision !== flowRevision(execution.document) || execution.revision !== flowRevision(stored.compiled.document) ||
      !execution.rounds.some(round => round.cards.includes(id)) || !intent ||
      (answered ? intent.state !== 'done' || intent.outcome !== outcome : !['open', 'claimed'].includes(intent.state) || !person?.live) ||
      !person || !person.outcomes.includes(outcome) || budget?.spend !== 'known' || budget.reservedUsdMicros !== 0)
      throw leadRefusal('lead-gate-changed')
  }
  check()
  const evidence = await options.readEvidence(owned.runId)
  const result = evaluateLeadAcceptance(contract, evidence, { now: options.now(), freshnessMs: 60000, revision: options.journal.state.seq })
  if (evidence.runId !== card.runId || result.status !== 'reviewed' || compareAssertions && leadAssertionFacts(result.assertions) !== leadAssertionFacts(card.assertions))
    throw leadRefusal('lead-gate-changed')
  check()
  return { assertions: result.assertions, check, async answer() {
    check()
    if (answered) return
    await options.team.intentAction(owned.teamId, id, 'done', undefined, outcome, undefined, undefined, undefined, check)
    await options.team.flush()
    const saved = options.team.stateFor(owned.teamId).intents.find(intent => intent.id === id)
    if (saved?.state !== 'done' || saved.outcome !== outcome) throw leadRefusal('lead-gate-save-failed')
  } }
}
export const answerLeadPersonGate = async (options: PersonDecisionOptions, card: Extract<LeadCard, { type: 'waiting' }>,
  decision: LeadCardDecision, contract: LeadAcceptanceContract): Promise<void> => {
  await (await prepareLeadPersonGate(options, card, decision, contract)).answer()
}
/** A terminal Lead result is still a collection of real person gates, never summary authority. */
export const answerLeadResult = async (options: PersonDecisionOptions, card: Extract<LeadCard, { type: 'result' }>,
  decision: LeadCardDecision, contract: LeadAcceptanceContract): Promise<void> => {
  const state = options.journal.state, budget = state.budget && leadBudgetProjection(state.budget, options.now())
  const accounting = (value: typeof budget) => value && JSON.stringify({ caps: value.caps, lead: value.leadUsdMicros,
    workers: value.workerUsdMicros, reserved: value.reservedUsdMicros, spend: value.spend, stop: value.stop })
  const runs = leadPlanRuns(state)
  if (!runs.length || !state.steps.every(step => step.state === 'started') || !budget || accounting(budget) !== accounting(card.budget))
    throw leadRefusal('lead-gate-changed')
  const gates: Awaited<ReturnType<typeof prepareLeadPersonGate>>[] = []
  for (const run of runs) {
    const execution = options.flows.executionOf(run.runId), board = options.team.stateFor(run.teamId)
    const candidates = board.intents.filter(intent => execution?.rounds.some(round => round.cards.includes(intent.id)) &&
      options.flows.personCard(run.teamId, intent) && ['open', 'claimed', 'done'].includes(intent.state))
    if (candidates.length !== 1) throw leadRefusal('lead-gate-changed')
    gates.push(await prepareLeadPersonGate(options, { version: 1, id: card.id, revision: card.revision, contractDigest: card.contractDigest,
      type: 'waiting', kind: 'person', runId: run.runId, personCardId: String(candidates[0]!.id), summary: card.summary, assertions: [] }, decision, contract, false, candidates[0]!.state === 'done'))
  }
  const combined = contract.assertions.map(assertion => {
    const results = gates.map(gate => gate.assertions.find(result => result.assertionId === assertion.id)!)
    return { ...results[0]!, evidence: results.flatMap(result => result.evidence) }
  })
  if (leadAssertionFacts(combined) !== leadAssertionFacts(card.assertions)) throw leadRefusal('lead-gate-changed')
  for (const gate of gates) gate.check()
  for (const gate of gates) await gate.answer()
}
