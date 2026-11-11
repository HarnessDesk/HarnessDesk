import { leadDataContainsCredential } from './journal-security.js'
import type { MessagesTurn } from './messages-types.js'

/** Scan structured prose as well as JSON-escaped strings. Refusals never carry input. */
export const leadContainsSecret = (value: unknown, key?: string): boolean => {
  if (leadDataContainsCredential(value, key ? [key] : [])) return true
  if (typeof value === 'string') {
    if (/sk-ant-[A-Za-z0-9_-]+/.test(value)) return true
    try { const decoded: unknown = JSON.parse(value); return decoded !== value && leadContainsSecret(decoded, key) }
    catch { return false }
  }
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, child]) => leadContainsSecret(name, key) || leadContainsSecret(child, key))
}

/** Check each JSON document, including encoded strings, before allowing a preview token field. */
const hasDuplicateJsonFields = (value: unknown): boolean => {
  if (typeof value === 'string') {
    let decoded: unknown
    try { decoded = JSON.parse(value) } catch { return false }
    const objects: (Set<string> | null)[] = []
    let previous = ''
    for (const [token] of value.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)) {
      if (token === '{') objects.push(new Set())
      else if (token === '[') objects.push(null)
      else if (token === '}' || token === ']') objects.pop()
      else if (token === ':') {
        const name = JSON.parse(previous) as string, names = objects.at(-1)
        if (!names || names.has(name)) return true
        names.add(name)
      }
      previous = token
    }
    return hasDuplicateJsonFields(decoded)
  }
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, child]) =>
    hasDuplicateJsonFields(name) || hasDuplicateJsonFields(child))
}

/** Flow previews mint UUIDs for their next start. Only these two protocol fields omit the credential-name check; their
 * values and every other field still scan. Each block's view is for screening only and never replaces what is sent. */
const screenedBlocks = (messages: readonly MessagesTurn[]) => {
  const flowToken = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const source = value as Record<string, unknown>
    if (typeof source.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.token)) return value
    const { token, ...rest } = source
    return [rest, token]
  }
  const tools = new Map<string, string>()
  return messages.map(turn => turn.content.map(block => {
    if (block.type === 'tool_use') {
      tools.set(block.id, block.name)
      if (block.name === 'flow_start_goal') return { view: { ...block, input: flowToken(block.input) }, refused: false }
    } else if (block.type === 'tool_result' && !block.is_error && tools.get(block.tool_use_id) === 'flow_preview') {
      if (hasDuplicateJsonFields(block.content)) return { view: block, refused: true }
      try { return { view: { ...block, content: flowToken(JSON.parse(block.content)) }, refused: false } }
      catch { /* Non-JSON content keeps the ordinary recursive screen. */ }
    }
    return { view: block, refused: false }
  }))
}

/** The host's last check before a request leaves the machine: any credential-shaped text anywhere in the body. */
export const leadMessagesContainSecret = (body: { readonly messages: readonly MessagesTurn[] }, key: string): boolean => {
  const screened = screenedBlocks(body.messages)
  return screened.some(turn => turn.some(block => block.refused)) ||
    leadContainsSecret({ ...body, messages: body.messages.map((turn, index) => ({ ...turn, content: screened[index]!.map(block => block.view) })) }, key)
}

/** What the model reads in place of a piece of the conversation the desk will not send. */
export const LEAD_WITHHELD_TEXT = 'Withheld by the desk: this part looked like a password, key or token, so it is not sent. Ask the person if you need what it said.'

/** What was withheld from one turn: the kind of block and how many, never what they said. */
export interface LeadWithheldPiece {
  readonly turn: number
  readonly kind: 'text' | 'tool_result' | 'tool_use' | 'thinking'
  readonly count: number
}

/**
 * The conversation with every piece the host's check would refuse put aside, block by block, so one credential-shaped
 * line in a chat read or a person's message costs that piece and not every request after it. A text or a tool result
 * keeps its place and says it was withheld; a tool call keeps its id and name and loses its arguments. Reasoning is
 * signed and cannot be edited: a reasoning block that screens is dropped from an earlier assistant turn, which does not
 * need it, and kept in the latest one, whose tool loop does (the host then refuses the request by name). A turn left
 * with nothing says it was withheld. Turns with nothing to withhold are returned as they were. `withheld` counts what
 * was put aside, by turn and kind, and carries no content.
 */
export const leadWithholdCredentialsReport = (messages: readonly MessagesTurn[], key?: string): { readonly messages: MessagesTurn[]; readonly withheld: LeadWithheldPiece[] } => {
  const screened = screenedBlocks(messages)
  const lastAssistant = messages.findLastIndex(turn => turn.role === 'assistant')
  const withheld: LeadWithheldPiece[] = []
  const result = messages.map((turn, index) => {
    const blocks = screened[index]!
    if (!blocks.some(({ view, refused }) => refused || leadContainsSecret(view, key))) return turn
    const counts = new Map<LeadWithheldPiece['kind'], number>()
    const count = (kind: LeadWithheldPiece['kind']) => counts.set(kind, (counts.get(kind) ?? 0) + 1)
    const content = turn.content.flatMap((block, position) => {
      const { view, refused } = blocks[position]!
      if (!refused && !leadContainsSecret(view, key)) return [block]
      if (block.type === 'text') { count('text'); return [{ type: 'text' as const, text: LEAD_WITHHELD_TEXT }] }
      if (block.type === 'tool_result') { count('tool_result'); return [{ ...block, content: LEAD_WITHHELD_TEXT }] }
      if (block.type === 'tool_use') { count('tool_use'); return [{ ...block, input: {} }] }
      if (index === lastAssistant) return [block]
      count('thinking'); return []
    })
    for (const [kind, total] of counts) withheld.push({ turn: index, kind, count: total })
    if (!counts.size) return turn
    return { ...turn, content: content.length ? content : [{ type: 'text' as const, text: LEAD_WITHHELD_TEXT }] } as MessagesTurn
  })
  return { messages: result, withheld }
}

export const leadWithholdCredentials = (messages: readonly MessagesTurn[], key?: string): MessagesTurn[] =>
  leadWithholdCredentialsReport(messages, key).messages
