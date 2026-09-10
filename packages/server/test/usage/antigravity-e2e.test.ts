import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent } from '@harnessdesk/protocol'

import { antigravityUsageRecord } from '../../src/usage/antigravity-store.js'

/**
 * The store reader through the real adapter and a real agent process: the
 * adapter's fake agent, told to keep an Antigravity-shaped conversation store
 * the way Antigravity's server does — open for as long as it runs — and to
 * put nothing about usage on the wire. What the ring would draw is what the
 * adapter records, so that is what is read back.
 */
const FAKE = fileURLToPath(new URL('../../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

test('through the adapter, each turn is what the agent wrote down, and a turn with no model call is a turn of nothing', async (t) => {
  const gemini = mkdtempSync(join(tmpdir(), 'hd-agy-e2e-'))
  const runtime = new AcpRuntime({
    id: 'antigravity-acp',
    name: 'Antigravity',
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_AGY_STORE: gemini },
    usageRecord: antigravityUsageRecord({ env: { GEMINI_HOME: gemini } }),
  })
  // In the order they must run: the agent lets go of its store first.
  t.after(() => runtime.dispose())
  t.after(() => rmSync(gemini, { recursive: true, force: true }))
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  const session = await runtime.createSession({ cwd: gemini })
  const completed = (): number => events.filter((event) => event.type === 'turn/completed').length
  const turn = async (text: string): Promise<void> => {
    const before = completed()
    await session.send([{ type: 'text', text }])
    const deadline = Date.now() + 10_000
    while (completed() === before) {
      if (Date.now() > deadline) throw new Error(`the turn "${text}" never completed`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const usage = async () => (await runtime.readSession(session.id)).usage

  // Two calls a turn, the context growing call on call — see the fixture.
  await turn('hello there')
  assert.deepEqual((await usage())?.last, {
    totalTokens: 25506,
    inputTokens: 24800,
    cachedInputTokens: 20600,
    outputTokens: 706,
    reasoningOutputTokens: 430,
  })
  await turn('hello again')
  assert.deepEqual((await usage())?.last, {
    totalTokens: 38506,
    inputTokens: 37800,
    cachedInputTokens: 33600,
    outputTokens: 706,
    reasoningOutputTokens: 430,
  })
  assert.equal((await usage())?.total.totalTokens, 25506 + 38506, 'turns add up, none counted twice')

  await turn('deleg nothing')
  assert.deepEqual(
    (await usage())?.last,
    { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    'the last turn is this one, and it spent nothing',
  )
  assert.equal((await usage())?.total.totalTokens, 25506 + 38506, 'and the session total is unchanged')
})
