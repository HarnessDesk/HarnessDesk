import { WireCallError } from '@harnessdesk/client'
import { leadToolDefinitions, parseLeadToolCall, LeadToolFencedError, LeadToolRefusedError } from './tools.js'
import { LEAD_LIMITS, clientTierFor, parseLeadAcceptanceContract, parseLeadCard,
  type LeadAsk, type LeadProactive, type LeadMessageRef, LEAD_MESSAGE_REFS_MAX, parseLeadMessageRef, parseLeadAsk, parseLeadProactiveOutput, type LeadBudgetEvent, type LeadAcceptanceContract, type LeadCard } from '@harnessdesk/protocol'
import type { LeadPermissionCall } from './permissions.js'
import { LEAD_CONTEXT } from './context.js'
import { LEAD_CHECKPOINT_OPEN } from './compaction.js'
import { splitLeadOutput } from './envelope.js'
import type { LeadMessagesClient, LeadMessagesOptions, LeadMessagesResult, MessagesHttpResponse, MessagesPrice,
  MessagesRedactedThinking, MessagesText, MessagesThinking, MessagesToolUse, MessagesToolResult, MessagesTurn, MessagesUsage } from './messages-types.js'

/** Configuration defaults only; model choice never changes permissions or behavior. */
export const LEAD_MESSAGES_DEFAULTS = Object.freeze({ model: 'claude-sonnet-5-5', observerModel: 'claude-haiku-5-5', hardPlanModel: 'claude-opus-5-5' })
const LIMIT = Object.freeze({ bytes: 1_048_576, text: 16_384, blocks: 64, turns: 256, nodes: 16_384,
  depth: 24, maxTokens: 65_536, retries: 2, retryMs: 30_000,
  /** One reasoning field (the thinking text, its signature, or redacted data): a reply of the largest
   * allowed `max_tokens` at four characters a token. The whole body is still held to `bytes`. */
  reasoning: 262_144 })
const TOOL_ERROR = Object.freeze({
  refused: 'Tool was not permitted: tool or arguments are outside the allowed API.',
  policy: 'Tool was not permitted: policy refused this operation.',
  uncertain: 'Tool failed: completion could not be confirmed; inspect before retrying.',
  changed: 'Tool failed: desk activity changed; read fresh state.',
  scope: 'Tool failed: the selected project access check failed.',
  deadline: 'Tool refused: the time the person set for this goal has run out, so no new work starts for it. Tell the person, and ask whether to extend it.',
  cap: 'Tool refused: runs started without the person asking are limited, the account may be near its limit, or the Lead is still loading after a restart, so the person\'s next follow-up keeps its room. Wait for a run to finish, then try again.',
  failed: 'Tool failed: the desk request could not complete.',
  overflow: 'Tool failed: its result exceeded the conversation limit.',
})
const policyRefusal = (layer: 'desk' | 'project') => `Tool was not permitted: ${layer} policy rule refused this operation.`
const fail = (): never => { throw new Error('lead-messages-invalid') }
const object = (value: unknown, allowed?: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const source = value as Record<string, unknown>
  if (allowed && Object.keys(source).some(key => !allowed.includes(key))) return fail()
  return source
}
const integer = (value: unknown, max = 100_000_000): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return fail()
  return value
}
const string = (value: unknown, max: number = LIMIT.text): string => {
  if (typeof value !== 'string' || value.length > max) return fail()
  return value
}
const identifier = (value: unknown): string => {
  const text = string(value, 128)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) return fail()
  return text
}
/** Check plain data before serializing: getters, cycles, deep/wide trees and huge
 * strings must not bypass a byte cap or execute while crossing a trust boundary. */
const json = (value: unknown, max: number = LIMIT.bytes): string => {
  let nodes = 0, chars = 0
  const active = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > LIMIT.nodes || depth > LIMIT.depth) fail()
    if (typeof item === 'string') { chars += item.length; if (chars > max) fail(); return }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || active.has(item)) return fail()
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) fail()
    const descriptors = Object.getOwnPropertyDescriptors(item)
    // JSON.stringify consults toJSON even when it is not enumerable. Never invoke
    // a serializer or accessor that can replace the already-checked tree.
    if (Object.hasOwn(descriptors, 'toJSON')) fail()
    const keys = Reflect.ownKeys(descriptors).filter(key => descriptors[key as string]!.enumerable)
    if (keys.length > LIMIT.nodes || array && keys.length !== (item as unknown[]).length) fail()
    active.add(item)
    for (const key of keys) {
      const descriptor = descriptors[key as string]!
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) return fail()
      // Protocol parsers normalize optional fields to undefined; JSON omits them.
      if (!array && descriptor.value === undefined) continue
      chars += key.length
      if (chars > max) fail()
      visit(descriptor.value, depth + 1)
    }
    active.delete(item)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > max) fail()
  return encoded
}

/** An assistant turn's blocks, as the provider returns them and as this client sends them back. */
type Block = MessagesText | MessagesThinking | MessagesRedactedThinking | MessagesToolUse
/** History the caller supplies must be exactly what this client returned. A provider
 * reply may carry fields added after this was written (`citations`, `caller`); they
 * are read past and never passed on, except that a tool use made on behalf of anything
 * other than the model directly was never offered here and is refused.
 * Reasoning (`thinking`, `redacted_thinking`) is kept byte for byte, because the provider verifies
 * its signature when the turn comes back inside a tool loop. Its text may be empty. */
const block = (value: unknown, provider = false): Block => {
  const source = object(value)
  if (source.type === 'text') {
    if (!provider) object(source, ['type', 'text'])
    return { type: 'text', text: string(source.text) }
  }
  if (source.type === 'thinking') {
    if (!provider) object(source, ['type', 'thinking', 'signature'])
    return { type: 'thinking', thinking: string(source.thinking, LIMIT.reasoning), signature: string(source.signature, LIMIT.reasoning) }
  }
  if (source.type === 'redacted_thinking') {
    if (!provider) object(source, ['type', 'data'])
    return { type: 'redacted_thinking', data: string(source.data, LIMIT.reasoning) }
  }
  if (source.type !== 'tool_use') return fail()
  if (!provider) object(source, ['type', 'id', 'name', 'input'])
  else if (source.caller !== undefined && object(source.caller).type !== 'direct') fail()
  // A recognizable use with malformed arguments still receives its correlated error.
  return { type: 'tool_use', id: identifier(source.id), name: string(source.name, 128), input: source.input ?? null }
}
const blocks = (value: unknown, provider = false): Block[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMIT.blocks) return fail()
  const result = value.map(item => block(item, provider)), ids = result.filter(item => item.type === 'tool_use').map(item => item.id)
  if (new Set(ids).size !== ids.length) return fail()
  return result
}
/** Turns as a fragment: a continuation of a conversation whose last assistant turn left `pending` tool uses open.
 * No orphan, reordered, duplicate or unanswered result is admitted; what is still open at the end is returned. */
const fragment = (value: unknown, open: readonly string[] = []): { turns: MessagesTurn[]; pending: string[] } => {
  if (!Array.isArray(value) || value.length > LIMIT.turns) return fail()
  let pending: string[] = [...open]
  const result: MessagesTurn[] = []
  for (const item of value) {
    const source = object(item, ['role', 'content'])
    if (source.role !== 'user' && source.role !== 'assistant') return fail()
    if (source.role === 'assistant') {
      if (pending.length) fail()
      const content = blocks(source.content)
      pending = content.filter(b => b.type === 'tool_use').map(b => b.id)
      result.push({ role: 'assistant', content })
    } else {
      const rawContent = source.content
      if (!Array.isArray(rawContent) || !rawContent.length || rawContent.length > LIMIT.blocks) return fail()
      const content = rawContent.map((raw: unknown, index: number) => {
        const entry = object(raw)
        if (!pending.length || index >= pending.length) {
          const parsed = block(entry)
          if (parsed.type !== 'text') return fail()
          return parsed
        }
        object(entry, ['type', 'tool_use_id', 'content', 'is_error'])
        if (entry.type !== 'tool_result' || entry.tool_use_id !== pending[index] || typeof entry.is_error !== 'boolean') return fail()
        return { type: 'tool_result' as const, tool_use_id: identifier(entry.tool_use_id), content: string(entry.content), is_error: entry.is_error }
      })
      if (pending.length && content.length < pending.length) fail()
      pending = []
      result.push({ role: 'user', content })
    }
  }
  return { turns: result, pending }
}
/** A continuation may never contain orphan, reordered, duplicate or unanswered results. */
const history = (value: unknown): MessagesTurn[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMIT.turns - 2) return fail()
  const { turns: result, pending } = fragment(value)
  if (pending.length || result[0]!.role !== 'user' || result.at(-1)!.role !== 'user') fail()
  return result
}
/** Stored context turns the child reports, checked as this client checks a continuation: a fragment that may follow
 * a stored assistant turn whose tool uses are `open`. Throws on anything else. */
export const parseLeadContextTurns = (value: unknown, open: readonly string[] = []): { readonly turns: MessagesTurn[]; readonly pending: string[] } => {
  json(value)
  const parsed = fragment(value, open)
  // Two person or desk turns in a row never reach a provider: the desk joins them into one before it sends or stores.
  if (parsed.turns.some((turn, index) => index > 0 && turn.role === 'user' && parsed.turns[index - 1]!.role === 'user')) throw new Error('lead-context-turns')
  return parsed
}
/** The provider's cache mark, the one field a request block may carry beyond its type's own. */
const CACHE_MARK = Object.freeze({ type: 'ephemeral' as const })
/**
 * Cache marks, at most `LEAD_CONTEXT.breakpoints` (a provider honours four): the end of the instructions, the end of a
 * checkpoint turn that opens the conversation, and the last stable block of the history (rolling forward as it grows).
 * Desk context of the moment always comes after the last mark, so it never enters the cached prefix. A mark never
 * sits on reasoning, which a provider does not cache on its own.
 */
const withCacheMarks = (messages: readonly MessagesTurn[], stable: { readonly turns: number; readonly blocks: number } | undefined): unknown[] => {
  const marks = new Set<string>()
  const mark = (turn: number, upto: number) => {
    const content = messages[turn]?.content
    if (!content) return
    for (let index = Math.min(upto, content.length - 1); index >= 0; index--) {
      const type = content[index]!.type
      if (type !== 'thinking' && type !== 'redacted_thinking') { marks.add(`${turn}:${index}`); return }
    }
  }
  const first = messages[0]?.content[0]
  if (messages[0]?.role === 'user' && first?.type === 'text' && first.text.startsWith(LEAD_CHECKPOINT_OPEN)) mark(0, messages[0].content.length - 1)
  if (stable && stable.turns > 0 && stable.blocks > 0 && stable.turns <= messages.length) mark(stable.turns - 1, stable.blocks - 1)
  return messages.map((turn, index) => ({ role: turn.role, content: turn.content.map((block, position) =>
    marks.has(`${index}:${position}`) ? { ...block, cache_control: CACHE_MARK } : block) }))
}
const systemBlocks = (system: string) => [{ type: 'text' as const, text: system, cache_control: CACHE_MARK }]
/** The most turns of the person's readable conversation one request carries. The request admits LIMIT.turns - 2;
 * the rest is room for the host's own closing turns and for a tool loop's continuations within the request. */
export const LEAD_HISTORY_TURNS = 128
/** And the most bytes of it: half of what one request admits, the rest for the system prompt, tools and closing turns. */
export const LEAD_HISTORY_BYTES = LIMIT.bytes / 2
/**
 * The person's readable conversation as a history this module admits: the latest turns that fit, opening with a
 * person turn. A Lead that spoke first (on a resume, or an automatic wake) and a conversation longer than a request
 * holds, in turns or in bytes, are both ordinary, and either one, sent as it stands, is refused before every request
 * that follows.
 */
export const leadHistory = (messages: readonly { readonly id?: string; readonly role: string; readonly text: string; readonly ask?: LeadAsk; readonly proactive?: LeadProactive }[]): MessagesTurn[] => {
  const spoken = messages.filter(message => message.role === 'user' || message.role === 'assistant')
  const turns: MessagesTurn[] = spoken.slice(-LEAD_HISTORY_TURNS).map(message => {
    const ask = message.ask ?? (message.proactive?.options && message.proactive.recommended ? {
      question: message.proactive.ask, options: message.proactive.options, recommended: message.proactive.recommended,
    } : undefined)
    return { role: message.role as 'user' | 'assistant', content: [
      ...(ask && !message.text.trim() ? [] : [{ type: 'text' as const, text: message.text }]),
      ...(message.role === 'user' && message.id ? [{ type: 'text' as const, text: `Desk reference for the preceding person message: ${message.id}` }] : []),
      ...(message.role === 'assistant' && ask ? [{ type: 'text' as const, text: `Decision offered in this reply: ${JSON.stringify(parseLeadAsk(ask))}` }] : []),
    ] }
  })
  let bytes = new TextEncoder().encode(JSON.stringify(turns)).length
  while (turns.length > 1 && bytes > LEAD_HISTORY_BYTES) bytes -= new TextEncoder().encode(JSON.stringify(turns.shift())).length + 1
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: [{ type: 'text', text: turns.length < spoken.length ?
    'Desk observation: earlier messages in this conversation are left out.' :
    'Desk observation: the Lead spoke first in this conversation, after a desk event, before the person wrote.' }] })
  return turns
}
/** Validate the child's complete provider dialect before the host serializes it.
 * JSON.parse alone loses duplicate keys, including escaped spellings of a key. */
export const parseLeadMessagesBody = (body: string) => {
  string(body, LIMIT.bytes)
  const source = object(JSON.parse(body), ['model', 'max_tokens', 'stream', 'messages', 'tools', 'system'])
  json(source)
  const keys: (Set<string> | null)[] = []
  let previous = ''
  for (const [token] of body.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)) {
    if (token === '{') keys.push(new Set())
    else if (token === '[') keys.push(null)
    else if (token === '}' || token === ']') keys.pop()
    else if (token === ':') {
      const key = JSON.parse(previous) as string, seen = keys.at(-1)
      if (!seen || seen.has(key)) return fail()
      seen.add(key)
    }
    previous = token
  }
  const same = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
    const left = Object.keys(a), right = Object.keys(b)
    return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  if (!['model', 'max_tokens', 'stream', 'messages', 'tools'].every(key => Object.hasOwn(source, key)) ||
    source.stream !== false || !same(source.tools, leadToolDefinitions)) fail()
  const maxTokens = integer(source.max_tokens, Number.MAX_SAFE_INTEGER)
  if (maxTokens === 0) fail()
  // A block may carry the provider's cache mark and nothing else beyond its own fields; at most four in all.
  let marks = 0
  const unmark = (value: unknown): unknown => {
    const entry = object(value)
    if (!Object.hasOwn(entry, 'cache_control')) return entry
    if (!same(entry.cache_control, CACHE_MARK) || ++marks > LEAD_CONTEXT.breakpoints) return fail()
    const { cache_control: _mark, ...rest } = entry
    return rest
  }
  const marked = new Set<string>()
  if (!Array.isArray(source.messages)) fail()
  const plain = (source.messages as unknown[]).map((turn, index) => {
    const entry = object(turn)
    if (!Array.isArray(entry.content)) return entry
    return { ...entry, content: entry.content.map((block: unknown, position: number) => {
      const bare = unmark(block)
      if (bare !== block) marked.add(`${index}:${position}`)
      return bare
    }) }
  })
  let system: string | undefined
  if (Object.hasOwn(source, 'system')) {
    if (typeof source.system === 'string') system = string(source.system)
    else {
      if (!Array.isArray(source.system) || source.system.length !== 1) fail()
      const only = object(unmark((source.system as unknown[])[0]), ['type', 'text'])
      if (only.type !== 'text') fail()
      system = string(only.text, LIMIT.bytes)
    }
  }
  const messages = history(plain).map((turn, index) => ({ role: turn.role, content: turn.content.map((block, position) =>
    marked.has(`${index}:${position}`) ? { ...block, cache_control: CACHE_MARK } : block) }))
  return { model: string(source.model, 128), max_tokens: maxTokens, stream: false as const,
    messages, tools: leadToolDefinitions,
    ...(system === undefined ? {} : { system: Array.isArray(source.system) ? systemBlocks(system) : system }) }
}
const usage = (value: unknown): MessagesUsage => {
  const source = object(value)
  return { inputTokens: integer(source.input_tokens), outputTokens: integer(source.output_tokens),
    cacheReadTokens: source.cache_read_input_tokens === undefined ? 0 : integer(source.cache_read_input_tokens),
    cacheWriteTokens: source.cache_creation_input_tokens === undefined ? 0 : integer(source.cache_creation_input_tokens) }
}
/** Text that parses as an object naming `type: 'lead-output'` is the structured
 * assistant-output envelope; anything else, brace or not, is ordinary text. A named
 * envelope must then be valid. Whatever the text decodes to is returned as `decoded`
 * so the caller's credential scan sees escaped strings too. Proposals are data only;
 * their validators confer no authority to execute them. */
/** The refs an envelope carries, leniently: a malformed one is dropped, never the reply with it. */
const replyRefs = (value: unknown): readonly LeadMessageRef[] => {
  if (!Array.isArray(value)) return []
  const out: LeadMessageRef[] = [], seen = new Set<string>()
  for (const one of value.slice(0, 32)) {
    let ref: LeadMessageRef
    try { ref = parseLeadMessageRef(one) } catch { continue }
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key); out.push(ref)
    if (out.length === LEAD_MESSAGE_REFS_MAX) break
  }
  return out
}
const proposals = (text: string, outer?: string): { text: string; plan: LeadAcceptanceContract | null; cards: readonly LeadCard[]; proactive?: LeadProactive; ask?: LeadAsk; refs?: readonly LeadMessageRef[]; decoded: unknown } => {
  let decoded: unknown = null
  try { decoded = JSON.parse(text) } catch { /* prose */ }
  let prose = ''
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || (decoded as Record<string, unknown>).type !== 'lead-output') {
    // The envelope after the prose, or in a code fence, is still the envelope: protocol JSON is never the person's
    // words. One that names itself but does not validate is left in the text; the host strips it and warns.
    const split = splitLeadOutput(text)
    if (!split?.envelope) return { text, plan: null, cards: [], decoded }
    try { return { ...proposals(JSON.stringify(split.envelope), split.prose), decoded: { decoded, envelope: split.envelope } } } catch { return { text, plan: null, cards: [], decoded } }
  }
  if (outer !== undefined) prose = outer
  const candidate = decoded
  const source = object(candidate, ['version', 'type', 'text', 'ask', 'proactive', 'plan', 'cards', 'refs'])
  if (source.version !== 1 || source.ask !== undefined && source.proactive !== undefined) return fail()
  if (source.cards !== undefined && (!Array.isArray(source.cards) || source.cards.length > LIMIT.blocks)) return fail()
  const cards = source.cards === undefined ? [] : (source.cards as unknown[]).map(value => parseLeadCard(value))
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail()
  const own = source.text === undefined ? '' : string(source.text)
  return { text: prose && own && !prose.includes(own) ? `${prose}\n\n${own}` : prose || own,
    plan: source.plan === undefined ? null : parseLeadAcceptanceContract(source.plan), cards, ...(source.proactive === undefined ? {} : { proactive: parseLeadProactiveOutput(source.proactive) }), ...(source.ask === undefined ? {} : { ask: parseLeadAsk(source.ask) }),
    ...(source.proactive === undefined && replyRefs(source.refs).length > 0 ? { refs: replyRefs(source.refs) } : {}), decoded }
}
/** Cancellation also wins when a broken injected operation ignores its signal. */
const cancellable = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return fail()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('lead-messages-cancelled')) })
  signal.addEventListener('abort', abort, { once: true })
  try {
    const pending = operation()
    if (signal.aborted) abort()
    return await Promise.race([pending, cancelled])
  } finally { signal.removeEventListener('abort', abort) }
}
const retryDelay = (value: string | undefined, now: number): number | null => {
  if (value === undefined) return 1000
  if (value.length > 128) return null
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
  const ms = seconds === null ? Date.parse(value) - now : Math.ceil(seconds * 1000)
  return Number.isFinite(ms) && ms <= LIMIT.retryMs ? Math.max(0, ms) : null
}

export const createLeadMessages = (options: LeadMessagesOptions): LeadMessagesClient => {
  // Capture owner configuration once. Neither request arguments nor provider output
  // can replace the model, destination, headers, price table or tool definitions.
  const { apiKey, transport, journal, now, nextId, countInput, wait, resolveTool, dispatch } = options
  const model = options.model ?? LEAD_MESSAGES_DEFAULTS.model
  let price: MessagesPrice
  try {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) fail()
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model) || !Object.hasOwn(options.prices, model)) fail()
    const source = object(options.prices[model], ['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion', 'cacheReadUsdMicrosPerMillion', 'cacheWriteUsdMicrosPerMillion'])
    price = { inputUsdMicrosPerMillion: integer(source.inputUsdMicrosPerMillion, 1_000_000_000_000),
      outputUsdMicrosPerMillion: integer(source.outputUsdMicrosPerMillion, 1_000_000_000_000),
      cacheReadUsdMicrosPerMillion: integer(source.cacheReadUsdMicrosPerMillion, 1_000_000_000_000),
      cacheWriteUsdMicrosPerMillion: integer(source.cacheWriteUsdMicrosPerMillion, 1_000_000_000_000) }
  } catch { throw new Error('lead-messages-config') }
  const safeJson = (value: unknown, max: number = LIMIT.bytes): string => {
    const encoded = json(value, max)
    // Compare decoded strings too: JSON escaping must not conceal an echoed key.
    const scan = (item: unknown): void => {
      if (typeof item === 'string' && item.includes(apiKey)) fail()
      if (item !== null && typeof item === 'object') for (const [name, child] of Object.entries(item)) { if (name.includes(apiKey)) fail(); scan(child) }
    }
    scan(value)
    return encoded
  }
  return { async request(input, signal): Promise<LeadMessagesResult> {
    if (signal.aborted) return { status: 'cancelled' }
    let requestId: string, body: string, messages: MessagesTurn[], maxTokens: number, compaction = false
    try {
      const captured = JSON.parse(safeJson(input)) as unknown
      const source = object(captured, ['messages', 'system', 'maxTokens', 'proactive', 'conversation', 'wakeSource', 'stable', 'compaction'])
      if (source.conversation !== undefined && typeof source.conversation !== 'boolean') fail()
      if (source.compaction !== undefined && source.compaction !== true) fail()
      compaction = source.compaction === true
      messages = history(source.messages)
      const stable = source.stable === undefined ? undefined : object(source.stable, ['turns', 'blocks'])
      const mark = stable && { turns: integer(stable.turns, LIMIT.turns), blocks: integer(stable.blocks, LIMIT.blocks) }
      maxTokens = integer(source.maxTokens, LIMIT.maxTokens)
      if (maxTokens === 0) fail()
      body = safeJson({ model, max_tokens: maxTokens, stream: false, messages: withCacheMarks(messages, mark), tools: leadToolDefinitions,
        ...(source.system === undefined ? {} : { system: systemBlocks(string(source.system, LIMIT.bytes)) }) })
      const inputTokens = integer(await cancellable(() => countInput(body, signal), signal))
      requestId = string(nextId(), 100)
      if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(requestId) || requestId.includes(apiKey)) fail()
      if (signal.aborted) return { status: 'cancelled' }
      await journal.updateBudget({ version: 1, type: 'reserve', now: now(), requestId, inputTokens, maxOutputTokens: maxTokens, ...price, ...(input.compaction ? { purpose: 'compaction' as const } : {}) })
    } catch (error) { return { status: signal.aborted ? 'cancelled' : 'refused', reason: (error as { wireCode?: unknown })?.wireCode === 'lead-budget-admission' ? 'lead-messages-capacity' : 'lead-messages-admission' } }
    const accounting = (event: Omit<Extract<LeadBudgetEvent, { type: 'settle' }>, 'version' | 'now' | 'requestId'> | { type: 'uncertain' }) =>
      journal.updateBudget({ version: 1, now: now(), requestId, ...event })
    const zero = () => accounting({ type: 'settle', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const uncertain = async (): Promise<LeadMessagesResult> => {
      try { await accounting({ type: 'uncertain' }) } catch { /* The durable reservation remains held; journal failures latch the writer. */ }
      return { status: 'uncertain', reason: 'lead-messages-billing-unknown' }
    }
    let response!: MessagesHttpResponse
    for (let retry = 0; ; retry++) {
      if (signal.aborted) {
        try { await zero() } catch { return uncertain() }
        return { status: 'cancelled' }
      }
      try {
        const reply = object(await cancellable(() => transport.send({ requestId, origin: 'https://api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: Object.freeze({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }),
          body, maxResponseBytes: LIMIT.bytes, signal }), signal))
        // A reply of the wrong shape proves nothing about billing either.
        if (!Number.isSafeInteger(reply.status) || reply.retryAfter !== undefined && typeof reply.retryAfter !== 'string' ||
          reply.processing !== undefined && reply.processing !== 'not-started' && reply.processing !== 'unknown') fail()
        // Read each field once: the checked values are the ones acted on.
        response = Object.freeze({ status: reply.status as number, body: reply.body as string,
          retryAfter: reply.retryAfter as string | undefined, processing: reply.processing as MessagesHttpResponse['processing'] })
      } catch { return uncertain() }
      if ((response.status === 429 || response.status === 529) && response.processing === 'not-started') {
        const delay = retryDelay(response.retryAfter, now())
        if (retry === LIMIT.retries || delay === null) {
          try { await zero() } catch { return uncertain() }
          return { status: 'rate-limited', reason: 'lead-messages-rate-limit' }
        }
        try { await cancellable(() => wait(delay, signal), signal) }
        catch {
          try { await zero() } catch { return uncertain() }
          return { status: signal.aborted ? 'cancelled' : 'failed', reason: 'lead-messages-delay' }
        }
        continue
      }
      // A client error the transport saw refused before processing was never billed.
      // Naming its cause lets the owner fix a key instead of losing the goal's budget.
      if (response.status >= 400 && response.status < 500 && response.processing === 'not-started') {
        try { await zero() } catch { return uncertain() }
        return { status: 'failed', reason: response.status === 401 || response.status === 403 ? 'lead-messages-auth'
          // A timeout or conflict the provider names is about that moment, not the request: the same one may pass next.
          : response.status === 408 || response.status === 409 ? 'lead-messages-transient'
          : response.status === 400 && typeof response.body === 'string' && /prompt is too long|too many tokens|context (?:length|window)/i.test(response.body.slice(0, 4096)) ? 'lead-messages-too-long' : 'lead-messages-request' }
      }
      // No other status or transport rejection proves a zero charge.
      if (response.status !== 200) return uncertain()
      break
    }
    let parsed: Record<string, unknown>, used: MessagesUsage
    try {
      const raw = string(response.body, LIMIT.bytes)
      if (new TextEncoder().encode(raw).byteLength > LIMIT.bytes) fail()
      parsed = object(JSON.parse(raw))
      // Bound the full parsed tree before reading usage or any block.
      json(parsed)
      used = usage(parsed.usage)
      await accounting({ type: 'settle', ...used })
    } catch { return uncertain() }
    // Usage is settled; a refusal or a paused turn is the model's answer, not a protocol fault.
    if (parsed.stop_reason === 'refusal') return { status: 'failed', reason: 'lead-messages-model-refusal', usage: used }
    if (parsed.stop_reason === 'pause_turn') return { status: 'failed', reason: 'lead-messages-paused', usage: used }
    let content: Block[], output: ReturnType<typeof proposals>
    try {
      if (parsed.type !== 'message' || parsed.role !== 'assistant' || !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(parsed.stop_reason as string)) fail()
      content = blocks(parsed.content, true)
      safeJson(content)
      if (parsed.stop_reason === 'tool_use' && !content.some(item => item.type === 'tool_use')) fail()
      if (parsed.stop_reason !== 'tool_use' && parsed.stop_reason !== 'max_tokens' && content.some(item => item.type === 'tool_use')) fail()
      output = proposals(string(content.filter(item => item.type === 'text').map(item => item.text).join('\n')))
      // Scans the decoded text as well, so an escaped key cannot hide in JSON-shaped prose.
      safeJson(output)
    } catch { return { status: 'invalid-response', reason: 'lead-messages-output', usage: used } }
    // A checkpoint is words only. A tool call there is never dispatched and the answer is refused.
    if (compaction) return content.some(item => item.type === 'tool_use') || parsed.stop_reason === 'max_tokens'
      ? { status: 'invalid-response', reason: 'lead-messages-checkpoint', usage: used }
      : { status: 'completed', usage: used, text: content.filter(item => item.type === 'text').map(item => item.text).join('\n') }
    const uses = content.flatMap((use, index) => use.type === 'tool_use' ? [{ use, index }] : [])
    const results: MessagesToolResult[] = uses.map(({ use }) => ({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: TOOL_ERROR.refused }))
    const continuation: MessagesTurn[] = [...messages, { role: 'assistant', content }, ...(results.length ? [{ role: 'user' as const, content: results }] : [])]
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength
    const predecessorRefusal = (index: number) => `Tool was not permitted: step ${index} is not yet awaiting acceptance; wait for desk activity.`
    const terminalRefusal = (index: number, reason: string) => `Tool was not permitted: step ${index + 1} cannot start: step ${index}'s result ${reason === 'lead-predecessor-unavailable' ? 'was not accepted' : 'cannot be confirmed'}. Ask the person how to continue.`
    // The placeholder already pays for most diagnostics. Reserve only the extra serialized bytes.
    const extraSpace = (texts: readonly string[]) => Math.max(0, ...texts.map(text => bytes(json(text)) - bytes(json(TOOL_ERROR.refused))))
    const errorSpace = extraSpace([...Object.values(TOOL_ERROR), policyRefusal('desk'), policyRefusal('project')])
    const refusalSpace = extraSpace([predecessorRefusal(LEAD_LIMITS.steps), terminalRefusal(LEAD_LIMITS.steps, 'lead-predecessor-unavailable'), terminalRefusal(LEAD_LIMITS.steps, 'lead-predecessor-unverifiable')])
    const reserved = uses.map(({ use }) => Math.max(errorSpace, use.name === 'flow_start_goal' ? refusalSpace : 0))
    let available: number
    try {
      // Leave room for the next request's fixed tools/model/system wrapper too.
      available = LIMIT.bytes - (bytes(body) - bytes(json(messages))) - bytes(safeJson(continuation)) - reserved.reduce((sum, space) => sum + space, 0)
      if (available < 0) fail()
    } catch { return { status: 'invalid-response', reason: 'lead-messages-continuation-limit', usage: used, toolResults: results } }
    let predecessorReason: string | undefined
    const permissionDeniedTools: string[] = []
    const transientTools: string[] = [], succeededTools: string[] = [], deskActivityTools: string[] = []
    for (const [position, { use, index }] of uses.entries()) {
      available += reserved[position]!
      if (!signal.aborted && parsed.stop_reason !== 'max_tokens') {
        try {
          const call = parseLeadToolCall(use)
          safeJson(call, LIMIT.text)
          const scope = await cancellable(() => resolveTool(structuredClone(call)), signal)
          if (signal.aborted) fail()
          let dispatchError: unknown
          const executed = await journal.execute({ id: `${requestId}/tool/${index}`, request: { method: call.method, params: call.params,
            project: scope.project, runId: scope.runId, start: scope.start }, context: scope.context, stepId: scope.stepId, predecessor: scope.predecessor },
            async (approved, id) => {
              try { return await cancellable(() => dispatch(approved, id, signal), signal) }
              catch (error) { dispatchError = error; throw error }
            })
          if (executed.decision.effect !== 'allow') permissionDeniedTools.push(use.id)
          // Gate reasons are policy facts. Dispatch exceptions are not refusals and raw exceptions may contain secrets.
          const errorText = executed.decision.effect !== 'allow'
            ? executed.decision.rule ? policyRefusal(executed.decision.rule.layer) : `Tool was not permitted: ${executed.decision.reason.slice(0, 240)}`
            : executed.outcome === 'uncertain'
              ? TOOL_ERROR.uncertain
            : dispatchError instanceof LeadToolFencedError
              ? TOOL_ERROR.changed
              : dispatchError instanceof WireCallError && dispatchError.code === 'leadScope'
                ? TOOL_ERROR.scope
              : dispatchError instanceof WireCallError && dispatchError.code === 'leadDeadline'
                ? TOOL_ERROR.deadline
              : dispatchError instanceof WireCallError && dispatchError.code === 'leadRunCap'
                ? TOOL_ERROR.cap
                : TOOL_ERROR.failed
          if (executed.outcome !== 'succeeded') {
            const result = { ...results[position]!, content: errorText }
            const extra = bytes(json(result)) - bytes(json(results[position]))
            // A longer policy reason is useful when it fits; the correlated refusal is already present.
            if (extra <= available) { available -= extra; results[position] = result }
            else if (executed.decision.effect !== 'allow') {
              const fallback = { ...results[position]!, content: TOOL_ERROR.policy }
              available -= bytes(json(fallback)) - bytes(json(results[position]))
              results[position] = fallback
            }
          }

          if (executed.outcome === 'denied' && ['lead-predecessor-unavailable', 'lead-predecessor-unverifiable'].includes(executed.decision.reason)) {
            predecessorReason = executed.decision.reason
            const index = journal.state.contract?.steps.findIndex(step => step.id === scope.stepId) ?? 0
            const result = { ...results[position]!, content: terminalRefusal(index, predecessorReason) }
            available -= bytes(json(result)) - bytes(json(results[position]))
            results[position] = result
          }
          if (executed.outcome === 'denied' && executed.decision.reason === 'lead-predecessor-not-ready') {
            const index = journal.state.contract?.steps.findIndex(step => step.id === scope.stepId) ?? 0
            const result = { ...results[position]!, content: predecessorRefusal(index) }
            const extra = bytes(json(result)) - bytes(json(results[position]))
            results[position] = result; available -= extra
            deskActivityTools.push(use.id)
            transientTools.push(use.id)
          }
          if (
            dispatchError instanceof LeadToolFencedError || executed.outcome === 'failed' &&
            clientTierFor(call.method, call.params) === 'read' && !(dispatchError instanceof LeadToolRefusedError)) transientTools.push(use.id)
          if (executed.outcome === 'failed' && call.method === 'lead/chat/start' && executed.value !== undefined) {
            const result = { ...results[position]!, content: safeJson(executed.value, LIMIT.text), is_error: true }
            const extra = bytes(json(result)) - bytes(json(results[position]))
            if (extra <= available) { results[position] = result; available -= extra }
          }
          if (executed.outcome === 'succeeded') {
            const result = { ...results[position]!, content: safeJson(executed.value ?? null, LIMIT.text), is_error: false }
            const extra = bytes(json(result)) - bytes(json(results[position]))
            if (extra <= available) { results[position] = result; available -= extra; succeededTools.push(use.id) }
            else {
              const overflow = { ...results[position]!, content: TOOL_ERROR.overflow }
              available -= bytes(json(overflow)) - bytes(json(results[position]))
              results[position] = overflow
              transientTools.push(use.id)
            }
          }
        } catch (error) {
          if (error instanceof LeadToolFencedError) transientTools.push(use.id)
          const result = { ...results[position]!, content: error instanceof LeadToolRefusedError
            ? TOOL_ERROR.refused
            : TOOL_ERROR.failed }
          available -= bytes(json(result)) - bytes(json(results[position]))
          results[position] = result
          // No raw exception, argument or credential is echoed.
        }
      }
    }
    return { status: parsed.stop_reason === 'max_tokens' ? 'max-tokens' : signal.aborted ? 'cancelled' : 'completed', usage: used,
      ...(predecessorReason ? { reason: predecessorReason } : {}),
      text: output.text, ...(output.ask ? { ask: output.ask } : {}), ...(output.refs ? { refs: output.refs } : {}), ...(output.proactive ? { proactive: output.proactive } : {}), proposals: { plan: output.plan, cards: output.cards }, toolResults: results, permissionDeniedTools, transientTools, deskActivityTools, succeededTools, messages: continuation }
  } }
}
