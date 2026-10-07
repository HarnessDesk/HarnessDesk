#!/usr/bin/env node
/**
 * N seats on one Codex account: how many processes do they hold, and how much
 * resident memory? Each seat is a new thread with one synthetic tool helper
 * (a tiny Node child, standing in for the tool servers an agent's own
 * configuration names). An isolated `CODEX_HOME`, a loopback provider that
 * answers nothing, no sign-in and no turn: nothing leaves this machine.
 *
 *   pnpm build:node && node script/probe/seat-processes.mjs [1,3,8]
 *   SEAT_PROCESSES_LIST=1 lists each process it counted.
 *
 * It counts what hangs under this script, so a seat's own process (if the
 * runtime gives it one), its helper and the launcher in front of each
 * app-server all show. See script/probe/README.md.
 */
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'

const COUNTS = (process.argv[2] ?? '1,3,8').split(',').map(Number)
const root = await mkdtemp(join(tmpdir(), 'hd-seat-processes-'))
const ledger = join(root, 'helpers')
const entry = join(root, 'tiny-tool-server.mjs')
await writeFile(ledger, '')
await writeFile(entry, `
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ledger)}, process.pid + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'seat-probe', version: '1' } }
    : { tools: [] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
})
process.stdin.on('end', () => process.exit(0))
`)
const nothing = http.createServer((_, res) => { res.writeHead(404).end() })
await new Promise((resolve) => nothing.listen(0, '127.0.0.1', resolve))
await writeFile(join(root, 'config.toml'), `model = "probe-model"
model_provider = "loopback"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.loopback]
name = "Loopback"
base_url = "http://127.0.0.1:${nothing.address().port}/v1"
env_key = "PROBE_API_KEY"
wire_api = "responses"
supports_websockets = false

[mcp_servers.seat_probe]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(entry)}]
`)

const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const helperPids = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(Number)
const until = async (read, message) => {
  const deadline = Date.now() + 30_000
  while (!await read()) {
    if (Date.now() >= deadline) throw new Error(message)
    await pause(50)
  }
}

/** Everything alive under this script, by kind. */
const measure = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => {
      const [pid, ppid, rss, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(' ') }
    })
  const below = new Set([process.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) if (!below.has(row.pid) && below.has(row.ppid)) { below.add(row.pid); grew = true }
  }
  below.delete(process.pid)
  const mine = rows.filter((row) => below.has(row.pid) && !row.command.startsWith('<defunct>') && !row.command.startsWith('ps -axo'))
  const counted = () => mine.filter((row) => kind(row) !== 'other')
  const kind = (row) => row.command.includes('tiny-tool-server') ? 'helper'
    : /(^|\/)codex app-server/.test(row.command) && !/^\S*node\b/.test(row.command) ? 'app-server'
      : /app-server/.test(row.command) ? 'launcher' : 'other'
  if (process.env.SEAT_PROCESSES_LIST) {
    for (const row of mine) console.log(`  ${kind(row).padEnd(10)} ${String(Math.round(row.rss / 1024)).padStart(4)} MB  ${row.command.slice(0, 110)}`)
  }
  const count = (name) => mine.filter((row) => kind(row) === name).length
  const mb = (rows) => Math.round(rows.reduce((sum, row) => sum + row.rss, 0) / 1024)
  return {
    appServers: count('app-server'), launchers: count('launcher'), helpers: count('helper'),
    processes: counted().length, appServerMb: mb(mine.filter((row) => ['app-server', 'launcher'].includes(kind(row)))), totalMb: mb(counted()),
  }
}

const table = []
try {
  for (const seats of COUNTS) {
    const before = (await helperPids()).length
    const runtime = new CodexRuntime({ codexHome: root, clientName: 'seat-processes-probe', maxRestarts: 0, env: { PROBE_API_KEY: 'x' } })
    try {
      await runtime.start()
      const sessions = []
      for (let n = 0; n < seats; n++) sessions.push(await runtime.createSession({ cwd: root }))
      await until(async () => (await helperPids()).length - before === seats, `${seats} helpers did not start`)
      await pause(2_000)
      table.push({ seats, ...measure() })
      await Promise.all(sessions.map((session) => session.close()))
    } finally {
      await runtime.dispose()
    }
    await until(async () => (await helperPids()).every((pid) => !running(pid)), 'helpers outlived the runtime')
    await pause(500)
  }
  console.log('seats  app-servers  launchers  helpers  processes  app-server MB  total MB')
  for (const row of table) {
    console.log([row.seats, row.appServers, row.launchers, row.helpers, row.processes, row.appServerMb, row.totalMb]
      .map((value, index) => String(value).padStart([5, 11, 9, 7, 9, 13, 8][index])).join('  '))
  }
} finally {
  nothing.close()
  // Only helpers recorded by this isolated run may be cleaned.
  for (const pid of await helperPids()) if (running(pid)) process.kill(pid, 'SIGTERM')
  await rm(root, { recursive: true, force: true })
}
