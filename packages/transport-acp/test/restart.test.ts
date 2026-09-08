import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AcpConnection } from '../src/index.js'
import { lifeline, type Checkin, type Lifeline } from './lifeline.js'

/**
 * One generation at a time.
 *
 * A bridge is not a leaf and it is not alone in its workspace: it spawns the
 * vendor's CLI, which spawns that CLI's own MCP servers, and every one of them
 * is pointed at the same checkout. Seeing that family out takes as long as it
 * takes — SIGTERM, a grace for anyone flushing, then SIGKILL — and for the
 * whole of that window the previous generation is still *in* the workspace.
 *
 * So what these tests pin is a boundary, not a duration: nothing that could
 * put a second generation into the workspace may return, or begin, before the
 * first one is confirmed gone. Two doors led in, and both stood open:
 *
 *   - `stop()` returned on a handle it no longer had — cleared by the exit
 *     handler after a crash, or by a `stop()` already running — while the reap
 *     that owned it was still in the grace;
 *   - `start()` never asked at all, so "select the runtime again to restart
 *     it" spawned the next bridge into a workspace the last one still held.
 *
 * Closing the second opened a third, which the fix itself is responsible for
 * and a reviewer found: once `start()` waits, a `stop()` can queue behind the
 * same reap and be *overtaken* by it, so the shutdown returns and reports
 * itself finished with a bridge the waiting start had just spawned. That one
 * is settled inside our own process rather than by the kernel — the
 * interleaving is pure microtask order — so its test asserts on `alive`, which
 * is exact for the same reason the socket-versus-timer comparison below is not.
 *
 * The arbiter here is the kernel rather than a clock. Each family's stand-in
 * holds a listening port for as long as it lives, and a port cannot be bound
 * twice; "the last generation has gone" is a `listen` that succeeds. That is a
 * fact, settled before the question is asked and the same answer however long
 * the asking takes — where a deadline only ever asked whether the answer had
 * arrived yet, and a loaded machine made it guess wrong.
 *
 * What is deliberately *not* pinned here is the last instant of a shutdown.
 * `reapGroup` also used to resolve on issuing the SIGKILL rather than on the
 * death that follows it, and that gap is real but a few microseconds of kernel
 * scheduling wide — no assertion can separate the two without betting on the
 * scheduler, which is the bet this file exists to avoid making. Each of these
 * tests instead attacks the window that was seconds wide, and the honesty of
 * that last instant rides along with the fix rather than with a test.
 */

/** The two stand-in scripts, and where the family writes what it claimed. */
interface Desk {
  readonly bridge: string
  readonly claim: string
}

/** The port a generation's family is holding, once it says it is holding it. */
interface Workspace {
  readonly port: number
  readonly family: Checkin
}

/**
 * A bridge, and the "MCP server" it spawns to hold the workspace.
 *
 * `HD_FAMILY` chooses which bridge comes up, because a restart reuses the very
 * connection that crashed and `withEnv` is the only thing about the next spawn
 * a caller can change:
 *
 *   'crash' — spawns the family, then falls over the moment it is holding;
 *   'stay'  — spawns the family and stays up itself;
 *   ''      — no family at all, which is the generation that follows a crash.
 */
const desk = async (t: TestContext, line: Lifeline): Promise<Desk> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const claim = join(dir, 'workspace.port')
  const grandchild = join(dir, 'grandchild.mjs')
  const bridge = join(dir, 'bridge.mjs')

  /* Stands in for the vendor CLI's MCP server: it holds the workspace, and it
     *ignores SIGTERM*, so nothing short of the SIGKILL at the end of the grace
     ends it. That is what makes the window this file is about a wide one —
     with the old code a caller was let back into the workspace two seconds
     before the process holding it died.

     The check-in is written inside the listen callback on purpose: arriving on
     the line then means the port is already bound *and* SIGTERM is already
     trapped, so nothing below has to guess at how long a stand-in takes to
     boot Node. */
  await writeFile(
    grandchild,
    `
    import { createServer, connect } from 'node:net'
    import { writeFileSync } from 'node:fs'

    process.on('SIGTERM', () => {})

    const workspace = createServer()
    workspace.listen(0, '127.0.0.1', () => {
      writeFileSync(${JSON.stringify(claim)}, String(workspace.address().port))
      connect(${line.port}, '127.0.0.1', () => process.stdout.write('up\\n')).on('error', () => {})
    })
    setInterval(() => {}, 1 << 30)
  `,
  )
  await writeFile(
    bridge,
    `
    import { spawn } from 'node:child_process'
    import { connect } from 'node:net'

    const family = process.env.HD_FAMILY
    if (family) {
      const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      /* Falls over the moment the family says it is holding the workspace — an
         event, not a moment picked off a clock. A timer that beat the
         stand-in's own start-up would put the group's SIGTERM on a process
         that had trapped nothing yet, and lose the whole point of the test. */
      if (family === 'crash') child.stdout.on('data', () => process.exit(1))
    } else {
      // The generation after the crash. It holds no workspace; checking in is
      // only how it says it came up at all.
      connect(${line.port}, '127.0.0.1').on('error', () => {})
    }
    setInterval(() => {}, 1 << 30)
  `,
  )
  return { bridge, claim }
}

/** Waits for the family to say it is holding, and reads the port it holds. */
const held = async (line: Lifeline, claimFile: string): Promise<Workspace> => {
  const family = await line.checkin()
  return { family, port: Number.parseInt(await readFile(claimFile, 'utf8'), 10) }
}

/**
 * Take the workspace — the assertion, and one the kernel decides.
 *
 * A bind cannot succeed while another process holds the port, so this fails if
 * and only if something of the last generation is still running. Nothing is
 * timed and nothing is retried: whatever the answer is, it was already true
 * before the question was asked.
 */
const claimWorkspace = async (t: TestContext, workspace: Workspace): Promise<void> => {
  const server = createServer()
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          `the workspace on :${workspace.port} was still held (${error.code}); ` +
            `the family ${workspace.family.alive() ? 'is still on the line' : 'had already let the line go, so this is a stranger on the port'}`,
        ),
      ),
    )
    server.listen(workspace.port, '127.0.0.1', () => resolve())
  })
}

/** A connection whose bridge has crashed with its family still in the workspace. */
const afterACrash = async (
  t: TestContext,
): Promise<{ connection: AcpConnection; workspace: Workspace }> => {
  const line = await lifeline(t)
  const desks = await desk(t, line)
  let sawExit: (code: number | null) => void = () => undefined
  const bridgeExited = new Promise<number | null>((resolve) => {
    sawExit = resolve
  })
  const connection = new AcpConnection({
    command: process.execPath,
    args: [desks.bridge],
    onExit: (code) => sawExit(code),
  })
  t.after(async () => {
    await connection.stop()
  })
  connection.withEnv({ HD_FAMILY: 'crash' })
  await connection.start()

  const workspace = await held(line, desks.claim)
  assert.equal(await bridgeExited, 1, 'the bridge fell over on its own')
  assert.ok(workspace.family.alive(), 'and left its family holding the workspace')
  return { connection, workspace }
}

test('stop() does not return while the family a crash left behind is still in the workspace', async (t) => {
  if (process.platform === 'win32') return

  const { connection, workspace } = await afterACrash(t)

  /* The crash cleared the handle and left the reap running behind it, so this
     used to return on `if (!child) return` — instantly, two seconds before the
     SIGKILL that would end the family, with the caller free to start the next
     bridge on top of it. */
  await connection.stop()

  await claimWorkspace(t, workspace)
})

test('start() does not spawn the next bridge into a workspace the last one still holds', async (t) => {
  if (process.platform === 'win32') return

  const { connection, workspace } = await afterACrash(t)

  /* No `stop()` at all, which is the real path: a crashed runtime says "select
     the runtime again to restart it", and selecting it lands straight here. */
  connection.withEnv({ HD_FAMILY: '' })
  await connection.start()

  await claimWorkspace(t, workspace)
  assert.ok(connection.alive, 'and the next bridge is up')
})

test('a second stop() waits for the shutdown the first one started', async (t) => {
  if (process.platform === 'win32') return

  const line = await lifeline(t)
  const { bridge, claim } = await desk(t, line)
  const connection = new AcpConnection({ command: process.execPath, args: [bridge] })
  t.after(async () => {
    await connection.stop()
  })
  connection.withEnv({ HD_FAMILY: 'stay' })
  await connection.start()
  const workspace = await held(line, claim)

  /* Two callers ask at once — the app quitting while a catalogue refresh is
     mid-restart is the real shape of it. The first takes the handle; the
     second finds nothing to signal, and used to take that for "already
     stopped" and return into a workspace still held by a family in its grace. */
  const first = connection.stop()
  await connection.stop()

  await claimWorkspace(t, workspace)
  await first
})

test('a stop() that lands on a queued start() does not return with a bridge running', async (t) => {
  if (process.platform === 'win32') return

  const { connection, workspace } = await afterACrash(t)

  /* The restart is asked for and not awaited — which is a person selecting the
     crashed runtime again — and the app is quit underneath it while the family
     that crash left behind is still being reaped.

     This window is one `start()` being asynchronous opened: while it spawned
     synchronously, a `stop()` arriving after it always found a `#child` to
     reap. Now both callers queue behind the same reap, `start()` resumes first
     because it waited first, and it spawns into a shutdown that has already
     decided it is finished. Nothing would ever reap what it spawned — the app
     is on its way out. */
  connection.withEnv({ HD_FAMILY: '' })
  const restarting = connection.start()
  await connection.stop()

  /* Our own object, not the kernel's: the interleaving above is pure microtask
     order, so this is exact rather than probable. */
  assert.ok(!connection.alive, 'stop() returned with nothing running')
  /* And it *says* so. A caller that cannot tell an abandoned start from a
     started one speaks to a process that was never spawned and then reports
     that failure from where it happens to be standing — in this app, as an
     agent that is not installed, about a working one. */
  assert.equal(await restarting, false, 'start() reported that it had not started')
  assert.ok(!connection.alive, 'and the start it overtook did not spawn one behind it')
  await claimWorkspace(t, workspace)
})
