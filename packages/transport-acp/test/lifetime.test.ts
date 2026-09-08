import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AcpConnection } from '../src/index.js'
import { checkIn, lifeline } from './lifeline.js'

/**
 * A bridge is rarely a leaf.
 *
 * It spawns the vendor's CLI, which spawns that CLI's own MCP servers. Ending
 * only the bridge left both of those running, reparented to init: quitting
 * HarnessDesk gave back the window and none of the processes behind it. Real
 * runs left `claude-acp` and a handful of Electron MCP hosts alive for hours,
 * and one of them rewriting `dist/` under a test run is what made a suite
 * fail once and pass five times.
 *
 * So the bridge leads a process group, and the *group* is what gets signalled
 * and what the deadline belongs to. Three things have to hold at once, and
 * each was broken on its own at some point:
 *
 *   - a descendant that ignores SIGTERM still dies;
 *   - a descendant that traps SIGTERM to flush gets the time to do it;
 *   - a bridge that exits on its own reaps its family too, rather than
 *     orphaning it and throwing away the only handle to the group.
 */

test('a descendant that ignores SIGTERM still goes with the bridge', async (t) => {
  if (process.platform === 'win32') return

  const line = await lifeline(t)
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-lifetime-'))
  /* One hook, not two: `t.after` runs in registration order, so a separate
     `rm` registered here would delete the scripts while the family was still
     running them. The body stops the family itself on the way through — this
     is the failure path, where it did not get that far. */
  let stop: (() => Promise<void>) | undefined
  t.after(async () => {
    try {
      await stop?.()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  const grandchild = join(dir, 'grandchild.mjs')
  const bridge = join(dir, 'bridge.mjs')

  /* Stands in for the vendor CLI's MCP server, and it *ignores SIGTERM* —
     the case the first version of this test missed. A grandchild with default
     handling dies on the group's SIGTERM and proves nothing about the SIGKILL
     that is supposed to follow. */
  await writeFile(
    grandchild,
    `
    process.on('SIGTERM', () => {})
    process.on('SIGINT', () => {})
    ${checkIn(line.port)}
    setInterval(() => {}, 1 << 30)
  `,
  )
  await writeFile(
    bridge,
    `
    import { spawn } from 'node:child_process'
    spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })
    setInterval(() => {}, 1 << 30)
  `,
  )

  const connection = new AcpConnection({ command: process.execPath, args: [bridge] })
  stop = () => connection.stop()
  await connection.start()

  const family = await line.checkin()
  assert.ok(family.alive(), 'the grandchild is running')

  await connection.stop()
  // The line going quiet is the assertion: it went with the bridge, SIGTERM
  // ignored or not — and ignoring it, the only thing that could have ended it
  // is the SIGKILL at the end of the grace.
  await family.gone
})

test('a descendant that traps SIGTERM is given time to finish', async (t) => {
  if (process.platform === 'win32') return

  const line = await lifeline(t)
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-grace-'))
  /* One hook, not two: `t.after` runs in registration order, so a separate
     `rm` registered here would delete the scripts while the family was still
     running them. The body stops the family itself on the way through — this
     is the failure path, where it did not get that far. */
  let stop: (() => Promise<void>) | undefined
  t.after(async () => {
    try {
      await stop?.()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  const grandchild = join(dir, 'grandchild.mjs')
  const bridge = join(dir, 'bridge.mjs')
  const flushed = join(dir, 'flushed.txt')

  /* The other direction, and the one the first fix broke. Killing the group
     the instant the leader exited took the grace away from exactly the
     descendant the escalation exists to accommodate: one that traps SIGTERM
     in order to flush. Its cleanup lands well inside the deadline, so it must
     be allowed to happen. */
  await writeFile(
    grandchild,
    `
    import { writeFileSync } from 'node:fs'
    process.on('SIGTERM', () => {
      setTimeout(() => {
        writeFileSync(${JSON.stringify(flushed)}, 'done')
        process.exit(0)
      }, 250)
    })
    ${checkIn(line.port)}
    setInterval(() => {}, 1 << 30)
  `,
  )
  /* And the leader leaves at once, which is what made this fail: `stop()`
     returned in two milliseconds and the group was killed on its way out. */
  await writeFile(
    bridge,
    `
    import { spawn } from 'node:child_process'
    spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1 << 30)
  `,
  )

  const connection = new AcpConnection({ command: process.execPath, args: [bridge] })
  stop = () => connection.stop()
  await connection.start()

  const family = await line.checkin()
  assert.ok(family.alive(), 'the grandchild is running')
  await connection.stop()
  await family.gone

  assert.equal(
    await readFile(flushed, 'utf8').catch(() => null),
    'done',
    'the descendant finished what it trapped SIGTERM to do',
  )
})

test('a bridge that exits on its own takes its family with it', async (t) => {
  if (process.platform === 'win32') return

  const line = await lifeline(t)
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-crash-'))
  /* One hook, not two: `t.after` runs in registration order, so a separate
     `rm` registered here would delete the scripts while the family was still
     running them. The body stops the family itself on the way through — this
     is the failure path, where it did not get that far. */
  let stop: (() => Promise<void>) | undefined
  t.after(async () => {
    try {
      await stop?.()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  const grandchild = join(dir, 'grandchild.mjs')
  const bridge = join(dir, 'bridge.mjs')

  /* Checking in is also how this one tells the bridge it is ready: the line
     is up, and so is the handler that ignores SIGTERM. */
  await writeFile(
    grandchild,
    `
    process.on('SIGTERM', () => {})
    ${checkIn(line.port, " process.stdout.write('up\\n') ")}
    setInterval(() => {}, 1 << 30)
  `,
  )
  /* No deliberate stop at all: the bridge falls over. The exit handler used to
     clear the only handle to the group without reaping it, so the family was
     orphaned *and* a later `stop()` had nothing left to signal.

     It falls over the moment the grandchild says it is up, and not a moment
     chosen off a timer: a timer that beat the grandchild's own start-up — a
     coin-flip on an idle machine, a foregone conclusion under the full suite —
     put the group's SIGTERM on a process that had not yet trapped anything,
     and the test failed as a bridge that never launched a family at all. */
  await writeFile(
    bridge,
    `
    import { spawn } from 'node:child_process'
    const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.on('data', () => process.exit(1))
    setInterval(() => {}, 1 << 30)
  `,
  )

  let sawExit: (code: number | null) => void = () => undefined
  const bridgeExited = new Promise<number | null>((resolve) => {
    sawExit = resolve
  })
  const connection = new AcpConnection({
    command: process.execPath,
    args: [bridge],
    onExit: (code) => sawExit(code),
  })
  stop = () => connection.stop()
  await connection.start()

  const family = await line.checkin()
  assert.equal(await bridgeExited, 1, 'the bridge fell over on its own')
  assert.ok(family.alive(), 'and left the grandchild behind it')
  // Nothing here asks for a shutdown: the line goes quiet because the exit
  // handler saw the family out on its own.
  await family.gone
})
