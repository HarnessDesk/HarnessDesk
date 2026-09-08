import type { StackMember } from '../ui'
import type { Tint, Tone } from '../ui'

/**
 * The page's contents, kept apart from the page.
 *
 * A mock page is only useful if it is realistic, and it is only *safely*
 * realistic if the numbers are obviously invented. These are: they are
 * HarnessDesk's own vocabulary — agents, sessions, workspaces, approvals — at
 * quantities a real desk would produce, and nothing here is anyone's data.
 *
 * Keeping them in their own module also means the showcase reads as a layout
 * rather than as a wall of literals, which is the whole point of looking at it.
 */

export const AGENTS: StackMember[] = [
  { name: 'Claude Code' },
  { name: 'Codex' },
  { name: 'Cursor' },
  { name: 'DeepSeek Harness' },
  { name: 'Gemini' },
]

export const SPEND_BY_DAY = [42, 58, 51, 73, 66, 88, 61, 79, 94, 71, 83, 68]
export const SPEND_LABELS = ['Aug 18', '', '', 'Aug 21', '', '', 'Aug 24', '', '', 'Aug 27', '', '']
export const SESSIONS_TREND = [12, 18, 15, 24, 21, 30, 27, 34, 29, 41, 38, 46]

export const AGENT_SHARE: { label: string; value: number; tint: Tint }[] = [
  { label: 'Claude Code', value: 46, tint: 'blue' },
  { label: 'Codex', value: 28, tint: 'teal' },
  { label: 'Cursor', value: 17, tint: 'violet' },
  { label: 'DeepSeek Harness', value: 9, tint: 'orange' },
]

export type SessionRow = {
  agent: string
  title: string
  workspace: string
  progress: number
  tone: Tone
  state: string
}

export const SESSIONS: SessionRow[] = [
  {
    agent: 'Claude Code',
    title: 'Migrate the auth callers',
    workspace: 'harnessdesk / src/api',
    progress: 82,
    tone: 'success',
    state: 'Running',
  },
  {
    agent: 'Codex',
    title: 'Integration tests for the gateway',
    workspace: 'harnessdesk / packages/server',
    progress: 44,
    tone: 'neutral',
    state: 'Running',
  },
  {
    agent: 'Cursor',
    title: 'Rewrite the release notes',
    workspace: 'harnessdesk-site / content',
    progress: 100,
    tone: 'success',
    state: 'Done',
  },
  {
    agent: 'DeepSeek Harness',
    title: 'Trace the flaky socket test',
    workspace: 'harnessdesk / packages/transport-acp',
    progress: 19,
    tone: 'warning',
    state: 'Waiting on approval',
  },
]

export type Task = {
  id: string
  title: string
  assignees: StackMember[]
  priority?: { label: string; tone: Tone }
  tag?: { label: string; tint: Tint }
  attachments: number
  comments: number
}

export type Column = {
  id: string
  title: string
  tint: Tint
  tasks: Task[]
}

/**
 * The board, in HarnessDesk's own terms: an intent moves from open, to claimed
 * by an agent, to waiting on a human, to landed. The columns are the states the
 * Team plane actually holds, so this page is a proposal and not a mood board.
 */
export const COLUMNS: Column[] = [
  {
    id: 'open',
    title: 'Open',
    tint: 'sky',
    tasks: [
      {
        id: 'o1',
        title: 'Split the transport package',
        assignees: [],
        priority: { label: 'Normal', tone: 'neutral' },
        tag: { label: 'harnessdesk', tint: 'blue' },
        attachments: 0,
        comments: 2,
      },
      {
        id: 'o2',
        title: 'Retire the legacy session format',
        assignees: [],
        priority: { label: 'Low', tone: 'neutral' },
        attachments: 1,
        comments: 0,
      },
    ],
  },
  {
    id: 'claimed',
    title: 'Claimed',
    tint: 'violet',
    tasks: [
      {
        id: 'c1',
        title: 'Migrate the auth callers',
        assignees: [AGENTS[0] as StackMember],
        priority: { label: 'High', tone: 'danger' },
        tag: { label: 'src/api', tint: 'teal' },
        attachments: 3,
        comments: 7,
      },
      {
        id: 'c2',
        title: 'Integration tests for the gateway',
        assignees: [AGENTS[1] as StackMember, AGENTS[2] as StackMember],
        priority: { label: 'Normal', tone: 'neutral' },
        attachments: 0,
        comments: 4,
      },
      {
        id: 'c3',
        title: 'Cache the plugin roster read',
        assignees: [AGENTS[4] as StackMember],
        priority: { label: 'Low', tone: 'neutral' },
        attachments: 0,
        comments: 1,
      },
    ],
  },
  {
    id: 'review',
    title: 'Waiting on you',
    tint: 'amber',
    tasks: [
      {
        id: 'r1',
        title: 'Trace the flaky socket test',
        assignees: [AGENTS[3] as StackMember],
        priority: { label: 'High', tone: 'danger' },
        tag: { label: 'approval', tint: 'amber' },
        attachments: 2,
        comments: 12,
      },
    ],
  },
  {
    id: 'landed',
    title: 'Landed',
    tint: 'green',
    tasks: [
      {
        id: 'l1',
        title: 'Rewrite the release notes',
        assignees: [AGENTS[2] as StackMember],
        attachments: 1,
        comments: 3,
      },
      {
        id: 'l2',
        title: 'Bundle Geist for offline launch',
        assignees: [AGENTS[0] as StackMember, AGENTS[1] as StackMember],
        attachments: 0,
        comments: 5,
      },
    ],
  },
]

export const SETUP_STEPS = [
  { label: 'Add an agent', hint: 'Claude Code' },
  { label: 'Pick a workspace' },
  { label: 'Set approvals' },
  { label: 'Run a session' },
]
