import { parseLeadMessage, parseLeadThreadSend, parseLeadAcceptanceContract, parseLeadCard, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
import { parseLeadJournalRecord, parseLeadRunIdentity, parseLeadRunEvidence } from './journal.js'
import { initialLeadState, type LeadState, type LeadAttemptState } from './state.js'
import { parseLeadBudgetLedger } from './budget.js'

export interface LeadJournalCheckpoint {
  readonly type: 'checkpoint'; readonly version: 1; readonly seq: number; readonly head: string
  readonly state: Omit<LeadState, 'attempts'> & { readonly attempts: readonly (readonly [string, LeadAttemptState])[] }
}
export const leadCheckpoint = (state: LeadState, head: string): LeadJournalCheckpoint => ({
  type: 'checkpoint', version: 1, seq: state.seq, head, state: { ...state, attempts: [...state.attempts] },
})
const assert = (condition: unknown): void => { if (!condition) throw new Error('lead-journal-checkpoint') }
/** Checkpoints are host-owned, hash-anchored snapshots, never model-supplied records. */
export const parseLeadCheckpoint = (value: unknown): { checkpoint: LeadJournalCheckpoint; state: LeadState } => {
  const checkpoint = value as LeadJournalCheckpoint
  assert(checkpoint && checkpoint.type === 'checkpoint' && checkpoint.version === 1 && /^[a-f0-9]{64}$/.test(checkpoint.head))
  assert(Object.keys(checkpoint).sort().join() === ['type', 'version', 'seq', 'head', 'state'].sort().join())
  const stored = checkpoint.state
  // Step 9 had no thread records. Add only the complete, absent thread suffix;
  // retain the original checkpoint object for its authenticated-byte checksum.
  const legacy = stored && !['messages', 'olderMessages', 'sends'].some(key => Object.hasOwn(stored, key))
  const threadSource = legacy ? { ...stored, messages: [], olderMessages: 0, sends: [] } : stored
  // Earlier checkpoints predate inline ordering; their retained card order is
  // preserved at the retained suffix boundary. Stable ordering puts all saved
  // cards after that message and before the next journal write.
  const namedSource = threadSource && { ...threadSource, completedBudgets: Object.hasOwn(threadSource, 'completedBudgets') ? threadSource.completedBudgets : [], name: Object.hasOwn(threadSource, 'name') ? threadSource.name : 'dex', decisionMessages: Object.hasOwn(threadSource, 'decisionMessages') ? threadSource.decisionMessages : [] }
  const source = namedSource && !Object.hasOwn(namedSource, 'cardPositions')
    ? { ...namedSource, cardPositions: Object.fromEntries(threadSource.cards.map(card => [card.id, Math.max(1, ...threadSource.messages.map(message => message.revision))])) } : namedSource
  assert(source && Object.keys(source).sort().join() === Object.keys(initialLeadState()).sort().join())
  assert(source.name === 'dex' || source.name === 'lex')
  assert(Array.isArray(source.decisionMessages) && source.decisionMessages.length <= 64)
  for (const message of source.decisionMessages) {
    assert(Object.keys(message).sort().join() === ['card', 'choice', 'position'].sort().join())
    parseLeadCard(message.card)
    assert(['approve', 'accept', 'decline'].includes(message.choice) && Number.isSafeInteger(message.position) && message.position > 0 && message.position <= source.seq)
  }
  assert(Number.isSafeInteger(source.seq) && source.seq > 0 && source.seq === checkpoint.seq)
  assert(['draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'accepted', 'declined', 'stopped'].includes(source.phase))
  parseLeadJournalRecord({ version: 1, seq: 1, type: 'management', phase: 'waiting-for-user', reason: source.managementReason })
  assert(Array.isArray(source.messages) && source.messages.length <= 256 && Number.isSafeInteger(source.olderMessages) && source.olderMessages >= 0)
  const messages = source.messages.map(message => parseLeadMessage(message))
  assert(new Set(messages.map(message => message.id)).size === messages.length && messages.every(message => message.revision <= source.seq))
  assert(Array.isArray(source.sends) && source.sends.length <= 4096 && new Set(source.sends.map(send => send.key)).size === source.sends.length)
  for (const send of source.sends) {
    assert(Object.keys(send).sort().join() === ['key', 'messageId', 'revision'].sort().join())
    parseLeadThreadSend({ idempotencyKey: send.key, text: 'receipt' })
    assert(Number.isSafeInteger(send.revision) && send.revision > 0 && send.revision <= source.seq && send.messageId === `message-${send.revision}`)
  }
  const policy = source.policy === null ? null : parseLeadPermissionPolicy(source.policy)
  const contract = source.contract === null ? null : parseLeadAcceptanceContract(source.contract)
  assert(Array.isArray(source.completedBudgets) && source.completedBudgets.length <= 64)
  const completedBudgets = source.completedBudgets.map(value => parseLeadBudgetLedger(value))
  assert(new Set(completedBudgets.map(budget => budget.logicalGoalId)).size === completedBudgets.length)
  assert(completedBudgets.every(budget => budget.stop?.reason === 'cancelled' && budget.requests.length === 0))
  const budget = source.budget === null ? null : parseLeadBudgetLedger(source.budget)
  assert(!budget?.stop || ['stopped', 'accepted', 'declined'].includes(source.phase))
  assert(source.stopEffectsPending === null || Number.isSafeInteger(source.stopEffectsPending) && source.stopEffectsPending > 0 && source.stopEffectsPending <= source.seq && (budget?.stop || source.phase === 'stopped'))
  assert(typeof source.recoveryBlocked === 'boolean' && Array.isArray(source.cards) && source.cards.length <= 64)
  const cards = source.cards.map(card => parseLeadCard(card))
  assert(new Set(cards.map(card => card.id)).size === cards.length)
  assert(source.cardPositions && Object.keys(source.cardPositions).length === cards.length)
  for (const card of cards) assert(Number.isSafeInteger(source.cardPositions[card.id]) && source.cardPositions[card.id]! > 0 && source.cardPositions[card.id]! <= Math.max(source.seq, Math.max(0, ...messages.map(message => message.revision)) + cards.length))
  assert(source.cardRevisions && Object.keys(source.cardRevisions).length === cards.length)
  for (const card of cards) assert(Number.isInteger(source.cardRevisions[card.id]) && source.cardRevisions[card.id]! >= 1 && source.cardRevisions[card.id]! <= 32)
  assert(Array.isArray(source.decidedCards) && source.decidedCards.length <= 2048 && source.decidedCards.every(key => typeof key === 'string' && key.length <= 300))
  assert(Array.isArray(source.steps) && source.steps.length <= 64)
  const steps = source.steps.map(step => {
    assert(step && Object.keys(step).sort().join() === ['id', 'state', 'attemptId', ...(Object.hasOwn(step, 'contractDigest') ? ['contractDigest'] : [])].sort().join())
    assert(contract?.steps.some(approved => approved.id === step.id) && ['pending', 'admitted', 'started', 'uncertain'].includes(step.state))
    assert(step.attemptId === null || typeof step.attemptId === 'string' && step.attemptId.length <= 256)
    assert(!Object.hasOwn(step, 'contractDigest') || step.contractDigest === null || typeof step.contractDigest === 'string' && /^[a-f0-9]{64}$/.test(step.contractDigest))
    // An older snapshot cannot prove the digest at admission. Keep it unknown;
    // the host guard must not adopt the latest plan as an old run's binding.
    return { ...step, contractDigest: step.contractDigest ?? null }
  })
  assert(Array.isArray(source.teams) && source.teams.length <= 4096 && source.teams.every(id => typeof id === 'string' && /^[A-Za-z0-9._:/@-]{1,256}$/.test(id)))
  assert(Array.isArray(source.runs) && source.runs.length <= 64)
  const runs = source.runs.map(parseLeadRunIdentity)
  assert(Array.isArray(source.attempts) && source.attempts.length <= 4096)
  const attempts = new Map<string, LeadAttemptState>()
  for (const entry of source.attempts) {
    assert(Array.isArray(entry) && entry.length === 2)
    const [key, attempt] = entry
    assert(key === attempt.id && !attempts.has(key))
    assert(Object.keys(attempt).sort().join() === ['id', 'correlationId', 'method', 'action', 'kind', 'stepId', 'arguments', 'phase', 'effect', 'dispatched', 'outcome', 'recoveryReported', 'evidence', 'evidenceSeq', 'resolutionPending', 'contested'].sort().join())
    parseLeadJournalRecord({ version: 1, seq: 1, type: 'attempt', id: key, correlationId: attempt.correlationId, method: attempt.method, action: attempt.action,
      kind: attempt.kind, stepId: attempt.stepId, arguments: attempt.arguments, policyRevision: null, projectPolicyRevision: null, contractRevision: null })
    assert(['attempted', 'decided', 'started', 'finished'].includes(attempt.phase) && [null, 'allow', 'ask', 'deny'].includes(attempt.effect))
    assert(typeof attempt.dispatched === 'boolean' && typeof attempt.recoveryReported === 'boolean' && typeof attempt.resolutionPending === 'boolean' && typeof attempt.contested === 'boolean')
    assert([null, 'succeeded', 'failed', 'denied', 'asked', 'malformed', 'uncertain', 'interrupted'].includes(attempt.outcome))
    if (attempt.evidence === null) assert(attempt.evidenceSeq === null)
    else {
      assert(Number.isSafeInteger(attempt.evidenceSeq) && attempt.evidenceSeq! > 0 && attempt.evidenceSeq! <= source.seq)
      assert(parseLeadRunEvidence(attempt.evidence).every(identity => identity.correlationId === attempt.correlationId))
    }
    attempts.set(key, structuredClone(attempt))
  }
  if (source.consent !== null) {
    const consent = source.consent
    assert(consent && Object.keys(consent).sort().join() === ['contractDigest', 'contractRevision', 'policyRevision', 'expiresAt', ...(consent.renewalCardRevision === undefined ? [] : ['renewalCardRevision'])].sort().join())
    assert(contract && consent.contractDigest === contract.digest && consent.contractRevision === contract.revision && consent.policyRevision === contract.policyRevision)
    if (consent.renewalCardRevision !== undefined) assert(Number.isSafeInteger(consent.renewalCardRevision) && cards.some(card => card.type === 'plan' && card.contractDigest === consent.contractDigest && card.revision === consent.renewalCardRevision))
    assert(Number.isSafeInteger(consent.expiresAt) && consent.expiresAt > 0)
  }
  const state = structuredClone({ ...source, completedBudgets, policy, contract, budget, cards, runs, steps, attempts, messages })
  return { checkpoint: structuredClone(checkpoint), state }
}
