/** Portable entry. Process ownership and transports belong to separate entries. */
export type { LeadCancellation, LeadDeskPort, LeadMessagesPort, LeadPersistencePort, LeadPorts } from './ports.js'
export { decideLeadPermission, compareLeadPolicyAuthority, proposeLeadPolicyChange, applyLeadPolicyDecision } from './permissions.js'
export type { LeadPermissionEffect, LeadPermissionFloor, LeadPermissionCall, LeadPermissionDecision, LeadPermissionRequest, LeadPermissionContext,
  LeadAuthorityChange, LeadPolicyProposal, LeadPolicyChange } from './permissions.js'
export { LEAD_JOURNAL_BYTES, summarizeLeadArguments, parseLeadOwnedPush, parseLeadPublicationSource, parseLeadPublicationOperation, parseLeadJournalRecord, prepareLeadJournalRecord, parseLeadRunIdentity, LeadJournal, createLeadJournal } from './journal.js'
export type { LeadJournalEvent, LeadJournalRecord, LeadStopFrom, LeadJournalStorage, LeadRunIdentity, LeadRunObservation, LeadOwnedPush, LeadPublicationSource, LeadPublicationOperation, LeadArgumentSummary,
  LeadAttemptOutcome, LeadCompactionTrigger, LeadToolAttempt, LeadDispatch, LeadDispatchResult, LeadRecoveryAction } from './journal.js'
export { hasPendingLeadPlan, isLeadPlanRenewal, hasUncertainLeadChatEffect, leadDecisionRevisionMatches, canOfferAutomaticLeadGoal, leadHandbackTerminal, leadRepairResultReady, leadWorkerDispatchBlockedByOpenPr, canBeginLeadGoal, canReplaceLeadPlan, initialLeadContext, LEAD_CHECKPOINT_NOTICE, LEAD_CONTEXT_UNCOUNTED, leadPlanRuns, leadGoalTeams, leadOwnedTeams, LEAD_ACCEPTED_TEAMS, leadLimitedCaps, leadDraftCaps, leadGoalSpendCap, initialLeadState, reduceLeadRecord, replayLeadJournal } from './state.js'
export type { LeadAcceptedTeam, LeadOwnedTeam } from './state.js'
export type { LeadState, LeadStepState, LeadAttemptState, LeadChatEffects, LeadContextState } from './state.js'

export type { LeadJournalSecurity } from './journal-security.js'
export { leadCheckpoint, parseLeadCheckpoint } from './checkpoint.js'
export type { LeadJournalCheckpoint } from './checkpoint.js'
export { leadRoundId, reduceLeadBudget, leadBudgetProjection, parseLeadBudgetLedger } from './budget.js'
export type { LeadBudgetLedger } from './budget.js'
export { createLeadMessages, parseLeadMessagesBody, parseLeadContextTurns, leadHistory, LEAD_HISTORY_TURNS, LEAD_HISTORY_BYTES, LEAD_MESSAGES_DEFAULTS } from './messages.js'
export type { LeadMessagesClient, LeadMessagesOptions, LeadMessagesRequest, LeadMessagesResult, LeadMessagesStatus,
  MessagesTransport, MessagesHttpRequest, MessagesHttpResponse, MessagesPrice, MessagesUsage, MessagesToolScope,
  MessagesTurn, MessagesText, MessagesThinking, MessagesRedactedThinking, MessagesToolUse, MessagesToolResult } from './messages-types.js'
export { createLeadLoop } from './loop.js'
export { classifyLeadRuns, createLeadWakeGate, leadChatFingerprint, leadDeskFingerprint, LEAD_STUCK_MS, type LeadRunClass, type LeadRunReading, type LeadWakeCounts } from './wake.js'
export { LEAD_QUIET, LEAD_REMEMBER, isLeadQuiet, leadRememberLines } from './instructions.js'
export type { LeadLoop, LeadLoopOptions, LeadLoopState, LeadLoopClock, LeadContextPort, LeadContextRecordInput } from './loop.js'
export { createLeadTools, LEAD_TOPICS, leadWorkerApprovalRelay } from './tools.js'
export type { LeadTools, LeadToolsOptions, LeadResolvedTool } from './tools.js'
export { evaluateLeadAcceptance, leadPublicationEvidenceRevision, leadResultSummary, leadVerifyLine, LEAD_HEDGE_PHRASES, LEAD_REPAIR_INSTRUCTIONS, leadAssertionsToRerun, leadRepairInput, leadRepairDetail, leadAcceptanceObservation } from './acceptance.js'
export type { LeadAcceptanceEvidence, LeadAcceptanceResult } from './acceptance.js'
export { LEAD_REVIEWED_RESULT, leadReviewedResultSource, leadReviewedResultSourceFor } from './recipes/reviewed-result.js'
export { leadInstructions, leadContinuation, leadApprovedPlan, leadPlanMoment, leadObservation, parseLeadSeatChoices, LEAD_SEATS_PER_ROLE } from './instructions.js'
export type { LeadSeatChoices, LeadInstructionFacts, LeadContinuationFacts } from './instructions.js'

export { leadDataContainsCredential } from './journal-security.js'
export { leadWorkCards } from './work.js'
export { LEAD_CONTEXT, LEAD_CONTEXT_WINDOWS, LEAD_DESK_STUB_PREFIX, leadContextWindow, leadContextBytes, leadEstimatedTokens, leadContextPressure, leadNextSoftShare,
  leadDeskStub, leadContextMarkOf, leadStubVolatile, leadContextRecord, leadWithoutReasoning, leadPruneContext, leadContextBoundary, leadContextSplit, leadCloseOpenLoop, leadPairedTurns, leadMergedTurns, leadAppendUser, leadWithPlan, LEAD_EPOCH_ADDENDA, leadEpochAddendum, leadClip } from './context.js'
export type { LeadContextMark, LeadContextRecord, LeadContextPressureInput } from './context.js'
export { LEAD_CHECKPOINT_SECTIONS, LEAD_CHECKPOINT_OPEN, leadCheckpointInstruction, leadCheckpointRefusal, leadCheckpointTurn, leadCheckpointText, leadPersonWords,
  leadFallbackCheckpoint, leadCheckpointMessages, leadRegionBytes, leadPersonSection, leadPersonQuotes, leadCheckpointCompose, leadCheckpointModelPart, leadFitTurns } from './compaction.js'
export type { LeadCheckpointRequestFacts } from './compaction.js'
export { leadAutonomyMode, leadDeadlinePassed, leadWakeAutonomy } from './autonomy.js'
export { leadRulesAddendum, LEAD_RULES_OPEN, LEAD_RULES_CLOSE } from './context.js'
