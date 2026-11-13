import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentItem } from '@harnessdesk/protocol'

import { AcpRuntime, type AcpAgentConfig } from '../src/index.js'

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

interface RigOptions {
  readonly flag: boolean
  readonly resumeOnly: boolean
  /** More of the fake's switches. */
  readonly env?: Readonly<Record<string, string>>
  /** More of the runtime's configuration. */
  readonly config?: Partial<AcpAgentConfig>
}

async function rig(t: TestContext, options: RigOptions) {
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
      ...options.env,
    },
    ...(options.flag ? { cancelLeavesSubagents: true } : {}),
    ...options.config,
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

/** A session with a process of its own: the agent offers no close, so each conversation gets a worker. */
const OWN_PROCESS = { FAKE_ACP_NO_CLOSE: '1' }
/** A prompt the cancel does not settle: only the close ends it. */
const NEVER_SETTLES = { FAKE_ACP_IGNORE_CANCEL: '1' }
const QUICK = { stopReopenTimings: { settleMs: 150 } }

async function stoppedOnce(r: Rig, session: Awaited<ReturnType<typeof startSubagent>>['session']) {
  const stopped = completions(r.events)
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0]?.turn.status, 'interrupted')
  assert.equal(r.events.some((event) => event.type === 'error'), false, JSON.stringify(r.events.filter((event) => event.type === 'error')))
  await session.send([{ type: 'text', text: 'hello again' }])
  await completedTimes(r, 2)
  assert.equal(completions(r.events)[1]?.turn.status, 'completed')
  assert.equal(completions(r.events).length, 2, 'the close never failed the stopped turn afterwards')
}

test('a stop on a session with its own process stops that process and reopens on a new one', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: OWN_PROCESS })
  const { session, pid } = await startSubagent(r)
  await session.interrupt()
  const id = String(session.id)
  assert.deepEqual(await lines(r.files.sequence), [`session/new ${id}`, `session/cancel ${id}`, `session/resume ${id}`])
  const deadline = Date.now() + 2_000
  while (alive(pid) && Date.now() < deadline) await pause(20)
  assert.equal(alive(pid), false, 'stopping the process ended the subagent')
  await stoppedOnce(r, session)
})

for (const [label, env] of [['a shared process', NEVER_SETTLES], ['its own process', { ...NEVER_SETTLES, ...OWN_PROCESS }]] as const) {
  test(`a prompt the cancel never settles is the stopped turn, not a failed one, on ${label}`, async (t) => {
    const r = await rig(t, { flag: true, resumeOnly: true, env, config: QUICK })
    const { session } = await startSubagent(r)
    const started = Date.now()
    await session.interrupt()
    assert.ok(Date.now() - started < 3_000, `the stop waited ${Date.now() - started}ms`)
    await pause(100)
    await stoppedOnce(r, session)
  })
}

test('a reopen that does not finish in time detaches the conversation, and its late open is closed again', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { FAKE_ACP_RESUME_DELAY_MS: '1500' }, config: { stopReopenTimings: { reopenMs: 200 } } })
  const { session } = await startSubagent(r)
  const started = Date.now()
  await session.interrupt()
  assert.ok(Date.now() - started < 1_200, `the stop waited ${Date.now() - started}ms`)
  assert.equal(completions(r.events)[0]?.turn.status, 'interrupted')
  const error = r.events.find((event) => event.type === 'error')
  assert.ok(error && error.type === 'error')
  assert.match(error.error.message, /did not finish within 0.2 seconds/)
  assert.ok(r.events.some((event) => event.type === 'session/detached'))
  const id = String(session.id)
  const deadline = Date.now() + 4_000
  while ((await lines(r.files.sequence)).at(-1) !== `session/close ${id}` && Date.now() < deadline) await pause(20)
  assert.deepEqual((await lines(r.files.sequence)).slice(-3), [`session/close ${id}`, `session/resume ${id}`, `session/close ${id}`])
})

test('a question asked while the stop waits is withdrawn, and none is put to the person during the reopen', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { ...NEVER_SETTLES, FAKE_ACP_ASK_AFTER_CANCEL: '1' }, config: { stopReopenTimings: { settleMs: 400 } } })
  const { session } = await startSubagent(r)
  await session.interrupt()
  const requested = r.events.filter((event) => event.type === 'approval/requested')
  assert.equal(requested.length, 1)
  const resolved = r.events.find((event) => event.type === 'approval/resolved')
  assert.ok(resolved && resolved.type === 'approval/resolved' && resolved.resolution.outcome === 'abandoned', JSON.stringify(resolved))
  const deadline = Date.now() + 2_000
  while (!(await lines(r.files.sequence)).includes('permission cancelled') && Date.now() < deadline) await pause(20)
  assert.ok((await lines(r.files.sequence)).includes('permission cancelled'))
})

test('what the reopen says of the session is kept, and anything else it says is not', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { FAKE_ACP_OPEN_MODE: 'terse' } })
  const { session } = await startSubagent(r)
  const before = r.events.length
  await session.interrupt()
  const after = r.events.slice(before)
  assert.ok(after.some((event) => event.type === 'session/options'), 'the mode the reopen declared reached the window')
  assert.equal(JSON.stringify(after).includes('said while reopening'), false)
})

test('a second stop while the first is still reopening sends nothing more', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const { session } = await startSubagent(r)
  await Promise.all([session.interrupt(), pause(5).then(() => session.interrupt())])
  const id = String(session.id)
  assert.deepEqual(await lines(r.files.sequence), [`session/new ${id}`, `session/cancel ${id}`, `session/close ${id}`, `session/resume ${id}`])
})

test('releasing a running conversation on a shared process with no close cancels it without waiting or reopening', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { ...OWN_PROCESS, ...NEVER_SETTLES }, config: { sharedSessionProcess: true } })
  const { session } = await startSubagent(r)
  const started = Date.now()
  await session.close()
  assert.ok(Date.now() - started < 2_000, `the release waited ${Date.now() - started}ms`)
  const id = String(session.id)
  // The last conversation's release also rests the shared process, which
  // may end before it reads the cancel; either way nothing is closed or reopened.
  await pause(100)
  assert.deepEqual((await lines(r.files.sequence)).filter((line) => !line.startsWith('session/cancel ')), [`session/new ${id}`])
})

/**
 * Sub-agents that outlast the turn. An agent's delegation list can still name
 * a child as running after the prompt that started it has ended; the
 * conversation then says so, and Stop ends the children without a turn.
 */
const statuses = (r: Rig, id: string) =>
  r.events.filter((event): event is Extract<AgentEvent, { type: 'session/status' }> =>
    event.type === 'session/status' && String(event.sessionId) === id).map((event) => event.status)
const outlasting = (r: Rig, id: string): boolean => {
  const status = statuses(r, id).at(-1)
  return status?.type === 'idle' && status.subagentsRunning === true
}

async function idleOverDelegation(r: Rig, flagged = true) {
  const session = await r.runtime.createSession({ cwd: r.dir })
  // A first exchange the agent keeps, so the conversation can be reopened.
  await session.send([{ type: 'text', text: 'hello' }])
  await completedTimes(r, 1)
  await session.send([{ type: 'text', text: 'deleg spawn' }])
  await completedTimes(r, 2)
  if (flagged) await r.until(() => outlasting(r, String(session.id)))
  // The list is pushed before the prompt settles; give a status it might raise time to land.
  else await pause(100)
  return session
}
const everOutlasting = (r: Rig, id: string, from = 0): boolean =>
  r.events.slice(from).some((event) => event.type === 'session/status' && String(event.sessionId) === id &&
    event.status.type === 'idle' && event.status.subagentsRunning === true)

/** Waits for the agent to have read a notification the runtime sent it, which nothing answers. */
async function sequenceGrows(r: Rig, from: number): Promise<string[]> {
  const deadline = Date.now() + 2_000
  while ((await lines(r.files.sequence)).length === from && Date.now() < deadline) await pause(20)
  await pause(100)
  return (await lines(r.files.sequence)).slice(from)
}

test('an idle conversation over a running delegation says its sub-agents still work, and stops saying it when the list says they ended', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const session = await idleOverDelegation(r)
  await session.send([{ type: 'text', text: 'deleg finish' }])
  await completedTimes(r, 3)
  await r.until(() => !outlasting(r, String(session.id)) && statuses(r, String(session.id)).at(-1)?.type === 'idle')
})

test('Stop with the turn over closes and reopens the session to end its sub-agents, and starts no turn', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const session = await idleOverDelegation(r)
  const id = String(session.id)
  const turnsBefore = r.events.filter((event) => event.type === 'turn/started').length
  const sequenceBefore = (await lines(r.files.sequence)).length

  await session.interrupt()

  assert.deepEqual((await lines(r.files.sequence)).slice(sequenceBefore), [`session/close ${id}`, `session/resume ${id}`],
    'no prompt to cancel: the close and the reopen, and nothing else')
  assert.equal(outlasting(r, id), false, 'the conversation no longer says a sub-agent works')
  assert.equal(statuses(r, id).at(-1)?.type, 'idle')
  await pause(150)
  assert.equal(r.events.filter((event) => event.type === 'turn/started').length, turnsBefore, 'no turn was started')
  assert.equal(completions(r.events).length, 2, 'and none was ended')
  assert.equal(r.events.some((event) => event.type === 'error'), false)

  // The conversation carries on through the same handle.
  await session.send([{ type: 'text', text: 'hello again' }])
  await completedTimes(r, 3)
  assert.equal(completions(r.events)[2]?.turn.status, 'completed')
})

test('without the declaration, a running delegation does not offer Stop, whose cancel with no prompt ACP leaves undefined', async (t) => {
  const r = await rig(t, { flag: false, resumeOnly: true })
  const session = await idleOverDelegation(r, false)
  const id = String(session.id)
  assert.equal(everOutlasting(r, id), false, 'the conversation is never said to have sub-agents Stop can end')
  // A Stop sent anyway is the agent's own cancel, as an idle Stop always was.
  const sequenceBefore = (await lines(r.files.sequence)).length
  await session.interrupt()
  assert.deepEqual(await sequenceGrows(r, sequenceBefore), [`session/cancel ${id}`])
})

test('an agent that declares it but cannot be closed here does not offer Stop, and a Stop sent anyway is its cancel', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: OWN_PROCESS, config: { sharedSessionProcess: true } })
  const session = await idleOverDelegation(r, false)
  const id = String(session.id)
  assert.equal(everOutlasting(r, id), false, 'no close can run on a shared process without session/close, so no Stop is offered')
  const sequenceBefore = (await lines(r.files.sequence)).length
  await session.interrupt()
  assert.deepEqual(await sequenceGrows(r, sequenceBefore), [`session/cancel ${id}`],
    'the close could not run, so the cancel is sent rather than nothing')
})

test('a list the closing session or the reopened one replays does not say the stopped sub-agent runs again; a new one does', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { FAKE_ACP_DELEGATION_REPLAY: '1' } })
  const session = await idleOverDelegation(r)
  const id = String(session.id)
  const sequenceBefore = (await lines(r.files.sequence)).length
  const eventsBefore = r.events.length

  await session.interrupt()

  assert.deepEqual((await lines(r.files.sequence)).slice(sequenceBefore), [`session/close ${id}`, `session/resume ${id}`],
    'the close and the reopen ran')
  await pause(150)
  assert.equal(outlasting(r, id), false, 'the replayed list did not bring the flag back')
  assert.equal(everOutlasting(r, id, eventsBefore), false, 'not even for a moment')
  await session.send([{ type: 'text', text: 'deleg again' }])
  await completedTimes(r, 3)
  await r.until(() => outlasting(r, id))
})

test('the closing session’s last list still ends the stopped sub-agent’s row, though it says nothing of what runs', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true, env: { FAKE_ACP_CLOSE_ENDS_DELEGATIONS: '1' } })
  const session = await idleOverDelegation(r)
  const id = String(session.id)
  const eventsBefore = r.events.length

  await session.interrupt()

  const ended = r.events.slice(eventsBefore).find((event) => event.type === 'item/completed' && String(event.sessionId) === id &&
    event.item.type === 'subagent' && String(event.item.id) === 'd1')
  assert.ok(ended, 'the row of the child the close ended is marked ended')
  const row = (ended as Extract<AgentEvent, { type: 'item/completed' }>).item
  assert.equal(row.type === 'subagent' ? row.status : null, 'failed')
  const rows = (await r.runtime.readSession(session.id)).turns.flatMap((turn) => turn.items).filter((item): item is Extract<AgentItem, { type: 'subagent' }> => item.type === 'subagent')
  assert.deepEqual(rows.map((item) => item.status), ['failed'], 'one row, ended')
  assert.equal(outlasting(r, id), false)
})

test('a list replayed from history while a conversation loads is not taken as sub-agents running now', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: false, env: { FAKE_ACP_LOAD_DELEGATIONS: '1' } })
  const first = await r.runtime.createSession({ cwd: r.dir })
  await first.send([{ type: 'text', text: 'hello' }])
  await completedTimes(r, 1)
  const id = String(first.id)
  await first.close()
  const eventsBefore = r.events.length

  const loaded = await r.runtime.resumeSession(first.id, { cwd: r.dir })
  await loaded.send([{ type: 'text', text: 'hello again' }])
  await r.until(() => completions(r.events.slice(eventsBefore)).length >= 1)
  await pause(50)
  assert.equal(everOutlasting(r, id, eventsBefore), false, 'the loaded conversation never says a sub-agent still works')
  assert.equal(statuses(r, id).at(-1)?.type, 'idle')
})

test('Stop with the turn over and nothing below it neither closes nor reopens', async (t) => {
  const r = await rig(t, { flag: true, resumeOnly: true })
  const session = await r.runtime.createSession({ cwd: r.dir })
  await session.send([{ type: 'text', text: 'hello' }])
  await completedTimes(r, 1)
  const id = String(session.id)
  assert.equal(outlasting(r, id), false)
  const sequenceBefore = (await lines(r.files.sequence)).length
  await session.interrupt()
  assert.deepEqual((await lines(r.files.sequence)).slice(sequenceBefore).filter((line) => !line.startsWith('session/cancel ')), [])
  assert.equal(r.events.filter((event) => event.type === 'turn/started').length, 1)
})

test('a declared spawn alone feeds idle Stop after the root is cancelled, and Stop closes and reopens', async t => {
  const r = await rig(t, { flag: true, resumeOnly: true,
    env: { FAKE_ACP_DELEGATION_TOOL: '1', FAKE_ACP_CHILD_CANCELS_ROOT: '1' },
    config: { delegationTools: { spawn: ['subagent', 'subagent_fork'], send: ['send_message'], wait: ['wait_agent'], cancel: ['interrupt_agent'] } },
  })
  const { session, pid } = await startSubagent(r)
  await completedTimes(r, 1)
  assert.equal(completions(r.events)[0]?.turn.status, 'interrupted')
  await r.until(() => outlasting(r, String(session.id)))
  assert.equal(alive(pid), true, 'the cancelled root left the child running')
  const before = (await lines(r.files.sequence)).length
  await session.interrupt()
  const id = String(session.id)
  assert.deepEqual((await lines(r.files.sequence)).slice(before), [`session/close ${id}`, `session/resume ${id}`])
  const deadline = Date.now() + 2_000
  while (alive(pid) && Date.now() < deadline) await pause(20)
  assert.equal(alive(pid), false)
  assert.equal(outlasting(r, id), false)
  assert.equal(completions(r.events).length, 1)
  const item = (await r.runtime.readSession(session.id)).turns[0]?.items.find(item => item.type === 'subagent')
  assert.ok(item?.type === 'subagent')
  assert.equal(item.members[0]?.state, 'stopped')
})
