import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { AcpRuntime, type AcpExecutableSpec, type ResolvedExecutable } from '../src/index.js'

/**
 * Nothing is spawned after the host has finished with the runtime.
 *
 * `transport-acp` holds "one generation at a time": a start waits for the
 * last family to be confirmed gone, and a stop that overtakes a queued start
 * abandons it. Both of those are answers to *another generation*, and neither
 * has anything to say when there is none — which is the whole of this door.
 *
 * The catalogue refresher restarts an idle agent to re-ask what it offers
 * (`#restartIfIdle`): stop, then start. The stop reaps the family and returns,
 * and the start then yields twice before it spawns — once to ask the host what
 * to run, once to find the agent's CLI on disk. Quit in that gap and the
 * transport sees a runtime with nothing in flight, so `Host.dispose()`'s stop
 * returns immediately and the quit goes on; then the parked start wakes and
 * spawns a bridge, the vendor CLI it drives and that CLI's own MCP servers
 * into an app that is already gone. Nobody is left to reap any of it. That is
 * the family `transport-acp/test/lifetime.test.ts` exists to prevent, reached
 * through a door on this side of the transport.
 *
 * So the ordering under test is entirely microtask order inside this process,
 * and the test drives it rather than waiting on it: the CLI lookup is a
 * promise the test resolves by hand, so "the quit landed inside the gap" is
 * arranged, not hoped for. What is asked afterwards is settled before it is
 * asked — every generation writes down the workspace it holds *before* it will
 * answer the handshake, and every handshake here is awaited, so by the time
 * the refresh has returned either two bridges were born or one was. Then the
 * kernel is asked the last question: the port that one generation holds for
 * life can only be bound again once it is really gone.
 */

/** A stand-in bridge, and the file every generation of it writes to. */
interface Desk {
  readonly bridge: string
  readonly claims: string
}

/**
 * The smallest thing that is both a real process family and a real ACP agent.
 *
 * The order inside is the point. It claims a port — held for as long as the
 * process lives, which is what makes "has this generation gone?" a question
 * the kernel answers — writes that claim down, and only then starts reading
 * stdin. So a generation that answered `initialize` has certainly recorded
 * itself, and an awaited handshake is an awaited claim; nothing below has to
 * guess how long a stand-in takes to boot Node.
 */
const desk = async (t: TestContext): Promise<Desk> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const claims = join(dir, 'generations')
  await writeFile(claims, '')
  const bridge = join(dir, 'bridge.mjs')
  await writeFile(
    bridge,
    `
    import { appendFileSync } from 'node:fs'
    import { createServer } from 'node:net'
    import { createInterface } from 'node:readline'

    const workspace = createServer()
    workspace.listen(0, '127.0.0.1', () => {
      appendFileSync(${JSON.stringify(claims)}, workspace.address().port + '\\n')
      createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method !== 'initialize') return
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\\n',
        )
      })
    })
  `,
  )
  return { bridge, claims }
}

/** Every generation that has ever run, in the order they came up. */
const generations = async (desks: Desk): Promise<number[]> =>
  (await readFile(desks.claims, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10))

/**
 * Take the workspace back — the assertion the kernel decides.
 *
 * A port cannot be bound while another process is listening on it, so this
 * fails if and only if that generation is still running. Nothing is timed and
 * nothing is retried: the answer was already true before the question.
 */
const claimWorkspace = async (t: TestContext, port: number): Promise<void> => {
  const server = createServer()
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(new Error(`the workspace on :${port} was still held (${error.code})`)),
    )
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

/**
 * A runtime whose CLI lookup the test owns.
 *
 * `#pointAtExecutable` is the last await in `start()` before the spawn, so
 * parking it puts the shutdown exactly where the bug needs it: after the
 * restart's stop has reaped the old family, before the new one is born.
 */
const runtimeWithAParkedLookup = (
  t: TestContext,
  desks: Desk,
): {
  runtime: AcpRuntime
  lookups: () => number
  park: () => Promise<void>
  release: () => void
} => {
  let counted = 0
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  let arrived: () => void = () => undefined
  const parked = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [desks.bridge],
    executable: { command: 'agent-cli', env: 'AGENT_CLI' } satisfies AcpExecutableSpec,
    // Declared so `reloadSecrets` is a live door on this runtime rather than
    // an `'unsupported'` early return — it is the third stop-then-start
    // caller, and the one neither test below would otherwise reach.
    secrets: [{ env: 'AGENT_TOKEN', label: 'Agent token' }],
    resolveSecret: () => 'a-token',
    resolveExecutable: async (): Promise<ResolvedExecutable | null> => {
      counted += 1
      if (gate) {
        arrived()
        await gate
      }
      return { path: '/nowhere/agent-cli', version: '1.0.0' }
    },
  })
  t.after(() => runtime.dispose())
  return {
    runtime,
    lookups: () => counted,
    park: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
      return parked
    },
    release: () => open(),
  }
}

test('a refresh parked mid-restart when the app quits spawns no bridge behind the quit', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const { runtime, park, release } = runtimeWithAParkedLookup(t, desks)
  await runtime.start()
  assert.deepEqual((await generations(desks)).length, 1, 'one bridge to begin with')

  const arrived = park()
  /* The refresher's own call. It stops the agent — the family is reaped and
     gone before the gap below opens — and starts it again. */
  const refresh = runtime.refreshCatalog()
  await arrived

  // The quit, landing in the gap. Nothing is in flight for it to wait on:
  // the connection has no child and no reap, so this returns at once.
  await runtime.dispose()
  release()

  /* Settled either way before anything is asked. A bridge that spawned has
     already claimed a workspace and answered the handshake this awaits, so
     the count below is a fact rather than a race. */
  const outcome = await refresh.then(
    () => 'the runtime reported a restart',
    (error: unknown) => String(error),
  )

  const born = await generations(desks)
  assert.deepEqual(
    born.length,
    1,
    `a second bridge was spawned into the quit, and nothing will reap it (workspaces: ${born.join(', ')})`,
  )
  await claimWorkspace(t, born[0]!)
  assert.match(outcome, /has been shut down/, 'and the refusal is reported, not passed off as a restart')

  /* And it left the same kind of state behind as its sibling. `start()` set
     `starting` on the way in; a throw that left it there would have two guards
     an arm's length apart disagreeing about what a runtime that did not start
     looks like. */
  const health = runtime.health()
  assert.equal(health.state, 'unavailable')
  assert.match(health.state === 'unavailable' ? health.message : '', /has been shut down/)
})

/**
 * The third stop-then-start caller, and the one the two cases above miss.
 *
 * `reloadSecrets` restarts for a different reason — a key changed, and the
 * agent read its environment at spawn — but it reaches the same two awaits
 * before the same spawn. Both round-one reviewers that read the whole branch
 * raised it independently as the door with no case on it, which is a good
 * enough reason on its own: the weld is meant to cover callers nobody has
 * thought of yet, and that claim is worth one test that is not `refreshCatalog`.
 */
test('a secret reload parked mid-restart when the app quits spawns no bridge either', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const { runtime, park, release } = runtimeWithAParkedLookup(t, desks)
  await runtime.start()
  assert.deepEqual((await generations(desks)).length, 1, 'one bridge to begin with')

  const arrived = park()
  const reloading = runtime.reloadSecrets()
  await arrived

  await runtime.dispose()
  release()

  const outcome = await reloading.then(
    (verdict) => `the runtime reported ${verdict}`,
    (error: unknown) => String(error),
  )

  const born = await generations(desks)
  assert.deepEqual(
    born.length,
    1,
    `a second bridge was spawned into the quit, and nothing will reap it (workspaces: ${born.join(', ')})`,
  )
  await claimWorkspace(t, born[0]!)
  assert.match(outcome, /has been shut down/, 'and the refusal is reported, not passed off as a reload')
})

test('a runtime the host has finished with will not start again', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const { runtime, lookups } = runtimeWithAParkedLookup(t, desks)
  await runtime.start()
  const born = await generations(desks)
  assert.deepEqual(born.length, 1)

  await runtime.dispose()
  await assert.rejects(runtime.start(), /has been shut down/)

  assert.deepEqual(await generations(desks), born, 'no bridge was spawned to find that out')
  // And nothing went looking on the way out either: the refusal is ahead of
  // the launch decision and the CLI lookup, both of which shell out.
  assert.equal(lookups(), 1, 'the CLI was looked for once, at the start that happened')

  // Disposing twice is a second no-op, not a second shutdown. Every test here
  // does it by way of `t.after`; this is the one that says so.
  await runtime.dispose()
  assert.deepEqual(await generations(desks), born, 'and disposing again changes nothing')

  await claimWorkspace(t, born[0]!)
})
