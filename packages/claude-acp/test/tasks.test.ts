import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratch } from './scratch.js'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, BackgroundTask } from '@harnessdesk/protocol'

import { TaskRegistry } from '../src/tasks.js'

/**
 * Background tasks, both halves.
 *
 * The unit half replays the message shapes Claude Code 2.1.240 was observed
 * emitting; the end-to-end half drives the real bridge and the real ACP
 * adapter against the fake CLI, so the extension channel — the notification,
 * the list, the stop — is exercised on the wire rather than asserted about.
 */

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const WORKDIR = scratch('claude-acp-tasks-')

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'claude-code',
    name: 'Claude Code',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CLAUDE_CODE_EXECUTABLE: FAKE,
      CLAUDE_ACP_STATE_DIR: scratch('claude-acp-tasks-state-'),
      CLAUDECODE: '',
      ...env,
    },
  })

// ------------------------------------------------------------------- the unit

test('a backgrounded command becomes a running task, with the command it ran', () => {
  const registry = new TaskRegistry(() => 1_000)
  registry.observe({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'sleep 25; echo done', description: 'Sleep 25s then echo', run_in_background: true },
        },
      ],
    },
  })
  assert.equal(registry.list().length, 0, 'a tool use alone is not yet a task')

  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'ba2vfthh3', task_type: 'local_bash', description: 'Sleep 25s then echo' }],
  })
  registry.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'ba2vfthh3',
    tool_use_id: 'toolu_1',
    description: 'Sleep 25s then echo',
    is_backgrounded: true,
    task_type: 'local_bash',
  })

  const [task] = registry.list()
  assert.equal(task?.id, 'ba2vfthh3')
  assert.equal(task?.state, 'running')
  assert.equal(task?.kind, 'command')
  assert.equal(task?.label, 'Sleep 25s then echo')
  // The command lives only on the tool_use block; a panel without it can say
  // what the agent called the job but not what it actually ran.
  assert.equal(task?.command, 'sleep 25; echo done')
  assert.equal(task?.stoppable, true)
})

test('a task the user stopped is stopped, not completed', () => {
  const registry = new TaskRegistry(() => 2_000)
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'x1', task_type: 'local_bash', description: 'Watch the tests' }],
  })
  registry.observe({ type: 'system', subtype: 'task_updated', task_id: 'x1', patch: { status: 'killed', end_time: 1_900 } })
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'x1',
    status: 'stopped',
    output_file: '/tmp/x1.output',
    summary: 'Watch the tests',
  })
  registry.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })

  const [task] = registry.list()
  assert.equal(task?.state, 'stopped')
  assert.equal(task?.stoppable, false)
  assert.equal(task?.outputFile, '/tmp/x1.output')
})

test('an empty running set retires whatever it no longer names', () => {
  const registry = new TaskRegistry(() => 3_000)
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'One' }],
  })
  registry.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  assert.deepEqual(
    registry.list().map((task) => [task.id, task.state, task.endedAt]),
    [['a', 'completed', 3_000]],
  )
})

test('the name a task started with is the name it keeps', () => {
  // Claude Code's closing summary is a sentence about how it went, not a
  // name. Letting it become the label renames the row at the moment it ends
  // — and then truncates it, which is how this was noticed.
  const registry = new TaskRegistry(() => 4_500)
  registry.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'w1',
    description: 'Run pnpm tests in watch mode',
    task_type: 'local_bash',
  })
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'w1',
    status: 'failed',
    summary: 'Background command "Run pnpm tests in watch mode" failed with exit code 1',
  })
  const [task] = registry.list()
  assert.equal(task?.label, 'Run pnpm tests in watch mode')
  assert.equal(task?.summary, 'Background command "Run pnpm tests in watch mode" failed with exit code 1')
})

test('a task nothing ever named falls back to the summary rather than its id', () => {
  const registry = new TaskRegistry(() => 4_600)
  registry.observe({ type: 'system', subtype: 'task_notification', task_id: 'z9', status: 'completed', summary: 'The build finished' })
  assert.equal(registry.list()[0]?.label, 'The build finished')
})

test('a finished task is never dragged back to running', () => {
  const registry = new TaskRegistry(() => 4_000)
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'late',
    status: 'failed',
    summary: 'It broke',
  })
  // Claude Code's running set and its per-task messages race on the stream;
  // an out-of-order set must not resurrect something that has already ended.
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'late', task_type: 'local_bash', description: 'It broke' }],
  })
  assert.equal(registry.list()[0]?.state, 'failed')
})

test('a finished task waits for its output until it is handed one, and only once', () => {
  const registry = new TaskRegistry(() => 7_000)
  registry.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'o1',
    description: 'Run the tests',
    task_type: 'local_bash',
  })
  // Running: there is nothing to read yet, whatever the file will say.
  assert.deepEqual(registry.awaitingOutput(), [])
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'o1',
    status: 'completed',
    output_file: '/tmp/o1.output',
    summary: 'Run the tests',
  })
  assert.deepEqual(registry.awaitingOutput(), [{ id: 'o1', outputFile: '/tmp/o1.output' }])
  assert.equal(registry.attachOutput('o1', 'pass 1\n', true), true)
  assert.deepEqual(registry.awaitingOutput(), [])
  assert.equal(registry.list()[0]?.output, 'pass 1\n')
  assert.equal(registry.list()[0]?.outputTruncated, true)
  // The same text again changes nothing, so nothing is published twice.
  assert.equal(registry.attachOutput('o1', 'pass 1\n', true), false)
  assert.equal(registry.attachOutput('nobody', 'x'), false)
})

test('a task whose output was never found says so, and is not asked about again', () => {
  const registry = new TaskRegistry(() => 7_500)
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'gone',
    status: 'completed',
    output_file: '/tmp/gone.output',
    summary: 'Ran the build',
  })
  assert.deepEqual(registry.awaitingOutput().map((task) => task.id), ['gone'])
  assert.equal(registry.markOutputMissing('gone'), true)
  assert.equal(registry.list()[0]?.outputMissing, true)
  assert.equal(registry.list()[0]?.output, undefined)
  assert.deepEqual(registry.awaitingOutput(), [])
  // Said once: a second mark changes nothing, so nothing is published twice.
  assert.equal(registry.markOutputMissing('gone'), false)
  assert.equal(registry.markOutputMissing('nobody'), false)
  // And output that turns up after all is output: the mark gives way.
  assert.equal(registry.attachOutput('gone', 'after all'), true)
  assert.equal(registry.list()[0]?.outputMissing, undefined)
})

test('a task that ends before anything named it takes its name and kind from the tool-use block', () => {
  // Seen on the real wire: a shell that fails in its first millisecond is
  // announced as over before `task_started` or the running set has said it
  // started, so the closing summary — a whole sentence about how it went —
  // was becoming the row's name, and the row's kind stayed unknown.
  const registry = new TaskRegistry(() => 8_000)
  registry.observe({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fast',
          name: 'Bash',
          input: { command: 'node --test test/', description: 'Run test suite in background', run_in_background: true },
        },
      ],
    },
  })
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'fast',
    tool_use_id: 'toolu_fast',
    status: 'failed',
    output_file: '/tmp/fast.output',
    summary: 'Background command "Run test suite in background" failed with exit code 1',
  })
  const [task] = registry.list()
  assert.equal(task?.label, 'Run test suite in background')
  assert.equal(task?.kind, 'command')
  assert.equal(task?.command, 'node --test test/')
  assert.equal(task?.summary, 'Background command "Run test suite in background" failed with exit code 1')
  assert.equal(task?.state, 'failed')
})

test('a summary standing in for a name gives way when the name finally arrives', () => {
  // The other order: the notification first and the block after it, or the
  // running set carrying the description a moment later.
  const registry = new TaskRegistry(() => 9_000)
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'late-name',
    tool_use_id: 'toolu_late',
    status: 'completed',
    summary: 'Background command "Watch the build" completed',
  })
  assert.equal(registry.list()[0]?.label, 'Background command "Watch the build" completed')
  // And the block *announces* the change: the client's own refresh answers
  // from the last push, so a rename that was not pushed was a rename nobody
  // saw — which is exactly how the second live take still read the summary.
  const announced = registry.observe({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_late',
          name: 'Bash',
          input: { command: 'pnpm build --watch', description: 'Watch the build', run_in_background: true },
        },
      ],
    },
  })
  assert.equal(announced, true)
  const [task] = registry.list()
  assert.equal(task?.label, 'Watch the build')
  assert.equal(task?.kind, 'command')
  assert.equal(task?.summary, 'Background command "Watch the build" completed')
  // And a name given once is kept: a second summary does not rename it.
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'late-name',
    status: 'completed',
    summary: 'Background command "Watch the build" completed again',
  })
  assert.equal(registry.list()[0]?.label, 'Watch the build')
  // A block that only waits for its task — nothing to rename yet — is quiet.
  assert.equal(
    registry.observe({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_unclaimed',
            name: 'Bash',
            input: { command: 'sleep 9', description: 'Wait', run_in_background: true },
          },
        ],
      },
    }),
    false,
  )
})

test('on the 2.1.258 wire the tool result is the start, and a TaskOutput read is the end', () => {
  // Traced on the real wire: no `task_started`, no `background_tasks_changed`,
  // a notification with no `tool_use_id`. The backgrounded call's own result
  // names the task and its file; a `TaskOutput` read says how it went.
  let clock = 10_000
  const registry = new TaskRegistry(() => clock)
  registry.observe({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_modern',
          name: 'Bash',
          input: { command: 'node --test test/', description: 'Run all tests in background', run_in_background: true },
        },
      ],
    },
  })
  clock = 12_000
  assert.equal(
    registry.observe({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_modern',
            content: 'Command running in background with ID: bdff13a. Output is being written to: /tmp/tasks/bdff13a.output',
          },
        ],
      },
    }),
    true,
  )
  let [task] = registry.list()
  assert.equal(task?.id, 'bdff13a')
  assert.equal(task?.label, 'Run all tests in background')
  assert.equal(task?.kind, 'command')
  assert.equal(task?.state, 'running')
  assert.equal(task?.command, 'node --test test/')
  assert.equal(task?.startedAt, 10_000)
  assert.equal(task?.outputFile, '/tmp/tasks/bdff13a.output')
  assert.equal(task?.stoppable, true)

  clock = 15_000
  registry.observe({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_read',
          content: [{ type: 'text', text: '<retrieval_status>success</retrieval_status>\n\n<task_id>bdff13a</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>failed</status>\n\n<exit_code>1</exit_code>\n\n<output>\nboom\n</output>' }],
        },
      ],
    },
  })
  ;[task] = registry.list()
  assert.equal(task?.state, 'failed')
  assert.equal(task?.endedAt, 15_000)

  clock = 28_000
  registry.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'bdff13a',
    status: 'failed',
    output_file: '/tmp/tasks/bdff13a.output',
    summary: 'Background command "Run all tests in background" failed with exit code 1',
  })
  ;[task] = registry.list()
  // The name it was given when it started, the end it was first seen to have.
  assert.equal(task?.label, 'Run all tests in background')
  assert.equal(task?.summary, 'Background command "Run all tests in background" failed with exit code 1')
  assert.equal(task?.endedAt, 15_000)
  assert.equal(task?.stoppable, false)
})

test('the start line is read loosely: an odd id, a path with spaces, a sentence around it', () => {
  // The words are Claude Code's to change. A colon in the id, a space in the
  // path, extra whitespace and a trailing period must not cost the join.
  const registry = new TaskRegistry(() => 11_000)
  registry.observe({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_loose',
          name: 'Bash',
          input: { command: 'pnpm build', description: 'Build it', run_in_background: true },
        },
      ],
    },
  })
  registry.observe({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_loose',
          content:
            'Command running in background with ID: task:7.a2.  Output is being written to: /Users/a b/My Tasks/task:7.a2.output.\nCheck it with TaskOutput.',
        },
      ],
    },
  })
  const [task] = registry.list()
  assert.equal(task?.id, 'task:7.a2')
  assert.equal(task?.label, 'Build it')
  assert.equal(task?.outputFile, '/Users/a b/My Tasks/task:7.a2.output')
})

test('clearing drops what has finished and keeps what has not', () => {
  const registry = new TaskRegistry(() => 5_000)
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'live', task_type: 'local_bash', description: 'Still going' },
      { task_id: 'over', task_type: 'local_bash', description: 'Done' },
    ],
  })
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'live', task_type: 'local_bash', description: 'Still going' }],
  })
  assert.equal(registry.clearFinished(), true)
  assert.deepEqual(registry.list().map((task) => task.id), ['live'])
})

test('an unknown message says nothing, and an unknown task type still shows up', () => {
  const registry = new TaskRegistry(() => 6_000)
  assert.equal(registry.observe({ type: 'stream_event' }), false)
  assert.equal(registry.observe(null), false)
  registry.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'r1', task_type: 'remote_session', description: 'On the web' }],
  })
  assert.equal(registry.list()[0]?.kind, 'other')
  assert.equal(registry.list()[0]?.state, 'running')
})

// ----------------------------------------------------------- through the wire

const record = (runtime: AcpRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    async until<T extends AgentEvent>(
      predicate: (event: AgentEvent) => event is T,
      timeoutMs = 10_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`timed out; saw ${events.map((event) => event.type).join(', ')}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    /** The most recent task list this runtime announced. */
    tasks(): readonly BackgroundTask[] {
      const announcements = events.filter(
        (event): event is Extract<AgentEvent, { type: 'session/tasks' }> => event.type === 'session/tasks',
      )
      return announcements[announcements.length - 1]?.tasks ?? []
    },
    async settle(predicate: (tasks: readonly BackgroundTask[]) => boolean, timeoutMs = 10_000): Promise<readonly BackgroundTask[]> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const tasks = this.tasks()
        if (predicate(tasks)) return tasks
        if (Date.now() > deadline) {
          throw new Error(`timed out; last list was ${JSON.stringify(tasks)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

const send = async (
  session: { id: string; send(input: readonly { type: 'text'; text: string }[]): Promise<unknown> },
  tape: ReturnType<typeof record>,
  text: string,
): Promise<void> => {
  const before = tape.events.length
  await session.send([{ type: 'text', text }])
  await tape.until(
    (event): event is Extract<AgentEvent, { type: 'turn/completed' }> =>
      event.type === 'turn/completed' &&
      event.sessionId === session.id &&
      tape.events.indexOf(event) >= before,
  )
}

test('the agent announces its background tasks, and the runtime says it can', async () => {
  const runtime = make()
  await runtime.start()
  try {
    // Declared at initialize, before any task exists: a client has to know
    // the surface is there in order to show it at all.
    assert.equal(runtime.info.capabilities.backgroundTasks, true)
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })

    await send(session, tape, 'bg pnpm test --watch')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    assert.equal(running[0]?.label, 'Run pnpm test --watch')
    assert.equal(running[0]?.command, 'pnpm test --watch')
    assert.equal(running[0]?.stoppable, true)

    // And the pull answers the same thing, for a pane that has just opened.
    const listed = await runtime.tasks!.list(session.id)
    assert.deepEqual(listed.map((task) => task.id), running.map((task) => task.id))

    await send(session, tape, `endbg ${running[0]!.id}`)
    const done = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state !== 'running')
    assert.equal(done[0]?.state, 'completed')
    assert.equal(done[0]?.stoppable, false)
    // The notification names an output file and carries no text; the bridge
    // reads the file and publishes again with what it said, so the client's
    // next list carries the output rather than a path it cannot open.
    const spoken = await tape.settle((tasks) => typeof tasks[0]?.output === 'string')
    assert.equal(typeof spoken[0]?.output, 'string')
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('the 2.1.258 wire announces the same task, named and ended, through the bridge', async () => {
  const runtime = make({ FAKE_CLAUDE_TASK_WIRE: 'modern' })
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'bg pnpm test --watch')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    assert.equal(running[0]?.label, 'Run pnpm test --watch')
    assert.equal(running[0]?.command, 'pnpm test --watch')
    assert.equal(running[0]?.kind, 'command')

    await send(session, tape, `endbg ${running[0]!.id}`)
    const done = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state !== 'running')
    assert.equal(done[0]?.state, 'completed')
    // Still the name it started with, not the sentence it ended on.
    assert.equal(done[0]?.label, 'Run pnpm test --watch')
    const spoken = await tape.settle((tasks) => typeof tasks[0]?.output === 'string')
    assert.equal(typeof spoken[0]?.output, 'string')
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('output that lands after the notification is still fetched, on the retry clock', async () => {
  // The notification and the last write race. The fixture writes the file
  // 600ms after naming it; a one-shot read at the notification would have
  // left the card saying nothing was kept.
  const runtime = make({ FAKE_CLAUDE_TASK_WIRE: 'modern', FAKE_CLAUDE_LATE_OUTPUT: '600' })
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'bg pnpm test --watch')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    await send(session, tape, `endbg ${running[0]!.id}`)
    const done = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state !== 'running')
    assert.equal(done[0]?.state, 'completed')
    // Not there yet — and then there, without anyone typing anything.
    const spoken = await tape.settle((tasks) => typeof tasks[0]?.output === 'string', 15_000)
    assert.equal(typeof spoken[0]?.output, 'string')
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('a file that never appears is given up on, and the task says so', async () => {
  // The clock is shortened for the test; the default adds up to sixteen
  // seconds. What is pinned is the end of it: the task is marked, once, and
  // the bridge stops looking.
  const runtime = make({
    FAKE_CLAUDE_TASK_WIRE: 'modern',
    FAKE_CLAUDE_LATE_OUTPUT: 'never',
    CLAUDE_ACP_TASK_OUTPUT_RETRIES_MS: '50,50,50',
  })
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'bg pnpm test --watch')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    await send(session, tape, `endbg ${running[0]!.id}`)
    const gaveUp = await tape.settle((tasks) => tasks[0]?.outputMissing === true, 10_000)
    assert.equal(gaveUp[0]?.state, 'completed')
    assert.equal(gaveUp[0]?.output, undefined)
    // The list a pane would fetch says the same thing.
    const listed = await runtime.tasks!.list(session.id)
    assert.equal(listed[0]?.outputMissing, true)
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('a task that ends while nobody is prompting is still announced', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'bg tail -f log')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')

    // The turn is over before the task ends. Nothing is draining the agent's
    // stream at that point unless the bridge drains it on its own — which is
    // the difference between being told when it finishes and finding out the
    // next time you type something.
    await send(session, tape, `idlebg ${running[0]!.id}`)
    const done = await tape.settle((tasks) => tasks.every((task) => task.state !== 'running'))
    assert.equal(done[0]?.state, 'completed')
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('stopping a task ends it, and stopping it twice is not an error', async () => {
  const runtime = make()
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'bg sleep 600')
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')

    assert.equal(await runtime.tasks!.stop(session.id, running[0]!.id), true)
    const stopped = await tape.settle((tasks) => tasks[0]?.state === 'stopped')
    assert.equal(stopped[0]?.state, 'stopped')

    // Two windows can press the same button; the second one is told no rather
    // than shown an error.
    assert.equal(await runtime.tasks!.stop(session.id, running[0]!.id), false)
    assert.equal(await runtime.tasks!.stop(session.id, 'never-existed'), false)

    await runtime.tasks!.clear!(session.id)
    assert.deepEqual(await runtime.tasks!.list(session.id), [])
    await session.close()
  } finally {
    await runtime.dispose()
  }
})

test('the session keeps working after the pump has taken over its stream', async () => {
  // The pump owns the generator now. Two turns back to back, a task started
  // in the first and read in the second, is the shape that would break if the
  // buffer handed `prompt` anything out of order — or stopped handing it
  // anything at all.
  const runtime = make()
  await runtime.start()
  try {
    const tape = record(runtime)
    const session = await runtime.createSession({ cwd: WORKDIR })
    await send(session, tape, 'hello')
    await send(session, tape, 'bg one --forever')
    await send(session, tape, 'still there?')

    const said = tape.events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'turn/completed' }> => event.type === 'turn/completed',
      )
      .flatMap((event) =>
        event.turn.items.flatMap((item) => (item.type === 'assistantMessage' ? [item.text] : [])),
      )
    assert.ok(
      said.some((text) => text.includes('still there?')),
      `the third turn was answered; saw ${JSON.stringify(said)}`,
    )
    const running = await tape.settle((tasks) => tasks.length === 1 && tasks[0]?.state === 'running')
    assert.equal(running[0]?.command, 'one --forever')
    await session.close()
  } finally {
    await runtime.dispose()
  }
})
