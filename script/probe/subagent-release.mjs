#!/usr/bin/env node
/**
 * A seat whose agent spawns a sub-agent: what does closing the seat leave behind?
 *
 * Two seats in one app-server, each with one synthetic tool server per thread,
 * against a loopback provider that answers a turn that says `SPAWN` with a
 * `spawn_agent` call and everything else with text. An isolated agent home, no
 * account, nothing leaves this machine. The desk unsubscribes from the first
 * seat only, and from the second seat and its sub-agent, then watches.
 *
 *   pnpm build:node && node script/probe/subagent-release.mjs [--watch 100]
 *
 * See script/probe/README.md.
 */
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexAppServer } from '../../packages/codex/dist/src/index.js'

const flag = process.argv.indexOf('--watch')
const watch = (flag === -1 ? 100 : Number(process.argv[flag + 1])) * 1_000
const root = await mkdtemp(join(tmpdir(), 'hd-subagent-release-'))
const ledger = join(root, 'pids')
const entry = join(root, 'tiny-mcp.mjs')
await writeFile(ledger, '')
await writeFile(entry, `
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ledger)}, process.pid + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'resource-probe', version: '1' } }
    : { tools: [] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
})
process.stdin.on('end', () => process.exit(0))
`)

let answered = 0
const provider = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const n = ++answered
    const spawns = /SPAWN/.test(body) && !body.includes('function_call_output')
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: `resp_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1e3), model: 'probe-model', status: 'in_progress', output: [] }
    send('response.created', { type: 'response.created', response: base, sequence_number: 0 })
    let item
    if (spawns) {
      item = { id: `fc_${n}`, type: 'function_call', status: 'completed', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: JSON.stringify({ message: 'say hello' }), call_id: `call_${n}` }
      send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' }, sequence_number: 1 })
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item, sequence_number: 2 })
    } else {
      item = { id: `msg_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
      send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] }, sequence_number: 1 })
      send('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 2 })
      send('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK', sequence_number: 3 })
      send('response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0], sequence_number: 4 })
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item, sequence_number: 5 })
    }
    send('response.completed', { type: 'response.completed', sequence_number: 6, response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } })
    res.end()
  })
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
await writeFile(join(root, 'config.toml'), `model = "probe-model"
model_provider = "loopback"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.loopback]
name = "Loopback"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"
supports_websockets = false

[mcp_servers.resource_probe]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(entry)}]
`)

const server = new CodexAppServer({ codexHome: root, clientInfo: { name: 'resource-probe', version: '1' }, maxRestarts: 0, env: { PROBE_API_KEY: 'x', PATH: process.env.PATH } })
const pids = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(Number)
const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const alive = async () => (await pids()).filter(running).length
const names = {}
const label = (ids) => JSON.stringify(ids.map((id) => names[id] ?? id).sort())
const finished = new Map()
const t0 = Date.now()
const at = () => `${Math.round((Date.now() - t0) / 1000)} s`
try {
  await server.start()
  server.onNotification((notification) => {
    if (notification.method === 'turn/completed') finished.get(notification.params.threadId)?.()
    if (notification.method === 'thread/closed') console.log(`${at()}: ${names[notification.params.threadId] ?? 'thread'} closed`)
  })
  console.log(`version: ${server.installation.version}`)
  const seat = async (name) => {
    const started = await server.request('thread/start', { cwd: root })
    names[started.thread.id] = name
    const done = new Promise((resolve) => finished.set(started.thread.id, resolve))
    await server.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'SPAWN', text_elements: [] }] })
    await Promise.race([done, pause(15_000)])
    return started.thread.id
  }
  const first = await seat('first seat')
  const second = await seat('second seat')
  await pause(2_000)
  for (const id of (await server.request('thread/loaded/list', {})).data) {
    if (names[id]) continue
    const parent = (await server.request('thread/read', { threadId: id, includeTurns: false })).thread.parentThreadId
    names[id] = `sub-agent of the ${names[parent] ?? parent}`
  }
  console.log(`loaded: ${label((await server.request('thread/loaded/list', {})).data)}; processes: ${await alive()}`)
  const subOfSecond = Object.keys(names).find((id) => names[id] === 'sub-agent of the second seat')
  await server.request('thread/unsubscribe', { threadId: first })
  await server.request('thread/unsubscribe', { threadId: second })
  console.log(`unsubscribed the first seat only, and the second seat with its sub-agent: ${(await server.request('thread/unsubscribe', { threadId: subOfSecond })).status}`)
  let last = ''
  const until = Date.now() + watch
  while (Date.now() < until) {
    const line = `loaded: ${label((await server.request('thread/loaded/list', {})).data)}; processes: ${await alive()}`
    if (line !== last) { console.log(`${at()}: ${line}`); last = line }
    await pause(1_000)
  }
} finally {
  await server.stop()
  provider.close()
  // Only the synthetic processes recorded by this isolated probe may be cleaned.
  for (const pid of await pids()) if (running(pid)) process.kill(pid, 'SIGTERM')
  await rm(root, { recursive: true, force: true })
}
