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
  let duplicatePreview = false
  const messages = body.messages.map(turn => ({ ...turn, content: turn.content.map(block => {
    if (block.type === 'tool_use') {
      tools.set(block.id, block.name)
      if (block.name === 'flow_start_goal') return { ...block, input: flowToken(block.input) }
    } else if (block.type === 'tool_result' && !block.is_error && tools.get(block.tool_use_id) === 'flow_preview') {
      if (hasDuplicateJsonFields(block.content)) { duplicatePreview = true; return block }
      try { return { ...block, content: flowToken(JSON.parse(block.content)) } }
      catch { /* Non-JSON content keeps the ordinary recursive screen. */ }
    }
    return block
  }) }))
  return duplicatePreview || leadContainsSecret({ ...body, messages }, key)
}
