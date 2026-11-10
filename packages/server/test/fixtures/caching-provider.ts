import { createHash } from 'node:crypto'

/**
 * A scripted Messages provider that keeps a prompt cache the way the real one is documented to: the prefix is tools,
 * then system, then messages, block by block; a request writes the prefix up to each `cache_control` mark, and reads
 * the longest prefix written before that ends at a mark or up to 20 blocks before one. Tokens are bytes / 3.5. No
 * endpoint or credential is ever consulted.
 */
export interface CachedUsage { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number }
export interface CachingRequest { readonly body: any; readonly usage: CachedUsage }
type Answer = (body: any) => { readonly content: unknown[]; readonly stop_reason?: string } | { readonly status: number; readonly body: string; readonly processing?: 'not-started' }

const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3.5)
const unmarked = (block: any) => { const { cache_control: _mark, ...rest } = block; return rest }

export const cachingProvider = (answer: Answer) => {
  const written = new Set<string>(), requests: CachingRequest[] = []
  return {
    requests,
    async send(request: { readonly body: string }) {
      const body = JSON.parse(request.body)
      const reply = answer(body)
      if ('status' in reply) return { status: reply.status, body: reply.body, ...(reply.processing ? { processing: reply.processing } : {}) }
      const units: { readonly value: unknown; readonly marked: boolean }[] = [
        ...(body.tools ?? []).map((tool: any) => ({ value: unmarked(tool), marked: !!tool.cache_control })),
        ...(Array.isArray(body.system) ? body.system : [{ type: 'text', text: body.system ?? '' }]).map((block: any) => ({ value: unmarked(block), marked: !!block.cache_control })),
        ...body.messages.flatMap((turn: any) => turn.content.map((block: any) => ({ value: { role: turn.role, block: unmarked(block) }, marked: !!block.cache_control }))),
      ]
      const hashes: string[] = [], sums: number[] = []
      let hash = '', sum = 0
      for (const unit of units) {
        hash = createHash('sha256').update(hash).update(JSON.stringify(unit.value)).digest('hex')
        sum += tokens(unit.value)
        hashes.push(hash); sums.push(sum)
      }
      const marks = units.flatMap((unit, index) => unit.marked ? [index] : [])
      let read = 0
      for (const mark of marks) for (let at = mark; at >= Math.max(0, mark - 20); at--) if (written.has(hashes[at]!)) { read = Math.max(read, sums[at]!); break }
      const end = marks.length ? sums[marks.at(-1)!]! : 0
      for (const mark of marks) written.add(hashes[mark]!)
      const cacheWrite = Math.max(0, end - read), input = Math.max(0, sum - read - cacheWrite), output = tokens(reply.content)
      const usage = { input, cacheRead: read, cacheWrite, output }
      requests.push({ body, usage })
      return { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: reply.content, stop_reason: reply.stop_reason ?? 'end_turn',
        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: cacheWrite } }) }
    },
  }
}
