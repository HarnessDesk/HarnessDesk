import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LeadDeskSummary, LeadWindowProjection } from '@harnessdesk/protocol'

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
