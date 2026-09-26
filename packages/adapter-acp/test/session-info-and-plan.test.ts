import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * Two ACP features the adapter used to drop on the floor: a title an agent
 * names live, through `session_info_update` rather than only the next
 * `session/list`, and a plan entry's priority.
 *
 * DSH's own fork emits both on the wire the fake agent below reproduces —
 * see `packages/adapter-acp/test/fixtures/fake-acp-agent.mjs`'s `rename to `
 * and `plan with priority` triggers — and the RFD
 * (agentclientprotocol.com/rfds/session-info-update) lets any ACP agent.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const make = (): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
  })

test('session_info_update names the session live, the same place session/list feeds', async (t) => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()

  const titles: (string | null)[] = []
  runtime.subscribe((event: AgentEvent) => {
    if (event.type === 'session/title') titles.push(event.title)
  })

  const session = await runtime.createSession({ cwd: '/tmp/acp-title' })
  assert.equal(runtime.titleOf(session.id), null, 'nothing named yet')

  await session.send([{ type: 'text', text: 'rename to Debug the checkout flow' }])
  const deadline = Date.now() + 5_000
  while (titles.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual(titles, ['Debug the checkout flow'])
  // The same table `titleOf` reads for `session/list` and `summary()` — a
  // conversation opened right after still shows the live name, not a stale
  // one from before this turn.
  assert.equal(runtime.titleOf(session.id), 'Debug the checkout flow')
})

test('a blank title is not a title — it never reaches a window as a rename', async (t) => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()

  const titles: (string | null)[] = []
  runtime.subscribe((event: AgentEvent) => {
    if (event.type === 'session/title') titles.push(event.title)
  })

  const session = await runtime.createSession({ cwd: '/tmp/acp-title-blank' })
  const turn = await session.send([{ type: 'text', text: 'rename to blank' }])
  const deadline = Date.now() + 5_000
  for (;;) {
    const found = (await runtime.readSession(session.id)).turns.find(({ id }) => id === turn)
    if (found && found.status !== 'inProgress') break
    if (Date.now() > deadline) throw new Error('turn never closed')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(titles, [], 'whitespace said nothing worth showing')
  assert.equal(runtime.titleOf(session.id), null)
})

test('a plan update keeps only entries with words and a status this client draws, and carries priority', async (t) => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()

  const plans: { readonly steps: readonly { readonly step: string; readonly status: string; readonly priority?: string | null }[] }[] = []
  runtime.subscribe((event: AgentEvent) => {
    if (event.type === 'turn/plan') plans.push(event)
  })

  const session = await runtime.createSession({ cwd: '/tmp/acp-plan' })
  await session.send([{ type: 'text', text: 'plan with priority' }])
  const deadline = Date.now() + 5_000
  while (plans.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0]!.steps, [
    { step: 'ship the fix', status: 'inProgress', priority: 'high' },
    { step: 'write the tests', status: 'pending' },
  ])
})
