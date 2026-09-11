import type { AgentItem, FileChange, Session } from '@harnessdesk/protocol'

import { splitContext, wrapContext } from './context-envelope'
import { countFileChange } from './diff'
import { applyPlanEdits, type PlanEdit } from './plan-edits'
import { sessionPlan } from './todos'

/**
 * The hand-off packet: what one agent's conversation becomes when another
 * agent picks it up.
 *
 * No vendor can adopt another's thread, so what travels is text — and the
 * text that matters is not the chatter but the state: what was asked, where
 * it stands, which files changed, what is still to do, and the commit to
 * diff against rather than trust prose. Every agent reads Markdown.
 */

export type Carry = 'summary' | 'transcript' | 'files'

export const CARRY_OPTIONS: readonly { readonly id: Carry; readonly label: string; readonly hint: string }[] = [
  {
    id: 'summary',
    label: 'Summary',
    hint: 'The goal, the latest exchanges, files changed, open tasks, and the commit. Cheap and usually enough.',
  },
  {
    id: 'transcript',
    label: 'Full transcript',
    hint: 'Every exchange in order, plus files changed and open tasks. Faithful; costs the target agent more tokens.',
  },
  {
    id: 'files',
    label: 'Files changed only',
    hint: 'The goal and the list of files touched, with the commit. For when the code speaks for itself.',
  },
]

export const CARRY_LABEL: Record<Carry, string> = {
  summary: 'summary',
  transcript: 'full transcript',
  files: 'files changed',
}

export interface HandoffSource {
  readonly agentName: string
  readonly session: Session
  /**
   * Tasks the person reworded in the panel. The packet carries their wording,
   * not the wording the agent being left behind used: the panel's rule is that
   * what the next agent is told is still open is what the person was looking
   * at, and an edit is precisely the part of that the transcript cannot say.
   * The receiving agent has never heard the old phrasing, so there is nothing
   * for it to reconcile — only the correction to honour.
   */
  readonly planEdits?: readonly PlanEdit[]
}

/** How many recent exchanges a summary keeps. */
const RECENT = 6
const ASK_LIMIT = 600
const ANSWER_LIMIT = 1000
/**
 * How much a full transcript may weigh. A marathon conversation runs to
 * megabytes; a packet that size starts the target agent by drowning it.
 * Whole exchanges are kept from the end — the recent ones are the ones the
 * work continues from — and the packet says how many earlier ones fell off.
 */
const TRANSCRIPT_LIMIT = 120_000
/** How many changed files the packet lists before counting the rest. */
const FILES_LIMIT = 200

interface Exchange {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

const textOf = (item: AgentItem): Exchange | null => {
  if (item.type === 'userMessage') {
    // What the user typed, without the envelopes the desk itself injected —
    // a git note or a previous hand-off quoted back inside this one is both
    // noise and a `<context>` nested in a `<context>`.
    const text = item.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? splitContext(part.text).text : ''))
      .join(' ')
      .trim()
    return text ? { role: 'user', text } : null
  }
  if (item.type === 'assistantMessage' && item.phase !== 'commentary' && item.text.trim()) {
    return { role: 'assistant', text: item.text.trim() }
  }
  return null
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'file']
const EDIT_KEYS = [
  'content',
  'new_string',
  'new_str',
  'edits',
  'code_edit',
  'diff',
  'patch',
  'new_source',
  // Cursor's own name for the text it wrote, captured from the CLI's
  // stream-json: without it every Cursor hand-off says nothing was touched.
  'streamContent',
]

/**
 * An edit hiding in a tool call. Codex reports edits as fileChange items;
 * ACP agents report them as the tool they used — Write, Edit, MultiEdit —
 * with the path and the new text in the arguments. Both count.
 */
export const editOf = (item: AgentItem): FileChange | null => {
  if (item.type !== 'toolCall' || typeof item.args !== 'object' || item.args === null) return null
  const args = item.args as Record<string, unknown>
  const path = PATH_KEYS.map((key) => args[key]).find((value): value is string => typeof value === 'string')
  if (!path || !EDIT_KEYS.some((key) => key in args)) return null
  const fresh =
    (typeof args['content'] === 'string' || typeof args['streamContent'] === 'string') &&
    !('old_string' in args) &&
    !('old_str' in args)
  const body = [
    args['content'],
    args['new_string'],
    args['new_str'],
    args['code_edit'],
    args['diff'],
    args['patch'],
    args['streamContent'],
  ]
    .find((value): value is string => typeof value === 'string') ?? ''
  const removed = [args['old_string'], args['old_str']].find((value): value is string => typeof value === 'string') ?? ''
  const diff =
    body.includes('\n@@') || body.startsWith('---')
      ? body
      : [...removed.split('\n').filter(Boolean).map((line) => `-${line}`), ...body.split('\n').map((line) => `+${line}`)].join('\n')
  return { path, kind: { type: fresh ? 'add' : 'update' }, diff }
}

/** Files by path, the last change to each winning. */
export const changedFiles = (items: readonly AgentItem[]): FileChange[] => {
  const byPath = new Map<string, FileChange>()
  for (const item of items) {
    if (item.type === 'fileChange') {
      for (const change of item.changes) byPath.set(change.path, change)
      continue
    }
    const edit = editOf(item)
    if (edit) byPath.set(edit.path, edit)
  }
  return [...byPath.values()]
}

/** A file's `+N −M`, counted as the file view draws it (#155). */
const diffStats = (change: FileChange): string => {
  const { added, removed } = countFileChange(change)
  return `+${added} −${removed}`
}

export const titleOf = (session: Session): string =>
  session.title?.trim() || session.preview?.trim() || 'an untitled conversation'

/**
 * The goal a previous hand-off carried into this conversation.
 *
 * A handed-off session's first typed words are usually "take it from here" —
 * the real ask lives in the packet the desk injected around them. Without
 * this, every further hop's `## Goal` is the instruction, and by the third
 * agent nobody is told what the work actually is.
 */
const carriedGoal = (session: Session): string | null => {
  for (const turn of session.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue
      for (const part of item.content) {
        if (part.type !== 'text') continue
        for (const block of splitContext(part.text).injections) {
          if (!block.label.startsWith('Handed off from ')) continue
          const goal = /## Goal\n([\s\S]*?)(?=\n## |$)/.exec(block.text)?.[1]?.trim()
          if (goal) return goal
        }
      }
      // Only the first user message can have started the conversation.
      return null
    }
  }
  return null
}

/** The one-line lineage a reader sees first, in the draft and in the packet. */
export const lineageLine = (source: HandoffSource): string =>
  `Handed off from ${source.agentName} — “${titleOf(source.session)}”`

export const buildHandoff = (source: HandoffSource, carry: Carry): string | null => {
  const { session } = source
  const exchanges: Exchange[] = []
  for (const turn of session.turns) {
    for (const item of turn.items) {
      const exchange = textOf(item)
      if (exchange) exchanges.push(exchange)
    }
  }
  const files = changedFiles(session.turns.flatMap((turn) => turn.items))
  // The same plan the sidebar's Tasks panel is showing, from the same
  // function: what the next agent is told is still open is what the person
  // handing over was looking at.
  const todos = applyPlanEdits(sessionPlan(session) ?? [], source.planEdits ?? [])
  if (exchanges.length === 0 && files.length === 0) return null

  const sections: string[] = []
  const firstAsk = exchanges.find((exchange) => exchange.role === 'user')
  const inherited = carriedGoal(session)
  // A chained hand-off inherits the original goal; the hop's own instruction
  // still shows in the conversation flow below. `goal` stays the exchange the
  // Goal section actually quotes, so the summary knows what not to repeat.
  const goal = inherited ? null : (firstAsk ?? null)
  if (inherited) sections.push(`## Goal\n${clip(inherited, ASK_LIMIT)}`)
  else if (goal) sections.push(`## Goal\n${clip(goal.text, ASK_LIMIT)}`)

  if (carry === 'transcript') {
    const lines = exchanges.map(
      (exchange) => `**${exchange.role === 'user' ? 'User' : source.agentName}:** ${exchange.text}`,
    )
    // Whole exchanges from the end, up to the budget — always at least the
    // last one, clipped if it alone is over.
    let kept = 0
    let weight = 0
    while (kept < lines.length) {
      const line = lines[lines.length - 1 - kept]
      if (line === undefined || weight + line.length > TRANSCRIPT_LIMIT) break
      weight += line.length
      kept += 1
    }
    if (kept === 0) kept = 1
    const tail = lines.slice(lines.length - kept).map((line) => clip(line, TRANSCRIPT_LIMIT))
    const dropped = lines.length - kept
    const elided =
      dropped > 0
        ? `*The first ${dropped} exchange${dropped === 1 ? '' : 's'} did not fit; open the original conversation if they matter.*\n\n`
        : ''
    sections.push(`## Conversation\n${elided}${tail.join('\n\n')}`)
  } else if (carry === 'summary') {
    const recent = exchanges.slice(-RECENT).filter((exchange) => exchange !== goal || exchanges.length <= RECENT)
    if (recent.length > 0) {
      // A summary that quietly drops the middle reads as the whole story. The
      // count is the reader's cue to ask for the transcript when it matters.
      const dropped = exchanges.length - recent.length - (goal && !recent.includes(goal) ? 1 : 0)
      const elided =
        dropped > 0
          ? `*${dropped} earlier exchange${dropped === 1 ? '' : 's'} are not included; ask for the full transcript if they matter.*\n\n`
          : ''
      sections.push(
        `## Where it stands\n${elided}${recent
          .map((exchange) =>
            exchange.role === 'user'
              ? `Asked: ${clip(exchange.text, ASK_LIMIT)}`
              : `${source.agentName} answered: ${clip(exchange.text, ANSWER_LIMIT)}`,
          )
          .join('\n\n')}`,
      )
    }
  }

  if (files.length > 0) {
    const relative = (path: string): string =>
      path.startsWith(`${session.cwd}/`) ? path.slice(session.cwd.length + 1) : path
    const listed = files.slice(0, FILES_LIMIT)
    const rest = files.length - listed.length
    sections.push(
      `## Files changed\n${listed
        .map((change) => `- \`${relative(change.path)}\` — ${change.kind.type} (${diffStats(change)})`)
        .join('\n')}${rest > 0 ? `\n- …and ${rest} more; \`git status\` in the working folder has the full list.` : ''}`,
    )
  } else if (carry === 'files') {
    // The reader picked "files changed only" — a packet that never mentions
    // files reads as an omission, where a sentence reads as an answer.
    sections.push('## Files changed\nNo files were changed in this conversation.')
  }

  if (carry !== 'files' && todos && todos.some((todo) => !todo.done)) {
    sections.push(
      `## Open plan\n${todos.map((todo) => `- [${todo.done ? 'x' : ' '}] ${todo.label}`).join('\n')}`,
    )
  }

  const truth: string[] = [`Working folder: \`${session.cwd}\``]
  if (session.git?.branch) {
    truth.push(
      `Branch \`${session.git.branch}\`${session.git.sha ? ` at \`${session.git.sha.slice(0, 10)}\`` : ''} when handed off — run \`git diff\` there for the actual changes rather than trusting this summary.`,
    )
  } else {
    // Only Codex reports a branch; every ACP agent reports none. The reader
    // still has to be told that the folder, not this text, is the truth.
    truth.push(
      'Run `git status` and `git diff` there for the actual changes rather than trusting this summary.',
    )
  }
  sections.push(`## Ground truth\n${truth.join('\n')}`)

  return wrapContext(lineageLine(source), sections.join('\n\n'))
}
