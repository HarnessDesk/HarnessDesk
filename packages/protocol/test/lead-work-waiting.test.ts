import assert from 'node:assert/strict'
import { test } from 'node:test'

import { leadWorkWaiting, type LeadInbox, type LeadWorkBoard, type LeadWorkCard } from '../src/index.js'

const card = (id: string, patch: Partial<LeadWorkCard> = {}): LeadWorkCard => ({
  id, title: id, project: 'acme-api', stage: 'done', group: 'done', links: { chats: [], teams: [], prs: [], issues: [] },
  createdAt: 1, updatedAt: 2, ...patch,
})

test('the Work list names every Team and chat the header counts as needing the person', () => {
  const inbox: LeadInbox = { version: 1, needsYou: 4, items: [
    { id: 'lead', kind: 'lead', title: 'Dex is waiting for you', at: 9, needsYou: true },
    { id: 'team:goal-game', kind: 'team', title: 'build a game', project: 'acme-api', at: 8, needsYou: true, target: 'goal-game' },
    { id: 'chat:codex:linked', kind: 'chat', title: 'Fix the login', at: 7, needsYou: true, target: 'codex:linked' },
    { id: 'chat:codex:loose', kind: 'chat', title: 'Tidy the README', at: 6, needsYou: true, target: 'codex:loose' },
    { id: 'notice:usage', kind: 'notice', title: 'Weekly is 80% used', at: 5, needsYou: false },
  ] }
  const board: LeadWorkBoard = { version: 1, more: 0, items: [
    // Already on the board while open: its card says it, so it is not listed twice.
    card('w1', { stage: 'needs-you', group: 'needs-you', links: { chats: ['codex:linked'], teams: [], prs: [], issues: [] } }),
    // Closed work that once touched the Team does not hide the Team that waits now.
    card('w2', { closedAt: 3, links: { chats: [], teams: ['goal-game'], prs: [], issues: [] } }),
  ] }
  assert.deepEqual(leadWorkWaiting(board, inbox), [
    { kind: 'team', id: 'goal-game', title: 'build a game', project: 'acme-api', at: 8 },
    { kind: 'chat', id: 'codex:loose', title: 'Tidy the README', at: 6 },
  ])
  assert.deepEqual(leadWorkWaiting(null, null), [])
})
