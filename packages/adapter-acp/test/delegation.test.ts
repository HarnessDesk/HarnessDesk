import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentItem, Session, SubagentItem } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * The delegation extension, client side, against a generic ACP agent.
 *
 * Not Claude-specific on purpose: what is under test is the adapter's own
 * arithmetic and its placement of rows, which any agent implementing the
 * extension gets. Each case here is a sequence that produced a wrong reading
 * before — a child outliving the turn that started it, an output count that
 * is a floor, and a running total that claimed to be exact after a silent
 * turn.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const WORKDIR = mkdtempSync(join(tmpdir(), 'acp-delegation-'))
after(() => rmSync(WORKDIR, { recursive: true, force: true }))

const make = (): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env: {},
  })

const subagents = (session: Session): readonly { turn: number; item: SubagentItem }[] =>
  session.turns.flatMap((turn, index) =>
    turn.items
      .filter((item: AgentItem): item is SubagentItem => item.type === 'subagent')
      .map((item) => ({ turn: index, item })),
  )

/** Sends one prompt and waits for the turn to close. */
const ask = async (
  session: { send(input: readonly { type: 'text'; text: string }[]): Promise<unknown> },
  text: string,
): Promise<void> => {
  await session.send([{ type: 'text', text }])
  // The delegation push is a notification, not part of the prompt reply, so
  // it can land a tick after the turn closes.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('a child that outlives its turn is updated where it started, not appended to the turn in flight', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(session, 'deleg spawn')

    const started = subagents(await runtime.readSession(session.id))
    assert.equal(started.length, 1, 'one row after the first turn')
    assert.equal(started[0]?.turn, 0)
    assert.equal(started[0]?.item.status, 'inProgress')

    // A second turn, during which the *first* turn's child reports that it
    // finished. The list is pushed whole every time anything in it moves, so
    // this payload names a delegation turn 2 never made.
    await ask(session, 'deleg finish')

    const after = subagents(await runtime.readSession(session.id))
    assert.equal(after.length, 1, 'still one row — the child was not duplicated into turn 2')
    assert.equal(after[0]?.turn, 0, 'and it stayed on the turn that started it')
    assert.equal(after[0]?.item.status, 'completed', 'updated in place rather than left stuck')
    assert.equal(after[0]?.item.usage?.totalTokens, 12)
  } finally {
    await runtime.dispose()
  }
})

test('an output count that is still a floor stays a floor across the boundary', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(session, 'deleg floor')

    const [row] = subagents(await runtime.readSession(session.id))
    assert.ok(row)
    assert.equal(row.item.usage?.outputTokens, 1)
    // The whole point: 1 is what was counted, not what was produced. Without
    // the flag the interface can only render "1 token" for a child that may
    // have written a thousand lines.
    assert.equal(row.item.usage?.outputExact, false)
    assert.equal(row.item.members[0]?.usage?.outputExact, false)

    const usage = (await runtime.readSession(session.id)).usage
    assert.equal(usage?.delegated?.outputExact, false, 'and the session share says so too')
  } finally {
    await runtime.dispose()
  }
})

test('an exact delegation carries no exactness claim at all', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })
    await ask(session, 'deleg spawn')
    const [row] = subagents(await runtime.readSession(session.id))
    // Absent, not `true`: writing the flag on every ordinary reading would
    // make an unremarkable count look like a claim.
    assert.equal(row?.item.usage?.outputExact, undefined)
  } finally {
    await runtime.dispose()
  }
})

test('a session total drops its cache-write count once any turn is silent about writes', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: WORKDIR })

    await ask(session, 'writes')
    const first = (await runtime.readSession(session.id)).usage
    assert.equal(first?.last.cacheWriteTokens, 50)
    assert.equal(first?.total.cacheWriteTokens, 50, 'one reporting turn is a knowable total')

    // A turn that says nothing about writes. Summing it as zero would leave
    // an exact-looking 50 for a conversation whose second half is unknown.
    await ask(session, 'nowrites')
    const second = (await runtime.readSession(session.id)).usage
    assert.equal(second?.last.cacheWriteTokens, undefined)
    assert.equal(second?.total.cacheWriteTokens, undefined, 'the total is unknown, not 50')

    // And it does not come back: the gap is permanent, so a later reporting
    // turn cannot make the whole conversation look measured again.
    await ask(session, 'writes')
    const third = (await runtime.readSession(session.id)).usage
    assert.equal(third?.last.cacheWriteTokens, 50)
    assert.equal(third?.total.cacheWriteTokens, undefined)
  } finally {
    await runtime.dispose()
  }
})
