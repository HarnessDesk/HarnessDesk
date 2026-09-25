import { describe, expect, it } from 'vitest'

import type { FlowExecution, GoalView } from '@harnessdesk/protocol'

import { goalRunOf, namedGoalRun } from './goal-run'

const run = (id: string, state: FlowExecution['state'], goal = 'g1'): FlowExecution =>
  ({ version: 2, id, goal, state, rounds: [], operations: [], legacyRun: null, reason: null } as unknown as FlowExecution)

const view = (over: { origin?: GoalView['goal']['origin']; reservation?: { run: string } } = {}): GoalView =>
  ({ goal: { id: 'g1', origin: over.origin ?? { kind: 'person' } }, ...(over.reservation ? { reservation: over.reservation } : {}) } as unknown as GoalView)

const cache = (...runs: FlowExecution[]) => new Map(runs.map((one) => [one.id, one]))

describe('goalRunOf — one rule for the room header and the Findings pane (#890)', () => {
  it('prefers the reserved run over a live one and over the opener', () => {
    const goal = view({ origin: { kind: 'flow', run: 'run-old' } as never, reservation: { run: 'run-new' } })
    expect(goalRunOf('g1', goal, cache(run('run-old', 'stopped'), run('run-new', 'stopped'), run('run-x', 'running')))?.id).toBe('run-new')
    expect(namedGoalRun(goal)).toBe('run-new')
  })

  it('then the run going on now, over a dropped opener cached first', () => {
    const goal = view({ origin: { kind: 'flow', run: 'run-old' } as never })
    expect(goalRunOf('g1', goal, cache(run('run-old', 'stopped'), run('run-live', 'stalled')))?.id).toBe('run-live')
  })

  it('then the opener', () => {
    const goal = view({ origin: { kind: 'flow', run: 'run-old' } as never })
    expect(goalRunOf('g1', goal, cache(run('run-other', 'settled'), run('run-old', 'stopped')))?.id).toBe('run-old')
  })

  it('never an older run standing in for a named one not loaded yet', () => {
    const goal = view({ reservation: { run: 'run-new' } })
    expect(goalRunOf('g1', goal, cache(run('run-old', 'stopped')))).toBeNull()
  })

  it('a Goal naming no run reads the last cached, and only its own', () => {
    expect(goalRunOf('g1', view(), cache(run('run-a', 'stopped'), run('run-b', 'settled'), run('run-c', 'running', 'g2')))?.id).toBe('run-b')
  })

  it('reads only the runs a surface accepts', () => {
    const goal = view()
    const found = goalRunOf('g1', goal, cache(run('run-live', 'running'), { ...run('run-kept', 'stopped'), findings: {} } as never), (one) => Boolean(one.findings))
    expect(found?.id).toBe('run-kept')
  })
})
