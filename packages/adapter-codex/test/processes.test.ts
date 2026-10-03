import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'

import { CodexRuntime } from '../src/index.js'
import { CodexProcesses } from '../src/processes.js'

/**
 * Sandboxed processes over `command/exec`: output streams, stdin reaches
 * the process, resize and kill work, and a process that cannot start is a
 * spawn error rather than a process that silently exited.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const started = async (t: { after(fn: () => Promise<void>): void }): Promise<CodexRuntime> => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

const collect = (process: { onOutput(l: (s: 'stdout' | 'stderr', d: Uint8Array) => void): unknown }) => {
  const chunks: string[] = []
  process.onOutput((_stream, data) => chunks.push(Buffer.from(data).toString()))
  return chunks
}

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** The fake controls startup and exit independently, as the server does. */
const controlled = () => {
  const exit = deferred<CodexProtocol.v2.CommandExecResponse>()
  const ready = deferred<CodexProtocol.v2.CommandExecWriteResponse>()
  void ready.promise.catch(() => {}) // The old implementation never asks for this check.
  const calls: { method: string; params: Record<string, unknown>; options: unknown }[] = []
  const server = {
    request: (method: string, params: Record<string, unknown>, options: unknown) => {
      calls.push({ method, params, options })
      if (method === 'command/exec') return exit.promise
      assert.equal(method, 'command/exec/write')
      return ready.promise
    },
  } as unknown as CodexAppServer
  const processes = new CodexProcesses(server, () => undefined)
  return { processes, exit, ready, calls }
}

test('a refusal beyond the old grace window still rejects spawn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fake = controlled()
  const spawn = fake.processes.spawn({ cwd: '/w', command: ['missing'], tty: false })
  const refusal = new Error('failed to spawn: missing executable')
  const rejected = assert.rejects(spawn, (error) => error === refusal)
  void rejected.catch(() => {}) // Keep a failing assertion handled until the fake releases exit.

  // Advance past 150ms without any wall-clock race; the fake has not yet
  // decided whether the command can start.
  t.mock.timers.tick(250)
  await new Promise((resolve) => setImmediate(resolve))
  fake.ready.reject(new Error('no active command/exec'))
  await new Promise((resolve) => setImmediate(resolve))
  fake.exit.reject(refusal)
  await rejected
  assert.equal(fake.calls.length, 2, 'one startup check, no retry')
})

test('a silent command waits for startup acknowledgement, not output or exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fake = controlled()
  let returned = false
  const spawn = fake.processes.spawn({ cwd: '/w', command: ['cat'], tty: false })
  void spawn.then(() => { returned = true })
  t.mock.timers.tick(250)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(returned, false, 'elapsed time does not establish startup')
  assert.deepEqual(fake.calls.map((call) => call.method), ['command/exec', 'command/exec/write'])
  assert.deepEqual(fake.calls[1]?.params, {
    processId: fake.calls[0]?.params['processId'], deltaBase64: '',
  }, 'startup check sends no bytes and leaves stdin open')
  assert.deepEqual(fake.calls[1]?.options, { timeoutMs: 0 })

  fake.ready.resolve({})
  const process = await spawn
  const exits: number[] = []
  process.onExit((code) => exits.push(code))
  assert.deepEqual(exits, [], 'startup resolves while a silent child is still running')
  fake.exit.resolve({ exitCode: 0, stdout: '', stderr: '' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exits, [0])
})

test('a fast exit wins even when the startup check finds no running command', async () => {
  const fake = controlled()
  const spawn = fake.processes.spawn({ cwd: '/w', command: ['true'], tty: false })
  fake.ready.reject(new Error('no active command/exec'))
  await new Promise((resolve) => setImmediate(resolve))
  fake.exit.resolve({ exitCode: 0, stdout: '', stderr: '' })
  const process = await spawn
  const exits: number[] = []
  process.onExit((code) => exits.push(code))
  assert.deepEqual(exits, [0])
})

test('stdin reaches the process and its output streams back until it exits', async (t) => {
  const runtime = await started(t)
  const process = await runtime.processes.spawn({ cwd: '/w', command: ['cat'], tty: false })
  const output = collect(process)
  let exit: number | null = null
  process.onExit((code) => (exit = code))

  await process.write(Buffer.from('hello through cat\n'))
  await waitFor(() => output.join('').includes('hello through cat'), 'echoed output')
  await process.kill()
  await waitFor(() => exit !== null, 'exit')
  await assert.rejects(() => process.write(Buffer.from('x')), /exited/)
})

test('a resize is delivered to the running process', async (t) => {
  const runtime = await started(t)
  const process = await runtime.processes.spawn({ cwd: '/w', command: ['cat'], tty: true, size: { rows: 24, cols: 80 } })
  const output = collect(process)
  await process.resize({ rows: 40, cols: 120 })
  await waitFor(() => output.join('').includes('[resized 40x120]'), 'the resize')
  await process.kill()
})

test('a command that cannot start is a spawn error, not a dead process', async (t) => {
  const runtime = await started(t)
  await assert.rejects(
    () => runtime.processes.spawn({ cwd: '/w', command: ['/definitely/not/a/binary'], tty: false }),
    /failed to spawn/,
  )
})

test('a terminal for a session runs under that session\'s permission profile', async (t) => {
  const runtime = await started(t)
  const session = await runtime.createSession({ cwd: '/w', options: { permissions: ':read-only' } })
  // The fake imitates Seatbelt by refusing `touch` under `:read-only`; the
  // response arrives as an immediate exit with stderr, which the adapter
  // reports as a process that exited rather than one that failed to spawn.
  const process = await runtime.processes.spawn({
    cwd: '/w',
    command: ['touch', '/w/x'],
    tty: false,
    session: session.id,
  })
  let exit: number | null = null
  process.onExit((code) => (exit = code))
  await waitFor(() => exit !== null, 'exit')
  assert.equal(exit, 1)
})

test('a finished process reports its exit to a listener that subscribes late', async (t) => {
  const runtime = await started(t)
  const process = await runtime.processes.spawn({ cwd: '/w', command: ['true'], tty: false })
  // The claim is about a listener that was not there when the process exited,
  // so the exit has to be established without subscribing to one — `onExit`
  // is the very thing under test, and a listener standing at exit time would
  // void the claim. `write` refuses on an exit the adapter has recorded, and
  // says so; before that the fake has usually forgotten the child too, and
  // its "unknown processId" is the same "not yet" seen from the other end,
  // which is why the poll tests the message rather than catching anything.
  // What this replaces slept a flat 300ms and asserted with no poll at all.
  await waitFor(async () => {
    try {
      await process.write(Buffer.from(''))
      return false
    } catch (error) {
      return /exited/.test(String(error))
    }
  }, 'the adapter to record the exit')

  let exit: number | null = null
  process.onExit((code) => (exit = code))
  assert.equal(exit, 0, 'the exit is replayed to the new listener there and then, not on some later tick')
})

test('output printed before anyone listens is delivered, not dropped', async (t) => {
  // The host registers its output listener only after startup is acknowledged.
  // A fast command can print before that; every byte must still arrive.
  const runtime = await started(t)
  const process = await runtime.processes.spawn({
    cwd: '/w',
    command: ['/bin/sh', '-c', 'echo said-before-listeners && sleep 0.3'],
    tty: false,
  })
  const output = collect(process) // registered AFTER spawn resolved, like Terminals does
  await waitFor(() => output.join('').includes('said-before-listeners'), 'the pre-listener output')

  // Even a process that has already exited hands its words to the first listener.
  const gone = await runtime.processes.spawn({
    cwd: '/w',
    command: ['/bin/sh', '-c', 'echo exited-unheard'],
    tty: false,
  })
  const late = collect(gone)
  await waitFor(() => late.join('').includes('exited-unheard'), 'output of an already-exited process')
})

test('output that arrives after the exec response still reaches a listener', async (t) => {
  // The response is not the end of the output. `command/exec` answers when the
  // child exits, which is not when its stdout has drained, and nothing orders
  // the response against that process's own deltas — so a trailing chunk
  // legally arrives after it. The fixture's `emit-after-exit` does that on
  // purpose; the commands above do it by accident whenever the last chunk
  // lands after Node's `'exit'`, which is how this was found. Either way the
  // bytes are the process's output, and `#pending`'s contract promises the
  // first listener gets them "even after exit".
  const runtime = await started(t)
  const gone = await runtime.processes.spawn({ cwd: '/w', command: ['emit-after-exit'], tty: false })
  // Attached while it is still running, which is what Terminals does.
  const late = collect(gone)
  let exit: number | null = null
  gone.onExit((code) => (exit = code))
  assert.deepEqual(late, [])

  // A later exec releases the exec response; wait for the exit to be seen, so
  // the delta that follows is unambiguously after the process finished.
  await runtime.processes.spawn({ cwd: '/w', command: ['true'], tty: false })
  await waitFor(() => exit !== null, 'the exec response')
  assert.deepEqual(late, [])

  // The next one releases the trailing delta.
  await runtime.processes.spawn({ cwd: '/w', command: ['true'], tty: false })
  await waitFor(() => late.join('').includes('after-the-response'), 'output emitted after the exec response')
})
