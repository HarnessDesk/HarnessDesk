import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { AcpRuntime } from '../src/index.js'

/**
 * A stop that has to end what the prompt started.
 *
 * DeepSeek Harness 0.2.2-rc.2 settles a cancelled prompt at once and leaves a
 * `subagent` child running; the agent then speaks for it with no prompt open,
 * and only closing the session ends it. An agent that declares
 * `cancelLeavesSubagents` is therefore closed and reopened in place after the
 * cancel. The fake's "start a subagent" plays that agent.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function lines(path: string): Promise<string[]> {
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
}

async function rig(t: TestContext, options: { flag: boolean; resumeOnly: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-stop-'))
  const files = {
    store: join(dir, 'store.json'),
    sequence: join(dir, 'sequence.txt'),
    subagents: join(dir, 'subagents.txt'),
  }
  const runtime = new AcpRuntime({
    id: 'stop-children',
    name: 'Stop Children',
    command: process.execPath,
    args: [FAKE],
    env: {
      FAKE_ACP_STORE: files.store,
      FAKE_ACP_SEQUENCE: files.sequence,
      FAKE_ACP_SUBAGENTS: files.subagents,
      ...(options.resumeOnly ? { FAKE_ACP_RESUME_ONLY: '1' } : {}),
    },
    ...(options.flag ? { cancelLeavesSubagents: true } : {}),
  })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  t.after(async () => {
    await runtime.dispose()
    for (const pid of await lines(files.subagents)) if (alive(Number(pid))) process.kill(Number(pid), 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  })
  await runtime.start()
  const until = async (predicate: (event: AgentEvent) => boolean, timeoutMs = 5_000): Promise<AgentEvent> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = events.find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`timed out; saw ${events.map((event) => event.type).join(', ')}`)
      await pause(10)
    }
  }
  return { dir, files, runtime, events, until }
}

type Rig = Awaited<ReturnType<typeof rig>>

const saidSubagent = (event: AgentEvent): boolean =>
  event.type === 'item/delta' && JSON.stringify(event).includes('subagent still working')

const completions = (events: readonly AgentEvent[]) =>
  events.filter((event): event is Extract<AgentEvent, { type: 'turn/completed' }> => event.type === 'turn/completed')

const completedTimes = async (r: Rig, count: number): Promise<void> => {
  await r.until(() => completions(r.events).length >= count)
}

async function startSubagent(r: Rig) {
  const session = await r.runtime.createSession({ cwd: r.dir })
  await session.send([{ type: 'text', text: 'start a subagent' }])
  await r.until(saidSubagent)
  const [pid] = await lines(r.files.subagents)
  assert.ok(pid && alive(Number(pid)), 'the subagent is running')
  return { session, pid: Number(pid) }
}

for (const resumeOnly of [true, false]) {
  const verb = resumeOnly ? 'session/resume' : 'session/load'
  test(`a stop cancels, closes and reopens with ${verb}, and the conversation carries on`, async (t) => {
    const r = await rig(t, { flag: true, resumeOnly })
    const { session, pid } = await startSubagent(r)

    await session.interrupt()

    // Cancel, then close, then the reopen, all on the same conversation.
    const id = String(session.id)
    assert.deepEqual(await lines(r.files.sequence), [
      `session/new ${id}`,
      `session/cancel ${id}`,
      `session/close ${id}`,
      `${verb} ${id}`,
    ])
    const deadline = Date.now() + 2_000
    while (alive(pid) && Date.now() < deadline) await pause(20)
    assert.equal(alive(pid), false, 'closing the session ended the subagent')

    // One stopped turn, and nothing the closed session said after it.
    const stopped = completions(r.events)
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0]?.turn.status, 'interrupted')
    const settledAt = r.events.indexOf(stopped[0]!)
    await pause(150)
    assert.equal(r.events.slice(settledAt).filter(saidSubagent).length, 0, 'no word from the subagent after the stop')
    assert.equal(r.events.filter((event) => event.type === 'turn/started').length, 1, 'the reopen replays nothing into the conversation')
    assert.equal((await r.runtime.readSession(session.id)).turns.length, 1)

    // The next prompt reaches the reopened session through the same handle.
    await session.send([{ type: 'text', text: 'hello again' }])
    await completedTimes(r, 2)
    const next = completions(r.events)[1]!.turn
    assert.equal(next.status, 'completed')
    assert.ok(JSON.stringify(next.items).includes('hearing: hello again'), JSON.stringify(next.items))
    assert.equal((await r.runtime.readSession(session.id)).turns.length, 2)
  })
}

test('a send made while the stop is still reopening goes to the reopened session', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const { session } = await startSubagent(r)
  const stopping = session.interrupt()
  await completedTimes(r, 1)
  await session.send([{ type: 'text', text: 'right after' }])
  await stopping
  await completedTimes(r, 2)
  assert.equal(completions(r.events)[1]?.turn.status, 'completed')
  const id = String(session.id)
  assert.deepEqual((await lines(r.files.sequence)).slice(-2), [`session/close ${id}`, `session/resume ${id}`])
})

test('without the declaration a stop sends the cancel and nothing else', async (t) => {
  const r = await rig(t, { flag: false, resumeOnly: true })
  const { session, pid } = await startSubagent(r)

  await session.interrupt()
  await completedTimes(r, 1)
  await pause(200)

  const id = String(session.id)
  assert.deepEqual(await lines(r.files.sequence), [`session/new ${id}`, `session/cancel ${id}`])
  assert.equal(alive(pid), true, 'the cancel alone leaves the subagent running')
  assert.equal(completions(r.events)[0]?.turn.status, 'interrupted')
})

test('a reopen that fails detaches the conversation and says why, without hanging the stop', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const { session } = await startSubagent(r)
  // The agent's store loses the conversation: the close succeeds, the resume cannot.
  await rm(r.files.store, { force: true })

  await session.interrupt()

  assert.equal(completions(r.events).length, 1)
  assert.equal(completions(r.events)[0]?.turn.status, 'interrupted')
  const error = r.events.find((event) => event.type === 'error')
  assert.ok(error && error.type === 'error', 'the failure is reported')
  assert.match(error.error.message, /could not reopen this conversation after it was stopped/)
  assert.equal(error.error.code, 'runtimeUnavailable')
  assert.ok(r.events.some((event) => event.type === 'session/detached' && String(event.sessionId) === String(session.id)))
  await assert.rejects(() => session.send([{ type: 'text', text: 'anyone there' }]), /could not reopen/)
})
