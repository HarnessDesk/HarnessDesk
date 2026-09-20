import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeId, SeatRecord } from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { seat } from './fixtures/goals.js'

const peer = (runtime: string, sessionId: string, busy = false): TeamPeer => ({
  runtime: runtime as RuntimeId,
  sessionId,
  title: null,
  cwd: '/repo',
  agent: runtime,
  busy,
  canSteer: false,
  queuedByUser: 0,
  here: true,
})

const goalSeat = (id: string, runtime: string, sessionId: string, name: string): SeatRecord => seat(id, {
  agent: { id: `agent-${id}`, name, origin: 'project' },
  session: { runtime, sessionId },
  seat: { runtime },
  seatLabel: runtime,
})

const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-goal-team-'))
  const peers: TeamPeer[] = []
  const memberships = new Map<string, SeatRecord[]>()
  const sentences = new Map<string, string>()
  const turns = new Map<string, string | null>()
  const sent: string[] = []
  let gate: Promise<void> | null = null
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async () => '/repo',
    send: async (_runtime, _session, text, allowed) => {
      if (gate) await gate
      const verdict = allowed?.()
      if (verdict && !verdict.ok) throw new Error(verdict.reason)
      sent.push(text)
    },
    steer: async (_runtime, _session, text, allowed) => {
      const verdict = allowed?.()
      if (verdict && !verdict.ok) throw new Error(verdict.reason)
      sent.push(text)
    },
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    goalMembers: (goal) => ({ seats: memberships.get(goal) ?? [], sentence: sentences.get(goal) }),
    memberStatus: (record) => ({ exists: true, turn: turns.get(String(record.id)) ?? null, stopped: null }),
    canDispatch: (goal) => memberships.has(goal)
      ? { ok: true }
      : { ok: false, reason: 'This Goal is no longer open.' },
  }
  const team = new Team(dir, port)
  t.after(async () => {
    team.stopWaiting('test finished')
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    team, peers, memberships, sentences, turns, sent,
    setGate(value: Promise<void> | null) { gate = value },
  }
}

test('member waits stay inside the caller Goal and consume no delivery effects', async (t) => {
  const { team, peers, memberships, turns, sent } = await rig(t)
  const first = (await team.createRoom('/repo', 'First')).id
  const second = (await team.createRoom('/repo', 'Second')).id
  const caller = goalSeat('caller', 'codex', 'caller', 'Builder')
  const worker = goalSeat('worker', 'codex', 'worker', 'Reviewer')
  const hidden = goalSeat('hidden', 'codex', 'hidden', 'Secret Reviewer')
  memberships.set(first, [caller, worker])
  memberships.set(second, [hidden])
  peers.push(peer('codex', 'caller'), peer('codex', 'worker', true), peer('codex', 'hidden', true))
  await team.joinRoom(first, 'codex' as RuntimeId, 'caller')
  await team.joinRoom(first, 'codex' as RuntimeId, 'worker')
  await team.joinRoom(second, 'codex' as RuntimeId, 'hidden')
  turns.set('worker', 'turn-1')

  const scope = { runtime: 'codex', sessionId: 'caller', invocation: 'invoke-1' }
  const waiting = team.awaitMember(scope, { member: 'Reviewer', cycle: 4, blockMs: 50_000 })
  await assert.rejects(
    team.awaitMember(scope, { member: 'Reviewer', blockMs: 50_000 }),
    /invocation is already waiting/,
  )
  await assert.rejects(
    team.awaitMember({ ...scope, invocation: 'self' }, { member: 'Builder' }),
    /Choose another member/,
  )
  assert.equal(await team.awaitMember({ ...scope, invocation: 'missing' }, { member: 'Secret Reviewer' }), 'gone; cycle: 1')
  await assert.rejects(
    team.awaitMember({ ...scope, invocation: 'unsafe' }, { member: 'Reviewer', cycle: Number.MAX_SAFE_INTEGER }),
    /nonnegative safe cycle/,
  )

  await team.onTurnEnded('codex' as RuntimeId, 'worker', { turn: 'turn-1' })
  assert.equal(await waiting, 'idle; cycle: 5')
  assert.deepEqual(sent, [])
})

test('128 pending waits are the Goal ceiling and every one is released on shutdown', async (t) => {
  const { team, peers, memberships, turns, sent } = await rig(t)
  const room = (await team.createRoom('/repo', 'Capacity')).id
  const caller = goalSeat('caller', 'codex', 'caller', 'Builder')
  const worker = goalSeat('worker', 'codex', 'worker', 'Reviewer')
  memberships.set(room, [caller, worker])
  peers.push(peer('codex', 'caller'), peer('codex', 'worker', true))
  await team.joinRoom(room, 'codex' as RuntimeId, 'caller')
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  turns.set('worker', 'turn-1')

  const pending = Array.from({ length: 128 }, (_, index) => team.awaitMember(
    { runtime: 'codex', sessionId: 'caller', invocation: `invoke-${index}` },
    { member: 'Reviewer' },
  ))
  await assert.rejects(team.awaitMember(
    { runtime: 'codex', sessionId: 'caller', invocation: 'overflow' },
    { member: 'Reviewer' },
  ), /already has 128 member waits/)
  team.stopWaiting('the desk is closing')
  assert.equal((await Promise.all(pending)).every((answer) => answer === 'stopped: the desk is closing; cycle: 1'), true)
  assert.deepEqual(sent, [])
})

test('a sender released while its runtime is prepared cannot deliver into the old Goal', async (t) => {
  const { team, peers, memberships, sent, setGate } = await rig(t)
  const room = (await team.createRoom('/repo', 'Delivery')).id
  const caller = goalSeat('caller', 'codex', 'caller', 'Builder')
  const worker = goalSeat('worker', 'codex', 'worker', 'Reviewer')
  memberships.set(room, [caller, worker])
  peers.push(peer('codex', 'caller'), peer('codex', 'worker'))
  await team.joinRoom(room, 'codex' as RuntimeId, 'caller')
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')

  let release!: () => void
  setGate(new Promise<void>((resolve) => { release = resolve }))
  const sending = team.send(
    { to: 'Reviewer', text: 'This must stay inside the Goal.' },
    { runtime: 'codex', sessionId: 'caller' },
  )
  await Promise.resolve()
  memberships.set(room, [worker])
  release()

  assert.match(await sending, /^Refused: sending failed/)
  assert.deepEqual(sent, [])
  const entry = team.stateFor(room).channel.at(-1)
  assert.equal(entry?.kind === 'message' ? entry.state : null, 'refused')
})

test('a delivered Goal message names the recorded Agent, Seat authority, and Goal sentence', async (t) => {
  const { team, peers, memberships, sentences, sent } = await rig(t)
  const room = (await team.createRoom('/repo', 'Delivery context')).id
  const caller = goalSeat('caller', 'codex', 'caller', 'Builder')
  const worker = goalSeat('worker', 'codex', 'worker', 'Reviewer')
  memberships.set(room, [caller, worker])
  sentences.set(room, 'Finish the change')
  peers.push(peer('codex', 'caller'), peer('codex', 'worker'))
  await team.joinRoom(room, 'codex' as RuntimeId, 'caller')
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')

  assert.match(await team.send(
    { to: 'Reviewer', text: 'Please inspect this.' },
    { runtime: 'codex', sessionId: 'caller' },
  ), /^Delivered to Reviewer\./)
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /Message from Builder/)
  assert.match(sent[0]!, /codex; permission read; ceiling not recorded; Goal: Finish the change/)
  assert.match(sent[0]!, /Please inspect this\./)
})

test('the ninth pending message is refused at the original eight-message boundary', async (t) => {
  const { team, peers, memberships, sent } = await rig(t)
  const room = (await team.createRoom('/repo', 'Backlog')).id
  const caller = goalSeat('caller', 'codex', 'caller', 'Builder')
  const worker = goalSeat('worker', 'codex', 'worker', 'Reviewer')
  memberships.set(room, [caller, worker])
  peers.push(peer('codex', 'caller'), peer('codex', 'worker', true))
  await team.joinRoom(room, 'codex' as RuntimeId, 'caller')
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  team.configure({ rateLimit: 60 })

  for (let index = 0; index < 8; index++) {
    assert.match(await team.send(
      { to: 'Reviewer', text: `queued-${index}` },
      { runtime: 'codex', sessionId: 'caller' },
    ), /^Queued:/)
  }
  assert.match(await team.send(
    { to: 'Reviewer', text: 'queued-nine' },
    { runtime: 'codex', sessionId: 'caller' },
  ), /^Refused: 8 messages are already waiting/)
  assert.deepEqual(sent, [])
})
