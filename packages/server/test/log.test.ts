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
