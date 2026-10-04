import { expect, it } from 'vitest'

import { sessionKey, type FlowExecution, type GoalView, type SeatRecord, type TeamState } from '@harnessdesk/protocol'

import { seatLabelsOf } from './seat-names'

/**
 * A seat in a Team is somebody's job, not a conversation anyone typed into, so
 * it has no first message to be named by. It is named by what it does and where.
 */

const record = (id: string, sessionId: string, role: string | null, agent = 'Claude Code'): SeatRecord =>
  ({ id, session: { runtime: 'agent-a', sessionId }, role, openedAt: 1, closed: null, agent: { name: agent } }) as unknown as SeatRecord
const team = (name = 'Fix the retry bug'): TeamState => ({ id: 'team', name, members: [] }) as unknown as TeamState
const goal = (members: SeatRecord[], over: Record<string, unknown> = {}): GoalView =>
  ({ goal: { id: 'team', state: 'open', sentence: 'Fix the retry bug', origin: { kind: 'person' }, ...over }, members }) as unknown as GoalView
const input = (members: SeatRecord[], over: Record<string, unknown> = {}, runs = new Map<string, FlowExecution>()) => ({
  teams: new Map([['team', team()]]),
  goals: new Map([['team', goal(members, over)]]),
  flowExecutions: runs,
})
const key = (sessionId: string): string => String(sessionKey('agent-a', sessionId))

it('names a seat by its job and its Team', () => {
  const labels = seatLabelsOf(input([record('a', 'one', 'implementer'), record('b', 'two', 'reviewer')]))
  expect(labels.get(key('one'))).toBe('Implementer · Fix the retry bug')
  expect(labels.get(key('two'))).toBe('Reviewer · Fix the retry bug')
})

it('says a job in words, and takes the round’s job over the one the seat was opened with', () => {
  const run = { goal: 'team', rounds: [{ role: 'code-reviewer', seats: ['a'] }] } as unknown as FlowExecution
  const labels = seatLabelsOf(input([record('a', 'one', 'implementer')], {}, new Map([['run', run]])))
  expect(labels.get(key('one'))).toBe('Code reviewer · Fix the retry bug')
})

it('falls back to the agent’s own name for a seat with no job', () => {
  expect(seatLabelsOf(input([record('a', 'one', null, 'Codex')])).get(key('one'))).toBe('Codex · Fix the retry bug')
})

it('names the Team by its Goal, the way every other row does', () => {
  const trigger = { sentence: 'Issue #42, from trigger triage-issue', origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } }
  expect(seatLabelsOf(input([record('a', 'one', 'triager')], trigger)).get(key('one'))).toBe('Triager · Issue #42')
})

it('names nothing for a conversation that is no seat’s, or a seat of a Team that has wrapped', () => {
  expect(seatLabelsOf(input([record('a', 'one', 'implementer')])).get(key('stranger'))).toBeUndefined()
  expect(seatLabelsOf(input([record('a', 'one', 'implementer')], { state: 'wrapped' })).size).toBe(0)
})

it('is worked out once for one snapshot, however many rows ask', () => {
  const one = input([record('a', 'one', 'implementer')])
  expect(seatLabelsOf(one)).toBe(seatLabelsOf(one))
  expect(seatLabelsOf(input([record('a', 'one', 'implementer')]))).not.toBe(seatLabelsOf(one))
})
