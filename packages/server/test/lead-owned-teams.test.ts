import assert from 'node:assert/strict'
import test from 'node:test'
import { leadOwnedTeams } from '../src/lead/owned-teams.js'

const attempt = (id: string, correlationId: string, stepId: string | null) => [id, { id, correlationId, stepId }] as const

test('each Lead Team carries the step its run was started for and whether the result was accepted', () => {
  const state = {
    phase: 'running' as const,
    contract: { steps: [{ id: 'first', title: 'Review first repair' }, { id: 'second', title: 'Review second repair' }] },
    attempts: new Map([attempt('a1', 'c1', 'first'), attempt('a2', 'c2', 'second'), attempt('r1', 'c9', null)]),
    runs: [{ correlationId: 'c1', runId: 'r1', teamId: 't1' }, { correlationId: 'c2', runId: 'r2', teamId: 't2' }],
    teams: ['t1', 't2', 't3'],
  } as never
  assert.deepEqual([...leadOwnedTeams(state)], [
    ['t1', { step: 'Review first repair', accepted: false }],
    ['t2', { step: 'Review second repair', accepted: false }],
    // Bound without a recorded start: no step is guessed.
    ['t3', { step: null, accepted: false }],
  ])
  assert.ok([...leadOwnedTeams({ ...(state as object), phase: 'accepted' } as never).values()].every(team => team.accepted))
})
