import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, BackgroundTask } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * Codex's background terminals as background tasks.
 *
 * The point under test is the join: Codex's list knows only what is *alive*
 * and its item stream knows only what *happened*, so neither alone can answer
 * "what is running, since when, and how did the last one end". The fake plays
 * both halves in the shapes the real app-server uses — a `unifiedExecStartup`
 * item with a `processId`, and a list that simply stops naming a process when
 * it dies.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const started = async (t: { after(fn: () => Promise<void>): void }): Promise<CodexRuntime> => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

const record = (runtime: CodexRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

const settle = async (
  read: () => Promise<readonly BackgroundTask[]>,
  predicate: (tasks: readonly BackgroundTask[]) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<readonly BackgroundTask[]> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tasks = await read()
    if (predicate(tasks)) return tasks
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last was ${JSON.stringify(tasks)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const ask = async (
  session: { send(input: readonly { type: 'text'; text: string }[]): Promise<unknown> },
  text: string,
): Promise<void> => {
  await session.send([{ type: 'text', text }])
  await new Promise((resolve) => setTimeout(resolve, 60))
}

test('the runtime says it keeps a background-task registry', async (t) => {
  const runtime = await started(t)
  assert.equal(runtime.info.capabilities.backgroundTasks, true)
})

test('a shell session the agent leaves running is a task, with what the poll knows about it', async (t) => {
  const runtime = await started(t)
  const events = record(runtime)
  const session = await runtime.createSession({ cwd: '/w' })

  await ask(session, 'bg tail -f server.log')
  const tasks = await settle(
    () => runtime.tasks.list(session.id),
    (list) => list.length === 1,
    'the shell session to be listed',
  )

  const [task] = tasks
  assert.equal(task?.state, 'running')
  assert.equal(task?.kind, 'command')
  assert.equal(task?.label, 'tail -f server.log')
  assert.equal(task?.cwd, '/w')
  assert.equal(task?.stoppable, true)
  // The item stream is where the transcript row comes from; the poll is where
  // the process figures do. Both halves, or the panel is missing one of them.
  assert.equal(task?.itemId, 'call-bg1')
  assert.equal(task?.osPid, 40001)
  assert.equal(task?.rssKb, 20480)
  assert.ok(typeof task?.startedAt === 'number' && task.startedAt > 0)

  // And it was announced, not only answerable — a panel that had to poll would
  // be a panel that is always a few seconds behind.
  const announced = events.filter(
    (event): event is Extract<AgentEvent, { type: 'session/tasks' }> => event.type === 'session/tasks',
  )
  assert.ok(announced.length > 0, 'the runtime announced the list')
  assert.equal(announced[announced.length - 1]?.sessionId, session.id)
})

test('a process that dies is finished, because the list stops naming it', async (t) => {
  const runtime = await started(t)
  const session = await runtime.createSession({ cwd: '/w' })

  await ask(session, 'bg sleep 600')
  const [running] = await settle(() => runtime.tasks.list(session.id), (list) => list.length === 1, 'a running task')

  await ask(session, `endbg ${running!.id}`)
  const finished = await settle(
    () => runtime.tasks.list(session.id),
    (list) => list.every((task) => task.state !== 'running'),
    'the task to be noticed gone',
  )
  assert.equal(finished[0]?.state, 'completed')
  assert.equal(finished[0]?.stoppable, false)
  assert.ok(typeof finished[0]?.endedAt === 'number')
  // Codex forgets the process entirely, so the live figures go with it rather
  // than freezing at whatever the last poll happened to catch.
  assert.equal(finished[0]?.osPid, undefined)
})

test('a startup that failed is failed, and never had a process to poll for', async (t) => {
  const runtime = await started(t)
  const session = await runtime.createSession({ cwd: '/w' })

  await ask(session, 'failbg ./missing-binary')
  const tasks = await settle(
    () => runtime.tasks.list(session.id),
    (list) => list.length === 1,
    'the failed startup',
  )
  assert.equal(tasks[0]?.state, 'failed')
  assert.equal(tasks[0]?.label, './missing-binary')
})

test('stopping terminates it; stopping it again says no rather than throwing', async (t) => {
  const runtime = await started(t)
  const session = await runtime.createSession({ cwd: '/w' })

  await ask(session, 'bg pnpm test --watch')
  const [running] = await settle(() => runtime.tasks.list(session.id), (list) => list.length === 1, 'a running task')

  assert.equal(await runtime.tasks.stop(session.id, running!.id), true)
  const stopped = await runtime.tasks.list(session.id)
  assert.equal(stopped[0]?.state, 'stopped')

  assert.equal(await runtime.tasks.stop(session.id, running!.id), false)
  assert.equal(await runtime.tasks.stop(session.id, 'never-existed'), false)
})

test('clearing forgets the finished ones and leaves the running ones alone', async (t) => {
  const runtime = await started(t)
  const session = await runtime.createSession({ cwd: '/w' })

  await ask(session, 'bg one --forever')
  await ask(session, 'bg two --forever')
  const both = await settle(() => runtime.tasks.list(session.id), (list) => list.length === 2, 'two tasks')
  await ask(session, `endbg ${both[0]!.id}`)
  await settle(
    () => runtime.tasks.list(session.id),
    (list) => list.some((task) => task.state !== 'running'),
    'one of them to end',
  )

  await runtime.tasks.clear(session.id)
  const left = await runtime.tasks.list(session.id)
  assert.deepEqual(
    left.map((task) => task.state),
    ['running'],
  )
})
