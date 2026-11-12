import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'
import { testProcessEnv } from './fixtures/test-process-env.js'

/**
 * Carry-on's evidence from the agent's side (the design's §11.5): a turn that
 * ends on an account's usage limit reaches the host as `credits`, the one code
 * the host carries a conversation on from without asking the meter first.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

test('a turn that hits the usage limit ends failed, coded as credits, in Codex’s own words', async (t) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, env: testProcessEnv({ FAKE_CODEX_MODE: 'limit' }) })
  await runtime.start()
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))

  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'Fix the failing build.' }])
  const deadline = Date.now() + 8_000
  const ended = () => events.find((event) => event.type === 'turn/completed')
  while (!ended()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the turn to end')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  const completed = ended()
  assert.ok(completed?.type === 'turn/completed')
  assert.equal(completed.turn.status, 'failed')
  assert.equal(completed.turn.error?.code, 'credits')
  assert.match(completed.turn.error?.message ?? '', /usage limit/)
  assert.notEqual(completed.turn.error?.retrying, true, 'a limit Codex will not retry is not one the host waits out')
})
