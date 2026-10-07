#!/usr/bin/env node
/** Synthetic native MCP selection on create, resume and fork; no turn, isolated agent home. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexAppServer } from '../../packages/codex/dist/src/index.js'
import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'

const root = await mkdtemp(join(tmpdir(), 'hd-mcp-release-'))
const ledger = join(root, 'pids')
const entry = join(root, 'tiny-mcp.mjs')
await writeFile(ledger, '')
await writeFile(entry, `
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ pid: process.pid, name: process.argv[2] }) + '\\n')
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
await writeFile(join(root, 'config.toml'), ['kept', 'excluded.with.dot'].map(name => `[mcp_servers.${JSON.stringify(name)}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, ${JSON.stringify(name)}]\n`).join(''))
const server = new CodexAppServer({ codexHome: root, clientInfo: { name: 'resource-probe', version: '1' }, maxRestarts: 0 })
const pids = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid)
const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const count = async () => (await pids()).filter(running).length
const until = async (read) => {
  const deadline = Date.now() + 75_000
  while (!await read()) {
    if (Date.now() >= deadline) throw new Error('The synthetic MCP child did not reach the expected state.')
    await pause(20)
  }
}
const clean = value => value === null ? undefined : Array.isArray(value) ? value.map(clean) : typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, one]) => one !== null).map(([key, one]) => [key, clean(one)])) : value
let config
try {
  await server.start()
  const native = (await server.request('config/read', { cwd: root })).config.mcp_servers
  config = { mcp_servers: Object.fromEntries(Object.entries(clean(native)).map(([name, spec]) => [name, name === 'excluded.with.dot' ? { ...spec, enabled: false } : spec])) }
  const created = await server.request('thread/start', { cwd: root, config })
  await until(async () => await count() === 1)
  console.log(`version: ${server.installation.version}`)
  console.log(`create: ${await readFile(ledger, 'utf8')}`)
  // Empty threads have no rollout until a turn. Synthesize only the observed
  // session_meta/message shape in this isolated home; never run a model turn.
  const path = join(root, 'synthetic.jsonl')
  await writeFile(path, [
    { type: 'session_meta', payload: { id: created.thread.id, timestamp: new Date().toISOString(), cwd: root, originator: 'resource-probe', cli_version: '0.160.0', source: 'cli', model_provider: 'openai' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic probe' }] } },
  ].map(value => JSON.stringify({ timestamp: new Date().toISOString(), ...value })).join('\n') + '\n')
  await server.stop()
  await until(async () => await count() === 0)
  await server.start()
  await server.request('thread/resume' , { threadId: created.thread.id, path, cwd: root, config })
  await until(async () => await count() === 1)
  console.log(`resume: ${await readFile(ledger, 'utf8')}`)
  await server.stop()
  await until(async () => await count() === 0)
  await server.start()
  await server.request('thread/fork', { threadId: created.thread.id, path, cwd: root, config })
  await until(async () => await count() === 1)
  await server.request('config/mcpServer/reload', {})
  await pause(200)
  const records = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  if (records.length !== 3 || records.some(record => record.name !== 'kept')) throw new Error('A thread loaded an excluded native server.')
  console.log('create/resume/fork: only the selected native server started')
  const defaults = new CodexAppServer({ codexHome: root, clientInfo: { name: 'defaults-probe', version: '1' }, maxRestarts: 0 })
  try {
    await defaults.start()
    await defaults.request('thread/start', { cwd: root })
    await until(async () => await count() === 3)
    console.log('unrestricted concurrent thread: both configured servers started')
  } finally { await defaults.stop() }
  await server.stop()
  await until(async () => await count() === 0)
  const runtime = new CodexRuntime({ codexHome: root, maxRestarts: 0 })
  try {
    await runtime.start()
    const narrowed = await runtime.createSession({ cwd: root, runtimeServers: ['kept'] })
    await until(async () => await count() === 1)
    const ordinary = await runtime.createSession({ cwd: root })
    await until(async () => await count() === 3)
    const none = await runtime.createSession({ cwd: root, runtimeServers: [] })
    if (await count() !== 3 || runtime.resourceProcessIds().length !== 1) throw new Error('The adapter did not preserve the independent selections and roots.')
    await narrowed.close()
    await until(async () => await count() === 2)
    await ordinary.close()
    await none.close()
    await until(async () => await count() === 0)
    if (!await runtime.stopForIdle() || runtime.resourceProcessIds().length !== 0) throw new Error('The adapter did not release its idle roots.')
    console.log('production adapter: selected/default/empty selections coexist; close releases only its helpers; idle roots are zero')
  } finally { await runtime.dispose() }
} finally {
  await server.stop()
  // Only the synthetic child recorded by this isolated probe may be cleaned.
  for (const pid of await pids()) if (running(pid)) process.kill(pid, 'SIGTERM')
  await rm(root, { recursive: true, force: true })
}
