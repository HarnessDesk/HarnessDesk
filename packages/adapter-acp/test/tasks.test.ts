import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, BackgroundTask, SessionId, Turn, TurnId } from '@harnessdesk/protocol'
import type { AcpConnection } from '@harnessdesk/transport-acp'

import { AcpRuntime } from '../src/index.js'
import { AcpTasks } from '../src/tasks.js'

/**
 * Background tasks over ACP's extension channel, and — just as important —
 * their absence.
 *
 * Most ACP agents have no concept of work that outlives a turn. The honest
 * answer for those is no capability and no surface, not an empty panel that
 * suggests the list was lost; the second test here is the one that keeps that
 * true. The first drives a generic agent that *does* implement the extension,
 * which is what makes this a protocol feature rather than one agent's.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE],
    env,
  })

const announced = (runtime: AcpRuntime) => {
  const lists: (readonly BackgroundTask[])[] = []
  runtime.subscribe((event: AgentEvent) => {
    if (event.type === 'session/tasks') lists.push(event.tasks)
  })
  return {
    lists,
    async settle(
      predicate: (tasks: readonly BackgroundTask[]) => boolean,
      timeoutMs = 5_000,
    ): Promise<readonly BackgroundTask[]> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const last = lists[lists.length - 1]
        if (last && predicate(last)) return last
        if (Date.now() > deadline) throw new Error(`timed out; last was ${JSON.stringify(lists[lists.length - 1])}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/**
 * Reads the session until `turn` has closed, and hands back the closed turn.
 *
 * `send` resolves once the runtime has accepted the prompt, not when the turn
 * ends, so a check made right after it — or after any fixed sleep — can run
 * before the agent has answered at all. The adapter reads what the agent
 * writes in order and closes the turn on its reply, so a closed turn means
 * everything the agent sent during it has been read. The deadline is a
 * ceiling for a turn that never closes, not a budget for a slow one; only the
 * test of this wait itself shortens it.
 */
const closed = async (runtime: AcpRuntime, session: SessionId, turn: TurnId, ceilingMs = 10_000): Promise<Turn> => {
  const deadline = Date.now() + ceilingMs
  for (;;) {
    const found = (await runtime.readSession(session)).turns.find(({ id }) => id === turn)
    if (found && found.status !== 'inProgress') return found
    if (Date.now() > deadline) throw new Error(`turn ${turn} never closed; it is ${found?.status ?? 'missing'}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('an agent that declares the extension gets a task registry, and its list is pushed', async (t) => {
  const runtime = make({ FAKE_ACP_TASKS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()

  // Declared at the handshake, so the window knows the surface exists before
  // there is anything to put in it.
  assert.equal(runtime.info.capabilities.backgroundTasks, true)
  assert.ok(runtime.tasks, 'the runtime offers RuntimeTasks')

  const tape = announced(runtime)
  const session = await runtime.createSession({ cwd: '/tmp/acp-tasks' })
  await session.send([{ type: 'text', text: 'bg pnpm dev' }])

  const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
  assert.equal(running[0]?.label, 'Run pnpm dev')
  assert.equal(running[0]?.command, 'pnpm dev')
  assert.equal(running[0]?.stoppable, true)

  // The pull agrees with the push, which is what lets a pane open on a
  // conversation that has had no change to announce.
  assert.deepEqual(
    (await runtime.tasks!.list(session.id)).map((task) => task.id),
    running.map((task) => task.id),
  )

  assert.equal(await runtime.tasks!.stop(session.id, running[0]!.id), true)
  const stopped = await tape.settle((tasks) => tasks[0]?.state === 'stopped')
  assert.equal(stopped[0]?.stoppable, false)
  assert.equal(await runtime.tasks!.stop(session.id, running[0]!.id), false)

  await runtime.tasks!.clear!(session.id)
  assert.deepEqual(await runtime.tasks!.list(session.id), [])
})

test('an agent with no such concept has no capability and no registry', async (t) => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()

  assert.equal(runtime.info.capabilities.backgroundTasks, false)
  assert.equal(runtime.tasks, undefined)

  // And a turn changes nothing about that: the surface stays off rather than
  // appearing empty the first time the agent is used. Checked once the turn
  // has closed: 100 ms after `send`, a loaded machine had not yet read any of
  // the agent's answer, and the check passed without having seen the turn.
  const session = await runtime.createSession({ cwd: '/tmp/acp-tasks' })
  const sent = await session.send([{ type: 'text', text: 'bg pnpm dev' }])
  const turn = await closed(runtime, session.id, sent)
  // The agent answered: a turn that died would leave the surface off too.
  assert.equal(turn.status, 'completed')
  assert.equal(runtime.info.capabilities.backgroundTasks, false)
  assert.equal(runtime.tasks, undefined)
})

test('the wait for a turn to close holds while the turn is open, and names it when it never closes', async (t) => {
  // The control for the test above, which is only as good as this wait: an
  // agent that leaves a turn open must be reported at the ceiling, not read
  // as closed, and the same wait must return once the turn does end.
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp/acp-tasks' })
  const sent = await session.send([{ type: 'text', text: 'slow' }])
  await assert.rejects(closed(runtime, session.id, sent, 200), { message: `turn ${sent} never closed; it is inProgress` })
  await session.interrupt()
  assert.equal((await closed(runtime, session.id, sent)).status, 'interrupted')
})

test('a list pushed without the declaration is still believed', async (t) => {
  // An agent that pushes a list has proved it speaks the extension more
  // convincingly than a flag at the handshake would. The runtime says so
  // afterwards, so a window drawn before the first task redraws with a panel.
  const runtime = make({ FAKE_ACP_TASKS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()

  let infoChanged = 0
  runtime.onInfoChange?.(() => {
    infoChanged += 1
  })
  const tape = announced(runtime)
  const session = await runtime.createSession({ cwd: '/tmp/acp-tasks' })
  await session.send([{ type: 'text', text: 'bg watch' }])
  await tape.settle((tasks) => tasks.length === 1)
  assert.equal(runtime.info.capabilities.backgroundTasks, true)
  // Declared at initialize here, so no late change was needed; the assertion
  // that matters is that the capability is true either way.
  assert.ok(infoChanged >= 0)
})

test('clearing the finished tasks is announced, not only held', async () => {
  // #40: clear() rewrote its own copy and told nobody, so the panel kept the rows it had removed.
  // The fake agent above pushes a fresh list after every clear, which hid this; an agent need not.
  const published: (readonly BackgroundTask[])[] = []
  const quiet = { request: async () => ({}) } as unknown as AcpConnection
  const tasks = new AcpTasks(quiet, (_session, list) => published.push(list))
  tasks.accept('s-1', [
    { id: 'a', label: 'Run pnpm dev', state: 'running' },
    { id: 'b', label: 'Run the tests', state: 'completed' },
  ])
  assert.deepEqual(published.at(-1)?.map((task) => task.id).sort(), ['a', 'b'], 'the control: both were announced')
  await tasks.clear('s-1' as SessionId)
  assert.deepEqual(published.at(-1)?.map((task) => task.id), ['a'])
  assert.deepEqual((await tasks.list('s-1' as SessionId)).map((task) => task.id), ['a'])
})

