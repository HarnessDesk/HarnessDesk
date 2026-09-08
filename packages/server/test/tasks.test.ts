import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundTask, Session } from '@harnessdesk/protocol'

import { FAKE_RUNTIME_ID } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'

/**
 * Background tasks through the host.
 *
 * What is under test is the host's one job here: it does not own these lists,
 * it relays them and remembers the last one. So the things that can go wrong
 * are a reloading client losing sight of a running job, a "Clear" that kills
 * live work, and two windows disagreeing about what is alive.
 */

const running = (id: string, label: string): BackgroundTask => ({
  id,
  label,
  kind: 'command',
  state: 'running',
  startedAt: Date.now(),
  stoppable: true,
})

const finished = (id: string, label: string): BackgroundTask => ({
  id,
  label,
  kind: 'command',
  state: 'completed',
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  stoppable: false,
})

const lastTasks = (client: Client): readonly BackgroundTask[] | null => {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    const event = client.events[index]
    if (event?.type === 'session/tasks') return event.tasks
  }
  return null
}

const openSession = async (client: Client): Promise<Session> =>
  (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session

test('a runtime announcing tasks reaches every window, and a new window is caught up', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = await openSession(client)
  harness.runtime.tasks.put(session.id, [running('t1', 'Watch the tests')])
  await client.until(() => lastTasks(client)?.length === 1)
  assert.equal(lastTasks(client)?.[0]?.label, 'Watch the tests')

  // The reload case: a second client gets the list in `sync`, because a job
  // still running is exactly what a window must not forget on ⌘R.
  const second = await Client.connect(harness.server)
  t.after(() => second.close())
  const sync = second.notifications.find(
    (notification): notification is Extract<typeof notification, { method: 'sync' }> =>
      'method' in notification && notification.method === 'sync',
  )
  assert.deepEqual(
    sync?.params.tasks.map((entry) => [entry.sessionId, entry.tasks.map((task) => task.id)]),
    [[session.id, ['t1']]],
  )
})

test('the list can be read on demand, for a pane opening on a quiet conversation', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = await openSession(client)
  // Put the list where only the runtime can see it: no event, so the only way
  // a client learns about it is by asking.
  harness.runtime.taskLists.set(session.id, [running('old', 'Since before this window')])

  const tasks = (await client.call('tasks/list', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
  })) as readonly BackgroundTask[]
  assert.deepEqual(tasks.map((task) => task.id), ['old'])
})

test('stopping ends the task and every window is told', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = await openSession(client)
  harness.runtime.tasks.put(session.id, [running('t1', 'Watch the tests')])
  await client.until(() => lastTasks(client)?.length === 1)

  const first = (await client.call('tasks/stop', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    taskId: 't1',
  })) as { stopped: boolean }
  assert.equal(first.stopped, true)
  await client.until(() => lastTasks(client)?.[0]?.state === 'stopped')

  // The second window pressing the same button is told no, not shown an error.
  const again = (await client.call('tasks/stop', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    taskId: 't1',
  })) as { stopped: boolean }
  assert.equal(again.stopped, false)
})

test('clearing drops the finished rows and leaves running work alone', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = await openSession(client)
  harness.runtime.tasks.put(session.id, [running('live', 'Still going'), finished('done', 'Finished')])
  await client.until(() => lastTasks(client)?.length === 2)

  await client.call('tasks/clear', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.until(() => lastTasks(client)?.length === 1)
  assert.equal(lastTasks(client)?.[0]?.id, 'live')
  assert.equal(lastTasks(client)?.[0]?.state, 'running')
  // And the runtime forgot the same one, so a later read agrees with the panel.
  assert.deepEqual(
    (await harness.runtime.tasks.list(session.id)).map((task) => task.id),
    ['live'],
  )
})

test('a runtime with no registry answers empty rather than failing', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = await openSession(client)
  // Most agents are this one: the surface is absent, and asking anyway is not
  // an error a window has to handle.
  const withoutTasks = harness.runtime as unknown as { tasks?: unknown }
  const held = withoutTasks.tasks
  delete withoutTasks.tasks
  t.after(() => {
    withoutTasks.tasks = held
  })

  assert.deepEqual(
    await client.call('tasks/list', { runtime: FAKE_RUNTIME_ID, sessionId: session.id }),
    [],
  )
  assert.deepEqual(
    await client.call('tasks/stop', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, taskId: 'x' }),
    { stopped: false },
  )
  assert.equal(
    await client.call('tasks/clear', { runtime: FAKE_RUNTIME_ID, sessionId: session.id }),
    null,
  )
})
