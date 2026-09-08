import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * The per-conversation verbs — rollback, compact, memory, review — each map to
 * a Codex request. The point worth a test is that they reach the right method
 * with the right shape; the fake echoes the call so it is observable.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const notices = (events: AgentEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'notice' ? [event.message] : []))

const start = async (t: { after(fn: () => Promise<void>): void }) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  const session = await runtime.createSession({ cwd: '/w' })
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out; saw ${notices(events).join(', ')}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { runtime, session, events, until }
}

test('every session verb the runtime declares is implemented', async (t) => {
  const { runtime, session } = await start(t)
  const capabilities = runtime.info.capabilities
  assert.ok(capabilities.undo && typeof session.rollback === 'function')
  assert.ok(capabilities.compaction && typeof session.compact === 'function')
  assert.ok(capabilities.memory && typeof session.setMemoryMode === 'function')
  assert.ok(capabilities.review && typeof session.review === 'function')
})

test('rollback sends the turn count', async (t) => {
  const { session, events, until } = await start(t)
  await session.rollback!(2)
  await until(() => notices(events).includes('ROLLBACK 2'))
})

test('memory mode maps on and off to Codex enabled/disabled', async (t) => {
  const { session, events, until } = await start(t)
  await session.setMemoryMode!(true)
  await until(() => notices(events).includes('MEMORY enabled'))
  await session.setMemoryMode!(false)
  await until(() => notices(events).includes('MEMORY disabled'))
})

test('compaction reaches Codex and surfaces its own marker', async (t) => {
  const { session, events, until } = await start(t)
  await session.compact!()
  await until(() => notices(events).some((message) => /compacted/i.test(message)))
})

test('review passes the target kind and delivery through', async (t) => {
  const { session, events, until } = await start(t)
  await session.review!({ type: 'uncommitted', delivery: 'detached' })
  await until(() => notices(events).includes('REVIEW uncommittedChanges detached'))
  await session.review!({ type: 'commit', sha: 'abc' })
  await until(() => notices(events).includes('REVIEW commit default'))
})
