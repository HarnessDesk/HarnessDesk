/**
 * The host's closed, first-match table for who an item waits on. Every kind ends
 * in a catch-all. Surfaces asking what waits on the person must read this stage
 * rather than derive another one; the model never computes it. Facts contain
 * host state and validated card kinds, never model-written prose.
 */
import type { LEAD_MANAGEMENT_REASONS, LeadThreadState } from './lead.js'
import type { PhoneTeamStatus } from './phone.js'

export type LeadStage = 'you-answer' | 'you-review' | 'you-blocked' | 'working' | 'queued' | 'idle'
export const LEAD_STAGES = ['you-answer', 'you-review', 'you-blocked', 'working', 'queued', 'idle'] as const satisfies readonly LeadStage[]
export const isWaitingOnYou = (stage: LeadStage): boolean => stage === 'you-answer' || stage === 'you-review' || stage === 'you-blocked'

export type LeadStageFacts =
  | { readonly kind: 'lead'; readonly state: LeadThreadState
      readonly pendingPersonCard: 'plan' | 'permission-change' | 'budget-change' | 'branch-ownership' | 'waiting' | null
      readonly resultReady: boolean; readonly workerApproval: boolean; readonly checkToRun: boolean
      readonly waitReason: typeof LEAD_MANAGEMENT_REASONS[number] | null
      readonly requestInFlight: boolean; readonly chatEffectQueued: boolean }
  | { readonly kind: 'session'; readonly archived: boolean; readonly waiting: boolean; readonly failed: boolean; readonly queuePaused: boolean; readonly running: boolean; readonly queued: boolean }
  | { readonly kind: 'team'; readonly status: PhoneTeamStatus; readonly prepared: boolean }

/** Deliberately explicit: a new management reason must make a classification choice. */
export const LEAD_WAIT_STAGES = {
  'lead-predecessor-unavailable': 'you-blocked', 'lead-predecessor-unverifiable': 'you-blocked', 'lead-renewal-blocked': 'you-blocked',
  'lead-disabled': 'you-blocked', 'lead-key-changed': 'you-blocked', 'lead-host-shutdown': 'you-blocked', 'lead-child-exited': 'you-blocked', 'lead-ownership-withdrawn': 'you-blocked',
  'lead-result-awaiting-person': 'you-answer', 'lead-handback-limit': 'you-blocked', 'lead-handback-pending': 'you-answer', 'lead-publication-needs-you': 'you-blocked',
  'lead-pr-head-changed': 'you-answer', 'lead-pr-branch-rewritten': 'you-blocked', 'lead-result-revisions-exhausted': 'you-blocked', 'lead-start-binding-failed': 'you-blocked',
  'lead-plan-refused': 'you-blocked', 'lead-activity-failed': 'you-blocked', 'lead-subscription-failed': 'you-blocked', 'lead-tools-refused': 'you-blocked',
  'lead-repair-failed': 'you-blocked', 'lead-repair-withdrawn': 'you-blocked', 'lead-repair-abandoned': 'you-blocked', 'lead-repair-unverified': 'you-blocked', 'lead-repair-recovery-failed': 'you-blocked',
  'lead-card-too-large': 'you-blocked', 'lead-send-deadline': 'you-blocked', 'lead-request-refused': 'you-blocked', 'lead-request-rate-limited': 'you-blocked',
  'lead-request-failed': 'you-blocked', 'lead-request-max-tokens': 'you-blocked', 'lead-request-invalid-response': 'you-blocked', 'lead-request-cancelled': 'you-blocked', 'lead-request-uncertain': 'you-blocked',
  'lead-worker-audit-failed': 'you-blocked', 'lead-chat-effect-uncertain': 'you-blocked', 'lead-run-not-started': 'you-blocked', 'lead-budget-unknown': 'you-blocked',
  'lead-plan-unseatable': 'you-blocked', 'lead-plan-not-independent': 'you-blocked',
  // The desk did not send the request: nothing waits on the person's answer, and the person is told why instead.
  'lead-request-unsent': 'idle', 'lead-request-unsent-again': 'idle', 'lead-request-withheld': 'idle', 'lead-request-held': 'idle',
} as const satisfies Record<typeof LEAD_MANAGEMENT_REASONS[number], 'you-answer' | 'you-blocked' | 'idle'>

type Row = { readonly kind: LeadStageFacts['kind']; readonly when: (facts: LeadStageFacts) => boolean; readonly stage: LeadStage; readonly reason: string }
export const LEAD_STAGE_TABLE: readonly Row[] = [
  ...(['plan', 'permission-change', 'budget-change', 'branch-ownership', 'waiting'] as const).map(card => ({
    kind: 'lead' as const, when: (facts: LeadStageFacts) => facts.kind === 'lead' && facts.pendingPersonCard === card,
    stage: 'you-answer' as const, reason: `card-${card}`,
  })),
  { kind: 'lead', when: f => f.kind === 'lead' && f.resultReady, stage: 'you-review', reason: 'result-ready' },
  { kind: 'lead', when: f => f.kind === 'lead' && f.workerApproval, stage: 'you-answer', reason: 'worker-approval' },
  { kind: 'lead', when: f => f.kind === 'lead' && f.checkToRun, stage: 'you-answer', reason: 'check-to-run' },
  ...Object.entries(LEAD_WAIT_STAGES).map(([reason, stage]) => ({ kind: 'lead' as const,
    when: (f: LeadStageFacts) => f.kind === 'lead' && f.waitReason === reason, stage, reason: reason.slice(5) })),
  { kind: 'lead', when: f => f.kind === 'lead' && f.state === 'waiting-for-user', stage: 'you-answer', reason: 'waiting-for-user' },
  { kind: 'lead', when: f => f.kind === 'lead' && (f.requestInFlight || ['planning', 'running', 'following'].includes(f.state)), stage: 'working', reason: 'running' },
  { kind: 'lead', when: f => f.kind === 'lead' && f.chatEffectQueued, stage: 'queued', reason: 'chat-effect-queued' },
  { kind: 'lead', when: () => true, stage: 'idle', reason: 'idle' },
  { kind: 'session', when: f => f.kind === 'session' && f.archived, stage: 'idle', reason: 'archived' },
  { kind: 'session', when: f => f.kind === 'session' && f.waiting, stage: 'you-answer', reason: 'worker-approval' },
  { kind: 'session', when: f => f.kind === 'session' && f.failed, stage: 'you-blocked', reason: 'failed' },
  { kind: 'session', when: f => f.kind === 'session' && f.queuePaused, stage: 'you-blocked', reason: 'queue-paused' },
  { kind: 'session', when: f => f.kind === 'session' && f.running, stage: 'working', reason: 'running' },
  { kind: 'session', when: f => f.kind === 'session' && f.queued, stage: 'queued', reason: 'send-queued' },
  { kind: 'session', when: () => true, stage: 'idle', reason: 'idle' },
  { kind: 'team', when: f => f.kind === 'team' && f.status === 'needs-you', stage: 'you-answer', reason: 'needs-you' },
  { kind: 'team', when: f => f.kind === 'team' && f.status === 'ready', stage: 'you-review', reason: 'result-ready' },
  { kind: 'team', when: f => f.kind === 'team' && f.status === 'stopped', stage: 'you-blocked', reason: 'stopped' },
  { kind: 'team', when: f => f.kind === 'team' && f.prepared && f.status === 'working', stage: 'queued', reason: 'start-queued' },
  { kind: 'team', when: f => f.kind === 'team' && f.status === 'working', stage: 'working', reason: 'running' },
  { kind: 'team', when: () => true, stage: 'idle', reason: 'idle' },
]

export const leadStage = (facts: LeadStageFacts): { stage: LeadStage; reason: string } => {
  const row = LEAD_STAGE_TABLE.find(row => row.kind === facts.kind && row.when(facts))!
  return { stage: row.stage, reason: row.reason }
}
