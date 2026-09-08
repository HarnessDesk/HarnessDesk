import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A fake OpenAI Responses endpoint, for proving what Codex sends and what it
 * will accept — without credits, a network, or an account.
 *
 * It captures each request to `out/req-N.json` and answers with a synthetic
 * `response.*` SSE stream. Codex 0.135.0 accepts this end to end, which is the
 * evidence behind the gateway decision: a translating gateway works, and no fork is needed.
 *
 *   node script/probe/responses-capture.mjs [--port 8791]
 *
 * See script/probe/README.md.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const PORT = Number(arg('port', 8791))
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(OUT, { recursive: true })
let n = 0

http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    n++
    const rec = { n, method: req.method, url: req.url, headers: req.headers, body }
    writeFileSync(join(OUT, `req-${n}.json`), JSON.stringify(rec, null, 1))
    console.log(`[${n}] ${req.method} ${req.url}  ${body.length}B`)

    // Minimal Responses-API SSE: one text message, then completion.
    const id = 'resp_probe1'
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1e3), model: 'probe-model', status: 'in_progress', output: [] }
    send('response.created', { type: 'response.created', response: base, sequence_number: 0 })
    send('response.in_progress', { type: 'response.in_progress', response: base, sequence_number: 1 })
    const item = { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item, sequence_number: 2 })
    send('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 3 })
    const text = 'GATEWAY-OK'
    send('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, sequence_number: 4 })
    send('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text, sequence_number: 5 })
    send('response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] }, sequence_number: 6 })
    const doneItem = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: doneItem, sequence_number: 7 })
    send('response.completed', {
      type: 'response.completed', sequence_number: 8,
      response: { ...base, status: 'completed', output: [doneItem],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } },
    })
    res.end()
  })
}).listen(PORT, '127.0.0.1', () => console.log(`capture gateway on ${PORT}, writing to ${OUT}`))
