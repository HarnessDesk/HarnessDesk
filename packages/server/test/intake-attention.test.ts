import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeId, TeamMessage, TriggerAttention } from '@harnessdesk/protocol'

import { QUESTION_MS, QUESTION_STOP, QuestionDeadline } from '../src/findings/rounds.js'
import { AttentionOutbox } from '../src/intake/attention.js'
import { goalWaits, NO_WAITS, type HostWaits } from '../src/intake/waits.js'
import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { tempDir } from './scratch.js'

/*
 * In a Goal a trigger opened, nothing waits on a person in silence. Every
 * held path is named — who it waits on, why, and what opens it — recorded
 * once, before it is said, and said once: a replay after a restart or a
 * reconnect is the same wait by the same id, never a second alert.
 */

const GOAL = 'goal-6f1b2c3d-0000-4000-8000-000000000001'

const outbox = async (home: string, now = { at: 1_000 }) => {
  const announced: TriggerAttention[] = []
  const box = new AttentionOutbox(home, { announce: (one) => announced.push(one), now: () => now.at })
  await box.load()
  return { box, announced, now }
}

const HELD: HostWaits = {
  ...NO_WAITS,
  messages: [{ id: 'm1', from: 'the fixer', to: 'the reviewer', reason: 'The user releases held messages from the Team panel.' }],
  approvals: [{ id: 'held-1a2b', seat: 'reviewer', what: 'post a review to the pull request', held: true }],
  questions: [{ id: 'q1', seat: 'reviewer', what: 'Which branch is the base?' }],
  steps: [{ card: 4, title: 'Approve the release' }],
}

test('every held path names who waits and notifies once', async () => {
  const home = tempDir('hd-intake-attention-')
  const { box, announced } = await outbox(home)
  await box.sync(`goal:${GOAL}`, goalWaits({ goal: GOAL, trigger: 'review', host: HELD, run: null, stop: null, firings: [] }))
  const open = box.list({ goal: GOAL, open: true })
  assert.deepEqual(open.map((one) => one.kind).sort(), ['approval', 'message', 'person-step', 'question'])
  const by = (kind: TriggerAttention['kind']): TriggerAttention => open.find((one) => one.kind === kind)!
  assert.match(by('message').sentence, /^A message from the fixer to the reviewer is held for you/)
  assert.match(by('message').sentence, /grants nothing/)
  assert.equal(by('approval').action, 'open-permissions', 'a held action opens where permissions are decided')
  assert.match(by('question').sentence, /Which branch is the base\?/)
  assert.match(by('person-step').sentence, /Card #4 is yours/)
  for (const one of open) {
    assert.deepEqual(one.waitingOn, { kind: 'person', label: 'You' }, `${one.kind} waits on the person`)
    assert.equal(one.notification, 'pending', 'nobody was told outside the app yet')
    assert.equal(one.trigger, 'review')
    assert.equal(one.goal, GOAL)
  }
  assert.equal(announced.length, 4, 'each is announced once')

  // Read again: the same waits, the same ids, nothing announced.
  await box.sync(`goal:${GOAL}`, goalWaits({ goal: GOAL, trigger: 'review', host: HELD, run: null, stop: null, firings: [] }))
  assert.equal(announced.length, 4)

  // A restart reads the outbox back and replays each unresolved wait by its own id — never a new one.
  const again = await outbox(home)
  again.box.replay()
  assert.deepEqual(again.announced.map((one) => one.id).sort(), open.map((one) => one.id).sort())
  await again.box.sync(`goal:${GOAL}`, goalWaits({ goal: GOAL, trigger: 'review', host: HELD, run: null, stop: null, firings: [] }))
  assert.equal(again.announced.length, 4, 'a replayed wait is not raised a second time')

  // The question is answered: only its wait ends, and the others keep the Goal waiting.
  again.now.at = 2_000
  await again.box.sync(`goal:${GOAL}`, goalWaits({ goal: GOAL, trigger: 'review', host: { ...HELD, questions: [] }, run: null, stop: null, firings: [] }))
  const resolved = again.announced.at(-1)!
  assert.equal(resolved.kind, 'question')
  assert.equal(resolved.resolvedAt, 2_000)
  assert.deepEqual(again.box.list({ goal: GOAL, open: true }).map((one) => one.kind).sort(), ['approval', 'message', 'person-step'])

  // The desktop's answer is recorded on the same id, and never claimed otherwise.
  assert.equal(await again.box.notified(by('message').id, 'unavailable'), true)
  assert.equal(again.box.list({ goal: GOAL }).find((one) => one.id === by('message').id)?.notification, 'unavailable')
  assert.equal(await again.box.notified(by('message').id, 'delivered'), false, 'one answer per attention')
})

test('a budget stop, a firing that needs a person and a stalled run are each named once', () => {
  const waits = goalWaits({
    goal: GOAL, trigger: 'review', host: NO_WAITS,
    run: { id: 'flow-trigger-1', state: 'stopped', reason: 'Out of budget: this Goal reached its spend limit.' },
    stop: { reason: 'out of budget', detail: 'Out of budget: this Goal reached its spend limit.', at: 5 },
    firings: [{ key: 'f'.repeat(64), attention: 'New work arrived for this Goal, and this trigger opens no further round. It was recorded; decide what to do with it.' }],
  })
  assert.deepEqual(waits.map((one) => one.kind), ['budget', 'person-step'], 'the stopped run repeats the budget stop, so it is said once')
  assert.equal(waits[0]!.action, 'open-usage')
  assert.match(waits[0]!.sentence, /cards, answers and findings are kept/)
})

test('question stops after its wait with partial work', async () => {
  // A clock the test moves: nothing fires until it is advanced past its instant.
  let now = 0
  const timers: { at: number; fire: () => void; live: boolean }[] = []
  const advance = async (to: number): Promise<void> => {
    now = to
    for (const timer of timers) if (timer.live && timer.at <= now) { timer.live = false; timer.fire() }
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  const interrupted: string[] = []
  const stopped: string[] = []
  const deadline = new QuestionDeadline({
    setTimer: (fire, ms) => { const timer = { at: now + ms, fire, live: true }; timers.push(timer); return timer },
    clearTimer: (timer) => { (timer as { live: boolean }).live = false },
    interrupt: async (key) => { interrupted.push(key) },
    stop: async (key, reason) => { stopped.push(`${key}:${reason}`) },
  })
  // The question is a named wait the moment it is asked — before any timer.
  const asked = goalWaits({ goal: GOAL, trigger: 'review', host: { ...NO_WAITS, questions: [{ id: 'q1', seat: 'reviewer', what: 'Which base?' }] }, run: null, stop: null, firings: [] })
  assert.deepEqual(asked.map((one) => one.kind), ['question'])
  assert.match(asked[0]!.sentence, /after five minutes, and what it said is kept/, 'the default wait, said')
  const waiting = goalWaits({ goal: GOAL, trigger: 'review', host: { ...NO_WAITS, questionWait: 'back', questions: [{ id: 'q1', seat: 'reviewer', what: 'Which base?' }] }, run: null, stop: null, firings: [] })
  assert.match(waiting[0]!.sentence, /waits for your answer, however long/, 'the machine’s own wait, said')

  deadline.asked('fake\u0000s1', 'q1')
  deadline.asked('fake\u0000s1', 'q1')
  assert.equal(timers.length, 1, 'one timer, the phase-7 one — no second')
  await advance(QUESTION_MS - 1)
  assert.deepEqual([interrupted, stopped], [[], []], 'nothing a moment before the wait ends')
  await advance(QUESTION_MS)
  assert.deepEqual(interrupted, ['fake\u0000s1'], 'its turn is interrupted once, what it said kept')
  assert.deepEqual(stopped, [`fake\u0000s1:${QUESTION_STOP}`], 'one named stop at the boundary')
  await advance(QUESTION_MS * 3)
  assert.equal(stopped.length, 1)
  // The stop is the run's reason; the Goal names it as the question it was.
  const after = goalWaits({ goal: GOAL, trigger: 'review', host: NO_WAITS, run: { id: 'flow-trigger-1', state: 'stalled', reason: `Card #1: its Seat ${QUESTION_STOP}. Its answer so far is kept.` }, stop: null, firings: [] })
  assert.deepEqual(after.map((one) => one.kind), ['question'])
  assert.match(after[0]!.sentence, /waits for you/)
})

// ------------------------------------------------------------------ Team

const peer = (over: Partial<TeamPeer> & { sessionId: string }): TeamPeer => ({
  runtime: 'codex' as RuntimeId, title: over.sessionId, cwd: '/repo', agent: 'Codex', busy: false, canSteer: false,
  queuedByUser: 0, here: true, ...over,
})

const teamRig = async (t: { after(fn: () => Promise<void>): void }, triggerRooms: Set<string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-intake-team-'))
  const sent: string[] = []
  const peers: TeamPeer[] = [
    peer({ sessionId: 'c1', title: 'Fixer' }),
    peer({ sessionId: 'k1', runtime: 'claude' as RuntimeId, title: 'Reviewer', agent: 'Claude Code' }),
    peer({ sessionId: 'c2', title: 'Quiet fixer' }),
    peer({ sessionId: 'k2', runtime: 'claude' as RuntimeId, title: 'Quiet reviewer', agent: 'Claude Code' }),
    peer({ sessionId: 'w1', title: 'Watched fixer' }),
    peer({ sessionId: 'w2', runtime: 'claude' as RuntimeId, title: 'Watched reviewer', agent: 'Claude Code' }),
    peer({ sessionId: 'o1', title: 'Outsider' }),
  ]
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async (cwd) => (cwd === '/repo' || cwd.startsWith('/repo/') ? '/repo' : null),
    send: async (runtime, sessionId, text) => { sent.push(`${runtime}/${sessionId}:${text.slice(0, 20)}`) },
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    unattendedInbound: (room) => triggerRooms.has(room),
  }
  const team = new Team(dir, port)
  t.after(async () => {
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return { team, sent }
}

test('messages accept within an armed shape and preserve blind isolation', async (t) => {
  const triggerRooms = new Set<string>()
  const { team, sent } = await teamRig(t, triggerRooms)
  // The person's own default holds inter-agent messages.
  team.configure({ inboundDefault: 'hold' })
  const room = async (name: string, members: readonly [string, string][]): Promise<string> => {
    const id = (await team.createRoom('/repo', name)).id
    for (const [runtime, sessionId] of members) await team.joinRoom(id, runtime as RuntimeId, sessionId)
    return id
  }
  const members = await room('members', [['codex', 'c1'], ['claude', 'k1']])
  const boardOnly = await room('board-only', [['codex', 'c2'], ['claude', 'k2']])
  const watched = await room('watched', [['codex', 'w1'], ['claude', 'w2']])
  await room('outside', [['codex', 'o1']])
  triggerRooms.add(members).add(boardOnly)
  team.setMessaging(boardOnly, false)

  // A trigger Goal whose flow lets members talk: accepted, though the person's default holds.
  assert.match(await team.send({ to: 'Reviewer', text: 'the fix is in' }, { runtime: 'codex', sessionId: 'c1' }), /^Delivered/)
  // Board-only stays board-only: a trigger never widens it.
  assert.match(await team.send({ to: 'Quiet reviewer', text: 'psst' }, { runtime: 'codex', sessionId: 'c2' }), /^Refused: this board is in board-only mode/)
  // Outside the Goal: its members are nobody this sender can reach.
  assert.match(await team.send({ to: 'Reviewer', text: 'hello' }, { runtime: 'codex', sessionId: 'o1' }), /^Refused/)
  // A room no trigger opened keeps the person's default.
  assert.match(await team.send({ to: 'Watched reviewer', text: 'look' }, { runtime: 'codex', sessionId: 'w1' }), /^Held/)
  assert.deepEqual(sent.map((one) => one.split(':')[0]), ['claude/k1'], 'only the trigger Goal member was reached')

  // A conversation's own explicit hold still holds inside a trigger Goal, and the hold is a named wait on the person.
  team.setInbound('claude', 'k1', 'hold')
  assert.match(await team.send({ to: 'Reviewer', text: 'look again' }, { runtime: 'codex', sessionId: 'c1' }), /^Held/)
  const held = team.stateFor(members).channel.filter((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'held')
  assert.equal(held.length, 1)
  const waits = goalWaits({
    goal: members, trigger: 'review',
    host: { ...NO_WAITS, messages: held.map((entry) => ({ id: entry.id, from: 'Fixer', to: entry.to?.title ?? 'everyone', reason: entry.reason ?? null })) },
    run: null, stop: null, firings: [],
  })
  assert.deepEqual(waits.map((one) => [one.kind, one.waitingOn.kind]), [['message', 'person']])
  assert.equal(sent.length, 1, 'nothing held was sent')
  void watched
})
