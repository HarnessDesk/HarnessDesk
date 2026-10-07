#!/usr/bin/env node
/**
 * Two threads in one app-server, each with one synthetic tool server that
 * starts a child of its own, no turn and an isolated agent home: when does
 * Codex let go of a thread the desk has unsubscribed from, and what goes with it?
 *
 *   pnpm build:node && node script/probe/mcp-release.mjs [--wait 90]
 *
 * It waits for `thread/closed`, which Codex sends a minute after the last
 * subscriber leaves an idle thread, so a run takes about that long.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexAppServer } from '../../packages/codex/dist/src/index.js'

const flag = process.argv.indexOf('--wait')
const wait = (flag === -1 ? 90 : Number(process.argv[flag + 1])) * 1_000
const root = await mkdtemp(join(tmpdir(), 'hd-mcp-release-'))
const ledger = join(root, 'pids')
const entry = join(root, 'tiny-mcp.mjs')
const grandchild = join(root, 'tiny-helper.mjs')
await writeFile(ledger, '')
await writeFile(grandchild, `
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ledger)}, process.pid + '\\n')
setInterval(() => {}, 1_000)
`)
await writeFile(entry, `
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ledger)}, process.pid + '\\n')
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' }).unref()
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
const until = async (read, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!await read()) {
    if (Date.now() >= deadline) throw new Error('The synthetic processes did not reach the expected state.')
    await pause(20)
  }
}
const closed = new Set()
try {
  await server.start()
  server.onNotification((notification) => { if (notification.method === 'thread/closed') closed.add(notification.params.threadId) })
  const first = await server.request('thread/start', { cwd: root, ephemeral: true })
  await server.request('thread/start', { cwd: root, ephemeral: true })
  await until(async () => await count() === 4)
  console.log(`version: ${server.installation.version}`)
  console.log(`processes after starting two threads: ${await count()}`)
  const released = await server.request('thread/unsubscribe', { threadId: first.thread.id })
  console.log(`unsubscribe the first: ${released.status}`)
  await pause(1_000)
  console.log(`processes one second after: ${await count()}`)
  const began = Date.now()
  while (!closed.has(first.thread.id) && Date.now() - began < wait) await pause(500)
  if (!closed.has(first.thread.id)) throw new Error(`Codex did not close the thread within ${wait / 1_000} s.`)
  await pause(500)
  console.log(`thread/closed after ${Math.round((Date.now() - began) / 1_000) + 1} s; processes then: ${await count()}`)
  await server.stop()
  await until(async () => await count() === 0)
  console.log(`processes after app-server exit: ${await count()}`)
} finally {
  await server.stop()
  // Only the synthetic processes recorded by this isolated probe may be cleaned.
  for (const pid of await pids()) if (running(pid)) process.kill(pid, 'SIGTERM')
  await rm(root, { recursive: true, force: true })
}
