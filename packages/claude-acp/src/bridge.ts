/*
 * Builds on `@zed-industries/claude-code-acp` and `@agentclientprotocol/sdk`
 * (Apache 2.0, Copyright Zed Industries, Inc. and contributors).
 * `HarnessDeskClaudeAgent` extends their `ClaudeAcpAgent`; changes are stated
 * in THIRD_PARTY_NOTICES.md. Licence: licenses/Apache-2.0.txt.
 */
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'

import { AgentSideConnection, RequestError, ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  Usage,
} from '@agentclientprotocol/sdk'
import { ClaudeAcpAgent, nodeToWebReadable, nodeToWebWritable } from '@zed-industries/claude-code-acp'
import { createMcpServer } from '@zed-industries/claude-code-acp/dist/mcp-server.js'
import { SettingsManager } from '@zed-industries/claude-code-acp/dist/settings.js'
import { acpToolNames, createPostToolUseHook, createPreToolUseHook } from '@zed-industries/claude-code-acp/dist/tools.js'
import { Pushable } from '@zed-industries/claude-code-acp/dist/utils.js'
import { query, type CanUseTool, type PermissionMode, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'

import { answerFor, answeredInput, permissionRequestFor, questionCallId, questionsOf, questionTitled } from './ask-user.js'

import { DelegationRegistry } from './delegation.js'
import {
  DELEGATION_CAPABILITY,
  DELEGATION_LIST,
  DELEGATION_NOTIFICATION,
  type BridgeDelegation,
} from './delegation-wire.js'
import { TaskRegistry, type BridgeTask } from './tasks.js'
import {
  SESSION_DELETE,
  SESSION_DELETE_CAPABILITY,
  TASKS_CAPABILITY,
  TASKS_CLEAR,
  TASKS_LIST,
  TASKS_NOTIFICATION,
  TASKS_STOP,
} from './tasks-wire.js'
import { sessionFiles, trash } from './store.js'

/**
 * `claude-acp` — Claude Code over ACP, with the controls the agent declares.
 *
 * `@zed-industries/claude-code-acp` speaks ACP for Claude Code and is kept as
 * is; this class sits on top of it and forwards what it drops — the session
 * controls Claude Code has and ACP has nowhere to put:
 *
 * - **Reasoning effort.** Claude Code reports, per model, which levels it
 *   supports (`supportedEffortLevels` on the SDK's `ModelInfo` — low,
 *   medium, high, xhigh, max today; none on Haiku), and the bridge's model
 *   list keeps only id, name and description. The levels become a
 *   `thought_level` config option, and ride each model in `_meta` so a
 *   client's catalogue can show them per model rather than per session.
 * - **Auto-compact.** Where Claude Code compacts a conversation that fills
 *   its window: automatic, or a size between 100k and 1M tokens.
 *
 * Setting one uses Claude Code's own mechanisms, never its settings file:
 *
 * - A session created with a value is spawned with the flag (the bridge
 *   merges `_meta.claudeCode.options` into the SDK call; `--autocompact`
 *   travels as `extraArgs`, which is the SDK's own passthrough).
 * - Changing it on a session with history re-spawns the process with
 *   `--resume` and the new flags; Claude continues the conversation. No turn
 *   is spent, nothing appears in the transcript.
 * - Changing it on a session with no history yet cannot resume (nothing is
 *   persisted until the first turn), so it is applied at the first prompt
 *   through Claude's own command — `/effort high`, `/autocompact 500k` —
 *   which shows once as a line of the agent's in that turn and costs
 *   nothing.
 * - `default` means "no flag": Claude Code applies its own settings.
 *
 * What was chosen is remembered per session in `CLAUDE_ACP_STATE_DIR`
 * (`~/.harnessdesk/claude-acp`), so a session loaded after the bridge was
 * restarted comes back where it was left, not silently at the default.
 */

const EFFORT_OPTION_ID = 'effort'
const AUTOCOMPACT_OPTION_ID = 'autocompact'
const OUTPUT_STYLE_OPTION_ID = 'output_style'
const DEFAULT = 'default'

/** Display names for the levels Claude has shipped; anything else is shown by its id. */
const LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/**
 * Where Claude Code compacts. The CLI takes `auto` or a size between 100k
 * and 1M (`--autocompact <auto|tokens>`), so these are its own values, and
 * the sizes offered are the round ones inside that range.
 */
const AUTOCOMPACT_CHOICES: readonly { readonly value: string; readonly name: string; readonly description?: string }[] = [
  { value: DEFAULT, name: 'Default', description: "Claude Code's own setting for this project." },
  { value: 'auto', name: 'Automatic', description: 'Claude Code decides when to compact.' },
  { value: '100k', name: '100k' },
  { value: '200k', name: '200k' },
  { value: '500k', name: '500k' },
  { value: '1m', name: '1M' },
]

interface SdkModel {
  readonly value: string
  readonly supportedEffortLevels?: readonly string[]
}

interface SessionState {
  /** The levels the agent declared for the session's model. */
  levels: readonly string[]
  /** The output styles the agent declared for this project, `default` included. */
  styles: readonly string[]
  /** What each control shows — its value, or `default`. */
  values: Record<string, string>
  /** What the running process was spawned with, per control. */
  spawned: Record<string, string>
  /** True once a prompt has run: the conversation exists, so `--resume` can carry it. */
  prompted: boolean
  /** Copied from `session/new` so a re-spawn asks for the same things. */
  readonly cwd: string
  readonly mcpServers: NewSessionRequest['mcpServers']
  readonly meta: Record<string, unknown> | null | undefined
  readonly modelId: string | null
  abort: AbortController
}

/** Marks a query this bridge is already pumping; see `#observe`. */
const PUMPED = Symbol('harnessdesk.pumped')

type Sessions = Record<
  string,
  {
    query: {
      initializationResult(): Promise<{
        models: readonly SdkModel[]
        output_style?: string
        available_output_styles?: readonly string[]
      }>
      next(...args: unknown[]): Promise<IteratorResult<SdkMessage, unknown>>
      return?: () => Promise<unknown>
      /** Ends one background task. Present from SDK 0.2.x; absent is survivable. */
      stopTask?: (taskId: string) => Promise<void>
    }
    input: { end(): void }
  }
>

/**
 * Where Claude Code keeps its transcripts, and how it spells a cwd as a
 * folder there. The base bridge has both and exports neither, so they are
 * reproduced — a copy of two lines, against a deep import of its internals.
 */
const CLAUDE_CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
const encodeProjectPath = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * How much of a transcript's end is read looking for its name. Claude Code
 * appends the title entries throughout a session, so the current pair is at
 * the tail; transcripts here reach 138MB, and the base bridge already reads
 * every one of them whole to find the first line.
 */
const TITLE_WINDOW = 512 * 1024

/**
 * How much of a finished background task's output rides on its row. The tail
 * of a long log is the half that says how it went; a panel is not a viewer
 * for the rest, and the file is still on disk for anything that is.
 */
const TASK_OUTPUT_CAP = 64 * 1024

/**
 * How long the bridge keeps trying to read a finished task's output before
 * it stops asking. The notification can name a file a moment before the
 * file is there to read — a one-shot read then leaves the card saying
 * nothing was kept, for output that lands a beat later. Each miss waits
 * twice as long as the last; six misses is about sixteen seconds, after
 * which the file is not coming.
 */
const TASK_OUTPUT_RETRIES: readonly number[] = readRetrySchedule(process.env['CLAUDE_ACP_TASK_OUTPUT_RETRIES_MS'])

/**
 * The retry clock, as milliseconds separated by commas, when a test wants a
 * shorter one than the sixteen seconds the default adds up to. A malformed
 * value is the default; an empty list is not a clock.
 */
function readRetrySchedule(raw: string | undefined): readonly number[] {
  const fallback = [250, 500, 1_000, 2_000, 4_000, 8_000]
  if (!raw) return fallback
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
  return parsed.length > 0 ? parsed : fallback
}

/**
 * The tail of a file, or null when there is no file to read yet. A tail cut
 * mid-line starts at the next whole one.
 */
const readTail = async (file: string): Promise<{ text: string; truncated: boolean } | null> => {
  try {
    const size = (await stat(file)).size
    const start = Math.max(0, size - TASK_OUTPUT_CAP)
    const truncated = start > 0
    const handle = await openFile(file, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8')
      return { text: truncated ? text.slice(text.indexOf('\n') + 1) : text, truncated }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * `CLAUDE_ACP_TRACE_TASKS=<file>` appends one line per message that bears on
 * the background-task registry — the system messages and every `tool_use`
 * block — in the order the SDK yielded them. The order is the whole question
 * when a task is announced as over before it was announced as started, and
 * nothing else on the machine records it: Claude Code's own transcript keeps
 * the blocks and not the system messages.
 */
const TASK_TRACE = process.env['CLAUDE_ACP_TRACE_TASKS']
const traceTaskMessage = (message: unknown): void => {
  if (!TASK_TRACE) return
  const record = message as { type?: string; subtype?: string; message?: { content?: unknown } }
  const blocks = Array.isArray(record.message?.content)
    ? record.message.content.filter(
        (block: { type?: string }) => block?.type === 'tool_use' || block?.type === 'tool_result',
      )
    : []
  if (record.type !== 'system' && blocks.length === 0) return
  const line = record.type === 'system' ? message : { type: record.type, blocks }
  try {
    writeFileSync(TASK_TRACE, `${new Date().toISOString()} ${JSON.stringify(line)}\n`, { flag: 'a' })
  } catch {
    /* a trace that cannot be written is not worth a failed turn */
  }
}

/**
 * Wrappers a prompt arrives inside that are not what anyone said: a slash
 * command's caveat, the reminders the CLI injects, the note the desktop app
 * pins to a screenshot someone drew on, HarnessDesk's own context envelope.
 * They are plumbing, and a session named after one reads as
 * `<local-command-caveat>Caveat: …` in the list.
 */
const WRAPPER_TAGS = [
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'system-reminder',
  'preview-annotation-context',
  'context',
] as const

/** A title with its plumbing removed, or nothing when that is all it was. */
export const unwrap = (title: string | null | undefined): string | null => {
  let text = title ?? ''
  for (const tag of WRAPPER_TAGS) {
    // The closed form and the truncated one alike: a title cut mid-block by
    // the base bridge's 128-character limit is all envelope and no name.
    text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`, 'g'), ' ')
  }
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Wrappers that are folded beside the sentence rather than dropped, and so
 * have to reach the adapter that folds them: HarnessDesk's own `context`
 * envelope, which the client renders as the "Context added" row it is, and
 * the desktop app's note about an annotated screenshot, which is the only
 * thing in the transcript saying what the picture beside it is. Both are real
 * context the model was given; stripping either here would lose it, and the
 * fold cannot show what never arrived.
 */
const FOLDED_TAGS: readonly string[] = ['context', 'preview-annotation-context']

/**
 * The plumbing tags, for a transcript being read back.
 *
 * `WRAPPER_TAGS` minus the folded ones, for the reason above.
 * `task-notification` is on this list and not that one: it never names a
 * session, but it is replayed into the middle of one.
 */
const PLUMBING_TAGS = [
  ...WRAPPER_TAGS.filter((tag) => !FOLDED_TAGS.includes(tag)),
  'task-notification',
] as const

/** Claude Code's own markers for a turn the person stopped. */
const INTERRUPTIONS = ['[Request interrupted by user', '[Request interrupted for tool use']

/**
 * The scaling note Claude Code pins beside every image it downsizes. Only
 * dropped from injected entries: the note describes a picture that reaches
 * the transcript on its tool call, so the text carries nothing of its own.
 */
const IMAGE_NOTES = /\[Image:[^\]]*\]/g

/**
 * Terminal styling Claude Code writes into the output of its own commands.
 * Anchored on the escape, because `[1m` is also how Claude Code spells a
 * million-token window: `opus[1m]` is a model name, not bold text.
 */
const ANSI = /\u001b\[[0-9;]*m/g

/** How much of a command's output one dim row can carry. */
const NOTICE_LIMIT = 300

const tagContents = (text: string, tag: string): string | null =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null

const oneLine = (text: string): string => {
  const clean = text.replace(ANSI, '').replace(/\s+/g, ' ').trim()
  return clean.length > NOTICE_LIMIT ? `${clean.slice(0, NOTICE_LIMIT - 1)}…` : clean
}

/**
 * What a replayed user message actually is: the person speaking, with any
 * plumbing around it removed; the runtime's own housekeeping, worth one dim
 * line; or boilerplate with nothing in it to read.
 */
export type Replayed =
  | { readonly kind: 'prompt'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string; readonly echo?: true }
  | null

/**
 * Sorts a replayed user message into speech, housekeeping, or nothing.
 *
 * Claude Code records more than typing as `user`: the echo of every slash
 * command — its caveat, its name, its output, written whenever the model or
 * the effort changes, HarnessDesk's own changes included — each background
 * task reporting back, the reminders it injects, and the marker for a turn
 * the person stopped. A live turn drops all of it (`ClaudeAcpAgent.prompt`
 * skips these user messages by hand); the replay a `session/load` runs does
 * not, so reopening a conversation shows plumbing as things the person said.
 *
 * `stored` carries what the transcript knew about the entry and the replay
 * dropped: `meta` for content Claude Code wrote for itself — a loaded
 * skill's template, an image note — with no tag around it to strip, and
 * `compact` for the summary that seeds a continued conversation. What would
 * have read as speech becomes one dim line saying what it actually was; the
 * shapes above keep their notices.
 */
export type StoredKind = 'meta' | 'compact'

export const classifyReplayed = (raw: string, stored?: StoredKind): Replayed => {
  const text = raw.trim()
  if (text.length === 0) return null
  if (INTERRUPTIONS.some((marker) => text.startsWith(marker))) return { kind: 'notice', text: 'Interrupted' }
  if (text.startsWith('<task-notification>')) {
    const summary = oneLine(tagContents(text, 'summary') ?? '')
    return { kind: 'notice', text: summary.length > 0 ? summary : 'A background task reported back' }
  }
  // A command's own output is the line of its echo worth keeping: it says
  // what the command did, where `<command-name>` only says that one ran.
  // `echo: true` marks it as safe to collapse: every open re-applies the
  // remembered settings and stores a fresh echo, so identical copies say
  // one thing — unlike an interruption, which is an event each time.
  for (const tag of ['local-command-stdout', 'local-command-stderr'] as const) {
    if (!text.includes(`<${tag}>`)) continue
    const said = oneLine(tagContents(text, tag) ?? '')
    return said.length > 0 ? { kind: 'notice', text: said, echo: true } : null
  }
  let stripped = text
  for (const tag of PLUMBING_TAGS) {
    stripped = stripped.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`, 'g'), ' ')
  }
  const spoken = stripped.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (spoken.length === 0) return null
  if (stored === undefined) return { kind: 'prompt', text: spoken }
  if (stored === 'compact') return { kind: 'notice', text: 'Continued from a previous conversation' }
  const worth = spoken.replace(IMAGE_NOTES, ' ').replace(/[ \t]+/g, ' ').trim()
  return worth.length > 0 ? { kind: 'notice', text: `Claude Code added: ${oneLine(worth)}` } : null
}

/**
 * Every text Claude Code wrote into a transcript as `user` without the person
 * typing it: a loaded skill's template, the scaling note beside each
 * downsized image, the caveat over command echoes (`isMeta`), and the summary
 * a continued conversation opens on (`isCompactSummary`). The flags exist
 * only in the stored file — the base replay reads the file and drops them —
 * so the texts themselves are what the sieve matches on.
 */
const injectedTexts = async (path: string, sessionId: string): Promise<ReadonlyMap<string, StoredKind>> => {
  const texts = new Map<string, StoredKind>()
  try {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of reader) {
        // The key check skips the parse for the overwhelming share of lines
        // that cannot match; the parsed values below are the actual test, so
        // a runtime that starts writing spaced JSON changes nothing here.
        if (!line.includes('"isMeta"') && !line.includes('"isCompactSummary"')) continue
        let entry: {
          type?: string
          isMeta?: boolean
          isCompactSummary?: boolean
          isSidechain?: boolean
          sessionId?: string
          message?: { role?: string; content?: unknown }
        }
        try {
          entry = JSON.parse(line) as typeof entry
        } catch {
          continue
        }
        if (entry.type !== 'user' || entry.isSidechain === true) continue
        if (entry.isMeta !== true && entry.isCompactSummary !== true) continue
        if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue
        const kind: StoredKind = entry.isCompactSummary === true ? 'compact' : 'meta'
        const content = entry.message?.content
        if (typeof content === 'string') {
          texts.set(content, kind)
          continue
        }
        if (!Array.isArray(content)) continue
        for (const block of content as ReadonlyArray<{ type?: string; text?: unknown }>) {
          if (block?.type === 'text' && typeof block.text === 'string') texts.set(block.text, kind)
        }
      }
    } finally {
      reader.close()
    }
  } catch {
    // A file that cannot be read replays unattributed rather than not at all.
  }
  return texts
}

/**
 * The name Claude Code kept for a session, read from the end of its
 * transcript: the last `custom-title`, else the last `ai-title`.
 *
 * Backwards, because the last entry of each kind is the current one — and
 * the given name wins over the model's running one even when the model
 * wrote its own later.
 */
export const storedTitle = (path: string): string | null => {
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(handle).size
    const length = Math.min(size, TITLE_WINDOW)
    const buffer = Buffer.alloc(length)
    readSync(handle, buffer, 0, length, size - length)
    let ai: string | null = null
    const lines = buffer.toString('utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line === undefined || !line.includes('-title"')) continue
      let entry: { type?: string; customTitle?: string; aiTitle?: string }
      try {
        // The first line of the window is usually half a line; it fails here.
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (entry.type === 'custom-title') {
        const named = unwrap(entry.customTitle)
        if (named) return named
      }
      if (entry.type === 'ai-title' && ai === null) ai = unwrap(entry.aiTitle)
    }
    return ai
  } catch {
    return null
  } finally {
    closeSync(handle)
  }
}

/** Where a session's transcript lives, the way the base bridge spells it. */
export const transcriptPath = (cwd: string, sessionId: string): string =>
  join(CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`)

/** The SDK messages this layer reads; everything else passes through untouched. */
type SdkMessage =
  | {
      readonly type: 'assistant'
      readonly parent_tool_use_id: string | null
      readonly message: { readonly model?: string; readonly usage?: SdkApiUsage | null }
    }
  | {
      readonly type: 'result'
      readonly total_cost_usd?: number
      readonly usage?: SdkApiUsage | null
      readonly modelUsage?: Readonly<Record<string, SdkModelUsage>>
    }
  | { readonly type: string }

interface SdkApiUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
}

/** A result's per-model counts — cumulative over the process, not the turn. */
interface SdkModelUsage {
  readonly contextWindow?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
}

/**
 * What a session has said about tokens so far.
 *
 * Claude Code counts per API call, on each `assistant` message; a turn is
 * several calls when tools are used. What is in context is the *latest*
 * top-level call's input — every message, tool result and system prompt is
 * re-sent on each call, so its input is the context. Sub-agent calls
 * (`parent_tool_use_id` set) run in a context of their own and are left out
 * of the fill, though they are still the session's spend.
 */
interface UsageState {
  /** Tokens the latest top-level call put in context. */
  contextUsed: number | null
  /** The model of that call, to find its window in `modelUsage`. */
  model: string | null
  /** The window, once a `result` has named it. */
  contextWindow: number | null
  /** `total_cost_usd` from the latest result. */
  cost: number | null
  /** The calls of the turn in flight, summed. */
  turn: Usage | null
  /**
   * The process's cumulative per-model counts at the last result, so a
   * turn can be read as their growth. Null until a result — and reset when
   * a session gets a fresh process, whose counts start from zero again.
   */
  modelTotals: Readonly<Record<string, SdkModelUsage>> | null
  /** Announcements in flight, so a prompt's reply never overtakes its own fill update. */
  pending: Promise<void>
}

/** The parts of the base class this layer reaches into; private in its typings, plain on the instance. */
interface BaseInternals {
  createSession(
    params: NewSessionRequest,
    creationOpts?: { resume?: string; forkSession?: boolean },
  ): Promise<NewSessionResponse>
  replaySessionHistory(sessionId: string, filePath: string): Promise<void>
}

/**
 * What a notice rides to the client on: `_meta` on the chunk, which ACP
 * reserves for exactly this. A client that ignores it still reads a sentence
 * rather than a wall of tags; HarnessDesk's ACP adapter looks for this key
 * and makes the row it deserves.
 */
const NOTICE_META = { harnessdesk: { notice: true } } as const

/**
 * One tool-call content block, in a shape ACP's schema will accept.
 *
 * The base bridge's Read path passes a result's non-text blocks through
 * untouched — Anthropic-shaped images (`source`/`media_type`), documents from
 * a PDF, whatever a future CLI stores — and the client validates each
 * notification whole, so a single such block voids the entire update: the
 * row spins forever and the result never arrives. Only what provably fits
 * survives as itself. Text stays, a base64 image is reshaped, a URL image
 * becomes its address, and anything else becomes a named placeholder — the
 * same posture the base takes for every other tool, where its converter
 * stringifies what it does not know.
 */
const safeBlock = (block: unknown): unknown => {
  const shaped = block as {
    type?: unknown
    text?: unknown
    data?: unknown
    mimeType?: unknown
    source?: { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown }
  } | null
  if (shaped === null || typeof shaped !== 'object') return { type: 'text', text: '[unreadable content]' }
  if (shaped.type === 'text' && typeof shaped.text === 'string') return block
  if (shaped.type === 'image') {
    if (typeof shaped.data === 'string' && typeof shaped.mimeType === 'string') return block
    const source = shaped.source
    if (source?.type === 'base64' && typeof source.data === 'string') {
      return {
        type: 'image',
        data: source.data,
        mimeType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
      }
    }
    if (typeof source?.url === 'string') return { type: 'text', text: `[image: ${source.url}]` }
    return { type: 'text', text: '[image]' }
  }
  return { type: 'text', text: `[${typeof shaped.type === 'string' ? shaped.type : 'unknown'} content]` }
}

/**
 * A tool-call notification whose content is guaranteed to validate. Same
 * update back — by reference — when nothing needed fixing, so untouched
 * notifications cost nothing.
 */
export const acpSafeToolContent = (update: SessionNotification['update']): SessionNotification['update'] => {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update
  const entries = (update as { content?: readonly unknown[] }).content
  if (!Array.isArray(entries)) return update
  let changed = false
  const safe = entries.map((entry) => {
    const wrapper = entry as { type?: unknown; content?: unknown }
    if (wrapper === null || typeof wrapper !== 'object' || wrapper.type !== 'content') return entry
    const block = safeBlock(wrapper.content)
    if (block === wrapper.content) return entry
    changed = true
    return { ...wrapper, content: block }
  })
  return changed ? ({ ...update, content: safe } as SessionNotification['update']) : update
}

/**
 * The client, with every notification made presentable on its way through.
 *
 * Two jobs share the one seam every notification passes. Tool-call content
 * is made schema-safe (`acpSafeToolContent`) on live turns and replays both
 * — the replay reads the transcript through the same Read path that leaks
 * raw blocks live. And during a `session/load`, replayed `user_message_chunk`s
 * are sifted: the base bridge replays every stored `user` entry — slash-command
 * echoes, background-task reports, injected reminders and all — where a live
 * turn drops the same messages by hand.
 */
const sifted = (
  client: AgentSideConnection,
  replaying: ReadonlySet<string>,
  injected: (sessionId: string) => ReadonlyMap<string, StoredKind> | undefined,
  noticed: (sessionId: string) => Set<string> | undefined,
): AgentSideConnection =>
  new Proxy(client, {
    get(target, property) {
      if (property === 'sessionUpdate') {
        return async (params: SessionNotification): Promise<void> => {
          const update = questionTitled(acpSafeToolContent(params.update))
          const sent = update === params.update ? params : { ...params, update }
          if (
            !replaying.has(params.sessionId) ||
            update.sessionUpdate !== 'user_message_chunk' ||
            update.content.type !== 'text'
          ) {
            return client.sessionUpdate(sent)
          }
          const said = classifyReplayed(update.content.text, injected(params.sessionId)?.get(update.content.text))
          if (!said) return
          if (said.kind === 'notice' && said.echo) {
            const seen = noticed(params.sessionId)
            if (seen?.has(said.text)) return
            seen?.add(said.text)
          }
          return client.sessionUpdate({
            ...sent,
            update: {
              ...update,
              content: { ...update.content, text: said.text },
              ...(said.kind === 'notice' ? { _meta: { ...(update._meta ?? {}), ...NOTICE_META } } : {}),
            },
          })
        }
      }
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

export interface HarnessDeskClaudeAgentOptions {
  /** Where per-session effort is remembered. */
  readonly stateDir?: string
  /** Diagnostics; never the protocol stream. */
  readonly log?: (line: string) => void
}

/**
 * The base bridge's model list, ported with `#createSession`: the settings'
 * model wins when it names one the CLI serves, and the pick is applied to
 * the query before the list goes out.
 */
const availableModels = async (
  q: { setModel: (model: string) => Promise<void> },
  models: readonly { value: string; displayName: string; description: string }[],
  settingsManager: { getSettings: () => { model?: string } },
): Promise<NewSessionResponse['models']> => {
  const settings = settingsManager.getSettings()
  let current = models[0]
  if (settings.model !== undefined) {
    const wanted = settings.model
    const match = models.find(
      (m) =>
        m.value === wanted ||
        m.value.includes(wanted) ||
        wanted.includes(m.value) ||
        m.displayName.toLowerCase() === wanted.toLowerCase() ||
        m.displayName.toLowerCase().includes(wanted.toLowerCase()),
    )
    if (match) current = match
  }
  if (current === undefined) return { availableModels: [], currentModelId: '' } as unknown as NewSessionResponse['models']
  await q.setModel(current.value)
  return {
    availableModels: models.map((model) => ({ modelId: model.value, name: model.displayName, description: model.description })),
    currentModelId: current.value,
  } as NewSessionResponse['models']
}

export class HarnessDeskClaudeAgent extends ClaudeAcpAgent {
  readonly #efforts = new Map<string, SessionState>()
  readonly #usage = new Map<string, UsageState>()
  /** Claude Code's background tasks, per session. See `TaskRegistry`. */
  readonly #tasks = new Map<string, TaskRegistry>()
  /**
   * Per finished task whose output file was not there yet, by `session\0task`:
   * how many times it was missed, and when it is next worth a look. Each
   * task keeps its own clock — a task on its fourth miss is not tried again
   * because a newer task is on its first.
   */
  readonly #outputMisses = new Map<string, { misses: number; due: number }>()
  /** One pending re-read per session, so misses do not stack timers. */
  readonly #outputRetries = new Map<string, ReturnType<typeof setTimeout>>()

  /** What each session delegated, per session. See `DelegationRegistry`. */
  readonly #delegations = new Map<string, DelegationRegistry>()
  /** Sessions whose stored history is being replayed right now. */
  readonly #replaying = new Set<string>()
  /** Per replaying session, the texts its transcript marked as its own. */
  readonly #injected = new Map<string, ReadonlyMap<string, StoredKind>>()
  /** Per replaying session, the notice texts already replayed this load. */
  readonly #noticed = new Map<string, Set<string>>()
  readonly #indexPath: string
  readonly #log: (line: string) => void

  constructor(client: AgentSideConnection, options: HarnessDeskClaudeAgentOptions = {}) {
    super(client)
    // Everything the base class emits goes through the sieve; only a session
    // in `#replaying` is actually filtered, so live turns are untouched.
    this.client = sifted(
      client,
      this.#replaying,
      (id) => this.#injected.get(id),
      (id) => this.#noticed.get(id),
    )
    const stateDir = options.stateDir ?? process.env['CLAUDE_ACP_STATE_DIR'] ?? join(homedir(), '.harnessdesk', 'claude-acp')
    this.#indexPath = join(stateDir, 'efforts.json')
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
    // The base replays `isMeta` entries — texts Claude Code stored as `user`
    // without the person typing them — the same as typing; the flag lives
    // only in the file it is about to read, so it is read here first. The
    // method is private in the base's typings and plain on the instance; a
    // base that renamed it degrades to unattributed replay, not to a bridge
    // that cannot construct.
    const internals = this as unknown as Partial<BaseInternals>
    // The base's session creation disallows `AskUserQuestion` outright, in a
    // local constant nothing outside the method can reach — so the method is
    // replaced on the instance with a port of it that leaves the tool in.
    // See `#createSession` for what the port changes, and `canUseTool` for
    // what answers the question.
    internals.createSession = (params, creationOpts) => this.#createSession(params, creationOpts)
    const replay = typeof internals.replaySessionHistory === 'function' ? internals.replaySessionHistory.bind(this) : null
    if (replay) {
      internals.replaySessionHistory = async (sessionId: string, filePath: string): Promise<void> => {
        this.#injected.set(sessionId, await injectedTexts(filePath, sessionId))
        await replay(sessionId, filePath)
      }
    } else {
      this.#log('claude-acp: base replaySessionHistory not found; stored entries will replay unattributed')
    }
  }

  /**
   * Claude Code's `AskUserQuestion`, answered by the person at the desk.
   *
   * Every other tool goes to the base's callback, which turns a permission
   * into `session/request_permission`. A question is not a permission — its
   * options are the answers — but ACP's request is the one flat option list
   * a client already renders, so each question goes out as one request whose
   * options are its choices, the whole question riding beside them. The
   * chosen label goes back the way the SDK reads answers: `updatedInput`
   * with an `answers` map keyed by the question text.
   *
   * A dismissed question is a deny without an interrupt: Claude is told the
   * person did not answer and carries on, rather than the turn ending.
   */
  override canUseTool(sessionId: string): CanUseTool {
    const base = super.canUseTool(sessionId)
    return async (toolName, toolInput, context) => {
      if (toolName !== 'AskUserQuestion') return base(toolName, toolInput, context)
      const asked = questionsOf(toolInput)
      if (asked.length === 0) {
        return { behavior: 'deny', message: 'The question carried no options to choose from.' }
      }
      const answers = new Map<string, string>()
      for (const [index, question] of asked.entries()) {
        if (question.options.length === 0) {
          return {
            behavior: 'deny',
            message: `"${question.question}" has no options; HarnessDesk answers a question from its options.`,
          }
        }
        // One id per question, not one per tool call. A call may carry up to
        // four questions and they are asked one after another; sharing the
        // call's id would anchor every card to the same transcript row, so
        // the second question would replace the first on screen.
        const response = await this.client.requestPermission(
          permissionRequestFor(sessionId, questionCallId(context.toolUseID, index, asked.length), question) as never,
        )
        if (context.signal.aborted) throw new Error('Tool use aborted')
        const label = answerFor(question, response.outcome as { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' })
        // Dismissed: the tool is denied without an interrupt, so Claude is
        // told the person did not answer and carries on. Answers already
        // given go with it — a partly-answered set is not an answer, and the
        // model asked for all of them.
        if (label === null) {
          return { behavior: 'deny', message: 'The user did not answer the question.' }
        }
        answers.set(question.question, label)
      }
      return { behavior: 'allow', updatedInput: answeredInput(toolInput, answers) }
    }
  }

  /**
   * A port of the base bridge's `createSession` (@zed-industries/claude-code-acp
   * 0.16.2, `acp-agent.js`), identical but for one line: `AskUserQuestion` is
   * no longer disallowed, so the tool exists for Claude to call and
   * `canUseTool` above can answer it. Everything the base does — the settings
   * manager, the `acp` MCP server for the client's own file and terminal
   * capabilities, the hooks that follow plan mode, the model list — is kept
   * as it is, because this layer's promise is to forward what the base drops,
   * never to change what it keeps.
   */
  async #createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
    const base = this as unknown as {
      sessions: Record<string, unknown>
      clientCapabilities?: { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean }
      logger: { error: (...args: unknown[]) => void; log?: (...args: unknown[]) => void }
    }
    // A new id unless resuming — and a fork is a new id over a resume.
    const sessionId = creationOpts.forkSession
      ? randomUUID()
      : creationOpts.resume !== undefined
        ? creationOpts.resume
        : randomUUID()
    const input = new Pushable<SDKUserMessage>()
    const settingsManager = new SettingsManager(params.cwd, { logger: base.logger as never })
    await settingsManager.initialize()
    const mcpServers: Record<string, unknown> = {}
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ('type' in server) {
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers ? Object.fromEntries(server.headers.map((e) => [e.name, e.value])) : undefined,
          }
        } else {
          mcpServers[server.name] = {
            type: 'stdio',
            command: server.command,
            args: server.args,
            env: server.env ? Object.fromEntries(server.env.map((e) => [e.name, e.value])) : undefined,
          }
        }
      }
    }
    const meta = (params._meta ?? {}) as {
      disableBuiltInTools?: unknown
      systemPrompt?: unknown
      claudeCode?: { options?: Record<string, unknown> }
    }
    // Only add the acp MCP server if built-in tools are not disabled.
    if (!meta.disableBuiltInTools) {
      const server = createMcpServer(this, sessionId, base.clientCapabilities as never)
      mcpServers['acp'] = { type: 'sdk', name: 'acp', instance: server }
    }
    let systemPrompt: { type: 'preset'; preset: 'claude_code'; append?: string } | string = {
      type: 'preset',
      preset: 'claude_code',
    }
    if (meta.systemPrompt) {
      const customPrompt = meta.systemPrompt
      if (typeof customPrompt === 'string') {
        systemPrompt = customPrompt
      } else if (
        typeof customPrompt === 'object' &&
        customPrompt !== null &&
        'append' in customPrompt &&
        typeof (customPrompt as { append?: unknown }).append === 'string'
      ) {
        systemPrompt.append = (customPrompt as { append: string }).append
      }
    }
    const permissionMode: PermissionMode = 'default'
    const userProvidedOptions = (meta.claudeCode?.options ?? {}) as Record<string, unknown> & {
      mcpServers?: Record<string, unknown>
      hooks?: { PreToolUse?: unknown[]; PostToolUse?: unknown[] }
      abortController?: AbortController
      disallowedTools?: string[]
    }
    const maxThinkingTokens = process.env['MAX_THINKING_TOKENS']
      ? parseInt(process.env['MAX_THINKING_TOKENS'], 10)
      : undefined
    // Bypass Permissions does not work for a root/sudo user.
    const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0
    const allowBypass = !isRoot || !!process.env['IS_SANDBOX']
    const options: Record<string, unknown> = {
      systemPrompt,
      settingSources: ['user', 'project', 'local'],
      stderr: (err: unknown) => base.logger.error(err),
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
      ...userProvidedOptions,
      // Override certain fields that must be controlled by ACP.
      cwd: params.cwd,
      includePartialMessages: true,
      mcpServers: { ...(userProvidedOptions.mcpServers ?? {}), ...mcpServers },
      allowDangerouslySkipPermissions: allowBypass,
      permissionMode,
      canUseTool: this.canUseTool(sessionId),
      executable: process.execPath,
      ...(process.env['CLAUDE_CODE_EXECUTABLE'] && {
        pathToClaudeCodeExecutable: process.env['CLAUDE_CODE_EXECUTABLE'],
      }),
      tools: { type: 'preset', preset: 'claude_code' },
      hooks: {
        ...userProvidedOptions.hooks,
        PreToolUse: [
          ...(userProvidedOptions.hooks?.PreToolUse ?? []),
          { hooks: [createPreToolUseHook(settingsManager, base.logger as never)] },
        ],
        PostToolUse: [
          ...(userProvidedOptions.hooks?.PostToolUse ?? []),
          {
            hooks: [
              createPostToolUseHook(base.logger as never, {
                onEnterPlanMode: async () => {
                  const session = base.sessions[sessionId] as { permissionMode?: PermissionMode } | undefined
                  if (session) session.permissionMode = 'plan'
                  await this.client.sessionUpdate({
                    sessionId,
                    update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
                  })
                },
              }),
            ],
          },
        ],
      },
      ...creationOpts,
    }
    if (creationOpts.resume === undefined || creationOpts.forkSession) {
      // Set our own session id if not resuming an existing session.
      options['sessionId'] = sessionId
    }
    const allowedTools: string[] = []
    // The base starts this list with "AskUserQuestion"; this port does not.
    const disallowedTools: string[] = []
    const disableBuiltInTools = meta.disableBuiltInTools === true
    if (!disableBuiltInTools) {
      if (base.clientCapabilities?.fs?.readTextFile) {
        allowedTools.push(acpToolNames.read)
        disallowedTools.push('Read')
      }
      if (base.clientCapabilities?.fs?.writeTextFile) {
        disallowedTools.push('Write', 'Edit')
      }
      if (base.clientCapabilities?.terminal) {
        allowedTools.push(acpToolNames.bashOutput, acpToolNames.killShell)
        disallowedTools.push('Bash', 'BashOutput', 'KillShell')
      }
    } else {
      // When built-in tools are disabled, explicitly disallow all of them.
      disallowedTools.push(
        acpToolNames.read, acpToolNames.write, acpToolNames.edit, acpToolNames.bash, acpToolNames.bashOutput, acpToolNames.killShell,
        'Read', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'Task', 'TodoWrite', 'ExitPlanMode',
        'WebSearch', 'WebFetch', 'AskUserQuestion', 'SlashCommand', 'Skill', 'NotebookEdit',
      )
    }
    if (allowedTools.length > 0) options['allowedTools'] = allowedTools
    if (disallowedTools.length > 0) {
      options['disallowedTools'] = [...((options['disallowedTools'] as string[] | undefined) ?? []), ...disallowedTools]
    }
    const abortController = userProvidedOptions.abortController
    if (abortController?.signal.aborted) throw new Error('Cancelled')
    const q = query({ prompt: input, options: options as never })
    base.sessions[sessionId] = { query: q, input, cancelled: false, permissionMode, settingsManager }
    const initializationResult = await q.initializationResult()
    const models = await availableModels(q, initializationResult.models, settingsManager)
    const availableModes = [
      { id: 'default', name: 'Default', description: 'Standard behavior, prompts for dangerous operations' },
      { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edit operations' },
      { id: 'plan', name: 'Plan Mode', description: 'Planning mode, no actual tool execution' },
      { id: 'dontAsk', name: "Don't Ask", description: 'Don\'t prompt for permissions, deny if not pre-approved' },
    ]
    if (allowBypass) {
      availableModes.push({ id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Bypass all permission checks' })
    }
    return {
      sessionId,
      models,
      modes: { currentModeId: permissionMode, availableModes },
    } as NewSessionResponse
  }

  override async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    const response = await super.initialize(request)
    return {
      ...response,
      agentInfo: { name: '@harnessdesk/claude-acp', title: 'Claude Code', version: VERSION },
      // Declared here rather than discovered by a failed call: a client that
      // knows the extension asks for the list when a pane opens, and one that
      // does not never learns the methods exist.
      _meta: {
        ...(response._meta ?? {}),
        harnessdesk: {
          [TASKS_CAPABILITY]: true,
          [SESSION_DELETE_CAPABILITY]: true,
          [DELEGATION_CAPABILITY]: true,
        },
      },
    }
  }

  /**
   * The extension methods this bridge serves — the background-task panel's
   * three verbs. Anything else is refused the way the SDK would have refused
   * it, so an unknown extension is still a method-not-found and not a hang.
   */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
    switch (method) {
      case TASKS_LIST:
        // A pane that just opened is a good moment to fetch any output the
        // last pass could not; the list answers now and the text follows.
        this.#fetchTaskOutputs(sessionId, { eager: true })
        return { tasks: this.#tasks.get(sessionId)?.list() ?? [] }
      case DELEGATION_LIST:
        return { delegations: this.#delegations.get(sessionId)?.list() ?? [] }
      case TASKS_STOP: {
        const taskId = typeof params['taskId'] === 'string' ? params['taskId'] : ''
        return { stopped: await this.#stopTask(sessionId, taskId) }
      }
      case TASKS_CLEAR: {
        if (this.#tasks.get(sessionId)?.clearFinished()) this.#publishTasks(sessionId)
        return {}
      }
      case SESSION_DELETE: {
        if (sessionId === '') throw RequestError.invalidParams('A session id is required.')
        // Whatever this bridge was holding about the session goes with it:
        // the effort state outlives the transcript otherwise, and would be
        // applied to the next session that happened to reuse the id.
        this.#efforts.delete(sessionId)
        this.#tasks.delete(sessionId)
        this.#forgetOutputRetries(sessionId)
        this.#delegations.delete(sessionId)
        this.#remember(sessionId, {})
        const removed = trash(sessionFiles(sessionId))
        return { removed, disposition: 'trash' }
      }
      default:
        throw RequestError.methodNotFound(method)
    }
  }

  override async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // A client may say what the session should start at; HarnessDesk does,
    // so the first turn already runs at the chosen effort.
    const wanted = optionsIn(params._meta)
    const abort = new AbortController()
    const response = await super.newSession({ ...params, _meta: withOptions(params._meta, wanted, abort) })
    const state: SessionState = {
      levels: [],
      styles: [],
      values: { ...wanted },
      spawned: { ...wanted },
      prompted: false,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      meta: params._meta,
      modelId: response.models?.currentModelId ?? null,
      abort,
    }
    this.#efforts.set(response.sessionId, state)
    this.#observe(response.sessionId)
    const init = await this.#initOf(response.sessionId)
    const declared = init.models
    state.levels = levelsOf(declared, state.modelId)
    state.styles = init.styles
    // A level this model cannot run is not silently downgraded; it falls
    // back to whatever Claude Code would have done on its own. A style this
    // project does not declare, the same.
    if (!state.levels.includes(valueOf(state, EFFORT_OPTION_ID))) state.values[EFFORT_OPTION_ID] = DEFAULT
    if (
      valueOf(state, OUTPUT_STYLE_OPTION_ID) !== DEFAULT &&
      !state.styles.includes(valueOf(state, OUTPUT_STYLE_OPTION_ID))
    ) {
      state.values[OUTPUT_STYLE_OPTION_ID] = DEFAULT
    }
    this.#remember(response.sessionId, state.values)
    return {
      ...response,
      ...withEffortLevels(response.models, declared),
      configOptions: this.#optionsOf(state),
    }
  }

  override async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // A session coming back after a bridge restart resumes where it was
    // left — the one thing a restart would otherwise lose.
    const remembered = this.#recall(params.sessionId)
    const abort = new AbortController()
    // The whole history is replayed before this resolves; everything the
    // sieve sees for this session until then is stored, not live.
    this.#replaying.add(params.sessionId)
    this.#noticed.set(params.sessionId, new Set())
    let response: LoadSessionResponse
    try {
      response = await super.loadSession({ ...params, _meta: withOptions(params._meta, remembered, abort) })
    } catch (error) {
      // Claude Code writes a conversation down when it is first prompted, so
      // one that was opened and never spoken to has no file to load — and the
      // SDK's answer for that is a bare "Internal error". Say what happened
      // instead, but only when the file really is missing: any other failure
      // is the SDK's to describe.
      if (!existsSync(transcriptPath(params.cwd, params.sessionId))) {
        throw RequestError.invalidParams(
          'nothing was ever sent in it, so Claude Code never wrote it down.',
        )
      }
      throw error
    } finally {
      this.#replaying.delete(params.sessionId)
      this.#injected.delete(params.sessionId)
      this.#noticed.delete(params.sessionId)
    }
    const state: SessionState = {
      levels: [],
      styles: [],
      values: { ...remembered },
      spawned: { ...remembered },
      prompted: true,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      meta: params._meta,
      modelId: response.models?.currentModelId ?? null,
      abort,
    }
    this.#efforts.set(params.sessionId, state)
    this.#observe(params.sessionId)
    const init = await this.#initOf(params.sessionId)
    const declared = init.models
    state.levels = levelsOf(declared, state.modelId)
    state.styles = init.styles
    return {
      ...response,
      ...withEffortLevels(response.models, declared),
      configOptions: this.#optionsOf(state),
    }
  }

  /**
   * The stored sessions, named the way Claude Code names them.
   *
   * The base bridge titles a stored session with its first user message,
   * whatever that message was — a slash command's caveat wrapper, a pasted
   * reminder, "hi". Claude Code has already written a better name into the
   * same file: `ai-title` is the model's, rewritten as the conversation
   * grows, and `custom-title` is the name the session was given. Neither
   * costs a token to read, and both beat anything this bridge could derive
   * from a first line.
   *
   * The first message stays as the last resort, with its wrappers stripped,
   * because a session too short to have been named still has to be called
   * something.
   */
  override async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const response = await super.unstable_listSessions(params)
    return {
      ...response,
      sessions: response.sessions.map((session) => ({
        ...session,
        title: storedTitle(transcriptPath(session.cwd, session.sessionId)) ?? unwrap(session.title),
      })),
    }
  }

  override async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse | void> {
    const result = await super.unstable_setSessionModel(params)
    // The levels are the model's; a model without any has no control, and a
    // level the new model lacks falls back to the default rather than to a
    // silent downgrade nobody can see.
    const state = this.#efforts.get(params.sessionId)
    if (state) {
      state.levels = await this.#levelsFor(params.sessionId, params.modelId)
      if (!state.levels.includes(valueOf(state, EFFORT_OPTION_ID))) state.values[EFFORT_OPTION_ID] = DEFAULT
      // The model announcement precedes the option one: a client folding
      // these into a single view must never see new options against the old
      // model. Both go before the reply, so the reply finds them applied.
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_model_update', currentModelId: params.modelId },
      })
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: this.#optionsOf(state) },
      })
    }
    return result
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const state = this.#efforts.get(params.sessionId)
    if (!state) throw RequestError.invalidParams(`Session not found: ${params.sessionId}`)
    const value = String(params.value)
    if (params.configId === EFFORT_OPTION_ID) {
      if (value !== DEFAULT && !state.levels.includes(value)) {
        throw RequestError.invalidParams(`${JSON.stringify(value)} is not an effort level this model supports.`)
      }
    } else if (params.configId === AUTOCOMPACT_OPTION_ID) {
      if (!AUTOCOMPACT_CHOICES.some((choice) => choice.value === value)) {
        throw RequestError.invalidParams(`${JSON.stringify(value)} is not an auto-compact window Claude Code takes.`)
      }
    } else if (params.configId === OUTPUT_STYLE_OPTION_ID) {
      if (value !== DEFAULT && !state.styles.includes(value)) {
        throw RequestError.invalidParams(`${JSON.stringify(value)} is not an output style this project declares.`)
      }
    } else {
      throw RequestError.invalidParams(`Claude Code has no session option named ${JSON.stringify(params.configId)}.`)
    }
    if (value === valueOf(state, params.configId)) return { configOptions: this.#optionsOf(state) }
    state.values[params.configId] = value
    this.#remember(params.sessionId, state.values)
    if (state.prompted) {
      await this.#respawn(params.sessionId, state)
    } else {
      // Nothing to resume yet; `prompt` applies it through Claude's own
      // command first.
      this.#log(`claude-acp: ${params.configId}=${value} queued for ${params.sessionId} until its first prompt`)
    }
    return { configOptions: this.#optionsOf(state) }
  }

  override async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.#efforts.get(params.sessionId)
    if (state && !state.prompted) {
      // The agent's own commands, run as the first thing in this turn. Each
      // answers with a line; those lines are the only trace, and they cost
      // nothing — no model call is made for a command.
      for (const command of commandsFor(state.values, state.spawned)) {
        await super.prompt({ sessionId: params.sessionId, prompt: [{ type: 'text', text: command }] })
      }
      state.spawned = { ...state.values }
    }
    if (state) state.prompted = true
    const usage = this.#usage.get(params.sessionId)
    if (usage) usage.turn = null
    const response = await super.prompt(params)
    // An output style chosen before the first message could not ride a
    // command the way effort does (`/output-style` is refused under
    // stream-json), and an empty session cannot be `--resume`d. Now that the
    // turn exists the respawn can carry it, so every later reply is styled.
    if (
      state &&
      (state.values[OUTPUT_STYLE_OPTION_ID] ?? DEFAULT) !== (state.spawned[OUTPUT_STYLE_OPTION_ID] ?? DEFAULT)
    ) {
      await this.#respawn(params.sessionId, state)
    }
    // The fill update goes out before the reply that ends the turn, so the
    // client has both when it closes the turn. The turn's own tokens ride the
    // reply, as ACP's unstable `usage` field.
    await usage?.pending
    return usage?.turn ? { ...response, usage: usage.turn } : response
  }

  // ------------------------------------------------------------------ internals

  /** Stops the session's process and starts another on the same conversation, at the chosen effort. */
  async #respawn(sessionId: string, state: SessionState): Promise<void> {
    const previous = (this.sessions as unknown as Sessions)[sessionId]
    const previousAbort = state.abort
    state.abort = new AbortController()
    this.#log(`claude-acp: re-spawning ${sessionId} with ${describeValues(state.values)}`)
    await (this as unknown as BaseInternals).createSession(
      { cwd: state.cwd, mcpServers: state.mcpServers, _meta: withOptions(state.meta, state.values, state.abort) },
      { resume: sessionId },
    )
    this.#observe(sessionId)
    // The replaced process: its input ends, which is how Claude Code is told
    // a stream-json session is over, and the abort is the belt to that brace.
    try {
      previous?.input.end()
      void previous?.query.return?.()
    } catch {
      // Already gone.
    }
    previousAbort.abort()
    state.spawned = { ...state.values }
  }

  /**
   * Tees the session's SDK stream. The base class drains `query.next()` in
   * `prompt`; wrapping it on the instance is the one seam that sees every
   * message without re-implementing the loop. A re-spawned session gets a
   * new query and is wrapped again.
   */
  #observe(sessionId: string): void {
    const session = (this.sessions as unknown as Sessions)[sessionId]
    if (!session) return
    const query = session.query as { next: Sessions[string]['query']['next']; [PUMPED]?: true }
    // A query is pumped once. Wrapping a wrapper would run two loops over one
    // generator: every message observed twice, and half of them delivered to
    // the wrong reader.
    if (query[PUMPED]) return
    query[PUMPED] = true
    const next = query.next.bind(query)
    // Pulled here rather than in `prompt`, and pulled *continuously*.
    //
    // The base class only drains the stream while a turn is in flight, which
    // is fine for a transcript and wrong for a background task: the whole
    // point of one is that it finishes while nobody is looking, and its
    // "done" message would sit unread until the next thing the user typed.
    // So this loop owns the generator, buffers every result, and hands them
    // to `prompt` in the order they arrived — the base loop cannot tell the
    // difference, and a task that ends during a coffee break is announced
    // when it ends.
    const buffered: IteratorResult<SdkMessage, unknown>[] = []
    const waiting: {
      resolve: (result: IteratorResult<SdkMessage, unknown>) => void
      reject: (error: unknown) => void
    }[] = []
    let failure: unknown = null
    let ended: IteratorResult<SdkMessage, unknown> | null = null
    const pump = async (): Promise<void> => {
      for (;;) {
        const result = await next()
        if (!result.done && result.value) this.#onMessage(sessionId, result.value)
        const waiter = waiting.shift()
        if (waiter) waiter.resolve(result)
        else buffered.push(result)
        if (result.done) {
          // Remembered, because a generator answers `done` every time it is
          // asked and this one is now only asked through the buffer. Without
          // it a `prompt` after the stream ended would wait for a message
          // that can never come.
          ended = result
          return
        }
      }
    }
    void pump().catch((error: unknown) => {
      // The stream ended badly — a killed process, a protocol error. Whoever
      // is waiting hears it, and whoever asks next hears it too, because a
      // `prompt` that hung here would be worse than one that throws.
      failure = error
      for (const waiter of waiting.splice(0)) waiter.reject(error)
    })
    query.next = async () => {
      const ready = buffered.shift()
      if (ready) return ready
      if (failure !== null) throw failure
      if (ended) return ended
      return new Promise<IteratorResult<SdkMessage, unknown>>((resolve, reject) => {
        waiting.push({ resolve, reject })
      })
    }
    if (!this.#tasks.has(sessionId)) this.#tasks.set(sessionId, new TaskRegistry())
    if (!this.#delegations.has(sessionId)) this.#delegations.set(sessionId, new DelegationRegistry())
    const kept = this.#usage.get(sessionId)
    if (kept) {
      // The rest of the state outlives a respawn on purpose, but the delta
      // baseline is per process: a fresh CLI counts from zero again.
      kept.modelTotals = null
    } else {
      this.#usage.set(sessionId, {
        contextUsed: null,
        model: null,
        contextWindow: null,
        cost: null,
        turn: null,
        modelTotals: null,
        pending: Promise.resolve(),
      })
    }
  }

  #onMessage(sessionId: string, message: SdkMessage): void {
    if (TASK_TRACE) traceTaskMessage(message)
    if (this.#tasks.get(sessionId)?.observe(message)) {
      this.#publishTasks(sessionId)
      this.#fetchTaskOutputs(sessionId)
    }
    if (this.#delegations.get(sessionId)?.observe(message)) this.#publishDelegations(sessionId)
    const state = this.#usage.get(sessionId)
    if (!state) return
    if (message.type === 'assistant' && 'message' in message) {
      const usage = message.message.usage
      if (!usage) return
      // A streamed assistant message carries `message_start` usage: the
      // inputs are real, but `output_tokens` is a placeholder counted when
      // the stream opened — 1, usually. Summing the calls is therefore only
      // a mid-turn estimate; the result's counts replace it below.
      const call = callUsage(usage)
      state.turn = state.turn ? addUsage(state.turn, call) : call
      if (message.parent_tool_use_id === null) {
        state.contextUsed = call.inputTokens
        state.model = message.message.model ?? state.model
        this.#announce(sessionId, state)
      }
      return
    }
    if (message.type === 'result' && 'modelUsage' in message) {
      if (typeof message.total_cost_usd === 'number') state.cost = message.total_cost_usd
      const windows = message.modelUsage ?? {}
      const own = state.model ? windows[state.model]?.contextWindow : undefined
      // The model named on the call, else the widest the result knows — a
      // sub-agent on a smaller model must not shrink the main window.
      const widest = Object.values(windows).reduce<number | null>(
        (best, entry) => (entry.contextWindow && (best === null || entry.contextWindow > best) ? entry.contextWindow : best),
        null,
      )
      state.contextWindow = own ?? widest ?? state.contextWindow
      // The turn's real tokens. `modelUsage` is cumulative over the process
      // with true output counts — helper models and sub-agents included —
      // so the turn is its growth since the last result. `result.usage` is
      // the per-turn fallback for a CLI whose modelUsage carries no counts.
      const turn = turnFromTotals(windows, state.modelTotals) ?? (message.usage ? callUsage(message.usage) : null)
      state.modelTotals = { ...windows }
      if (turn && turn.totalTokens > 0) state.turn = turn
      this.#announce(sessionId, state)
    }
  }

  /**
   * Tells the client the whole list. Fire-and-forget: a client that does not
   * know the extension ignores an unknown notification, which is exactly what
   * ACP says it should do, and there is nothing here worth failing a turn for.
   */
  #publishTasks(sessionId: string): void {
    const tasks: readonly BridgeTask[] = this.#tasks.get(sessionId)?.list() ?? []
    void this.client
      .extNotification(TASKS_NOTIFICATION, { sessionId, tasks })
      .catch((error: unknown) => {
        this.#log(
          `claude-acp: could not send background tasks: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  /**
   * `#readTaskOutputs`, fire-and-forget, with its failure logged rather than
   * dropped. `readTail` answers null for every read failure, so the only
   * thing left to throw is a publish — synchronous today, and a `void` would
   * swallow it silently the day it is not.
   */
  #fetchTaskOutputs(sessionId: string, options: { eager?: boolean } = {}): void {
    void this.#readTaskOutputs(sessionId, options).catch((error: unknown) => {
      this.#log(`claude-acp: could not read task output: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Fetches what a finished task printed.
   *
   * Claude Code's `task_notification` names an output file and never sends
   * the text, so the panel that shows a task would otherwise show a label
   * and a state and nothing of what the work said. The file is read when the
   * task ends and the list is published again with the text on the row.
   * Capped at the tail: a watcher that ran for an hour has written more than
   * any panel should carry, and the end is the half that says how it went.
   *
   * A file that is not there yet is tried again on a doubling clock rather
   * than given up on: the notification and the last write race, and a
   * one-shot read that lost the race left the card saying nothing was kept.
   * Each task keeps its own clock; a pass skips a task whose next look is
   * not due, unless it is `eager` — a pane just opened, and one `stat` is
   * cheap. When the clock runs out the task is marked `outputMissing`, so
   * the card can say "never found" rather than leave "not yet" standing
   * forever. Asynchronous, so a dozen tasks ending together do not hold the
   * stream while their tails are read.
   */
  async #readTaskOutputs(sessionId: string, { eager = false }: { eager?: boolean } = {}): Promise<void> {
    const registry = this.#tasks.get(sessionId)
    if (!registry) return
    const now = Date.now()
    let missed = false
    for (const { id, outputFile } of registry.awaitingOutput()) {
      const key = `${sessionId}\0${id}`
      const clock = this.#outputMisses.get(key)
      if (clock && !eager && clock.due > now) {
        missed = true
        continue
      }
      const read = await readTail(outputFile)
      // The registry may have gone while the file was being read.
      if (this.#tasks.get(sessionId) !== registry) return
      if (read === null) {
        const misses = (clock?.misses ?? 0) + 1
        const wait = TASK_OUTPUT_RETRIES[misses - 1]
        if (wait === undefined) {
          // Out of tries: say so on the task, once, and stop looking.
          this.#outputMisses.delete(key)
          if (registry.markOutputMissing(id)) this.#publishTasks(sessionId)
          continue
        }
        this.#outputMisses.set(key, { misses, due: Date.now() + wait })
        missed = true
        continue
      }
      this.#outputMisses.delete(key)
      if (registry.attachOutput(id, read.text, read.truncated)) this.#publishTasks(sessionId)
    }
    if (missed) this.#retryOutputsLater(sessionId)
  }

  /** Schedules one more pass for the session, when the earliest task is next due. */
  #retryOutputsLater(sessionId: string): void {
    if (this.#outputRetries.has(sessionId)) return
    const registry = this.#tasks.get(sessionId)
    if (!registry) return
    const dues = registry
      .awaitingOutput()
      .map(({ id }) => this.#outputMisses.get(`${sessionId}\0${id}`)?.due)
      .filter((due): due is number => typeof due === 'number')
    if (dues.length === 0) return
    const wait = Math.max(0, Math.min(...dues) - Date.now())
    const timer = setTimeout(() => {
      this.#outputRetries.delete(sessionId)
      this.#fetchTaskOutputs(sessionId)
    }, wait)
    timer.unref?.()
    this.#outputRetries.set(sessionId, timer)
  }

  #forgetOutputRetries(sessionId: string): void {
    const timer = this.#outputRetries.get(sessionId)
    if (timer) clearTimeout(timer)
    this.#outputRetries.delete(sessionId)
    for (const key of [...this.#outputMisses.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.#outputMisses.delete(key)
    }
  }

  /**
   * Tells the client what this session delegated, on the same terms as the
   * task list: the whole list, whenever it moves, unasked — and ignored by a
   * client that has never heard of the extension.
   */
  #publishDelegations(sessionId: string): void {
    const registry = this.#delegations.get(sessionId)
    const delegations: readonly BridgeDelegation[] = registry?.list() ?? []
    const delegated = registry?.totals() ?? null
    void this.client
      .extNotification(DELEGATION_NOTIFICATION, {
        sessionId,
        delegations,
        ...(delegated ? { delegated } : {}),
      })
      .catch((error: unknown) => {
        this.#log(
          `claude-acp: could not send delegations: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  /**
   * Ends one background task through Claude Code's own control channel. The
   * stream confirms it a moment later; marking it here is what makes the row
   * change under the finger that pressed the button.
   */
  async #stopTask(sessionId: string, taskId: string): Promise<boolean> {
    const query = (this.sessions as unknown as Sessions)[sessionId]?.query
    // Called on the query, never detached from it: `stopTask` is a method on
    // the SDK's own object and reading it off loses its `this`.
    if (!query?.stopTask || !taskId) return false
    // A task this bridge has watched end is not asked about again: Claude Code
    // answers an already-finished id with an error, and an error is a worse
    // way to say "someone else pressed it first" than simply saying no. An id
    // never seen still goes through — the registry can be behind, the agent
    // cannot.
    const known = this.#tasks.get(sessionId)?.list().find((task) => task.id === taskId)
    if (known && known.state !== 'running') return false
    try {
      await query.stopTask(taskId)
    } catch (error) {
      this.#log(`claude-acp: could not stop ${taskId}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    if (this.#tasks.get(sessionId)?.markStopped(taskId)) this.#publishTasks(sessionId)
    return true
  }

  /** `usage_update`, once both halves of the fraction are known. */
  #announce(sessionId: string, state: UsageState): void {
    if (state.contextUsed === null || state.contextWindow === null) return
    const update = {
      sessionUpdate: 'usage_update' as const,
      used: state.contextUsed,
      size: state.contextWindow,
      ...(state.cost !== null ? { cost: { amount: state.cost, currency: 'USD' } } : {}),
    }
    state.pending = state.pending
      .then(() => this.client.sessionUpdate({ sessionId, update }))
      .catch((error: unknown) => {
        this.#log(`claude-acp: could not send usage: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** What Claude Code says its models are, for this session's process. */
  async #modelsOf(sessionId: string): Promise<readonly SdkModel[]> {
    return (await this.#initOf(sessionId)).models
  }

  /** The one snapshot the SDK's control channel gives before any turn. */
  async #initOf(
    sessionId: string,
  ): Promise<{ models: readonly SdkModel[]; styles: readonly string[] }> {
    const session = (this.sessions as unknown as Sessions)[sessionId]
    if (!session) return { models: [], styles: [] }
    try {
      const init = await session.query.initializationResult()
      return { models: init.models, styles: init.available_output_styles ?? [] }
    } catch (error) {
      this.#log(`claude-acp: could not read models: ${error instanceof Error ? error.message : String(error)}`)
      return { models: [], styles: [] }
    }
  }

  async #levelsFor(sessionId: string, modelId: string | null): Promise<readonly string[]> {
    return levelsOf(await this.#modelsOf(sessionId), modelId)
  }

  /**
   * The session's controls: the effort levels this model declared, when it
   * declared any, and where Claude Code compacts — which every model has.
   */
  #optionsOf(state: SessionState): SessionConfigOption[] {
    const options: SessionConfigOption[] = []
    if (state.levels.length > 0) {
      options.push({
        id: EFFORT_OPTION_ID,
        name: 'Reasoning effort',
        description: 'How hard Claude thinks before answering.',
        category: 'thought_level',
        type: 'select',
        currentValue: valueOf(state, EFFORT_OPTION_ID),
        options: [
          { value: DEFAULT, name: 'Default', description: "Claude Code's own setting for this project." },
          ...state.levels.map((level) => ({ value: level, name: LABELS[level] ?? level })),
        ],
      })
    }
    options.push({
      id: AUTOCOMPACT_OPTION_ID,
      name: 'Auto-compact',
      description: 'Where a conversation that fills the window is summarised and continued.',
      type: 'select',
      currentValue: valueOf(state, AUTOCOMPACT_OPTION_ID),
      options: AUTOCOMPACT_CHOICES.map((choice) => ({ ...choice })),
    })
    const styles = state.styles.filter((style) => style !== DEFAULT)
    if (styles.length > 0) {
      options.push({
        id: OUTPUT_STYLE_OPTION_ID,
        name: 'Output style',
        description: "How Claude writes its replies — Claude Code's own output styles.",
        type: 'select',
        currentValue: valueOf(state, OUTPUT_STYLE_OPTION_ID),
        options: [
          { value: DEFAULT, name: 'Default', description: "Claude Code's own setting for this project." },
          ...styles.map((style) => ({ value: style, name: style })),
        ],
      })
    }
    return options
  }

  /**
   * What this session was left at. Older indexes stored the effort alone, as
   * a string; that shape is still read, so an upgrade does not reset the
   * sessions that were open before it.
   */
  #recall(sessionId: string): Record<string, string> {
    const stored = this.#index()[sessionId]
    if (typeof stored === 'string') return { [EFFORT_OPTION_ID]: stored }
    return { ...(stored ?? {}) }
  }

  #remember(sessionId: string, values: Record<string, string>): void {
    const index = this.#index()
    const set = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== DEFAULT))
    if (Object.keys(set).length === 0) delete index[sessionId]
    else index[sessionId] = set
    try {
      mkdirSync(dirname(this.#indexPath), { recursive: true })
      writeFileSync(this.#indexPath, JSON.stringify(index, null, 2))
    } catch (error) {
      this.#log(`claude-acp: could not write ${this.#indexPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #index(): Record<string, string | Record<string, string>> {
    try {
      const parsed = JSON.parse(readFileSync(this.#indexPath, 'utf8')) as unknown
      return typeof parsed === 'object' && parsed !== null
        ? { ...(parsed as Record<string, string | Record<string, string>>) }
        : {}
    } catch {
      return {}
    }
  }

  /** Serves ACP on stdio. */
  static serve(options: HarnessDeskClaudeAgentOptions = {}): void {
    const stream = ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin))
    new AgentSideConnection((client) => new HarnessDeskClaudeAgent(client, options), stream)
  }
}

/** The levels the agent declared for one of its models; none is a model without the control. */
export const levelsOf = (models: readonly SdkModel[], modelId: string | null): readonly string[] =>
  models.find((entry) => entry.value === modelId)?.supportedEffortLevels ?? []

/**
 * The session's model list with each model's own effort levels attached, in
 * ACP's `_meta`.
 *
 * ACP declares one effort control per session, for whatever model is current;
 * the catalogue a client shows is per model, and Claude Code's models differ
 * — Haiku has no levels at all. The levels ride with the model they belong
 * to, so nothing has to be inferred from the session's current one. An agent
 * that does not know this key is unaffected by it.
 */
export const withEffortLevels = (
  models: NewSessionResponse['models'],
  declared: readonly SdkModel[],
): { models?: NewSessionResponse['models'] } => {
  if (!models) return {}
  return {
    models: {
      ...models,
      availableModels: models.availableModels.map((model) => {
        // Always stated, empty included: "this model has no levels" is a
        // fact about Haiku, and a client that saw nothing here would fall
        // back to the session's control and show levels Haiku cannot run.
        const levels = levelsOf(declared, model.modelId)
        return {
          ...model,
          _meta: {
            ...(model._meta ?? {}),
            harnessdesk: {
              ...((model._meta?.['harnessdesk'] as Record<string, unknown> | undefined) ?? {}),
              effortLevels: levels.map((level) => ({ id: level, label: LABELS[level] ?? level })),
            },
          },
        }
      }),
    },
  }
}

export const VERSION = '0.1.0'

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedReadTokens: (a.cachedReadTokens ?? 0) + (b.cachedReadTokens ?? 0),
  cachedWriteTokens: (a.cachedWriteTokens ?? 0) + (b.cachedWriteTokens ?? 0),
  totalTokens: a.totalTokens + b.totalTokens,
})

/** One API call's counts, in the shape the wire's usage field takes. */
const callUsage = (usage: SdkApiUsage): Usage => {
  const input = usage.input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  return {
    inputTokens: input + cacheWrite + cacheRead,
    outputTokens: output,
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
    totalTokens: input + cacheWrite + cacheRead + output,
  }
}

/**
 * What this result's cumulative per-model counts added over the last one,
 * as one turn. Null when the counts carry no tokens at all — an older CLI
 * whose `modelUsage` names only windows. Deltas clamp at zero so a count
 * that ever shrinks (it should not) subtracts nothing rather than lying.
 */
const turnFromTotals = (
  models: Readonly<Record<string, SdkModelUsage>>,
  baseline: Readonly<Record<string, SdkModelUsage>> | null,
): Usage | null => {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let counted = false
  for (const [model, now] of Object.entries(models)) {
    if ((now.inputTokens ?? 0) + (now.outputTokens ?? 0) + (now.cacheReadInputTokens ?? 0) + (now.cacheCreationInputTokens ?? 0) === 0) continue
    counted = true
    const before = baseline?.[model]
    input += Math.max(0, (now.inputTokens ?? 0) - (before?.inputTokens ?? 0))
    output += Math.max(0, (now.outputTokens ?? 0) - (before?.outputTokens ?? 0))
    cacheRead += Math.max(0, (now.cacheReadInputTokens ?? 0) - (before?.cacheReadInputTokens ?? 0))
    cacheWrite += Math.max(0, (now.cacheCreationInputTokens ?? 0) - (before?.cacheCreationInputTokens ?? 0))
  }
  if (!counted) return null
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

type Meta = Record<string, unknown> | null | undefined

/** A control's value for this session, or `default` when it has none. */
export const valueOf = (state: { values: Record<string, string> }, id: string): string =>
  state.values[id] ?? DEFAULT

/** The controls this bridge adds, for reading a client's initial values. */
const CONTROL_IDS: readonly string[] = [EFFORT_OPTION_ID, AUTOCOMPACT_OPTION_ID, OUTPUT_STYLE_OPTION_ID]

/**
 * The controls Claude Code can be told about mid-session with its own
 * commands. Output style is not one: `/output-style` answers "isn't
 * available in this environment" under stream-json (probed against 2.1.240),
 * so that value can only ride a spawn.
 */
const COMMAND_IDS: readonly string[] = [EFFORT_OPTION_ID, AUTOCOMPACT_OPTION_ID]

/**
 * The values a client asked a new session to start at, from
 * `_meta.harnessdesk.options`. Anything the bridge does not own is ignored:
 * that key carries the whole draft, model and mode included.
 */
export const optionsIn = (meta: Meta): Record<string, string> => {
  const harnessdesk = meta?.['harnessdesk']
  if (typeof harnessdesk !== 'object' || harnessdesk === null) return {}
  const options = (harnessdesk as { options?: unknown }).options
  if (typeof options !== 'object' || options === null) return {}
  const wanted: Record<string, string> = {}
  for (const id of CONTROL_IDS) {
    const value = (options as Record<string, unknown>)[id]
    if (typeof value === 'string' && value.length > 0) wanted[id] = value
  }
  return wanted
}

/**
 * `_meta` with the SDK options the base bridge merges into its `query` call:
 * the flags for whatever is chosen, and an abort controller so the process
 * can be ended when it is replaced.
 *
 * `effort` is an option the SDK types; `--autocompact` is not, so it travels
 * as `extraArgs`, the SDK's own passthrough to the CLI. `default` means the
 * flag is left off entirely — Claude Code then applies its own settings,
 * which is a different thing from any value this bridge could pass.
 */
export const withOptions = (
  meta: Meta,
  values: Record<string, string>,
  abort: AbortController,
): Record<string, unknown> => {
  const claudeCode = (meta?.['claudeCode'] ?? {}) as { options?: Record<string, unknown> }
  const options: Record<string, unknown> = { ...(claudeCode.options ?? {}), abortController: abort }
  const effort = values[EFFORT_OPTION_ID]
  if (effort && effort !== DEFAULT) options['effort'] = effort
  else delete options['effort']
  const extraArgs = { ...((options['extraArgs'] as Record<string, string | null> | undefined) ?? {}) }
  const autocompact = values[AUTOCOMPACT_OPTION_ID]
  if (autocompact && autocompact !== DEFAULT) extraArgs['autocompact'] = autocompact
  else delete extraArgs['autocompact']
  // The one road to an output style: `--settings {"outputStyle": …}`. The
  // `/output-style` command is refused under stream-json, and there is no
  // dedicated flag, so the value is merged into whatever settings JSON the
  // caller already passes rather than replacing it.
  const style = values[OUTPUT_STYLE_OPTION_ID]
  const settings = parsedSettings(extraArgs['settings'])
  if (style && style !== DEFAULT) extraArgs['settings'] = JSON.stringify({ ...settings, outputStyle: style })
  else if ('outputStyle' in settings) {
    const { outputStyle: _dropped, ...rest } = settings
    if (Object.keys(rest).length > 0) extraArgs['settings'] = JSON.stringify(rest)
    else delete extraArgs['settings']
  }
  if (Object.keys(extraArgs).length > 0) options['extraArgs'] = extraArgs
  else delete options['extraArgs']
  return { ...(meta ?? {}), claudeCode: { ...claudeCode, options } }
}

/** The caller's own `--settings` JSON, or nothing — never a parse error. */
const parsedSettings = (raw: string | null | undefined): Record<string, unknown> => {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * The agent's own commands for whatever differs from what the process was
 * spawned with — the only way to change a session that has nothing to
 * resume yet. `default` is asked for as `auto`, the nearest thing Claude
 * Code's commands can say.
 */
export const commandsFor = (
  values: Record<string, string>,
  spawned: Record<string, string>,
): readonly string[] => {
  const commands: string[] = []
  for (const id of COMMAND_IDS) {
    const value = values[id] ?? DEFAULT
    if (value === (spawned[id] ?? DEFAULT)) continue
    commands.push(`/${id} ${value === DEFAULT ? 'auto' : value}`)
  }
  return commands
}

/** For the log line a re-spawn writes. */
const describeValues = (values: Record<string, string>): string =>
  CONTROL_IDS.map((id) => `${id}=${values[id] ?? DEFAULT}`).join(' ')
