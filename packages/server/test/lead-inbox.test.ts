import assert from 'node:assert/strict'
import { test } from 'node:test'

import { leadPersonNeeds, type LeadDeskSummary, type LeadWindowProjection } from '@harnessdesk/protocol'

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

test('an open question from the Lead is the Lead\'s line, under its own name, and an answered one is gone', () => {
  const ask = { version: 1, id: 'm4', revision: 4, role: 'assistant', text: 'Which first?', ask: { question: 'Fix the Team or the game first?', options: [{ id: 'team', label: 'Team' }, { id: 'game', label: 'Game' }], recommended: 'team' } }
  const open = leadInbox({ window: window({ stage: 'you-answer', settings: { name: 'lex' }, thread: { messages: [ask] } } as never), desk: null, kept: [], now: NOW })
  assert.deepEqual(open.items.map(item => [item.id, item.title, item.target]), [['ask:m4', 'Fix the Team or the game first?', 'm4']])
  const answered = leadInbox({ window: window({ stage: 'working', thread: { messages: [ask, { version: 1, id: 'm5', revision: 5, role: 'user', text: 'Team' }] } } as never), desk: null, kept: [], now: NOW })
  assert.deepEqual(answered.items, [])
  assert.equal(answered.needsYou, 0)
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
  const ask = { version: 1, id: 'm4', revision: 4, role: 'assistant', text: 'Which first?', ask: { question: 'Which first?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }
  const inbox = leadInbox({ window: window({ stage: 'you-answer', thread: { messages: [ask] } } as never), desk: null, kept: [], now: NOW, askSeenAt: id => id === 'm4' ? NOW - 600_000 : undefined })
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
