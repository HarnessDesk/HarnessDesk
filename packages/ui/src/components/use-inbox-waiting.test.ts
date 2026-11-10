import { describe, expect, it, vi } from 'vitest'
import type { LeadInbox } from '@harnessdesk/protocol'
import { inboxWaiting } from './use-inbox-waiting'

const inbox: LeadInbox = { version: 1, needsYou: 3, items: [
  { id: 'ask:m1', kind: 'ask', title: 'Which branch?', at: 3, needsYou: true, target: 'm1' },
  { id: 'team:goal-game', kind: 'team', title: 'build a game', project: 'Widgets', at: 2, needsYou: true, target: 'goal-game' },
  { id: 'chat:codex:s1', kind: 'chat', title: '\x1b[31mFix\n the tests', at: 1, needsYou: true, target: 'codex:s1' },
  { id: 'notice:n1', kind: 'notice', title: 'Usage is high', at: 0, needsYou: false },
] }

describe('inboxWaiting', () => {
  it('lists only what needs the person, as plain text, and opens each where it lives', () => {
    const open = { lead: vi.fn(), team: vi.fn(), chat: vi.fn() }
    const rows = inboxWaiting(inbox, open)
    expect(rows.map(row => row.id)).toEqual(['ask:m1', 'team:goal-game', 'chat:codex:s1'])
    expect(rows[1]!.place).toBe('Widgets')
    expect(rows[2]!.title).not.toContain('\x1b')
    rows.forEach(row => row.onOpen?.())
    expect(open.lead).toHaveBeenCalledTimes(1)
    expect(open.team).toHaveBeenCalledWith('goal-game')
    expect(open.chat).toHaveBeenCalledWith('codex', 's1')
  })

  it('lists nothing before the desk has answered', () => {
    expect(inboxWaiting(null, { lead: vi.fn(), team: vi.fn(), chat: vi.fn() })).toEqual([])
  })
})
