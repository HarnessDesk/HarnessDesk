import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AcpConnection } from '../src/index.js'

/**
 * A bridge whose stdin has closed while it is still alive.
 *
 * `alive` reads the exit code, and a process can shut its stdin long before
 * it exits — or die between the check and the write. Either way the pipe
 * answers EPIPE as an `error` event on the stream, and a stream nobody
 * listens to raises that as an uncaught exception in the host. In the
 * desktop app that is Electron's modal error box over a frozen window,
 * which a live run produced. The connection listens, so the write is a
 * logged line and the request is left to the exit that follows.
 */
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('a write after the agent shut its stdin is noted, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-stdin-'))
  const agent = join(dir, 'agent.mjs')
  // Closes its end of the pipe at once and lingers, which is the shape of the
  // race: the descriptor itself has to go — `process.stdin.destroy()` leaves
  // it open and every write still lands in the kernel's buffer.
  await writeFile(agent, `import { closeSync } from 'node:fs'; closeSync(0); setTimeout(() => process.exit(0), 1500)`)

  const stderr: string[] = []
  const uncaught: unknown[] = []
  const catcher = (error: unknown): void => {
    uncaught.push(error)
  }
  process.on('uncaughtException', catcher)
  try {
    const connection = new AcpConnection({
      command: process.execPath,
      args: [agent],
      onStderr: (line) => stderr.push(line),
    })
    await connection.start()
    await settle(300)
    const pending = connection.request('initialize', {}).catch((error: unknown) => error)
    await settle(600)
    assert.deepEqual(uncaught, [], 'an EPIPE on stdin must never escape as an uncaught exception')
    assert.ok(
      stderr.some((line) => /agent stdin: .*EPIPE/.test(line)),
      `the pipe error is logged where the agent's own stderr goes: ${JSON.stringify(stderr)}`,
    )
    // The exit that follows fails the request, the way any crash does.
    await settle(1800)
    const outcome = await pending
    assert.ok(outcome instanceof Error, 'the request is failed by the exit, not left hanging')
    await connection.stop()
  } finally {
    process.off('uncaughtException', catcher)
    await rm(dir, { recursive: true, force: true })
  }
})
