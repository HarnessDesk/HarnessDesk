import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { Session } from '@harnessdesk/protocol'

import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, halt, start } from './fixtures/harness.js'

/**
 * #156: a rollback is the conversation dropping its last turns, and the host's
 * transcript store has to hear it. Untold, a read after a relaunch from an
 * agent that serves the conversation but not its past, as an ACP agent
 * restarted out of its idle sessions does, was filled in from the store, and
 * the dropped turns came back.
 */

/** What the agent said in each turn, in order: the fake answers `echo: <text>`. */
const spoken = (turns: Session['turns']): string[] =>
  turns.map((turn) =>
    turn.items
      .map((item) => (item as { text?: unknown }).text)
      .filter((text): text is string => typeof text === 'string' && text.startsWith('echo:'))
      .join(''),
  )

/** The turns the last `session/started` this window was pushed carried, if any. */
const lastRead = (client: Client): Session['turns'] | null => {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    const event = client.events[index]
    if (event?.type === 'session/started') return event.session.turns
  }
  return null
}

/** A conversation of three finished turns, one, two and three, all of them on disk. */
const threeTurns = async () => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  // The fake keeps no history of its own to undo: what a rollback trims here is the host's copy and its store.
  ;(live as unknown as { rollback(turns: number): Promise<void> }).rollback = async () => {}
  for (const text of ['one', 'two', 'three']) {
    const done = client.events.filter((event) => event.type === 'turn/completed').length
    await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text }] })
    live.finish()
    await client.until(() => client.events.filter((event) => event.type === 'turn/completed').length > done)
  }
  // Where the store keeps it, spelled as the store spells it.
  const file = join(harness.stateDir, 'transcripts', encodeURIComponent(FAKE_RUNTIME_ID), `${encodeURIComponent(session.id)}.json`)
  const onDisk = (): string[] =>
    existsSync(file) ? spoken((JSON.parse(readFileSync(file, 'utf8')) as { turns: Session['turns'] }).turns) : []
  await client.until(() => onDisk().length === 3, 5_000, 'three turns on disk')
  let halted = false
  const close = async (): Promise<void> => {
    if (halted) return
    halted = true
    client.close()
    await halt(harness)
  }
  return { harness, client, session, file, onDisk, close }
}

/**
 * The host started again on the state a halted one left, as a relaunch does,
 * with an agent that serves the conversation and, unless `past` is given, none
 * of its past. What a read shows then is what the transcript store kept.
 */
const reopened = async (stateDir: string, session: Session, past?: Session['turns']): Promise<Session> => {
  const again = await start({}, stateDir)
  try {
    again.runtime.minted.set(String(session.id), '/w')
    if (past) again.runtime.stored.set(session.id, past)
    const client = await Client.connect(again.server)
    try {
      return (await client.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })) as Session
    } finally {
      client.close()
    }
  } finally {
    await halt(again)
  }
}

test('a rollback reaches the transcript store, and after a relaunch the dropped turn stays gone (#156)', async () => {
  const { harness, client, session, file, onDisk, close } = await threeTurns()
  try {
    // The turns as the agent lists them once it has dropped the last: their ids, with nothing in them.
    const theirs = (JSON.parse(readFileSync(file, 'utf8')) as { turns: Session['turns'] }).turns
      .slice(0, 2)
      .map((turn) => ({ ...turn, items: [] }))
    await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 1 })
    // Which turns survive, not only how many: the last one went (review of #236, round 1).
    assert.deepEqual(onDisk(), ['echo: one', 'echo: two'])
    await close()
    // An agent that serves none of the conversation's past: the read is the store's alone.
    assert.deepEqual(spoken((await reopened(harness.stateDir, session)).turns), ['echo: one', 'echo: two'])
    // The control: an agent that serves its own history, trimmed by its own rollback and thinner than the host's
    // copy, is filled in to the same two turns. So it would be with the dropped turn still on disk, since a turn the
    // agent no longer lists is never brought back: only an agent that serves no past shows the difference.
    assert.deepEqual(spoken((await reopened(harness.stateDir, session, theirs)).turns), ['echo: one', 'echo: two'])
  } finally {
    await close()
    await rm(harness.stateDir, { recursive: true, force: true })
  }
})

/**
 * #259: a rollback is a conversation changing under every window that has it
 * open, and each of them has to hear it. Untold, the pane that asked and any
 * other window on the same conversation went on drawing the turns that are
 * gone, until something happened to read the conversation again.
 */
test('a rollback reaches a second window, which drops the turns without asking (#259)', async () => {
  const { harness, client, session, close } = await threeTurns()
  const other = await Client.connect(harness.server)
  try {
    // A window opened on a conversation that already has its three turns: what
    // it hears about them afterwards is the whole of what it knows.
    await other.until(() => other.notifications.some((message) => 'method' in message && message.method === 'sync'))
    const caughtUp = other.notifications.find((message) => 'method' in message && message.method === 'sync') as
      | { params: { sessions: Session[] } }
      | undefined
    const synced = caughtUp?.params.sessions.find((entry) => entry.id === session.id)
    assert.deepEqual(spoken(synced?.turns ?? []), ['echo: one', 'echo: two', 'echo: three'])

    await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 1 })

    // The control, asked first so it answers whether or not anything was
    // pushed: the host trimmed its own copy either way, and a window reading
    // the conversation again is exactly what being told is meant to replace.
    const read = (await other.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })) as Session
    assert.deepEqual(spoken(read.turns), ['echo: one', 'echo: two'])

    // The conversation as it now stands, at the window that asked for none of it.
    await other.until(() => lastRead(other) !== null, 5_000, 'the second window to be told')
    assert.deepEqual(spoken(lastRead(other) ?? []), ['echo: one', 'echo: two'])
    // And at the one that asked, which had nothing else to tell it either.
    await client.until(() => lastRead(client) !== null, 5_000, 'the window that asked to be told')
    assert.deepEqual(spoken(lastRead(client) ?? []), ['echo: one', 'echo: two'])
  } finally {
    other.close()
    await close()
    await rm(harness.stateDir, { recursive: true, force: true })
  }
})

test('a rollback of every turn forgets the transcript, and after a relaunch nothing comes back (#156)', async () => {
  const { harness, client, session, file, close } = await threeTurns()
  try {
    await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 1 })
    await client.call('session/rollback', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, turns: 2 })
    assert.equal(existsSync(file), false)
    await close()
    assert.deepEqual((await reopened(harness.stateDir, session)).turns, [])
  } finally {
    await close()
    await rm(harness.stateDir, { recursive: true, force: true })
  }
})
