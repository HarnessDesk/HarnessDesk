import type {
  TriggerArmPreview,
  TriggerAttention,
  TriggerAttentionKind,
  TriggerBudgetState,
  TriggerDefinition,
  TriggerFiring,
  TriggerGoalStatus,
  TriggerHistoryPage,
  TriggerPreferences,
  TriggerProjectView,
  TriggerStopReason,
  TriggerView,
} from '@harnessdesk/protocol'
import { DEFAULT_TRIGGER_BUDGET } from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'
import { FIX_PREVIEW } from './flow-fixture'

export const INTAKE_ROOT = PREVIEW_ROOT

export const prDefinition = (over: Partial<TriggerDefinition> = {}): TriggerDefinition => ({
  id: 'review-pr',
  on: { kind: 'pull-request', events: ['opened', 'pushed'] },
  opens: { flow: 'review-pr' },
  goal: ['pr'],
  again: null,
  dedupe: ['pr', 'head', 'event'],
  concurrency: 4,
  forks: 'never',
  budget: DEFAULT_TRIGGER_BUDGET,
  ...over,
})

export const issueDefinition = (over: Partial<TriggerDefinition> = {}): TriggerDefinition => ({
  id: 'triage-issue',
  on: { kind: 'issue', events: ['labelled'] },
  opens: { agent: 'triager' },
  goal: ['issue'],
  again: null,
  dedupe: ['issue', 'event'],
  concurrency: 1,
  forks: 'never',
  budget: DEFAULT_TRIGGER_BUDGET,
  label: ['triage'],
  ...over,
})

export const scheduleDefinition = (over: Partial<TriggerDefinition> = {}): TriggerDefinition => ({
  id: 'nightly-sweep',
  on: { kind: 'schedule', events: ['tick'], everyMinutes: 1440 },
  opens: { flow: 'sweep' },
  goal: ['slot'],
  again: null,
  dedupe: ['slot'],
  concurrency: 1,
  forks: 'never',
  budget: DEFAULT_TRIGGER_BUDGET,
  ...over,
})

export const triggerFiring = (over: Partial<TriggerFiring> = {}): TriggerFiring => ({
  id: 'firing-1',
  trigger: 'review-pr',
  source: 'pull-request',
  subject: '12',
  at: 1_700_000_000_000,
  outcome: 'fired',
  reason: null,
  goal: 'goal-pr-12',
  run: 'run-1',
  round: 1,
  head: 'a'.repeat(40),
  ...over,
})

export const triggerView = (over: Partial<TriggerView> = {}): TriggerView => ({
  id: 'review-pr',
  definition: prDefinition(),
  armed: false,
  state: 'off',
  reason: null,
  fix: null,
  last: null,
  openGoals: 0,
  ...over,
})

export const triggerProjectView = (over: Partial<TriggerProjectView> = {}): TriggerProjectView => ({
  project: INTAKE_ROOT,
  revision: 1,
  path: `${INTAKE_ROOT}/.harnessdesk/triggers.yml`,
  exists: true,
  workingCopyChanged: false,
  triggers: [
    triggerView(),
    triggerView({
      id: 'triage-issue',
      definition: issueDefinition(),
      last: triggerFiring({
        id: 'firing-2', trigger: 'triage-issue', source: 'issue', subject: '7',
        outcome: 'skipped', reason: 'Out of budget for today.', goal: null, run: null, round: null, head: null,
      }),
    }),
    triggerView({
      id: 'nightly-sweep',
      definition: scheduleDefinition(),
      armed: true,
      state: 'armed',
      openGoals: 1,
    }),
  ],
  problems: [],
  ...over,
})

export const triggerArmPreview = (over: Partial<TriggerArmPreview> = {}): TriggerArmPreview => ({
  id: 'review-pr',
  token: 'preview-token-1',
  expiresAt: 1_700_000_060_000,
  sourcePath: `${INTAKE_ROOT}/.harnessdesk/triggers.yml`,
  workingCopyChanged: false,
  definition: prDefinition(),
  flow: FIX_PREVIEW,
  problems: [],
  moneyPolicy: 'observed-stop',
  repository: 'acme/widgets',
  ...over,
})

export const TRIGGER_ARM_SCENES = ['ready', 'refused', 'commands', 'fork', 'changed', 'unheld'] as const
export type TriggerArmScene = (typeof TRIGGER_ARM_SCENES)[number]

export const sceneArmPreview = (scene: TriggerArmScene): TriggerArmPreview => {
  if (scene === 'refused') {
    return triggerArmPreview({
      token: null,
      definition: null,
      flow: null,
      problems: [{ at: '[0].budget.usd', text: 'A budget must be a positive number.', fix: 'Give it a positive USD amount, or remove the field for the default.' }],
    })
  }
  if (scene === 'commands') {
    return triggerArmPreview({ flow: FIX_PREVIEW })
  }
  if (scene === 'fork') {
    return triggerArmPreview({ definition: prDefinition({ forks: 'allow' }) })
  }
  if (scene === 'changed') {
    return triggerArmPreview({ workingCopyChanged: true })
  }
  if (scene === 'unheld') {
    return triggerArmPreview()
  }
  return triggerArmPreview()
}

export const triggerHistoryPage = (over: Partial<TriggerHistoryPage> = {}): TriggerHistoryPage => ({
  items: [
    triggerFiring(),
    triggerFiring({ id: 'firing-2', subject: '11', outcome: 'skipped', reason: 'A stranger’s head; forks are never run.', goal: null, run: null, round: null, head: 'b'.repeat(40) }),
    triggerFiring({ id: 'firing-3', subject: '11', outcome: 'duplicate', reason: null }),
  ],
  next: null,
  ...over,
})

export const triggerPreferences = (over: Partial<TriggerPreferences> = {}): TriggerPreferences => ({
  revision: 1,
  paused: false,
  dailyUsd: 20,
  day: '2026-09-24',
  chargedUsd: 4.5,
  reservedUsd: 5,
  ...over,
})

export const triggerBudgetState = (over: Partial<TriggerBudgetState> = {}): TriggerBudgetState => ({
  goal: 'goal-pr-12',
  startedAt: 1_700_000_000_000,
  deadline: 1_700_014_400_000,
  budget: DEFAULT_TRIGGER_BUDGET,
  spentMicros: 1_200_000,
  reservedMicros: 5_000_000,
  provenance: 'vendorMetered',
  closedRounds: [1],
  idleRounds: 0,
  stop: null,
  ...over,
})

export const triggerAttention = (over: Partial<TriggerAttention> = {}): TriggerAttention => ({
  id: 'wait-1',
  goal: 'goal-pr-12',
  trigger: 'review-pr',
  kind: 'message',
  waitingOn: { kind: 'person', label: 'you' },
  sentence: 'A message is held for your review before it sends.',
  action: 'open-goal',
  createdAt: 1_700_000_010_000,
  resolvedAt: null,
  notification: 'delivered',
  ...over,
})

const WAIT_SCENES: Readonly<Record<TriggerAttentionKind, TriggerAttention>> = {
  message: triggerAttention({ id: 'wait-message', kind: 'message', sentence: 'A message is held for your review before it sends.', action: 'open-goal' }),
  approval: triggerAttention({ id: 'wait-approval', kind: 'approval', sentence: 'An action is held for your approval.', action: 'open-goal' }),
  question: triggerAttention({ id: 'wait-question', kind: 'question', waitingOn: { kind: 'person', label: 'you' }, sentence: 'A Seat asked a question and nobody answered in time.', action: 'open-goal' }),
  'person-step': triggerAttention({ id: 'wait-person-step', kind: 'person-step', sentence: 'A round needs a person to take the next card.', action: 'open-goal' }),
  member: triggerAttention({ id: 'wait-member', kind: 'member', waitingOn: { kind: 'member', label: 'the reviewer' }, sentence: 'Waiting on the reviewer to finish its round.', action: 'open-goal' }),
  budget: triggerAttention({ id: 'wait-budget', kind: 'budget', waitingOn: { kind: 'service', label: 'the daily cap' }, sentence: 'This Goal stopped: out of budget.', action: 'open-usage' }),
  source: triggerAttention({ id: 'wait-source', kind: 'source', waitingOn: { kind: 'service', label: 'the forge' }, sentence: 'The pull request could not be read.', action: 'open-trigger' }),
  publication: triggerAttention({ id: 'wait-publication', kind: 'publication', waitingOn: { kind: 'service', label: 'the pull request' }, sentence: 'A review could not be posted; the read-back was ambiguous.', action: 'open-goal' }),
  skipped: triggerAttention({ id: 'wait-skipped', kind: 'skipped', waitingOn: { kind: 'service', label: 'review-pr' }, sentence: 'A firing was skipped: out of budget for today.', action: 'open-trigger' }),
}

export const sceneWait = (kind: TriggerAttentionKind): TriggerAttention => WAIT_SCENES[kind]

export const TRIGGER_STOP_REASONS: readonly TriggerStopReason[] = [
  'answered', 'crashed', 'timed out', 'lease expired', 'cancelled', 'out of budget',
  'asked a question nobody can answer', 'needs a person',
]

export const triggerGoalStatus = (over: Partial<TriggerGoalStatus> = {}): TriggerGoalStatus => ({
  goal: 'goal-pr-12',
  trigger: 'review-pr',
  source: 'pull-request',
  label: 'from PR #12',
  url: 'https://forge.example/acme/widgets/pull/12',
  budget: triggerBudgetState(),
  waits: [],
  ...over,
})

export const GOAL_INTAKE_SCENES = [
  'pull-request', 'issue', 'schedule', 'held-message', 'held-action', 'question', 'person-step', 'stopped', 'unknown-budget',
  // A member's own approval pending: the room's composer slot holds it (`main.tsx` raises it on the store).
  'approval',
] as const
export type GoalIntakeScene = (typeof GOAL_INTAKE_SCENES)[number]

export const sceneGoalStatus = (scene: GoalIntakeScene): TriggerGoalStatus => {
  if (scene === 'issue') return triggerGoalStatus({ source: 'issue', label: 'from issue #7', url: 'https://forge.example/acme/widgets/issues/7' })
  if (scene === 'schedule') return triggerGoalStatus({ source: 'schedule', label: 'from a schedule', url: null })
  if (scene === 'held-message') return triggerGoalStatus({ waits: [sceneWait('message')] })
  if (scene === 'held-action') return triggerGoalStatus({ waits: [sceneWait('approval')] })
  if (scene === 'question') return triggerGoalStatus({ waits: [sceneWait('question')] })
  if (scene === 'person-step') return triggerGoalStatus({ waits: [sceneWait('person-step')] })
  if (scene === 'stopped') {
    return triggerGoalStatus({
      budget: triggerBudgetState({ stop: { reason: 'out of budget', detail: 'The daily cap was reached before this round closed.', at: 1_700_014_000_000 } }),
      waits: [sceneWait('budget')],
    })
  }
  if (scene === 'unknown-budget') return triggerGoalStatus({ budget: triggerBudgetState({ spentMicros: null, provenance: 'unknown' }) })
  return triggerGoalStatus()
}
