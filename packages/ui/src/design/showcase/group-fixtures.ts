import type { Brand } from '@/lib/brands'
import type { Tint, Tone } from '../ui'

/**
 * One group project, populated.
 *
 * The fixture carries the thing the design is actually about: **four agents on
 * four different harnesses**, and a board where each task names the harness
 * that took it. A roster of four Claudes would prove nothing &mdash; the whole
 * argument for a group project is that you pick the runtime that suits the
 * work, and the interface has to make that choice visible after it is made.
 */

export type HarnessAgent = {
  id: string
  name: string
  brand: Brand
  tint: Tint
  /** The model this one is running, which is half of "which harness". */
  model: string
  state: 'working' | 'idle' | 'waiting'
  /** The task it is on right now, by id. Idle agents have none. */
  onTask: string | null
  unread?: number
  /** What this harness is here for &mdash; why it was picked. */
  reason: string
}

export const AGENTS: HarnessAgent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    brand: 'claudecode',
    tint: 'blue',
    model: 'Opus 5',
    state: 'working',
    onTask: 't2',
    unread: 2,
    reason: 'Long refactors across many files',
  },
  {
    id: 'codex',
    name: 'Codex',
    brand: 'codex',
    tint: 'teal',
    model: 'GPT-5.6',
    state: 'working',
    onTask: 't3',
    reason: 'Test suites and flake hunting',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    brand: 'cursor',
    tint: 'violet',
    model: 'Composer',
    state: 'idle',
    onTask: null,
    reason: 'Fast single-file edits',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    brand: 'geminicli',
    tint: 'orange',
    model: '2.5 Pro',
    state: 'waiting',
    onTask: 't5',
    unread: 1,
    reason: 'Long-context reading of the spec',
  },
]

export type Task = {
  id: string
  title: string
  /** The agent that holds it, or null while it is unclaimed. */
  agent: string | null
  column: string
  priority?: { label: string; tone: Tone }
  /** The path or area it touches, which is how conflicts get avoided. */
  scope?: string
  comments: number
  attachments: number
}

export const COLUMNS = [
  { id: 'open', title: 'Open', tint: 'sky' as Tint },
  { id: 'claimed', title: 'Claimed', tint: 'violet' as Tint },
  { id: 'review', title: 'Waiting on you', tint: 'amber' as Tint },
  { id: 'landed', title: 'Landed', tint: 'green' as Tint },
]

export const TASKS: Task[] = [
  {
    id: 't1',
    title: 'Split the transport package',
    agent: null,
    column: 'open',
    priority: { label: 'Normal', tone: 'neutral' },
    scope: 'packages/transport-acp',
    comments: 2,
    attachments: 0,
  },
  {
    id: 't7',
    title: 'Retire the legacy session format',
    agent: null,
    column: 'open',
    priority: { label: 'Low', tone: 'neutral' },
    comments: 0,
    attachments: 1,
  },
  {
    id: 't2',
    title: 'Migrate the auth callers',
    agent: 'claude',
    column: 'claimed',
    priority: { label: 'High', tone: 'danger' },
    scope: 'src/api/**',
    comments: 7,
    attachments: 3,
  },
  {
    id: 't3',
    title: 'Integration tests for the gateway',
    agent: 'codex',
    column: 'claimed',
    priority: { label: 'Normal', tone: 'neutral' },
    scope: 'packages/server',
    comments: 4,
    attachments: 0,
  },
  {
    id: 't5',
    title: 'Read the ACP spec and list the gaps',
    agent: 'gemini',
    column: 'review',
    priority: { label: 'High', tone: 'danger' },
    scope: 'docs/',
    comments: 12,
    attachments: 2,
  },
  {
    id: 't6',
    title: 'Rewrite the release notes',
    agent: 'cursor',
    column: 'landed',
    comments: 3,
    attachments: 1,
  },
]

/** Every harness the desk could add to a project, for the picker. */
export const AVAILABLE: { brand: Brand; name: string; note: string }[] = [
  { brand: 'claude', name: 'Claude', note: 'Signed in' },
  { brand: 'deepseek', name: 'DeepSeek Harness', note: 'Signed in' },
  { brand: 'githubcopilot', name: 'Copilot', note: 'Not signed in' },
  { brand: 'opencode', name: 'OpenCode', note: 'From the registry' },
]
