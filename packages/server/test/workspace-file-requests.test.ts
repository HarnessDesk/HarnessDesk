import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { builtinAgentRoot } from '../src/host.js'
import { canonicalTarget } from '../src/path-confinement.js'
import { confine } from '../src/workspace.js'
import { Client, start, stop } from './fixtures/harness.js'
import { FAKE_RUNTIME_ID } from './fixtures/fake-runtime.js'

/**
 * A file request is answered without the host's own thread waiting on a disk.
 *
 * Confinement looks at the disk — where a link really leads, which of the
 * roster's folders are linked in — and does it for every read, stat, save and
 * listing the renderer asks for, a few seconds apart for every open editor
 * tab. A synchronous call there stops every wire method and every session's
 * stream behind it for as long as the volume takes to answer, and a network
 * mount that has stopped answering never does.
 *
 * So the checks are asynchronous, and a volume that never answers costs the
 * one request that asked about it: refused at a deadline, its walk stopped,
 * and nothing else waiting on it.
 */

type Sync = (...args: unknown[]) => unknown

/** The synchronous reads confinement used to make, counted when they name something under `prefixes`. */
const watchSyncReads = (prefixes: readonly string[]): { readonly calls: string[]; restore(): void } => {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, Sync> & { realpathSync: Sync & { native: Sync } }
  const calls: string[] = []
  const counted = (name: string, original: Sync): Sync => (...args) => {
    const first = String(args[0])
    if (prefixes.some((prefix) => first.startsWith(prefix))) calls.push(`${name} ${first}`)
    return original(...args)
  }
  const originals = {
    readdirSync: fs['readdirSync']!,
    statSync: fs['statSync']!,
    lstatSync: fs['lstatSync']!,
    readlinkSync: fs['readlinkSync']!,
    realpathSync: fs.realpathSync,
  }
  fs['readdirSync'] = counted('readdirSync', originals.readdirSync)
  fs['statSync'] = counted('statSync', originals.statSync)
  fs['lstatSync'] = counted('lstatSync', originals.lstatSync)
  fs['readlinkSync'] = counted('readlinkSync', originals.readlinkSync)
  fs.realpathSync = Object.assign(counted('realpathSync', originals.realpathSync), {
    native: counted('realpathSync.native', originals.realpathSync.native),
  })
  syncBuiltinESMExports()
  return {
    calls,
    restore: () => {
      Object.assign(fs, originals)
      syncBuiltinESMExports()
    },
  }
}

test('file requests make no synchronous filesystem call on the host thread', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })

  // The roster as a person has it: a folder, and one linked in from elsewhere.
  const agents = join(harness.stateDir, 'agents')
  await mkdir(join(agents, 'reviewer'), { recursive: true })
  await writeFile(join(agents, 'reviewer', 'AGENT.md'), 'reviewer')
  await mkdir(join(harness.stateDir, 'elsewhere', 'scout'), { recursive: true })
  await writeFile(join(harness.stateDir, 'elsewhere', 'scout', 'AGENT.md'), 'scout')
  await symlink(join(harness.stateDir, 'elsewhere', 'scout'), join(agents, 'scout'))
  const notes = join(harness.stateDir, 'notes.md')
  await writeFile(notes, 'first draft\n')

  const watch = watchSyncReads([harness.stateDir, await realpath(harness.stateDir), builtinAgentRoot()])
  t.after(() => watch.restore())
  const requests: Array<() => Promise<unknown>> = [
    () => client.call('workspace/readFile', { path: notes }),
    () => client.call('workspace/readFile', { path: join(agents, 'scout', 'AGENT.md') }),
    () => client.call('workspace/stat', { path: notes }),
    () => client.call('workspace/browse', { mode: 'entries', root: harness.stateDir, path: harness.stateDir }),
    () => client.call('preview/ticket', { path: notes }),
    () => client.call('file/save', { path: notes, content: 'second draft\n', expectedHash: '' }),
  ]
  const outcomes: string[] = []
  for (const request of requests) {
    await request().then(
      () => outcomes.push('answered'),
      (error: unknown) => outcomes.push(error instanceof Error ? error.message : String(error)),
    )
  }
  watch.restore()

  assert.deepEqual(watch.calls, [], 'a synchronous call blocks every other request until the disk answers')
  // Not a refusal among them: the save answers with the file as it is, which is still an answer.
  assert.deepEqual(outcomes, requests.map(() => 'answered'))
})

type Call = (...args: unknown[]) => Promise<unknown>

const ASYNC_READS = ['realpath', 'lstat', 'readlink'] as const

/**
 * The asynchronous reads confinement makes, counted when they name something
 * under `prefix`, and held — never answered until `release()` — when `isHeld`
 * says so: which is what a volume that has stopped answering looks like from here.
 */
const holdDisk = (
  prefix: string,
  isHeld: (read: string, path: string) => boolean,
): { readonly calls: string[]; release(): void; restore(): void } => {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, Call>
  const calls: string[] = []
  const held: Array<() => void> = []
  const originals = Object.fromEntries(ASYNC_READS.map((read) => [read, fsp[read]!])) as Record<(typeof ASYNC_READS)[number], Call>
  for (const read of ASYNC_READS) {
    fsp[read] = (...args) => {
      const path = String(args[0])
      if (!path.startsWith(prefix)) return originals[read](...args)
      calls.push(`${read} ${path}`)
      if (!isHeld(read, path)) return originals[read](...args)
      return new Promise((resolve, reject) => {
        held.push(() => { originals[read](...args).then(resolve, reject) })
      })
    }
  }
  syncBuiltinESMExports()
  return {
    calls,
    release: () => { for (const answer of held.splice(0)) answer() },
    restore: () => {
      Object.assign(fsp, originals)
      syncBuiltinESMExports()
    },
  }
}

const scratch = async (t: TestContext): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-file-requests-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('a path whose volume does not answer is refused at the deadline, and nothing more is asked of it', { timeout: 20_000 }, async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  const target = join(root, 'a', 'b', 'c', 'new.txt')
  // The disk never answers about the file itself; it answers about everything else.
  const disk = holdDisk(dir, (read, path) => read === 'realpath' && path === target)
  t.after(() => disk.restore())
  const started = performance.now()
  await assert.rejects(
    confine(target, [root], { deadlineMs: 30 }),
    /could not be checked: its volume did not answer in time/,
  )
  assert.ok(performance.now() - started < 10_000, 'the refusal came with the deadline and not with the disk')
  // The disk answers late. The walk it was in the middle of has been told to stop, so it climbs no further.
  disk.release()
  await new Promise((done) => setTimeout(done, 150))
  assert.deepEqual(
    disk.calls.filter((call) => call.startsWith('realpath ')),
    [`realpath ${target}`, `realpath ${root}`],
    'a late answer must not start another step of a walk that was given up on',
  )
})

test('a walk that is told to stop takes no further step', async (t) => {
  const dir = await scratch(t)
  const target = join(dir, 'a', 'b', 'c', 'new.txt')
  const disk = holdDisk(dir, (read, path) => read === 'realpath' && path === target)
  t.after(() => disk.restore())
  const stop = new AbortController()
  const walk = canonicalTarget(target, stop.signal)
  stop.abort()
  disk.release()
  await assert.rejects(walk, (error: unknown) => (error as Error).name === 'AbortError')
  assert.deepEqual(disk.calls.filter((call) => call.startsWith('realpath ')), [`realpath ${target}`])
})

test('a path outside every root is refused without asking the disk about it', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  // Anything asked of this disk would wait for the deadline, which the refusal must not.
  const disk = holdDisk(dir, () => true)
  t.after(() => disk.restore())
  await assert.rejects(
    confine(join(dir, 'elsewhere', 'file.txt'), [root], { deadlineMs: 200 }),
    /is outside every open workspace/,
  )
  assert.deepEqual(disk.calls, [])
})

test('a path on a volume that stops answering holds its own request and no other', { timeout: 30_000 }, async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  const notes = join(harness.stateDir, 'notes.md')
  await writeFile(notes, 'first draft\n')
  const stalled = join(harness.stateDir, 'stalled-mount', 'file.txt')
  const disk = holdDisk(harness.stateDir, (read, path) => read === 'realpath' && path === stalled)
  try {
    let answered = false
    const waiting = client.call('workspace/stat', { path: stalled }).then(
      () => { answered = true },
      () => { answered = true },
    )
    // Every other request is answered while that one waits for its disk.
    await client.call('workspace/stat', { path: notes })
    const read = (await client.call('workspace/readFile', { path: notes })) as { kind?: string }
    assert.equal(read.kind, 'text')
    assert.equal(answered, false, 'the stalled request is still waiting for its volume')
    disk.release()
    await waiting
  } finally {
    // Whatever happened above, the disk answers and its deadline timer is cleared before the host stops.
    disk.release()
    disk.restore()
  }
})

test('a roster change reaches the file checks at once, and a folder linked in is then readable', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const agents = join(harness.stateDir, 'agents')
  await mkdir(join(agents, 'reviewer'), { recursive: true })
  await writeFile(join(agents, 'reviewer', 'AGENT.md'), 'reviewer')
  // The first request reads the roster's folders, and they are kept.
  await client.call('workspace/readFile', { path: join(agents, 'reviewer', 'AGENT.md') })

  // A folder is linked in afterwards, and the desk says the roster changed.
  await mkdir(join(harness.stateDir, 'elsewhere', 'scout'), { recursive: true })
  await writeFile(join(harness.stateDir, 'elsewhere', 'scout', 'AGENT.md'), 'scout')
  await symlink(join(harness.stateDir, 'elsewhere', 'scout'), join(agents, 'scout'))
  await client.call('agent/seating/set', { id: 'reviewer', seats: [{ runtime: FAKE_RUNTIME_ID, model: 'big' }] })

  const read = (await client.call('workspace/readFile', { path: join(agents, 'scout', 'AGENT.md') })) as { kind: string; content?: string }
  assert.equal(read.kind, 'text')
  assert.equal(read.content, 'scout')
})
