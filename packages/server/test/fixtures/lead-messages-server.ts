import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import type { MessagesTransport } from '@harnessdesk/lead'

export const LEAD_RIG_KEY = 'sk-ant-test-not-real-0000' // hd-secrets-ok: brief-mandated synthetic key, accepted only by the loopback fixture
export interface ScriptedRequest { readonly id: string; readonly body: Record<string, any>; delivered: boolean }
/** A real loopback Messages endpoint. There is no fallback to a vendor URL. */
export async function leadMessagesServer(reply: (body: Record<string, any>) => unknown[], holdFirst: boolean | (() => boolean) = false, holdRepeated = false) {
  const requests: ScriptedRequest[] = []
  let held: { response: ServerResponse; finish: () => void } | null = null
  let interrupted = false, heldOnce = false
  const server = createServer(async (incoming, response) => {
    try {
      assert.equal(incoming.url, '/v1/messages'); assert.equal(incoming.method, 'POST')
      assert.equal(incoming.headers['x-api-key'], LEAD_RIG_KEY)
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of incoming) { bytes += chunk.length; assert.ok(bytes <= 1_048_576); chunks.push(Buffer.from(chunk)) }
      const entry: ScriptedRequest = { id: String(incoming.headers['x-rig-request-id']), body: JSON.parse(Buffer.concat(chunks).toString()), delivered: false }
      requests.push(entry)
      const finish = () => {
        if (response.destroyed) return
        const content = reply(entry.body)
        entry.delivered = true
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: content.some((one: any) => one.type === 'tool_use') ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }))
      }
      if ((!heldOnce || holdRepeated) && !interrupted && (typeof holdFirst === 'function' ? holdFirst() : holdFirst && requests.length === 1)) { heldOnce = true; held = { response, finish } }
      else finish()
    } catch { response.writeHead(400); response.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const transport: MessagesTransport = { send: input => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/v1/messages', method: 'POST',
      headers: { ...input.headers, 'x-rig-request-id': input.requestId }, signal: input.signal, timeout: holdFirst ? 60_000 : 5000 }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > input.maxResponseBytes) outgoing.destroy(new Error('rig-response-limit')); else chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('timeout', () => outgoing.destroy(new Error('rig-request-timeout')))
    outgoing.once('error', reject); outgoing.end(input.body)
  }) }
  return { requests, transport, get pending() { return held !== null },
    release() { const pending = held; held = null; pending?.finish() },
    interrupt() { interrupted = true; held?.response.destroy(); held = null },
    async close() { held?.response.destroy(); held = null; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
