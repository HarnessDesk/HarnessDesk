import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CursorAcpBridge } from '../src/bridge.js'
import { tempDir } from './scratch.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))
const WORKDIR = tempDir('cursor-acp-prompt-')
const STATE = tempDir('cursor-acp-idx-')
const CURSOR_HOME = tempDir('cursor-acp-home-')

test('concurrent session/prompt calls for the same session reject immediately with turn already running (#417)', async () => {
  process.env['CURSOR_ACP_COMMAND'] = FAKE
  process.env['CURSOR_ACP_STATE_DIR'] = STATE
  process.env['CURSOR_CONFIG_DIR'] = CURSOR_HOME

  const input = new PassThrough()
  const output = new PassThrough()
  const bridge = new CursorAcpBridge({ command: FAKE, input, output })
  const serving = bridge.serve()

  const responses = new Map<number, Record<string, unknown>>()
  const rl = createInterface({ input: output })
  rl.on('line', (line) => {
    if (line.trim() === '') return
    const msg = JSON.parse(line) as Record<string, unknown>
    if (typeof msg['id'] === 'number') responses.set(msg['id'], msg)
  })

  const send = (msg: unknown) => input.write(JSON.stringify(msg) + '\n')

  send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: WORKDIR } })
  while (!responses.has(1)) {
    await new Promise((r) => setTimeout(r, 10))
  }

  const newRes = responses.get(1)
  const sessionId = (newRes?.['result'] as { sessionId?: string })?.sessionId
  assert.ok(sessionId)

  // Send two prompts concurrently
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'be slow about it' }] },
  })
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'concurrent prompt' }] },
  })

  // Wait for the second prompt response
  const started = Date.now()
  while (!responses.has(3) && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 10))
  }

  const res3 = responses.get(3)
  assert.ok(res3, 'prompt 3 should receive an immediate response')
  const err = res3['error'] as { code?: number; message?: string } | undefined
  assert.ok(err, 'prompt 3 should fail with an error')
  assert.match(err?.message ?? '', /a turn is already running in this session/)

  // Cancel the first turn and clean up
  send({ jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId } })
  const cancelStart = Date.now()
  while (!responses.has(4) && Date.now() - cancelStart < 3000) {
    await new Promise((r) => setTimeout(r, 10))
  }
  rl.close()
  input.end()
  await serving
})
