#!/usr/bin/env node
/**
 * A scripted stand-in for the `codex` binary.
 *
 * Tests drive the real spawn/framing/correlation paths against this rather than
 * against OpenAI's servers, so the suite needs no credentials, no network, and
 * no credits. Behaviour is selected with FAKE_CODEX_MODE.
 */

import readline from 'node:readline'

const mode = process.env['FAKE_CODEX_MODE'] ?? 'normal'
const version = process.env['FAKE_CODEX_VERSION'] ?? '0.149.0'

if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${version}\n`)
  process.exit(0)
}

if (!process.argv.includes('app-server')) {
  process.stderr.write('fake-codex: expected `app-server`\n')
  process.exit(2)
}

if (mode === 'spawn-crash') process.exit(3)

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

// Exercise the decoder's partial-line handling: split one frame across writes.
const sendSplit = (value) => {
  const line = `${JSON.stringify(value)}\n`
  const mid = Math.floor(line.length / 2)
  process.stdout.write(line.slice(0, mid))
  setTimeout(() => process.stdout.write(line.slice(mid)), 5)
}

let initialized = false
let turnCounter = 0

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.method === 'initialized') {
    initialized = true
    if (mode === 'notify-on-init') sendSplit({ method: 'thread/started', params: { hello: true } })
    return
  }

  // Responses to server-initiated requests come back with an id and no method.
  if (message.id !== undefined && message.method === undefined) {
    send({ method: 'serverRequest/resolved', params: { id: message.id, answer: message.result ?? message.error } })
    return
  }

  const { id, method, params } = message

  if (method === 'initialize') {
    if (mode === 'slow-init') return // never answers, to exercise the timeout
    send({
      id,
      result: {
        userAgent: `fake/${version}`,
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    })
    return
  }

  if (mode === 'crash-on-request' && method === 'thread/start') {
    process.exit(7)
  }

  switch (method) {
    case 'thread/start':
      send({ id, result: { thread: { id: 'thread-1', turns: [] }, model: 'fake-model' } })
      return
    case 'turn/start': {
      turnCounter += 1
      const turnId = `turn-${turnCounter}`
      send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } })
      send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
      if (mode === 'approval') {
        send({
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: params.threadId, turnId, itemId: 'item-1', command: 'rm -rf /', startedAtMs: 1 },
        })
      }
      return
    }
    case 'rpc/error':
      send({ id, error: { code: -32000, message: 'scripted failure', data: { hint: 'expected' } } })
      return
    case 'echo/big': {
      // A payload comfortably larger than a single pipe chunk.
      send({ id, result: { blob: 'x'.repeat(2 * 1024 * 1024) } })
      return
    }
    case 'never/answers':
      return
    default:
      send({ id, result: { ok: true, method, initialized } })
  }
})

process.stdin.on('close', () => process.exit(0))
