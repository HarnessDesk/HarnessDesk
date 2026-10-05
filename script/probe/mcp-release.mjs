#!/usr/bin/env node
/** One thread, one synthetic MCP child, no turn and an isolated agent home. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexAppServer } from '../../packages/codex/dist/src/index.js'

const root = await mkdtemp(join(tmpdir(), 'hd-mcp-release-'))
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
await writeFile(join(root, 'config.toml'), `[mcp_servers.resource_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}]\n`)
const server = new CodexAppServer({ codexHome: root, clientInfo: { name: 'resource-probe', version: '1' }, maxRestarts: 0 })
const pids = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(Number)
const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const count = async () => (await pids()).filter(running).length
const until = async (read) => {
  const deadline = Date.now() + 10_000
  while (!await read()) {
    if (Date.now() >= deadline) throw new Error('The synthetic MCP child did not reach the expected state.')
    await pause(20)
  }
}
try {
  await server.start()
  const started = await server.request('thread/start', { cwd: root, ephemeral: true })
  await until(async () => await count() === 1)
  console.log(`version: ${server.installation.version}`)
  console.log(`children after start: ${await count()}`)
  const released = await server.request('thread/unsubscribe', { threadId: started.thread.id })
  console.log(`unsubscribe: ${released.status}`)
  await pause(1_000)
  console.log(`children one second after unsubscribe: ${await count()}`)
  await server.stop()
  await until(async () => await count() === 0)
  console.log(`children after app-server exit: ${await count()}`)
} finally {
  await server.stop()
  // Only the synthetic child recorded by this isolated probe may be cleaned.
  for (const pid of await pids()) if (running(pid)) process.kill(pid, 'SIGTERM')
  await rm(root, { recursive: true, force: true })
}
