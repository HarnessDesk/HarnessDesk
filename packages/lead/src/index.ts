/** Portable entry. Process ownership and transports belong to separate entries. */
export type { LeadCancellation, LeadDeskPort, LeadMessagesPort, LeadPersistencePort, LeadPorts } from './ports.js'
export { decideLeadPermission, compareLeadPolicyAuthority, proposeLeadPolicyChange, applyLeadPolicyDecision } from './permissions.js'
export type { LeadPermissionEffect, LeadPermissionFloor, LeadPermissionCall, LeadPermissionDecision, LeadPermissionRequest, LeadPermissionContext,
  LeadAuthorityChange, LeadPolicyProposal, LeadPolicyChange } from './permissions.js'
export { LEAD_JOURNAL_BYTES, summarizeLeadArguments, parseLeadOwnedPush, parseLeadPublicationSource, parseLeadPublicationOperation, parseLeadJournalRecord, prepareLeadJournalRecord, parseLeadRunIdentity, LeadJournal, createLeadJournal } from './journal.js'
export type { LeadJournalEvent, LeadJournalRecord, LeadJournalStorage, LeadRunIdentity, LeadRunObservation, LeadOwnedPush, LeadPublicationSource, LeadPublicationOperation, LeadArgumentSummary,
  LeadAttemptOutcome, LeadToolAttempt, LeadDispatch, LeadDispatchResult, LeadRecoveryAction } from './journal.js'
export { hasPendingLeadPlan, isLeadPlanRenewal, hasUncertainLeadChatEffect, leadDecisionRevisionMatches, canOfferAutomaticLeadGoal, leadHandbackTerminal, leadRepairResultReady, leadWorkerDispatchBlockedByOpenPr, canBeginLeadGoal, canReplaceLeadPlan, leadPlanRuns, leadLimitedCaps, leadDraftCaps, leadGoalSpendCap, initialLeadState, reduceLeadRecord, replayLeadJournal } from './state.js'
export type { LeadState, LeadStepState, LeadAttemptState, LeadChatEffects } from './state.js'

export type { LeadJournalSecurity } from './journal-security.js'
export { leadCheckpoint, parseLeadCheckpoint } from './checkpoint.js'
export type { LeadJournalCheckpoint } from './checkpoint.js'
export { leadRoundId, reduceLeadBudget, leadBudgetProjection, parseLeadBudgetLedger } from './budget.js'
export type { LeadBudgetLedger } from './budget.js'
export { createLeadMessages, parseLeadMessagesBody, leadHistory, LEAD_HISTORY_TURNS, LEAD_HISTORY_BYTES, LEAD_MESSAGES_DEFAULTS } from './messages.js'
export type { LeadMessagesClient, LeadMessagesOptions, LeadMessagesRequest, LeadMessagesResult, LeadMessagesStatus,
  MessagesTransport, MessagesHttpRequest, MessagesHttpResponse, MessagesPrice, MessagesUsage, MessagesToolScope,
  MessagesTurn, MessagesText, MessagesThinking, MessagesRedactedThinking, MessagesToolUse, MessagesToolResult } from './messages-types.js'
export { createLeadLoop } from './loop.js'
export { classifyLeadRuns, createLeadWakeGate, leadChatFingerprint, leadDeskFingerprint, LEAD_STUCK_MS, type LeadRunClass, type LeadRunReading, type LeadWakeCounts } from './wake.js'
export { LEAD_QUIET, LEAD_REMEMBER, isLeadQuiet, leadRememberLines } from './instructions.js'
export type { LeadLoop, LeadLoopOptions, LeadLoopState, LeadLoopClock } from './loop.js'
export { createLeadTools, LEAD_TOPICS, leadWorkerApprovalRelay } from './tools.js'
export type { LeadTools, LeadToolsOptions, LeadResolvedTool } from './tools.js'
export { evaluateLeadAcceptance, leadPublicationEvidenceRevision, LEAD_HEDGE_PHRASES, LEAD_REPAIR_INSTRUCTIONS, leadAssertionsToRerun, leadRepairInput, leadRepairDetail, leadAcceptanceObservation } from './acceptance.js'
export type { LeadAcceptanceEvidence, LeadAcceptanceResult } from './acceptance.js'
export { LEAD_REVIEWED_RESULT, leadReviewedResultSource, leadReviewedResultSourceFor } from './recipes/reviewed-result.js'
export { leadInstructions, leadContinuation, leadObservation, parseLeadSeatChoices, LEAD_SEATS_PER_ROLE } from './instructions.js'
export type { LeadSeatChoices, LeadInstructionFacts, LeadContinuationFacts } from './instructions.js'

export { leadDataContainsCredential } from './journal-security.js'
