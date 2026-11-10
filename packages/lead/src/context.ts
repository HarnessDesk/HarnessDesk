import type { MessagesText, MessagesToolResult, MessagesTurn } from './messages-types.js'
import type { LeadState } from './state.js'

/**
 * The Lead's context engine, as pure functions: how full the conversation is, what the desk may trim without a
 * model, which blocks carry a cache mark, and which blocks were desk context of the moment. Files belong to the
 * host (`packages/server/src/lead/context-store.ts`); the model request belongs to `messages.ts`.
 */
export const LEAD_CONTEXT = Object.freeze({
  /** Compaction runs between turns, when the Lead is idle, once this share of the window is used. */
  softShare: 0.70,
  /** And before the next request, whatever else is happening, at this share. */
  hardShare: 0.85,
  /** After a checkpoint that still leaves the conversation past the soft line, the next soft run waits this much more. */
  hysteresis: 0.10,
  /** The latest tool pairs the pruning stage never touches. */
  keepToolPairs: 3,
  /** An older tool result longer than this keeps only its head and tail. */
  trimAbove: 4096, trimHead: 1536, trimTail: 1024,
  /** The kept tail: at least this share of the window, and at least this many turns. */
  tailShare: 0.16, tailTurns: 6,
  /** The stored conversation never grows past this on disk. */
  diskBytes: 2 * 1024 * 1024,
  /** Bytes the desk has not yet seen a provider count for are estimated at this many per token. */
  bytesPerToken: 3.5,
  /** History one request carries: half of the request limit, the rest for instructions, tools and closing turns. */
  requestBytes: 524_288,
  /** And turns: a request admits 254, the rest are closing turns and a tool loop's continuations. */
  requestTurns: 200,
  /** A window the table below does not name. */
  defaultWindow: 200_000,
  /** Cache marks the provider honours in one request. */
  breakpoints: 4,
  /** Model attempts per compaction (one and two retries), and failures before the desk writes the checkpoint itself. */
  attempts: 3, breaker: 3,
  /** A checkpoint the model writes may be at most this long (the request's text limit). */
  checkpointChars: 16_384,
  /** Output allowed for the checkpoint request. */
  checkpointTokens: 4096,
})

/** Context windows by model. A model this table does not name is held to `LEAD_CONTEXT.defaultWindow`. */
export const LEAD_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'claude-sonnet-5-5': 200_000,
  'claude-haiku-5-5': 200_000,
  'claude-opus-5-5': 200_000,
})
export const leadContextWindow = (model: string): number =>
  Object.hasOwn(LEAD_CONTEXT_WINDOWS, model) ? LEAD_CONTEXT_WINDOWS[model]! : LEAD_CONTEXT.defaultWindow

/** Bytes of a value as it is sent. */
export const leadContextBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const leadEstimatedTokens = (bytes: number): number => Math.ceil(bytes / LEAD_CONTEXT.bytesPerToken)

export interface LeadContextPressureInput {
  readonly window: number
  /** The tokens the last request used as the provider reported them (input + cache read + cache write), plus an
   * estimate for the bytes added since; or an estimate alone when nothing was measured in this epoch. */
  readonly tokens: number
  readonly bytes: number
  readonly turns: number
}
/** The fullest of the three limits a request meets: the model's window, the request's bytes and its turns. */
export const leadContextPressure = (input: LeadContextPressureInput): number =>
  Math.max(input.tokens / Math.max(1, input.window), input.bytes / LEAD_CONTEXT.requestBytes, input.turns / LEAD_CONTEXT.requestTurns)

/** The soft line after a checkpoint left the conversation at `after`: back to normal when below it, otherwise raised
 * so the next idle turn does not summarise again for a few words. Never past the hard line. */
export const leadNextSoftShare = (after: number): number =>
  after < LEAD_CONTEXT.softShare ? LEAD_CONTEXT.softShare : Math.min(LEAD_CONTEXT.hardShare, after + LEAD_CONTEXT.hysteresis)

/** The one-line stand-in a desk-context block leaves in stored history. */
export const LEAD_DESK_STUB_PREFIX = '[Desk context at that time, left out'
export const leadDeskStub = (text: string): string => {
  const first = text.split('\n').find(line => line.trim())?.trim() ?? ''
  return `${LEAD_DESK_STUB_PREFIX}: ${first.length > 100 ? `${first.slice(0, 99)}…` : first}]`
}
const isStub = (block: { readonly type: string; readonly text?: string }) => block.type === 'text' && block.text!.startsWith(LEAD_DESK_STUB_PREFIX)

/** Where the stored (stable) part of a request ends: the last stable block is `blocks - 1` of turn `turns - 1`. */
export interface LeadContextMark { readonly turns: number; readonly blocks: number }
export const leadContextMarkOf = (messages: readonly MessagesTurn[]): LeadContextMark | undefined =>
  messages.length ? { turns: messages.length, blocks: messages.at(-1)!.content.length } : undefined

/**
 * The stored form of a request's turns. Everything up to `kept` (the stored part, then the host's own turns such as the
 * approved plan) stays as it is; every user text block after it was desk context of that moment (desk observations,
 * wake notes, the work cards, a closing nudge) and becomes one stub per run of such blocks. With no mark at all,
 * nothing was stored yet and every user text block is desk context. Assistant turns and tool results are kept.
 */
export const leadStubVolatile = (messages: readonly MessagesTurn[], mark: LeadContextMark | undefined, kept: LeadContextMark | undefined = mark): MessagesTurn[] => {
  const end = kept ?? { turns: 0, blocks: 0 }
  return messages.map((turn, index) => {
    if (turn.role !== 'user' || index < end.turns - 1) return turn
    const from = index === end.turns - 1 ? end.blocks : 0
    const content: MessagesTurn['content'][number][] = []
    let run: string[] = []
    const flush = () => { if (run.length) content.push({ type: 'text', text: leadDeskStub(run.join('\n')) }); run = [] }
    turn.content.forEach((block, position) => {
      if (position >= from && block.type === 'text' && !isStub(block)) run.push(block.text)
      else { flush(); content.push(block) }
    })
    flush()
    return { role: turn.role, content }
  })
}

/**
 * Adjacent turns of one role, joined into one turn. A provider reads two user turns in a row as one anyway; the desk
 * never sends or stores them apart, so a mark counted on the request is the mark on what is stored. The same array
 * when nothing needed it.
 */
export const leadMergedTurns = (turns: readonly MessagesTurn[]): readonly MessagesTurn[] => {
  if (!turns.some((turn, index) => index > 0 && turns[index - 1]!.role === turn.role)) return turns
  const out: MessagesTurn[] = []
  for (const turn of turns) {
    const last = out.at(-1)
    if (last && last.role === turn.role) out[out.length - 1] = { role: last.role, content: [...last.content, ...turn.content] }
    else out.push(turn)
  }
  return out
}
/** Blocks added to the end of a conversation: into its last turn when that is the person's or the desk's, as a turn of
 * their own after the Lead's. */
export const leadAppendUser = (turns: readonly MessagesTurn[], blocks: readonly MessagesText[]): MessagesTurn[] => {
  if (!blocks.length) return [...turns]
  const last = turns.at(-1)
  return last?.role === 'user' ? [...turns.slice(0, -1), { role: 'user', content: [...last.content, ...blocks] }] : [...turns, { role: 'user', content: [...blocks] }]
}

/**
 * The conversation with the approved plan in it, and where the host's own words end (`kept`). A conversation that
 * already carries these exact blocks, in a row, is returned as it is with no `kept`: the plan is stored once, not with
 * every message. One that does not (the plan was just approved, or a checkpoint took the region that held it) gets the
 * plan appended, so a desk wake with no person message after a compaction still reads its step ids, seats and vars.
 */
export const leadWithPlan = (turns: readonly MessagesTurn[], plan: readonly MessagesText[]): { readonly messages: MessagesTurn[]; readonly kept?: LeadContextMark } => {
  if (!plan.length || leadCarriesPlan(turns, plan)) return { messages: [...turns] }
  const messages = leadAppendUser(turns, plan)
  const kept = leadContextMarkOf(messages)
  return { messages, ...(kept ? { kept } : {}) }
}
const leadCarriesPlan = (turns: readonly MessagesTurn[], plan: readonly MessagesText[]): boolean => turns.some(turn => turn.role === 'user' &&
  turn.content.some((_, at) => plan.every((block, offset) => { const held = turn.content[at + offset]; return held?.type === 'text' && held.text === block.text })))

/**
 * What later areas add to the standing instructions at each new epoch, in order: each entry reads the Lead's state
 * and returns a line, or null. Append-only; an entry that throws is skipped. Joined by `leadEpochAddendum`, which the
 * child passes to the loop as its `onEpoch` hook.
 */
export const LEAD_EPOCH_ADDENDA: readonly ((state: LeadState) => string | null)[] = Object.freeze([])
export const leadEpochAddendum = (state: LeadState, addenda: readonly ((state: LeadState) => string | null)[] = LEAD_EPOCH_ADDENDA): string =>
  addenda.flatMap(addendum => { try { const line = addendum(state)?.trim(); return line ? [line] : [] } catch { return [] } }).join('\n')

/** What one step adds to the stored conversation: blocks to add to the last stored turn and the turns after it. */
export interface LeadContextRecord {
  readonly extend: readonly MessagesText[]
  readonly turns: readonly MessagesTurn[]
}
/** Reasoning is never stored. A turn made only of reasoning keeps a placeholder so the turn order survives. */
export const leadWithoutReasoning = (turn: MessagesTurn): MessagesTurn => {
  if (turn.role !== 'assistant') return turn
  const content = turn.content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking')
  return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no words)' }] }
}
/** The record a step leaves, from the conversation it ended with (already stubbed) and the stable mark it started from. */
export const leadContextRecord = (stubbed: readonly MessagesTurn[], mark: LeadContextMark | undefined): LeadContextRecord => {
  const turns = mark ? mark.turns : 0
  const last = turns > 0 ? stubbed[turns - 1] : undefined
  const extend = last && last.role === 'user' ? last.content.slice(mark!.blocks).filter((block): block is MessagesText => block.type === 'text') : []
  return { extend, turns: stubbed.slice(turns).map(leadWithoutReasoning) }
}

/** Indexes of the turns a tool pair occupies, newest first: the assistant turn that called and the user turn answering. */
const toolPairs = (turns: readonly MessagesTurn[]): number[] => {
  const pairs: number[] = []
  turns.forEach((turn, index) => { if (turn.role === 'user' && turn.content.some(block => block.type === 'tool_result')) pairs.push(index) })
  return pairs.reverse()
}
const trimmed = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= LEAD_CONTEXT.trimAbove) return text
  const decoder = new TextDecoder()
  const head = decoder.decode(bytes.slice(0, LEAD_CONTEXT.trimHead)).replace(/�$/, '')
  const tail = decoder.decode(bytes.slice(bytes.byteLength - LEAD_CONTEXT.trimTail)).replace(/^�/, '')
  return `${head}\n[… ${bytes.byteLength - LEAD_CONTEXT.trimHead - LEAD_CONTEXT.trimTail} bytes trimmed by the desk …]\n${tail}`
}
/**
 * The pruning stage, which needs no model: the latest `keepPairs` tool pairs stay whole; an older tool result
 * longer than `trimAbove` keeps its head and tail with a marker between; a desk-context block that was not yet a
 * stub becomes one. Returns the same array when nothing changed.
 */
export const leadPruneContext = (turns: readonly MessagesTurn[], keepPairs: number = LEAD_CONTEXT.keepToolPairs): readonly MessagesTurn[] => {
  const keep = new Set(toolPairs(turns).slice(0, keepPairs))
  let changed = false
  const pruned = turns.map((turn, index) => {
    if (turn.role !== 'user' || keep.has(index)) return turn
    const content = turn.content.map(block => {
      if (block.type !== 'tool_result') return block
      const content = trimmed(block.content)
      if (content === block.content) return block
      changed = true
      return { ...block, content } satisfies MessagesToolResult
    })
    return { role: turn.role, content }
  })
  return changed ? pruned : turns
}

/** A tail may begin only where the person or the desk spoke: a user turn that answers no tool call. */
export const leadContextBoundary = (turns: readonly MessagesTurn[], index: number): boolean =>
  index > 0 && index < turns.length && turns[index]!.role === 'user' && turns[index]!.content[0]?.type === 'text'

/**
 * Where the kept tail begins: the latest boundary that keeps at least `tailTurns` turns and at least `tailShare` of
 * the window. The region before it is what a checkpoint replaces. With no such boundary the latest boundary that
 * keeps anything is used; null when there is nothing to replace. `smallest` asks for that latest boundary outright: the
 * thrash guard's one smaller tail.
 */
export const leadContextSplit = (turns: readonly MessagesTurn[], window: number, smallest = false): number | null => {
  const want = smallest ? 0 : LEAD_CONTEXT.tailShare * window
  let tokens = 0, fallback: number | null = null
  for (let index = turns.length - 1; index > 0; index--) {
    tokens += leadEstimatedTokens(leadContextBytes(turns[index]))
    if (!leadContextBoundary(turns, index)) continue
    fallback ??= index
    if (smallest) return index
    if (turns.length - index >= LEAD_CONTEXT.tailTurns && tokens >= want) return index
  }
  return fallback
}

/**
 * A history whose last assistant turn called tools that are still unanswered by a later assistant turn ends inside a
 * tool loop. Its reasoning was not stored, so the desk rewrites that loop as words before sending it on.
 */
export const leadCloseOpenLoop = (turns: readonly MessagesTurn[]): MessagesTurn[] => {
  const at = turns.findLastIndex(turn => turn.role === 'assistant')
  const assistant = turns[at]
  if (!assistant || !assistant.content.some(block => block.type === 'tool_use')) return [...turns]
  const names = new Map<string, string>()
  const said: MessagesTurn = { role: 'assistant', content: assistant.content.map(block => {
    if (block.type !== 'tool_use') return block
    names.set(block.id, block.name)
    const input = JSON.stringify(block.input ?? null)
    return { type: 'text', text: `[Called ${block.name} with ${input.length > 400 ? `${input.slice(0, 399)}…` : input}]` }
  }) }
  const answered = turns.slice(at + 1).map((turn): MessagesTurn => ({ role: turn.role, content: turn.content.map(block => block.type === 'tool_result'
    ? { type: 'text', text: `[${block.is_error ? 'Error from' : 'Result of'} ${names.get(block.tool_use_id) ?? 'a tool'}: ${block.content.length > 1500 ? `${block.content.slice(0, 1499)}…` : block.content}]` }
    : block) }))
  return [...turns.slice(0, at), said, ...answered]
}

const calledInWords = (name: string, input: unknown): MessagesText => {
  const text = JSON.stringify(input ?? null)
  return { type: 'text', text: `[Called ${name} with ${text.length > 400 ? `${text.slice(0, 399)}…` : text}]` }
}
const resultInWords = (block: MessagesToolResult, name: string | undefined): MessagesText =>
  ({ type: 'text', text: `[${block.is_error ? 'Error from' : 'Result of'} ${name ?? 'a tool'}: ${block.content.length > 1500 ? `${block.content.slice(0, 1499)}…` : block.content}]` })
/**
 * Every tool call followed by its answer and every answer by its call, as a provider requires. A stored conversation
 * can hold a call whose answer never arrived (a step cut short), and a compaction can cut between them; either is
 * rewritten in words. Deterministic, and the same array when nothing needed it, so a request's cached prefix holds.
 */
export const leadPairedTurns = (turns: readonly MessagesTurn[]): readonly MessagesTurn[] => {
  let changed = false
  const out = [...turns], names = new Map<string, string>()
  out.forEach((turn, index) => {
    if (turn.role === 'assistant') {
      const calls = turn.content.flatMap(block => block.type === 'tool_use' ? [block] : [])
      if (!calls.length) return
      const next = out[index + 1]
      const answered = new Set(next?.role === 'user' ? next.content.flatMap(block => block.type === 'tool_result' ? [block.tool_use_id] : []) : [])
      if (calls.every(call => answered.has(call.id))) return
      changed = true
      out[index] = { role: 'assistant', content: turn.content.map(block => block.type === 'tool_use' ? calledInWords(block.name, block.input) : block) }
      return
    }
    const previous = out[index - 1]
    const called = new Map(previous?.role === 'assistant' ? previous.content.flatMap(block => block.type === 'tool_use' ? [[block.id, block.name] as const] : []) : [])
    for (const block of turns[index - 1]?.content ?? []) if (block.type === 'tool_use') names.set(block.id, block.name)
    if (!turn.content.some(block => block.type === 'tool_result' && !called.has(block.tool_use_id))) return
    changed = true
    out[index] = { role: 'user', content: turn.content.map(block => block.type === 'tool_result' && !called.has(block.tool_use_id) ? resultInWords(block, names.get(block.tool_use_id)) : block) }
  })
  return changed ? out : turns
}
