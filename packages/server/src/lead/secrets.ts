import { leadDataContainsCredential, type MessagesTurn } from '@harnessdesk/lead'
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

/** Flow previews mint UUIDs for their next start. Only these two protocol fields
 * omit the credential-name check; their values and every other field still scan.
 * This view is for screening only and never replaces the transported body. */
export const leadMessagesContainSecret = (body: { readonly messages: readonly MessagesTurn[] }, key: string): boolean => {
  const flowToken = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const source = value as Record<string, unknown>
    if (typeof source.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.token)) return value
    const { token, ...rest } = source
    return [rest, token]
  }
  const tools = new Map<string, string>()
  const messages = body.messages.map(turn => ({ ...turn, content: turn.content.map(block => {
    if (block.type === 'tool_use') {
      tools.set(block.id, block.name)
      if (block.name === 'flow_start_goal') return { ...block, input: flowToken(block.input) }
    } else if (block.type === 'tool_result' && !block.is_error && tools.get(block.tool_use_id) === 'flow_preview') {
      try { return { ...block, content: flowToken(JSON.parse(block.content)) } }
      catch { /* Non-JSON content keeps the ordinary recursive screen. */ }
    }
    return block
  }) }))
  return leadContainsSecret({ ...body, messages }, key)
}
