import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isWaitingOnYou, LEAD_UNSENT_WAITS, leadNeedsYou, leadPersonNeeds, leadStage, type LeadDeskSummary, type LeadWindowProjection } from '@harnessdesk/protocol'

import { leadInbox } from '../src/lead/inbox.js'

const NOW = Date.UTC(2026, 10, 10, 22)
const window = (over: Partial<LeadWindowProjection> = {}): LeadWindowProjection => ({
  stage: 'idle', settings: { name: 'dex' }, thread: { messages: [] }, ...over,
} as unknown as LeadWindowProjection)
const desk = (needsYou: LeadDeskSummary['needsYou'], needsYouMore = 0): LeadDeskSummary => ({ needsYou, needsYouMore } as unknown as LeadDeskSummary)
const team = { id: 'goal-game', title: 'build a game', project: 'HarnessDesk', kind: 'team' as const, state: 'needs-you' as const, updatedAt: NOW - 60_000 }
const usage = { id: 'usage:codex', title: 'Codex — Weekly is 80% used', body: '20% left, back in 6d 17h', at: NOW - 3_600_000, read: false, tone: 'warning' }

test('the bell and the phone list one inbox: the Lead waiting, the Team that needs the person, and the kept usage notice', () => {
  const inbox = leadInbox({ window: window({ stage: 'you-blocked', stageReason: 'lead-request-interrupted' }), desk: desk([team]), kept: [usage], now: NOW })
  assert.deepEqual(inbox.items.map(item => [item.kind, item.title, item.needsYou]), [
    ['lead', 'Dex is waiting for you', true],
    ['team', 'build a game', true],
    ['notice', 'Codex — Weekly is 80% used', false],
  ])
  assert.equal(inbox.needsYou, 2, 'a notice is kept to read, never counted')
  assert.equal(inbox.items[0]!.detail, 'lead-request-interrupted', 'the Lead line carries the host slug, never model text')
})

test('an open question from the Lead is an inbox row of its own, whatever the Lead\'s stage, and leaves once it is not open', () => {
  // #2105: an ask does not move the Lead into a waiting stage, so a row gated on the stage never showed it.
  const open = { id: 'm4', question: 'Fix the Team or the game first?' }
  const idle = leadInbox({ window: window({ stage: 'idle', settings: { name: 'lex' } } as never), desk: desk([team]), kept: [], now: NOW, ask: open })
  assert.deepEqual(idle.items.map(item => [item.id, item.kind, item.title, item.target]), [['ask:m4', 'ask', 'Fix the Team or the game first?', 'm4'], ['team:goal-game', 'team', 'build a game', 'goal-game']])
  assert.equal(idle.needsYou, 2, 'the question counts once, beside the Team')
  // The desk says it is no longer open (answered, expired, replaced or talked past): the row is gone and the count drops.
  const settled = leadInbox({ window: window({ stage: 'working' }), desk: desk([team]), kept: [], now: NOW, ask: null })
  assert.deepEqual(settled.items.map(item => item.id), ['team:goal-game'])
  assert.equal(settled.needsYou, 1)
  // A Lead that also waits on the person keeps its own row: the question does not hide what else it waits on.
  const both = leadInbox({ window: window({ stage: 'you-blocked', stageReason: 'lead-request-interrupted' }), desk: null, kept: [], now: NOW, ask: open })
  assert.deepEqual(both.items.map(item => item.id), ['ask:m4', 'lead'])
  assert.equal(both.needsYou, 2)
})

test('a notice about work already listed is not listed twice, and the count includes needs-you work past the list', () => {
  const teamNotice = { id: 'wait:goal-game', title: 'Your pick is next', at: NOW, read: false, tone: 'info', open: 'team:goal-game' }
  const inbox = leadInbox({ window: null, desk: desk([team], 3), kept: [teamNotice, usage, { id: 'broken' }], now: NOW })
  assert.deepEqual(inbox.items.map(item => item.id), ['team:goal-game', 'notice:usage:codex'])
  assert.equal(inbox.needsYou, 4)
})

test('a Lead that is not waiting on the person adds nothing, and a missing desk is an empty inbox', () => {
  assert.deepEqual(leadInbox({ window: window({ stage: 'working' }), desk: null, kept: undefined, now: NOW }), { version: 1, needsYou: 0, items: [] })
})

test('the Lead\'s row counts each approval it waits on, by the rule its own word uses', () => {
  const actions = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]
  const inbox = leadInbox({ window: window({ stage: 'you-answer', personActions: actions } as never), desk: null, kept: [], now: NOW })
  assert.equal(inbox.items[0]!.count, 3)
  assert.equal(inbox.needsYou, 3)
  assert.equal(inbox.needsYou, leadPersonNeeds({ personActions: actions }))
  const one = leadInbox({ window: window({ stage: 'you-blocked' }), desk: desk([team]), kept: [], now: NOW })
  assert.equal(one.items[0]!.count, undefined, 'a single need is one row of one')
  assert.equal(one.needsYou, 2)
})

test('an open question is dated by when the desk first saw it, not by the read', () => {
  const inbox = leadInbox({ window: window({ stage: 'idle' }), desk: null, kept: [], now: NOW, ask: { id: 'm4', question: 'Which first?' }, askSeenAt: id => id === 'm4' ? NOW - 600_000 : undefined })
  assert.equal(inbox.items[0]!.at, NOW - 600_000)
})

test('a kept notice that opens a chat already listed as needing the person is not listed twice', () => {
  const chat = { id: 'codex:s1', title: 'Fix the tests', project: 'HarnessDesk', kind: 'chat' as const, state: 'needs-you' as const, updatedAt: NOW - 1000 }
  const chatNotice = { id: 'msg:1', title: 'A message from the chat', at: NOW, read: false, tone: 'info', open: 'session:codex:s1' }
  const other = { ...chatNotice, id: 'msg:2', open: 'session:codex:s2' }
  const inbox = leadInbox({ window: null, desk: desk([chat]), kept: [chatNotice, other], now: NOW })
  assert.deepEqual(inbox.items.map(item => item.id), ['chat:codex:s1', 'notice:msg:2'])
})

test('every title and body is scrubbed on the desk, the work titles and the Lead\'s reason as much as the notices', () => {
  const leaky = { ...team, title: 'fix /Users/jane/work/secret/app.ts for jane@example.com' }
  const notice = { ...usage, title: 'mail jane@example.com', body: 'see /Users/jane/work/notes/todo.md' }
  const inbox = leadInbox({ window: window({ stage: 'you-blocked', stageReason: 'stuck on /Users/jane/work/x/y.ts' }), desk: desk([leaky]), kept: [notice], now: NOW })
  const text = JSON.stringify(inbox)
  assert.ok(!text.includes('/Users/'), text)
  assert.ok(!text.includes('jane@example.com'), text)
})

test('a request the desk did not send is not a wait on the person: no Lead row and nothing counted, while work that needs the person still is', () => {
  for (const waitReason of LEAD_UNSENT_WAITS) {
    // The stage as the host derives it, from a thread left waiting for the person's next message.
    const { stage, reason } = leadStage({ kind: 'lead', state: 'waiting-for-user', pendingPersonCard: null, resultReady: false, workerApproval: false, checkToRun: false, waitReason, requestInFlight: false, chatEffectQueued: false })
    assert.equal(stage, 'idle', waitReason)
    const inbox = leadInbox({ window: window({ stage, stageReason: reason, waitReason, failure: { reason: waitReason, detail: 'not sent' }, thread: { state: 'waiting-for-user', messages: [] } } as never), desk: desk([team]), kept: [], now: NOW })
    assert.deepEqual(inbox.items.map(item => item.kind), ['team'], waitReason)
    assert.equal(inbox.needsYou, 1, waitReason)
  }
})

test('with an open question the inbox and the Lead\'s word say one number: the inbox\'s Lead rows add up to leadNeedsYou', () => {
  // #2105 review: the question's row counted one more than the rule the Lead's word used. One fixture, both numbers.
  const open = { id: 'm4', question: 'Fix the Team or the game first?' }
  const cases: [string, LeadWindowProjection][] = [
    ['idle', window({ stage: 'idle' })],
    ['waiting, nothing else counted', window({ stage: 'you-blocked' })],
    ['waiting on three approvals', window({ stage: 'you-answer', personActions: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] } as never)],
    ['waiting on a plan', window({ stage: 'you-blocked', wayOut: 'decide-plan' } as never)],
  ]
  for (const [name, lead] of cases) {
    const waiting = lead.stage !== undefined && isWaitingOnYou(lead.stage)
    const inbox = leadInbox({ window: lead, desk: null, kept: [], now: NOW, ask: open })
    const word = leadNeedsYou({ ...lead, openAsk: true }, waiting)
    assert.equal(inbox.needsYou, word, name)
    assert.equal(inbox.needsYou, inbox.items.reduce((sum, item) => sum + (item.needsYou ? item.count ?? 1 : 0), 0), `${name}: the rows add up`)
    // Without the question each drops by exactly one, and the two still agree.
    assert.equal(leadInbox({ window: lead, desk: null, kept: [], now: NOW, ask: null }).needsYou, leadNeedsYou(lead, waiting), `${name}, answered`)
    assert.equal(word - leadNeedsYou(lead, waiting), 1, `${name}: the question is one`)
  }
  assert.equal(leadPersonNeeds({ openAsk: true }), 1, 'the shared rule counts the open question')
})

