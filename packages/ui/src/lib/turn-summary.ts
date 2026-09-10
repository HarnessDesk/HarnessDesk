import type { AgentItem, ForgeReference, Turn } from '@harnessdesk/protocol'

import { SHELL_TOOLS, shellCommandOf } from './group-items'
import { changedFiles } from './handoff'

/**
 * What a finished turn amounts to, for the developer who did not watch it.
 *
 * A transcript says how the agent got there; this says where it got. Every
 * figure is read off the items — files from edits, commands and their exit
 * codes, tool calls that failed — never from the prose, which is free to be
 * wrong about what happened. Absent facts are absent, not guessed.
 */

export interface TurnSummary {
  /** Paths edited, relative to the folder when under it. */
  readonly files: readonly string[]
  readonly commands: number
  /** Commands and tool calls that ended badly, by what ran. */
  readonly failures: readonly string[]
  /** Test runs, judged by the command line: null when none ran. */
  readonly tests: { readonly ran: number; readonly failed: number } | null
  readonly approvalsAsked: number
  /** The turn ended by asking the user something. */
  readonly question: boolean
  /** What the turn put on the forge, in order: pull requests opened or updated, reviews and comments posted. */
  readonly published: readonly ForgeReference[]
}

export const TEST_COMMAND =
  /\b(vitest|jest|mocha|pytest|py\.test|unittest|go test|cargo test|swift test|xcodebuild .*\btest\b|xcrun xctest|gradle\w* .*\btest\b|mvn .*\btest\b|dotnet test|npm (?:run )?test|pnpm (?:run )?test|yarn test|bun test|rspec|phpunit|ctest|make test)\b/i

/** Did this tool call run a shell command, by either reading? */
const isShellCall = (item: Extract<AgentItem, { type: 'toolCall' }>): boolean =>
  shellCommandOf(item) !== null || SHELL_TOOLS.test(item.tool)

interface Run {
  readonly command: string
  readonly failed: boolean
}

/** Shell runs, whichever way the agent reported them. */
const runsOf = (items: readonly AgentItem[]): Run[] => {
  const out: Run[] = []
  for (const item of items) {
    if (item.type === 'command') {
      if (item.status === 'inProgress') continue
      out.push({
        command: item.command,
        failed: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
      })
      continue
    }
    if (item.type === 'toolCall' && isShellCall(item)) {
      if (item.status === 'inProgress') continue
      out.push({
        command: shellCommandOf(item) ?? item.tool,
        failed: item.status === 'failed' || Boolean(item.error),
      })
    }
  }
  return out
}

const shortCommand = (command: string): string => {
  const line = command.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/**
 * What one turn handed to sub-agents, read off that turn's own rows.
 *
 * Deliberately not `SessionUsage.delegated`, which is cumulative and shares
 * its scope with `SessionUsage.total`. Pairing the session figure with a
 * turn's own tokens said a turn had delegated work an earlier turn did, and
 * over a long conversation reported a turn delegating more than it spent.
 *
 * Null when the turn delegated nothing, or delegated to a runtime that does
 * not attribute spend — a sub-agent shown as having cost nothing is a claim,
 * and usually a false one. `exact` is false when any child's output count was
 * still a streaming floor; see `TokenUsage.outputExact`.
 */
export const delegatedIn = (turn: Turn): { readonly tokens: number; readonly exact: boolean } | null => {
  let tokens = 0
  let exact = true
  for (const item of turn.items) {
    if (item.type !== 'subagent' || !item.usage) continue
    tokens += item.usage.totalTokens
    if (item.usage.outputExact === false) exact = false
  }
  return tokens > 0 ? { tokens, exact } : null
}

export const summariseTurn = (turn: Turn, cwd: string): TurnSummary | null => {
  if (turn.status === 'inProgress') return null
  const items = turn.items
  const relative = (path: string): string => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
  const files = changedFiles(items).map((change) => relative(change.path))

  const runs = runsOf(items)
  const failures = runs.filter((run) => run.failed).map((run) => shortCommand(run.command))
  for (const item of items) {
    /* A shell call is already in `runs` under its command line. What is left
       is a real tool, named by its title — but only the first word of it, or a
       failed `Read src/very/long/path.ts` fills the column. A title that is
       itself a command line reaches here only when the arguments were empty,
       and `shortCommand` is the right cut for that too. */
    if (item.type === 'toolCall' && !isShellCall(item) && (item.status === 'failed' || item.error)) {
      failures.push(shortCommand(item.tool))
    }
    if (item.type === 'error') failures.push(item.message.length > 60 ? `${item.message.slice(0, 59)}…` : item.message)
  }

  const testRuns = runs.filter((run) => TEST_COMMAND.test(run.command))
  const tests = testRuns.length > 0 ? { ran: testRuns.length, failed: testRuns.filter((run) => run.failed).length } : null

  const approvalsAsked = items.filter(
    (item) => (item.type === 'command' || item.type === 'toolCall') && 'approval' in item && Boolean((item as { approval?: unknown }).approval),
  ).length

  const lastProse = [...items].reverse().find((item) => item.type === 'assistantMessage' && item.phase !== 'commentary')
  const question = lastProse?.type === 'assistantMessage' && /\?\s*$/.test(lastProse.text.trim())

  const published = items.flatMap((item) => (item.type === 'publication' ? [item.reference] : []))

  if (files.length === 0 && runs.length === 0 && failures.length === 0 && !question && published.length === 0) return null
  return { files, commands: runs.length, failures, tests, approvalsAsked, question, published }
}
