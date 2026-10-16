import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, BackgroundTask } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'
import { taskLabel } from '../src/tasks.js'

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

test('a task is titled by its command, without the shell that wraps it', () => {
  // Short commands stay whole, as before.
  assert.equal(taskLabel('tail -f server.log'), 'tail -f server.log')
  assert.equal(taskLabel('/bin/zsh -lc "pnpm dev"'), 'pnpm dev')
  assert.equal(taskLabel("bash -c 'npm run watch'"), 'npm run watch')
  // A leading `cd` says where, not what; the plate still shows it.
  assert.equal(taskLabel('/bin/zsh -lc "cd /work/storefront && pnpm test --watch"'), 'pnpm test --watch')
  // A long one is cut to its program and first argument that is not a flag.
  assert.equal(
    taskLabel('/bin/zsh -lc "rg -n \\"type IntentState\\" /work/storefront/packages/protocol/src /work/storefront/packages/ui/src"'),
    'rg "type IntentState"…',
  )
  assert.equal(taskLabel('NODE_ENV=test /usr/local/bin/node --inspect scripts/very-long-script-name.mjs --flag-one --flag-two'), 'node scripts/very-long-script-name.mjs…')
  // A semicolon inside quotes is part of the word, not a second command.
  assert.equal(taskLabel('sh -c "echo \\"a; b\\""'), 'echo "a; b"')
  // Nothing to shorten to: the command as it came.
  assert.equal(taskLabel('   '), '   ')
})

test('a task title never names a command that is not the one running', () => {
  const cutTo48 = (line: string) => `${line.slice(0, 47).trimEnd()}…`
  // A leading `cd` goes only when its directory and the separator after it are read for sure.
  assert.equal(taskLabel('cd /work;pwd;tail -f server.log'), 'pwd;tail -f server.log')
  assert.equal(taskLabel('cd "/work/a\\"; echo pretend" && pnpm dev'), 'pnpm dev')
  assert.equal(taskLabel('cd x'), 'cd x')
  // A directory that expands is not read for sure, so its `cd` stays; the wrapper still goes.
  assert.equal(taskLabel('zsh -lc "cd $HOME/app && pnpm test --watch --reporter verbose"'), 'cd $HOME/app…')
  // A backslash outside quotes joins a word: the assignment stays one word.
  assert.equal(taskLabel('FOO=some\\ value pnpm dev --host 0.0.0.0 --port 3000'), 'pnpm dev…')
  // A separator touching a word still ends the command.
  const long = 'sleep 100 && echo done-with-a-long-enough-tail-to-cut'
  assert.equal(taskLabel(`zsh -c "ls; ${long}"`), 'ls…')
  assert.equal(taskLabel(`a&&b ${long}`), 'a…')
  assert.equal(taskLabel(`x;y ${long}`), 'x…')
  // Only a leading assignment is skipped, and a line with no program left keeps itself.
  const substitution = 'OUTPUT="$(node /work/scripts/a-script-with-a-long-name.mjs --flag)"'
  assert.equal(taskLabel(substitution), cutTo48(substitution))
  const assignments = 'FIRST_VARIABLE=one SECOND_VARIABLE=two THIRD_VARIABLE=three'
  assert.equal(taskLabel(assignments), cutTo48(assignments))
  // A quoted program path is read unquoted before its name is taken.
  assert.equal(taskLabel('"/my path/bin" --a value-that-makes-this-line-long enough-to-cut'), 'bin value-that-makes-this-line-long…')
  // What cannot be read for sure is shown as it came.
  const unterminated = '/bin/zsh -lc "rg -n pattern /work/storefront/packages/ui/src'
  assert.equal(taskLabel(unterminated), cutTo48(unterminated))
  assert.equal(taskLabel('bash -c "x" extra'), 'bash -c "x" extra')
  // A redirection can stand anywhere, before the program too; it is not read, so the line stays.
  const leading = '2>/dev/null pnpm dev --host 0.0.0.0 --port 3000 --strictPort'
  assert.equal(taskLabel(leading), cutTo48(leading))
  const attached = 'pnpm dev --host 0.0.0.0 --port 3000 --strictPort>/tmp/dev.log 2>&1'
  assert.equal(taskLabel(attached), cutTo48(attached))
  assert.equal(taskLabel('/bin/zsh -lc "pnpm dev 2>&1"'), 'pnpm dev 2>&1')
  // A line continuation joins, outside quotes and inside double quotes alike.
  assert.equal(taskLabel('pn\\\npm dev --host 0.0.0.0 --port 3000 --strictPort --open'), 'pnpm dev…')
  assert.equal(taskLabel('/bin/zsh -lc "pn\\\npm dev --host 0.0.0.0 --port 3000 --strictPort --open"'), 'pnpm dev…')
  // A cut counts code points, so an emoji at the edge stays whole.
  const emoji = `echo ${'x'.repeat(41)}🚀🚀🚀 and more after it`
  assert.equal(taskLabel(emoji), `echo ${'x'.repeat(41)}🚀…`)
  for (const label of [substitution, assignments, unterminated, leading, attached].map(taskLabel)) assert.notEqual(label, '…')
})

test('a task title keeps the line when the shell would rewrite the program or not run it', () => {
  const cutTo48 = (line: string) => `${line.slice(0, 47).trimEnd()}…`
  // A glob or a brace in the program word is expanded by the shell, so its name is not read for sure.
  const glob = '/bin/ec[h]o hello from a line long enough to need a cut'
  assert.equal(taskLabel(glob), cutTo48(glob))
  const brace = '/bin/{echo,printf} hello from a line long enough to need a cut'
  assert.equal(taskLabel(brace), cutTo48(brace))
  // Quoted, the same characters are only text.
  assert.equal(taskLabel(`"/bin/ec[h]o" hello from a line long enough to need a cut`), 'ec[h]o hello…')
  // Only a flag that runs the script unwraps it: `-n` only checks it, and an unknown flag is not guessed at.
  assert.equal(taskLabel("bash -nc 'printf ok'"), "bash -nc 'printf ok'")
  assert.equal(taskLabel("bash -Zc 'printf ok'"), "bash -Zc 'printf ok'")
  assert.equal(taskLabel("bash -ec 'printf ok'"), 'printf ok')
})

test('a task title is cut where a person sees a character end, and stays on one line', () => {
  // A joined emoji is several code points; the cut keeps it whole.
  const family = '👨‍👩‍👧'
  const joined = `echo ${'x'.repeat(41)}${family}${family}${family} and more after it`
  assert.equal(taskLabel(joined), `echo ${'x'.repeat(41)}${family}…`)
  // A short command continued onto a second line is not shown with the break in it.
  const continued = taskLabel('pnpm \\\ndev --port 3000')
  assert.ok(!continued.includes('\n'), continued)
  assert.equal(continued, 'pnpm dev…')
  // A comment ends at its line, and the command on the next line is the one that runs.
  assert.equal(taskLabel('# start the server\npnpm dev --host 0.0.0.0 --port 3000 --strictPort'), 'pnpm dev --host 0.0.0.0 --port 3000 --strictPort')
  assert.equal(taskLabel('pnpm dev # the port is set in the config'), 'pnpm dev # the port is set in the config')
  // A written `;` before a command is a syntax error, not a line break: the line is kept as it came.
  assert.equal(taskLabel(';printf ok'), ';printf ok')
  assert.equal(taskLabel('cd /tmp;; printf ok'), 'cd /tmp;; printf ok')
  assert.equal(taskLabel('cd /tmp\nprintf ok'), 'printf ok')
  // A program word that is only whitespace names nothing: the line is kept, cut.
  const blank = "' ' --flag value-long-enough-to-push-the-line-past-the-limit"
  assert.equal(taskLabel(blank), `${blank.slice(0, 47).trimEnd()}…`)
  const newline = '"\n" --flag value-long-enough-to-push-the-line-past-the-limit'
  assert.notEqual(taskLabel(newline).trim(), '…')
  assert.ok(!taskLabel(newline).startsWith('\n…'), taskLabel(newline))
})
