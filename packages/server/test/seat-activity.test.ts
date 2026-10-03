import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalId, itemId, runtimeId, sessionId, turnId, type Approval, type Session, type SeatActivity } from '@harnessdesk/protocol'
import { SeatActivities, deriveSeatActivity } from '../src/seat-activity.js'
import { seat, intent } from './fixtures/goals.js'

const session = (working = false, at?: number): Session => ({
  id: sessionId('s1'), runtime: runtimeId('fake'), cwd: '/work/repo', createdAt: 1, updatedAt: 1,
  status: { type: working ? 'active' : 'idle' }, itemsLoaded: true,
  turns: working ? [{ id: turnId('t1'), status: 'inProgress', items: [], ...(at === undefined ? {} : { startedAt: at }) }] : [],
})
const question: Approval = { id: approvalId('q'), sessionId: sessionId('s1'), type: 'userInput', tool: 'ask', requestedAt: 7, questions: [] }
const clock = () => {
  let now = 0
  const timers = new Map<object, { at: number; callback: () => void }>()
  let unrefs = 0
  return {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => { const handle = { unref: () => { unrefs++ } }; timers.set(handle, { at: now + delay, callback }); return handle },
    clearTimeout: (handle: object) => { timers.delete(handle) },
    tick: (ms: number) => { now += ms; for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() } },
    count: () => timers.size, unrefs: () => unrefs,
  }
}

test('first activity is immediate, unchanged recomputation is silent and the window sends only its latest state', () => {
  const fake = clock(); const sent: SeatActivity[] = []
  let current = session()
  const activities = new SeatActivities({ record: () => ({ session: current, approvals: new Map() }), send: (activity) => sent.push(activity) }, fake)
  activities.team('g1', [seat()], [])
  assert.equal(sent.length, 1)
  activities.session('fake', 's1')
  assert.equal(sent.length, 1)
  fake.tick(100); current = session(true, 5); activities.session('fake', 's1')
  fake.tick(100); activities.team('g1', [seat('s1', { role: 'reviewer' })], [])
  assert.equal(sent.length, 1)
  assert.equal(activities.all()[0]?.state, 'working', 'baseline is unthrottled')
  fake.tick(2299); assert.equal(sent.length, 1)
  fake.tick(1); assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], { goal: 'g1', seat: 'fake:s1', role: 'reviewer', card: null, state: 'working', doing: { kind: 'thinking' }, since: 5 })
  assert.equal(fake.unrefs(), 1)
})

test('waiting beats working; recorded times only; command text never leaves the transcript', () => {
  const busy = session(true)
  assert.deepEqual(deriveSeatActivity('g1', seat(), [], { session: busy, approvals: new Map([['q', question]]) }), { goal: 'g1', seat: 'fake:s1', role: null, card: null, state: 'waiting', doing: null, since: 7 })
  const command: Session = { ...busy, turns: [{ ...busy.turns[0]!, items: [{ type: 'command', id: itemId('c'), status: 'inProgress', origin: 'agent', command: 'SECRET=x curl https://example.com', cwd: '/work/repo', actions: [] }] }] }
  const activity = deriveSeatActivity('g1', seat(), [], { session: command, approvals: new Map() })
  assert.deepEqual(activity.doing, { kind: 'tool', tool: 'command' })
  assert.equal('since' in activity, false)
  assert.equal(JSON.stringify(activity).includes('SECRET'), false)
  assert.equal('since' in deriveSeatActivity('g1', seat(), [], undefined), false)
  const card = intent(4, { state: 'claimed', role: 'builder', claim: { runtime: runtimeId('fake'), sessionId: 's1', at: 9 } })
  assert.deepEqual(deriveSeatActivity('g1', seat(), [card], undefined), { goal: 'g1', seat: 'fake:s1', role: 'builder', card: 4, state: 'working', doing: { kind: 'thinking' }, since: 9 })
})

test('membership removal and dispose clear trailing timers; unrelated Teams are not recomputed', () => {
  const fake = clock(); const sent: SeatActivity[] = []; const reads: string[] = []
  let current = session()
  const activities = new SeatActivities({ record: (_runtime, id) => { reads.push(id); return { session: current, approvals: new Map() } }, send: (activity) => sent.push(activity) }, fake)
  activities.team('g1', [seat()], []); activities.team('g2', [seat('other', { board: 'g2' })], [])
  reads.length = 0; current = session(true); activities.session('fake', 's1')
  assert.deepEqual(reads, ['s1']); assert.equal(fake.count(), 1)
  activities.team('g1', [], []); assert.equal(fake.count(), 0)
  activities.session('fake', 'other'); assert.equal(fake.count(), 1)
  activities.dispose(); assert.equal(fake.count(), 0)
  fake.tick(2500); assert.equal(sent.length, 2)
})

test('an older unfinished turn never supplies current activity time', () => {
  const busy = session(true, 2)
  const completed: Session = { ...busy, status: { type: 'idle' }, turns: [...busy.turns, { id: turnId('newest'), status: 'completed', items: [], startedAt: 8 }] }
  const card = intent(1, { state: 'claimed', claim: { runtime: runtimeId('fake'), sessionId: 's1', at: 9 } })
  assert.equal(deriveSeatActivity('g1', seat(), [card], { session: completed, approvals: new Map() }).since, 9)
})

test('a change that returns to the sent state cancels its trailing notification', () => {
  const fake = clock(); const sent: SeatActivity[] = []; let current = session()
  const activities = new SeatActivities({ record: () => ({ session: current, approvals: new Map() }), send: (activity) => sent.push(activity) }, fake)
  activities.team('g1', [seat()], [])
  current = session(true); activities.session('fake', 's1')
  current = session(); activities.session('fake', 's1')
  assert.equal(fake.count(), 0); fake.tick(2500); assert.equal(sent.length, 1)
})
