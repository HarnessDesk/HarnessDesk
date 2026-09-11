import {
  runtimeId,
  sessionId,
  turnId,
  type ConfigOption,
  type PlanStep,
  type RuntimeId,
  type Session,
  type SessionGoal,
  type SessionSettings,
  type SessionStatus,
  type SessionSummary,
  type SessionUsage,
  type TokenUsage,
  type Turn,
  type TurnStatus,
  openingOf,
  splitContext,
} from '@harnessdesk/protocol'
import type { CodexProtocol } from '@harnessdesk/codex'

import { mapTurnError } from './errors.js'
import { mapItem } from './items.js'

/** Thread and turn translation. */

export const CODEX_RUNTIME_ID = runtimeId('codex')

type CodexThread = CodexProtocol.v2.Thread
type CodexTurn = CodexProtocol.v2.Turn
type CodexThreadStatus = CodexProtocol.v2.ThreadStatus

export const mapStatus = (status: CodexThreadStatus): SessionStatus => {
  switch (status.type) {
    case 'notLoaded':
      return { type: 'notLoaded' }
    case 'idle':
      return { type: 'idle' }
    case 'active':
      return { type: 'active' }
    case 'systemError':
      return { type: 'error' }
  }
}

const mapTurnStatus = (status: CodexProtocol.v2.TurnStatus): TurnStatus => status

/**
 * Codex records timestamps in seconds; the rest of HarnessDesk uses
 * milliseconds, matching `Date.now()`.
 */
const toMillis = (seconds: number): number => seconds * 1000

export const mapTurn = (turn: CodexTurn): Turn => ({
  id: turnId(turn.id),
  items: turn.items.map(mapItem),
  status: mapTurnStatus(turn.status),
  /* Classified, not just quoted. `mapTurnError` sits next door and knows
     what Codex's own taxonomy means; building the error by hand here threw
     that away, so every consumer above — the queue's pause reason, the room's
     notice when a member stops — could only ever see "something went wrong".
     A workspace spend cap read exactly like a network blip. */
  error: turn.error ? mapTurnError(turn.error) : null,
  // Codex stamps turns in seconds; everything above the adapter is milliseconds.
  startedAt: turn.startedAt === null ? null : toMillis(turn.startedAt),
  completedAt: turn.completedAt === null ? null : toMillis(turn.completedAt),
  durationMs: turn.durationMs,
})

export const mapPlanSteps = (steps: readonly CodexProtocol.v2.TurnPlanStep[]): PlanStep[] =>
  steps.map((step) => ({ step: step.step, status: step.status }))

const gitInfo = (thread: CodexThread) =>
  thread.gitInfo
    ? {
        sha: thread.gitInfo.sha ?? undefined,
        branch: thread.gitInfo.branch ?? undefined,
        originUrl: thread.gitInfo.originUrl ?? undefined,
      }
    : null


/**
 * Codex's stored preview is the raw first message, which includes the
 * `<context source=…>` preamble this adapter prepends (see `contextPreamble`).
 * That context is plumbing, not what the person said, so labels strip it.
 */
export const stripContext = (text: string): string =>
  // The protocol's own reader: a pattern of this file's stopped at the first quote, so a label with an escaped one stayed in (#186).
  // Trimmed, as that pattern's result was (review of #231).
  splitContext(text).text.trim()

/**
 * A thread's name from the message that opened it, for a thread Codex will
 * not name itself.
 *
 * Only the person's words: the `<context source=…>` blocks HarnessDesk
 * prepends — a chip, a hand-off packet, a plugin's preamble — were written
 * for the model, and a list that shows them is showing plumbing. Nothing is
 * invented beyond the first line, cut on a word where it has to be cut,
 * because a name Codex did not choose should not pretend to be a summary.
 */
export const nameFromMessage = (text: string, limit = 60): string | null => {
  const stripped = stripContext(text)
  const line = stripped.split('\n').find((entry) => entry.trim() !== '')?.trim()
  if (!line) return null
  if (line.length <= limit) return line
  const cut = line.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  const body = space > limit / 2 ? cut.slice(0, space) : cut
  return `${body.replace(/[\s,;:.!?—-]+$/, '')}…`
}

export const mapSummary = (
  thread: CodexThread,
  runtime: RuntimeId = CODEX_RUNTIME_ID,
  /** A block label this adapter wrote itself, which a conversation isn't called by (`automaticContext`). */
  skip?: (label: string) => boolean,
): SessionSummary => ({
  id: sessionId(thread.id),
  runtime,
  title: thread.name === null ? null : stripContext(thread.name) || null,
  // Cut where every other producer cuts, so a name's length doesn't depend on which of them made it (#188, review of #231).
  preview: openingOf(thread.preview, skip ? { skip } : {}).slice(0, 120) || null,
  cwd: thread.cwd,
  status: mapStatus(thread.status),
  createdAt: toMillis(thread.createdAt),
  updatedAt: toMillis(thread.updatedAt),
  git: gitInfo(thread),
})

export const mapSession = (
  thread: CodexThread,
  extras: {
    /** Which Codex account this thread was read through; see `CodexRuntimeOptions.id`. */
    readonly runtime?: RuntimeId
    readonly settings?: SessionSettings
    readonly options?: readonly ConfigOption[]
    readonly usage?: SessionUsage | null
    /**
     * Codex returns `turns: []` on most responses, which is indistinguishable
     * from a genuinely empty thread. The caller knows which it asked for.
     */
    readonly itemsLoaded: boolean
  },
): Session => ({
  ...mapSummary(thread, extras.runtime ?? CODEX_RUNTIME_ID),
  turns: thread.turns.map(mapTurn),
  itemsLoaded: extras.itemsLoaded,
  forkedFrom: thread.forkedFromId ? sessionId(thread.forkedFromId) : null,
  ...(extras.settings ? { settings: extras.settings } : {}),
  ...(extras.options ? { options: extras.options } : {}),
  usage: extras.usage ?? null,
})

export const mapGoal = (goal: CodexProtocol.v2.ThreadGoal | null): SessionGoal | null =>
  goal
    ? {
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
      }
    : null

/**
 * Codex reports the last response's tokens and the model's window; what is
 * in context is the last response minus its reasoning, because Codex drops
 * reasoning from the context it sends next. This is Codex's own
 * `tokens_in_context_window`, reproduced here so the renderer never has to
 * know it.
 */
export const mapUsage = (usage: CodexProtocol.v2.ThreadTokenUsage): SessionUsage => ({
  total: mapTokens(usage.total),
  last: mapTokens(usage.last),
  contextUsed: Math.max(0, usage.last.totalTokens - usage.last.reasoningOutputTokens),
  contextWindow: usage.modelContextWindow,
})

/**
 * Codex's breakdown in the protocol's shape.
 *
 * Passed through field by field rather than adopted whole, for one field:
 * Codex calls the miss half `cacheWriteInputTokens` and this protocol calls
 * it `cacheWriteTokens`, so a structural hand-over carried the count into the
 * app under a name nothing read. Codex has reported cache writes since the
 * breakdown existed; the turn tail has been dividing hits by input and
 * calling the result cache health the whole time.
 */
const mapTokens = (tokens: CodexProtocol.v2.TokenUsageBreakdown): TokenUsage => ({
  totalTokens: tokens.totalTokens,
  inputTokens: tokens.inputTokens,
  cachedInputTokens: tokens.cachedInputTokens,
  cacheWriteTokens: tokens.cacheWriteInputTokens,
  outputTokens: tokens.outputTokens,
  reasoningOutputTokens: tokens.reasoningOutputTokens,
})
