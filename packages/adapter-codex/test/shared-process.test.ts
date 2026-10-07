import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'
import { CodexRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const until = async (condition: () => boolean | Promise<boolean>, message: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const lines = async <T>(path: string): Promise<T[]> =>
  (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)

const environment = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

/** One account: a Codex home of its own, and ledgers of the app-servers and tool helpers the scripted Codex starts for it. */
const account = async (
  t: TestContext,
  env: Readonly<Record<string, string>> = {},
  gates: readonly ('unload' | 'close' | 'delegate-list' | 'delegate-read')[] = [],
) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-shared-'))
  const helpers = join(dir, 'helpers.ndjson')
  const claims = join(dir, 'servers.ndjson')
  const opened = join(dir, 'threads.ndjson')
  const calls = join(dir, 'calls.ndjson')
  await Promise.all([helpers, claims, opened, calls].map((file) => writeFile(file, '')))
  // A gate holds a step of Codex's close open for as long as its file exists.
  const gateFile = (name: string) => join(dir, `${name}.gate`)
  await Promise.all(gates.map((name) => writeFile(gateFile(name), '')))
  const runtime = new CodexRuntime({
    binaryPath: FAKE, codexHome: dir, clientName: 'harnessdesk-test',
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', FAKE_CODEX_MODE: 'hold',
      FAKE_CODEX_MCP_CHILDREN: helpers, FAKE_CODEX_CLAIMS: claims, FAKE_CODEX_THREADS: opened,
      FAKE_CODEX_PROCESS_CALLS: calls,
      ...Object.fromEntries(gates.map((name) => [`FAKE_CODEX_${name.toUpperCase().replaceAll('-', '_')}_GATE`, gateFile(name)])), ...env },
  })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  await runtime.start()
  return {
    runtime, events, dir,
    servers: async () => (await readFile(claims, 'utf8')).trim().split('\n').filter(Boolean).map(Number),
    helpers: () => lines<{ threadId: string; pid: number; parent: number }>(helpers),
    opened: () => lines<{ method: string; threadId: string; pid: number; cwd: string | null; model: string | null; environment: Record<string, string> | null }>(opened),
    calls: () => lines<{ method: string; threadId?: string }>(calls),
    seat: async (name: string, options: { model?: string; environment?: Readonly<Record<string, string>> } = {}): Promise<AgentSession> => {
      const cwd = join(dir, name)
      await mkdir(cwd, { recursive: true })
      return runtime.createSession({ cwd, ...options })
    },
    turn: async (session: AgentSession) => {
      await session.send([{ type: 'text', text: 'Keep working' }])
      await until(() => events.some((event) => event.type === 'turn/started' && event.sessionId === session.id), 'the turn started')
    },
    ended: (session: AgentSession) =>
      events.some((event) => event.type === 'turn/completed' && event.sessionId === session.id),
    release: (name: 'unload' | 'close' | 'delegate-list' | 'delegate-read') => rm(gateFile(name), { force: true }),
  }
}

test('seats on one account share its one process, and a second account has its own', async (t) => {
  const first = await account(t)
  for (let n = 0; n < 8; n++) await first.seat(`seat-${n}`)
  const servers = await first.servers()
  assert.equal(servers.length, 1, 'eight seats start one app-server')
  const helpers = await first.helpers()
  assert.equal(helpers.length, 8, 'each seat still has its own tool helpers')
  assert.deepEqual([...new Set(helpers.map((helper) => helper.parent))], servers, 'every helper hangs under that one process')

  const second = await account(t, { FAKE_CODEX_CLAIMS: join(first.dir, 'servers.ndjson') })
  await second.seat('seat-0')
  await second.seat('seat-1')
  const both = await first.servers()
  assert.equal(both.length, 2, 'two accounts start two app-servers however many seats each has')
  assert.equal(new Set(both).size, 2)
})

test('each seat’s folder, environment and model reach its own thread', async (t) => {
  const d = await account(t)
  const one = await d.seat('seat-one', { model: 'model-one', environment: environment(30000) })
  const two = await d.seat('seat-two', { model: 'model-two', environment: environment(30020) })
  const plain = await d.seat('seat-plain')
  await one.close()
  await two.close()
  await d.runtime.resumeSession(one.id, { cwd: join(d.dir, 'seat-one') })
  await d.runtime.resumeSession(two.id, { cwd: join(d.dir, 'seat-two') })
  await d.runtime.forkSession(one.id)

  const rows = await d.opened()
  assert.deepEqual([...new Set(rows.map((row) => row.pid))], await d.servers(), 'every thread was opened in the one process')
  const of = (id: string, method: string) => rows.find((row) => row.threadId === id && row.method === method)!
  assert.deepEqual(
    [of(one.id, 'thread/start'), of(two.id, 'thread/start'), of(plain.id, 'thread/start')].map((row) => [row.cwd, row.model, row.environment]),
    [
      [join(d.dir, 'seat-one'), 'model-one', environment(30000)],
      [join(d.dir, 'seat-two'), 'model-two', environment(30020)],
      [join(d.dir, 'seat-plain'), null, null],
    ],
  )
  assert.equal(of(one.id, 'thread/resume').cwd, join(d.dir, 'seat-one'))
  assert.deepEqual(of(one.id, 'thread/resume').environment, environment(30000), 'a resumed seat keeps its own environment')
  assert.deepEqual(of(two.id, 'thread/resume').environment, environment(30020))
  const forks = rows.filter((row) => row.method === 'thread/fork')
  assert.deepEqual(forks.map((row) => row.environment), [environment(30000)], 'a fork inherits its source’s environment, not another seat’s')
  assert.equal(d.runtime.session(one.id)?.settings()?.model, 'model-one')
  assert.equal(d.runtime.session(two.id)?.settings()?.model, 'model-two')
})

test('stopping one seat leaves the other seats’ turns running', async (t) => {
  const d = await account(t)
  const stopped = await d.seat('stopped')
  const working = await d.seat('working')
  const other = await d.seat('other')
  await d.turn(working)
  await d.turn(other)
  await d.turn(stopped)
  const [pid] = await d.servers()
  const helpers = await d.helpers()

  await stopped.interrupt()
  await until(() => d.ended(stopped), 'the stopped seat’s turn ended')
  await stopped.close()

  assert.deepEqual(await d.servers(), [pid], 'one process before and after')
  assert.ok(running(pid!), 'the process the others work in is still there')
  assert.ok(!d.ended(working) && !d.ended(other), 'no other turn was touched')
  assert.equal(d.runtime.session(working.id), working)
  assert.equal(d.runtime.session(other.id), other)
  assert.equal(d.runtime.health().state, 'ready')
  assert.ok(!d.events.some((event) => event.type === 'session/detached'), 'no seat lost its handle')
  for (const helper of helpers.filter((one) => one.threadId !== stopped.id)) assert.ok(running(helper.pid), 'the others keep their helpers')

  await working.interrupt()
  await until(() => d.ended(working), 'the working seat can still be stopped by its own call')
  assert.ok(!d.ended(other), 'and stopping it does not stop the next one either')
})

test('closing a seat interrupts its turn before unsubscribing, leaving the other seat working', async (t) => {
  const d = await account(t)
  const seat = await d.seat('seat')
  const other = await d.seat('other')
  await d.turn(seat)
  await d.turn(other)
  await seat.close()
  await until(() => d.ended(seat), 'the closed seat must finish its interrupted turn')
  const calls = (await d.calls()).filter(call => call.threadId === seat.id).map(call => call.method)
  assert.ok(calls.indexOf('turn/interrupt') >= 0)
  assert.ok(calls.indexOf('turn/interrupt') < calls.indexOf('thread/unsubscribe'))
  const again = await d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') })
  await assert.rejects(() => again.interrupt(), /no turn is currently running/)
  assert.ok(!d.ended(other), 'the other seat keeps working')
})

test('a failed close interruption retains the subscribed handle for a retry', async (t) => {
  const d = await account(t)
  const seat = await d.seat('seat')
  await d.turn(seat)
  const interrupt = seat.interrupt.bind(seat)
  seat.interrupt = async () => { throw new Error('Synthetic interruption refusal') }
  await assert.rejects(seat.close(), /Synthetic interruption refusal/)
  assert.equal(d.runtime.session(seat.id), seat)
  assert.ok(!(await d.calls()).some(call => call.method === 'thread/unsubscribe' && call.threadId === seat.id))
  seat.interrupt = interrupt
  await seat.close()
  await until(() => d.ended(seat), 'the retry ends the turn')
  assert.equal(d.runtime.session(seat.id), undefined)
})

test('a resumed active thread can steer and stop its current turn', async (t) => {
  const d = await account(t)
  const seat = await d.seat('seat')
  const other = await d.seat('other')
  await d.turn(seat)
  await d.turn(other)

  // Simulate an externally unsubscribed active thread. Local pane close now interrupts.
  seat.interrupt = async () => {}
  await seat.close()
  const again = await d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') })
  await again.steer([{ type: 'text', text: 'Continue here' }])
  await again.interrupt()
  await until(() => d.ended(seat), 'the reopened handle stops its turn')
  await assert.rejects(() => again.steer([{ type: 'text', text: 'Too late' }]), /no turn is currently running/)
  assert.ok(!d.ended(other), 'the other seat keeps working')
  assert.equal((await d.servers()).length, 1)
})

test('a completion heard while recovering a resumed turn beats the older turn snapshot', async (t) => {
  const d = await account(t, { FAKE_CODEX_COMPLETE_ON_TURNS_LIST: '1' })
  const seat = await d.seat('seat')
  await d.turn(seat)
  seat.interrupt = async () => {}
  await seat.close()
  const again = await d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') })
  assert.ok(d.ended(seat), 'completion arrived with the in-progress history snapshot')
  await assert.rejects(() => again.steer([{ type: 'text', text: 'Too late' }]), /no turn is currently running/)
  await assert.rejects(() => again.interrupt(), /no turn is currently running/)
})

test('a crashed process is restarted and every seat re-attached', async (t) => {
  const d = await account(t)
  const seats = [await d.seat('one'), await d.seat('two'), await d.seat('three')]
  await d.turn(seats[0]!)
  const [first] = await d.servers()
  assert.equal((await d.servers()).length, 1)

  process.kill(first!, 'SIGKILL')
  await until(async () => (await d.servers()).length === 2 && d.runtime.health().state === 'ready', 'the runtime started its process again')
  const [, second] = await d.servers()
  assert.notEqual(second, first)
  assert.ok(running(second!) && !running(first!))
  for (const seat of seats) {
    assert.ok(d.events.some((event) => event.type === 'session/detached' && event.sessionId === seat.id), 'each seat is told it lost its handle')
    assert.equal(d.runtime.session(seat.id), undefined, 'and the dead handle is not offered again')
  }

  const back = await Promise.all(seats.map((seat, n) => d.runtime.resumeSession(seat.id, { cwd: join(d.dir, ['one', 'two', 'three'][n]!) })))
  assert.deepEqual(back.map((seat) => seat.id), seats.map((seat) => seat.id), 'every seat reopens as itself')
  assert.deepEqual(await d.servers(), [first, second], 're-attaching the three seats started no process beyond the restarted one')
  assert.ok((await d.opened()).filter((row) => row.method === 'thread/resume').every((row) => row.pid === second))
})

test('a finished seat’s thread is released while the others keep working', async (t) => {
  const d = await account(t, { FAKE_CODEX_UNLOAD_MS: '1' })
  const finished = await d.seat('finished')
  const working = await d.seat('working')
  await d.turn(working)
  const helpers = await d.helpers()
  const own = helpers.find((helper) => helper.threadId === finished.id)!
  const kept = helpers.find((helper) => helper.threadId === working.id)!
  assert.equal((await d.servers()).length, 1)

  const told = d.events.length
  await finished.close()
  await until(() => !running(own.pid), 'the finished seat’s helpers were released')
  assert.ok(running(kept.pid), 'the working seat keeps its own')
  assert.ok(!d.ended(working), 'and its turn was not touched')
  assert.equal((await d.servers()).length, 1, 'all of it in the one process')
  assert.deepEqual(d.events.slice(told).filter((event) => 'sessionId' in event && event.sessionId === finished.id), [],
    'the close the desk asked for is not announced back as one it did not')
})

test('a seat reopened inside the release window keeps its thread and its helpers', async (t) => {
  const d = await account(t, { FAKE_CODEX_UNLOAD_MS: '1' }, ['unload'])
  const seat = await d.seat('seat')
  const [own] = await d.helpers()
  await seat.close()
  const again = await d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') })
  await d.release('unload')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(running(own!.pid), 'the thread was subscribed again, so Codex never closed it')
  assert.equal((await d.helpers()).length, 1, 'and no second set of helpers was started')
  assert.equal(d.runtime.session(seat.id), again)
  // The close it was waiting for is no longer owed, so one Codex makes later is news again.
  await again.send([{ type: 'text', text: 'closeit' }])
  await until(() => d.events.some((event) => event.type === 'session/closed' && event.sessionId === seat.id), 'a close of the reopened thread is announced')
})

test('a seat reopened while Codex is closing its thread waits for the close and loads it afresh', async (t) => {
  const d = await account(t, { FAKE_CODEX_UNLOAD_MS: '1' }, ['close'])
  const seat = await d.seat('seat')
  const [old] = await d.helpers()
  await seat.close()
  await until(() => !running(old!.pid), 'Codex began closing the thread')
  let reopened: AgentSession | null = null
  const reopening = d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') }).then((session) => { reopened = session })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(reopened, null, 'the reopening waits for the close rather than failing')
  await d.release('close')
  await reopening
  assert.equal(reopened!.id, seat.id)
  const helpers = await d.helpers()
  assert.equal(helpers.length, 2, 'the reloaded thread has helpers of its own')
  assert.ok(running(helpers[1]!.pid))
  assert.ok(!d.events.some((event) => event.type === 'session/closed' && event.sessionId === seat.id))
  assert.equal((await d.servers()).length, 1)
})

test('a close Codex makes on its own, of a thread the desk still holds, is still announced', async (t) => {
  const d = await account(t)
  const seat = await d.seat('seat')
  const other = await d.seat('other')
  await seat.send([{ type: 'text', text: 'closeit' }])
  await until(() => d.events.some((event) => event.type === 'session/closed' && event.sessionId === seat.id), 'the close was announced')
  assert.ok(!d.events.some((event) => event.type === 'session/closed' && event.sessionId === other.id), 'and only for the thread that closed')
})

test('closing a seat gives back the sub-agent threads it left loaded, and only its own', async (t) => {
  const d = await account(t, { FAKE_CODEX_UNLOAD_MS: '1' })
  const finished = await d.seat('finished')
  const working = await d.seat('working')
  await finished.send([{ type: 'text', text: 'spawn' }])
  await working.send([{ type: 'text', text: 'spawn' }])
  await until(async () => (await d.helpers()).length === 4, 'each seat spawned a sub-agent with helpers of its own')
  const helpers = await d.helpers()
  const own = helpers.filter((helper) => helper.threadId.startsWith(`${finished.id}`))
  const theirs = helpers.filter((helper) => helper.threadId.startsWith(`${working.id}`))
  assert.equal(own.length, 2, 'the seat and its sub-agent')
  assert.equal(theirs.length, 2)

  await until(() => d.ended(finished) && d.ended(working), 'both spawning turns finished')
  const told = d.events.length
  await finished.close()
  await until(() => own.every((helper) => !running(helper.pid)), 'the closed seat and its sub-agent were both released')
  assert.ok(theirs.every((helper) => running(helper.pid)), 'the other seat and its sub-agent were not touched')
  assert.deepEqual(
    d.events.slice(told).filter((event) => 'sessionId' in event && String(event.sessionId).startsWith(String(finished.id))), [],
    'and the desk is told nothing of the closed seat’s threads, the sub-agent’s included',
  )

  await working.close()
  await until(() => theirs.every((helper) => !running(helper.pid)), 'closing the other seat gives back its own')
  assert.equal((await d.servers()).length, 1)
})

for (const gate of ['delegate-list', 'delegate-read'] as const) {
  test(`reopening a root during ${gate} abandons its old sub-agent release sweep`, async (t) => {
    const d = await account(t, { FAKE_CODEX_UNLOAD_MS: '1' }, [gate, 'unload'])
    const seat = await d.seat('seat')
    const other = await d.seat('other')
    await seat.send([{ type: 'text', text: 'spawn' }])
    await other.send([{ type: 'text', text: 'spawn' }])
    await until(() => d.ended(seat) && d.ended(other), 'both spawning turns finished')
    const helpers = await d.helpers()
    const own = helpers.filter((helper) => helper.threadId.startsWith(String(seat.id)))
    const theirs = helpers.filter((helper) => helper.threadId.startsWith(String(other.id)))
    await seat.close()
    const method = gate === 'delegate-list' ? 'thread/loaded/list' : 'thread/read'
    await until(async () => (await d.calls()).some((call) => call.method === method), 'the sweep reached its held request')
    const again = await d.runtime.resumeSession(seat.id, { cwd: join(d.dir, 'seat') })
    assert.equal(d.runtime.session(seat.id), again)
    await d.release(gate)
    const reply = gate === 'delegate-list' ? 'DELEGATE_LIST_HELD_REPLIED' : 'DELEGATE_READ_HELD_REPLIED'
    await until(async () => (await d.calls()).filter((call) => call.method === reply).length >= (gate === 'delegate-list' ? 1 : 2),
      'the old sweep’s held replies were delivered')
    await d.release('unload')
    // Completing a later sweep is the barrier for the older, released request.
    await other.close()
    await until(() => theirs.every((helper) => !running(helper.pid)), 'the later sweep completed')
    assert.ok(own.every((helper) => running(helper.pid)), 'the reopened root keeps its sub-agent subscribed')
    const calls = await d.calls()
    assert.ok(!calls.some((call) => call.method === 'thread/unsubscribe' && call.threadId === own[1]!.threadId),
      'the abandoned sweep never unsubscribed its descendant')
  })
}
