import type { GoalActivity, GoalOrigin, GoalReceipt, GoalView, TeamState } from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

const at = 1_799_000_000_000

const board = (id: string, name: string): TeamState => ({
  id,
  name,
  root: PREVIEW_ROOT,
  updatedAt: at,
  members: [],
  messaging: true,
  intents: [],
  channel: [],
  nicknames: {},
  roles: {},
  plans: [],
  problem: null,
})

const receipt: GoalReceipt = {
  version: 1,
  id: 'receipt-preview',
  goal: 'goal-wrapped',
  sentence: 'Publish the verified desktop release',
  wrappedAt: at,
  summary: 'The release was built, checked and handed off.',
  cards: [],
  seats: [],
  evidence: [],
  answers: [],
  lanes: [],
  revisions: [],
  citations: [],
  gaps: ['One optional platform check was not available.'],
}

const view = (
  id: string,
  sentence: string,
  activity: GoalActivity | null,
  state: 'open' | 'wrapping' | 'wrapped' = 'open',
  options: Partial<Pick<GoalView, 'waitingOn' | 'problem' | 'receipt' | 'reservation'>> & { readonly origin?: GoalOrigin } = {},
): GoalView => ({
  ...(options.reservation ? { reservation: options.reservation } : {}),
  goal: {
    id,
    root: PREVIEW_ROOT,
    cwd: PREVIEW_ROOT,
    sentence,
    state,
    revision: state === 'open' ? 2 : 3,
    checkout: 'shared',
    dependsOn: options.waitingOn?.map((one) => one.id) ?? [],
    origin: options.origin ?? { kind: 'person' },
    createdAt: at - 60_000,
    updatedAt: at,
    receipt: state === 'wrapped' ? (options.receipt ?? receipt).id : null,
  },
  activity,
  waitingOn: options.waitingOn ?? [],
  members: [],
  board: board(id, sentence),
  receipt: options.receipt ?? null,
  problem: options.problem ?? null,
})

export const PREVIEW_GOALS: readonly GoalView[] = [
  view('goal-working', 'Finish the checkout boundary', 'working'),
  view('goal-needs-you', 'Approve the migration evidence', 'needs-you'),
  view('goal-waiting', 'Publish the desktop release', 'working', 'open', {
    waitingOn: [{ id: 'goal-working', sentence: 'Finish the checkout boundary' }],
  }),
  view('goal-refused', 'Recover the retained lane', 'needs-you', 'open', {
    problem: 'No lane port block is free. Release a retained lane or change Workspaces › Lanes.',
  }),
  view('goal-wrapped', receipt.sentence, null, 'wrapped', { receipt }),
  view('goal-restored', 'Imported release history', null, 'open', {
    problem: 'This Goal came from a backup. Start a new Goal to continue its work.',
  }),
  view('goal-trigger', 'Fix the retry bug', 'working', 'open', {
    origin: { kind: 'trigger', trigger: 'review-pr', event: 'e1' },
  }),
  // A person's own front-door start, whose reservation names the v2 run the
  // "flow scene" Dial's `flowExecutions` entries are keyed under — the same
  // linkage `TeamRoomPane`'s own `run` computation reads, so its header can
  // show what that run resolved: a pinned revision, or why it stopped.
  view('goal-flow', 'Retry the checkout call on a 502', 'working', 'open', {
    reservation: { run: 'preview-flow-run' },
  }),
]

export const PREVIEW_GOAL = PREVIEW_GOALS[1]!
/** The one Goal a front-door start reserved, for the "flow scene" preview. */
export const PREVIEW_FLOW_GOAL = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-flow')!
/** The one Goal a trigger opened, for the intake preview scenes. */
export const PREVIEW_TRIGGER_GOAL = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-trigger')!
