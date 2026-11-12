import assert from 'node:assert/strict'
import { test } from 'node:test'

import { leadTeamKey, leadWorkOpenCount, leadWorkWaiting, parseLeadWorkBoard, type LeadInbox, type LeadWorkBoard, type LeadWorkCard } from '../src/index.js'

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

test('a Team the board links by its room and the inbox names by its goal is one Team, listed and counted once', () => {
  const inbox: LeadInbox = { version: 1, needsYou: 1, items: [
    { id: 'team:goal-game', kind: 'team', title: 'build a game', at: 8, needsYou: true, target: 'goal-game' },
  ] }
  const board: LeadWorkBoard = { version: 1, more: 0, items: [
    card('w1', { stage: 'needs-you', group: 'needs-you', links: { chats: [], teams: ['room-game'], prs: [], issues: [] } }),
    card('w2', { closedAt: 3 }),
  ] }
  const teamOf = leadTeamKey([{ goal: 'goal-game', room: 'room-game' }])
  assert.equal(teamOf('room-game'), 'goal-game')
  assert.equal(teamOf('goal-game'), 'goal-game')
  assert.equal(teamOf('room-other'), 'room-other')
  assert.deepEqual(leadWorkWaiting(board, inbox, teamOf), [])
  assert.equal(leadWorkOpenCount(board, leadWorkWaiting(board, inbox, teamOf)), 1)
  // The other way round: the board holds the goal id and the inbox the room.
  const byRoom: LeadInbox = { ...inbox, items: [{ ...inbox.items[0]!, target: 'room-game' }] }
  const byGoal: LeadWorkBoard = { ...board, items: [card('w1', { stage: 'needs-you', group: 'needs-you', links: { chats: [], teams: ['goal-game'], prs: [], issues: [] } })] }
  assert.deepEqual(leadWorkWaiting(byGoal, byRoom, teamOf), [])
  // Without the resolver the two names would be two Teams, and the count one too high: what the resolver is for.
  assert.equal(leadWorkOpenCount(board, leadWorkWaiting(board, inbox)), 2)
})

// #2173: the board the Lead reads may name its open question; the parser keeps it and refuses anything else there.
test('a work board may carry the open question the desk holds, and nothing else beside it', () => {
  const ask = { id: 'message-7', question: 'Start the label fix?', at: 1767225600000, expiresAt: 1767227400000 }
  assert.deepEqual(parseLeadWorkBoard({ version: 1, items: [], more: 0, ask }).ask, ask)
  assert.equal(parseLeadWorkBoard({ version: 1, items: [], more: 0 }).ask, undefined)
  assert.throws(() => parseLeadWorkBoard({ version: 1, items: [], more: 0, ask: { ...ask, options: [] } }), /unexpected field options/)
  assert.throws(() => parseLeadWorkBoard({ version: 1, items: [], more: 0, ask: { ...ask, question: '' } }))
})
