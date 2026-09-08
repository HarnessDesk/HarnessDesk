#!/usr/bin/env node
/**
 * The same task, twice: DeepSeek Harness driven directly over its own ACP
 * server, and DeepSeek Harness driven through HarnessDesk's wire.
 *
 * The point is not that both work — it is what each path sees. Direct ACP is
 * the floor: whatever HarnessDesk shows that this run does not, HarnessDesk
 * added; whatever this run carries that HarnessDesk drops, HarnessDesk lost.
 * Both halves matter, so both are printed.
 *
 *   DEEPSEEK_API_KEY=… node script/dsh-compare.mjs [--port 4180] [--token …]
 *
 * With no token it reads one out of a host log named by `--log` or
 * HARNESSDESK_HOST_LOG. Exits non-zero if either path fails to produce the
 * artifact.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'

// `ws` is the server's dependency, not this script's: resolve it from there
// rather than pinning a version this file would have to keep up with.
const { default: WebSocket } = await import(
  createRequire(new URL('../packages/server/package.json', import.meta.url)).resolve('ws'),
)

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PROFILE = join(homedir(), '.dsh/profiles/harnessdesk')

/**
 * Where DeepSeek Harness is checked out. It is not vendored here — HarnessDesk
 * drives whatever the registry points at — so this reads the same answer the
 * app uses: the `dsh` agent's own working directory, with `DSH_HARNESS_DIR` as
 * the override for a checkout that is not the registered one.
 */
const registeredDsh = () => {
  try {
    const registry = JSON.parse(readFileSync(join(homedir(), '.harnessdesk/agents.json'), 'utf8'))
    return registry.agents?.find((agent) => agent.id === 'dsh')?.cwd ?? null
  } catch {
    return null
  }
}
const DSH = process.env.DSH_HARNESS_DIR ?? registeredDsh()
if (!DSH || !existsSync(DSH)) {
  console.error(
    'dsh-compare: no DeepSeek Harness checkout found.\n' +
      'Set DSH_HARNESS_DIR=<path to deepseek-harness>, or register the `dsh` agent with its cwd.',
  )
  process.exit(2)
}
const CONFIG = join(PROFILE, 'harnessdesk.cordis.yml')
const PORT = arg('port', '4180')
const TASK =
  'Create a file named proof.txt in this folder whose only line is exactly: hello from dsh. ' +
  'Write the file and stop. Do not run any commands.'

const line = (label, value) => console.log(`${label.padEnd(30)} ${value}`)
const section = (title) => console.log(`\n[1m${title}[0m\n${'─'.repeat(64)}`)

// ─────────────────────────────────────────────── path A: DSH's ACP, directly

const runDirect = async (cwd) => {
  const started = Date.now()
  const child = spawn(
    'node',
    ['--import', 'tsx', `${DSH}/packages/examples/acp-demo/src/bin.ts`, '--config', CONFIG],
    {
      cwd: DSH,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: join(PROFILE, 'node_modules') },
    },
  )
  const out = { notifications: [], stderr: '', capabilities: null, stopReason: null, error: null }
  child.stderr.on('data', (b) => (out.stderr += b.toString()))

  let buffer = ''
  let nextId = 0
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const raw = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!raw.trim()) continue
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message ?? 'rpc error')) : resolve(msg.result)
      } else if (msg.method) {
        out.notifications.push(msg.method)
      }
    }
  })

  const call = (method, params) => {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      sleep(180_000).then(() => pending.has(id) && reject(new Error(`${method} timed out`)))
    })
  }

  try {
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    out.capabilities = init.agentCapabilities
    const session = await call('session/new', { cwd, mcpServers: [] })
    const answer = await call('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: TASK }],
    })
    out.stopReason = answer.stopReason
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
  } finally {
    child.kill('SIGTERM')
  }
  out.ms = Date.now() - started
  return out
}

// ───────────────────────────────────────── path B: DSH through HarnessDesk

const runThroughDesk = async (cwd, token) => {
  const started = Date.now()
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`)
  const out = { events: [], items: [], error: null, stopReason: null }
  const pending = new Map()
  let nextId = 0

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.method === 'event') {
      const event = msg.params.event
      out.events.push(event.type)
      if (event.type === 'item/started' || event.type === 'item/completed') {
        out.items.push(event.item?.type ?? '?')
      }
      if (event.type === 'turn/completed') out.stopReason = event.turn?.status ?? 'completed'
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error?.message ?? 'wire error'))
    }
  })

  const call = (method, params) => {
    const id = ++nextId
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      sleep(180_000).then(() => pending.has(id) && reject(new Error(`${method} timed out`)))
    })
  }

  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await call('host/hello', { clientVersion: '0.1.0' })
    const session = await call('session/create', { runtime: 'dsh', options: { cwd } })
    await call('turn/send', {
      runtime: 'dsh',
      sessionId: session.id,
      input: [{ type: 'text', text: TASK }],
    })
    const deadline = Date.now() + 180_000
    while (!out.events.includes('turn/completed') && Date.now() < deadline) await sleep(500)
    // What the host kept, which is the half a direct run cannot have.
    const read = await call('session/read', { runtime: 'dsh', sessionId: session.id })
    out.persisted = read.turns.flatMap((turn) => turn.items).map((item) => item.type)
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
  } finally {
    socket.close()
  }
  out.ms = Date.now() - started
  return out
}

// ────────────────────────────────────────────────────────────────── compare

// The host prints its wire token once, as `?token=<64 hex>`. Point this at
// wherever that output was kept: `--log <path>`, or HARNESSDESK_HOST_LOG as a
// colon-separated list. Nothing is guessed — with no log and no `--token`,
// the run asks for one rather than reading a stranger's file.
const tokenFromLog = () => {
  for (const path of [arg('log', null), ...(process.env.HARNESSDESK_HOST_LOG ?? '').split(':')]) {
    if (!path || !existsSync(path)) continue
    const found = readFileSync(path, 'utf8').match(/\?token=([a-f0-9]{64})/g)
    if (found?.length) return found[found.length - 1].slice('?token='.length)
  }
  return null
}

const artifact = (dir) => {
  const path = join(dir, 'proof.txt')
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
}

const main = async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is not set; both paths need it.')
    process.exit(2)
  }
  const token = arg('token', tokenFromLog())
  if (!token) {
    console.error('No wire token: pass --token, or start the host so its log carries one.')
    process.exit(2)
  }

  const dirA = mkdtempSync(join(tmpdir(), 'dsh-direct-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-desk-'))

  section('The same task, both ways')
  line('task', JSON.stringify(TASK.slice(0, 52) + '…'))
  line('direct workspace', dirA)
  line('desk workspace', dirB)

  console.log('\nrunning both…')
  const [direct, desk] = await Promise.all([runDirect(dirA), runThroughDesk(dirB, token)])

  const wroteA = artifact(dirA)
  const wroteB = artifact(dirB)

  section('Result')
  const rows = [
    ['', 'DSH direct (ACP)', 'DSH through HarnessDesk'],
    ['wrote the file', wroteA ? 'yes' : 'NO', wroteB ? 'yes' : 'NO'],
    ['file contents', JSON.stringify(wroteA), JSON.stringify(wroteB)],
    ['stop reason', direct.stopReason ?? '—', desk.stopReason ?? '—'],
    ['seconds', (direct.ms / 1000).toFixed(1), (desk.ms / 1000).toFixed(1)],
    ['error', direct.error ?? 'none', desk.error ?? 'none'],
  ]
  for (const [a, b, c] of rows) console.log(`${a.padEnd(20)} ${String(b).padEnd(26)} ${c}`)

  section('What each path saw')
  const tally = (list) =>
    [...list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())]
      .map(([k, n]) => `${k}×${n}`)
      .join('  ') || '(none)'
  line('direct: ACP notifications', tally(direct.notifications))
  line('direct: capabilities', JSON.stringify(direct.capabilities?.promptCapabilities ?? {}))
  line('desk: wire events', tally(desk.events))
  line('desk: items rendered', tally(desk.items))
  line('desk: items persisted', tally(desk.persisted ?? []))

  section('What HarnessDesk added, and what it cost')
  const added = []
  if ((desk.persisted ?? []).length > 0) added.push('a transcript the host kept (session/read after the turn)')
  if (desk.events.includes('turn/completed')) added.push('typed turn lifecycle events')
  if (desk.items.length > 0) added.push(`structured items (${new Set(desk.items).size} kinds) instead of raw frames`)
  added.push('one permission policy, audit log, worktrees, and the roster — not exercised by this task')
  for (const item of added) console.log(`  + ${item}`)
  console.log('  − HarnessDesk plugin tools: dsh-acp refuses a non-empty mcpServers,')
  console.log('    so the tool bridge is withdrawn for this agent (see the host log).')
  if (direct.stderr.match(/error/i)) {
    console.log(`  ! direct stderr mentioned an error: ${direct.stderr.match(/.*error.*/i)[0].slice(0, 90)}`)
  }

  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
  const ok = Boolean(wroteA) && Boolean(wroteB)
  console.log(`\n${ok ? '✓ both paths produced the artifact' : '✗ at least one path failed'}`)
  process.exit(ok ? 0 : 1)
}

await main()
