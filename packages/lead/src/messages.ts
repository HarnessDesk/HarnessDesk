import { leadToolDefinitions, parseLeadToolCall, LeadToolFencedError, LeadToolRefusedError } from './tools.js'
import { LEAD_LIMITS, clientTierFor, parseLeadAcceptanceContract, parseLeadCard,
  type LeadBudgetEvent, type LeadAcceptanceContract, type LeadCard } from '@harnessdesk/protocol'
import type { LeadPermissionCall } from './permissions.js'
import type { LeadMessagesClient, LeadMessagesOptions, LeadMessagesResult, MessagesHttpResponse, MessagesPrice,
  MessagesRedactedThinking, MessagesText, MessagesThinking, MessagesToolUse, MessagesToolResult, MessagesTurn, MessagesUsage } from './messages-types.js'

/** Configuration defaults only; model choice never changes permissions or behavior. */
export const LEAD_MESSAGES_DEFAULTS = Object.freeze({ model: 'claude-sonnet-5-5', observerModel: 'claude-haiku-5-5', hardPlanModel: 'claude-opus-5-5' })
const LIMIT = Object.freeze({ bytes: 1_048_576, text: 16_384, blocks: 64, turns: 256, nodes: 16_384,
  depth: 24, maxTokens: 65_536, retries: 2, retryMs: 30_000,
  /** One reasoning field (the thinking text, its signature, or redacted data): a reply of the largest
   * allowed `max_tokens` at four characters a token. The whole body is still held to `bytes`. */
  reasoning: 262_144 })
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
/** A continuation may never contain orphan, reordered, duplicate or unanswered results. */
const history = (value: unknown): MessagesTurn[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMIT.turns - 2) return fail()
  let pending: string[] = []
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
        if (!pending.length) {
          const parsed = block(entry)
          if (parsed.type !== 'text') return fail()
          return parsed
        }
        object(entry, ['type', 'tool_use_id', 'content', 'is_error'])
        if (entry.type !== 'tool_result' || entry.tool_use_id !== pending[index] || typeof entry.is_error !== 'boolean') return fail()
        return { type: 'tool_result' as const, tool_use_id: identifier(entry.tool_use_id), content: string(entry.content), is_error: entry.is_error }
      })
      if (pending.length && content.length !== pending.length) fail()
      pending = []
      result.push({ role: 'user', content })
    }
  }
  if (pending.length || result[0]!.role !== 'user' || result.at(-1)!.role !== 'user') fail()
  return result
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
  return { model: string(source.model, 128), max_tokens: maxTokens, stream: false as const,
    messages: history(source.messages), tools: leadToolDefinitions,
    ...(Object.hasOwn(source, 'system') ? { system: string(source.system) } : {}) }
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
const proposals = (text: string): { text: string; plan: LeadAcceptanceContract | null; cards: readonly LeadCard[]; decoded: unknown } => {
  let decoded: unknown = null
  try { decoded = JSON.parse(text) } catch { /* prose */ }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || (decoded as Record<string, unknown>).type !== 'lead-output')
    return { text, plan: null, cards: [], decoded }
  const candidate = decoded
  const source = object(candidate, ['version', 'type', 'text', 'plan', 'cards'])
  if (source.version !== 1) return fail()
  if (source.cards !== undefined && (!Array.isArray(source.cards) || source.cards.length > LIMIT.blocks)) return fail()
  const cards = source.cards === undefined ? [] : (source.cards as unknown[]).map(value => parseLeadCard(value))
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail()
  return { text: source.text === undefined ? '' : string(source.text),
    plan: source.plan === undefined ? null : parseLeadAcceptanceContract(source.plan), cards, decoded }
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
    let requestId: string, body: string, messages: MessagesTurn[], maxTokens: number
    try {
      const captured = JSON.parse(safeJson(input)) as unknown
      const source = object(captured, ['messages', 'system', 'maxTokens', 'proactive', 'wakeSource'])
      messages = history(source.messages)
      maxTokens = integer(source.maxTokens, LIMIT.maxTokens)
      if (maxTokens === 0) fail()
      body = safeJson({ model, max_tokens: maxTokens, stream: false, messages, tools: leadToolDefinitions,
        ...(source.system === undefined ? {} : { system: string(source.system) }) })
      const inputTokens = integer(await cancellable(() => countInput(body, signal), signal))
      requestId = string(nextId(), 100)
      if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(requestId) || requestId.includes(apiKey)) fail()
      if (signal.aborted) return { status: 'cancelled' }
      await journal.updateBudget({ version: 1, type: 'reserve', now: now(), requestId, inputTokens, maxOutputTokens: maxTokens, ...price })
    } catch { return { status: signal.aborted ? 'cancelled' : 'refused', reason: 'lead-messages-admission' } }
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
        return { status: 'failed', reason: response.status === 401 || response.status === 403 ? 'lead-messages-auth' : 'lead-messages-request' }
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
    const uses = content.flatMap((use, index) => use.type === 'tool_use' ? [{ use, index }] : [])
    const results: MessagesToolResult[] = uses.map(({ use }) => ({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Tool refused' }))
    const continuation: MessagesTurn[] = [...messages, { role: 'assistant', content }, ...(results.length ? [{ role: 'user' as const, content: results }] : [])]
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength
    const predecessorRefusal = (index: number) => `Step ${index} is not yet awaiting acceptance; wait for desk activity.`
    const terminalRefusal = (index: number, reason: string) => `Step ${index + 1} cannot start: step ${index}'s result ${reason === 'lead-predecessor-unavailable' ? 'was not accepted' : 'cannot be confirmed'}. Ask the person how to continue.`
    // A preceding read cannot consume the space needed to explain a later start refusal.
    const refusalSpace = Math.max(...[predecessorRefusal(LEAD_LIMITS.steps), terminalRefusal(LEAD_LIMITS.steps, 'lead-predecessor-unavailable'), terminalRefusal(LEAD_LIMITS.steps, 'lead-predecessor-unverifiable')].map(text => bytes(json(text)))) - bytes(json('Tool refused'))
    const reserved = uses.map(({ use }) => use.name === 'flow_start_goal' ? refusalSpace : 0)
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
          if (executed.outcome === 'succeeded') {
            const result = { ...results[position]!, content: safeJson(executed.value ?? null, LIMIT.text), is_error: false }
            const extra = bytes(json(result)) - bytes(json(results[position]))
            if (extra <= available) { results[position] = result; available -= extra; succeededTools.push(use.id) }
            else transientTools.push(use.id)
          }
        } catch (error) {
          if (error instanceof LeadToolFencedError) transientTools.push(use.id)
          // Static correlated error: no raw exception, argument or credential is echoed.
        }
      }
    }
    return { status: parsed.stop_reason === 'max_tokens' ? 'max-tokens' : signal.aborted ? 'cancelled' : 'completed', usage: used,
      ...(predecessorReason ? { reason: predecessorReason } : {}),
      text: output.text, proposals: { plan: output.plan, cards: output.cards }, toolResults: results, permissionDeniedTools, transientTools, deskActivityTools, succeededTools, messages: continuation }
  } }
}
