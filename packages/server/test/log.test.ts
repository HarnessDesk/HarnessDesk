import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Logger } from '../src/log.js'

/**
 * A console that has gone away must not become the caller's problem.
 *
 * The desk is routinely started detached, and when its parent exits the pipe
 * behind stdout breaks. `write` then raises EPIPE at whatever line asked for
 * a log — and the one line that logs unconditionally is the shell's
 * `uncaughtException` handler, which is how a broken pipe became a loop that
 * wrote 267,665 crash files and 1.0 GB of disk in six minutes (2026-09-13).
 */
const withBrokenConsole = (run: () => void): { calls: number } => {
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  let calls = 0
  const broken = (): never => {
    calls += 1
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })
  }
  process.stdout.write = broken as typeof process.stdout.write
  process.stderr.write = broken as typeof process.stderr.write
  try {
    run()
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  return { calls }
}

test('a broken stdout does not throw out of the logger', () => {
  const logger = new Logger('test', { level: 'debug', file: null, console: true })
  const { calls } = withBrokenConsole(() => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      assert.doesNotThrow(() => logger[level](`a ${level} line`), `${level} threw out of the logger`)
    }
  })
  // The control: all four really did reach a stream that refused them.
  assert.equal(calls, 4)
})

test('a broken stdout does not stop the details being formatted, or the next line', () => {
  const logger = new Logger('test', { level: 'debug', file: null, console: true })
  withBrokenConsole(() => {
    assert.doesNotThrow(() => logger.error('with details', { a: 1, b: [2, 3] }))
  })
  // And the logger still works once the console comes back.
  const lines: string[] = []
  const stderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    logger.error('after the pipe came back')
  } finally {
    process.stderr.write = stderr
  }
  assert.equal(lines.length, 1)
  assert.match(lines[0] as string, /after the pipe came back/)
})

/**
 * The two tests above fake the broken pipe with a `write` that throws, and a
 * real one does not throw: on a pipe, Node dispatches the write, and the
 * EPIPE arrives afterwards as an `error` event on the stream. Nobody listened
 * for that event, so it became an uncaught exception; the shell's handler
 * logged it through the same console, which raised it again, until the storm
 * guard exited the app. Measured 2026-09-23 on a desk whose launcher had
 * exited: the first refused request after that — any refusal, since a refused
 * request is logged as a warning — took the whole app down with exit code 1
 * and 26 crash files in 3 ms.
 *
 * So this uses a real pipe and really closes it, in a child process, because
 * the process that dies is the one under test.
 */
test('a console pipe that closes under a running process does not take it down', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'hd-log-pipe-'))
  const file = join(dir, 'host.ndjson')
  const log = new URL('../src/log.js', import.meta.url).href
  const script = `
    import { Logger } from ${JSON.stringify(log)}
    const logger = new Logger('pipe', { level: 'debug', file: ${JSON.stringify(file)}, console: true })
    logger.info('the console is there')
    process.stdin.once('data', async () => {
      for (let n = 0; n < 50; n += 1) {
        logger.warn('method failed', { n })
        logger.error('an error line', { n })
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      logger.info('still here')
      await logger.flush()
      process.exit(0)
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    // Wait until the console really carried a line, so the pipe is proven open first.
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('exit', (code) => reject(new Error(`the child exited early with ${code}`)))
    })
    // A launcher that exits closes the read ends; this is that, without the exit.
    child.stdout.destroy()
    child.stderr.destroy()
    child.stdin.write('go\n')
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])))
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'a closed console pipe took the process down')
    const records = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { message: string })
    // The file sink still has every line, and says the console went away.
    assert.equal(records.filter((one) => one.message === 'method failed').length, 50)
    assert.ok(records.some((one) => one.message === 'still here'))
    assert.ok(records.some((one) => /console .*went away/.test(one.message)),
      'the log does not say its console went away')
  } finally {
    child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})
