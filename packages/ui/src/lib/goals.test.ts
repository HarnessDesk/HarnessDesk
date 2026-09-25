import { describe, expect, it } from 'vitest'

import type { Goal, GoalActivity } from '@harnessdesk/protocol'

import { goalActions, goalName, goalNotification, goalWords, projectGoals, type GoalRow } from './goals'

const goal = (id: string, patch: Partial<Goal> = {}): Goal => ({
  id,
  root: '/work/acme',
  cwd: '/work/acme',
  sentence: `Finish ${id}`,
  state: 'open',
  revision: 1,
  checkout: 'shared',
  dependsOn: [],
  origin: { kind: 'person' },
  createdAt: 1,
  updatedAt: 1,
  receipt: null,
  ...patch,
})

const row = (id: string, activity: GoalActivity | null = 'working', patch: Partial<Goal> = {}): GoalRow => ({
  goal: goal(id, patch),
  activity,
})

describe('Goal presentation', () => {
  it('groups one project by lifecycle and stable recency', () => {
    const result = projectGoals('/work/acme', [
      row('old', 'working', { updatedAt: 2 }),
      row('other', 'working', { root: '/work/other', updatedAt: 99 }),
      row('wrapped', null, { state: 'wrapped', updatedAt: 4 }),
      row('same-b', 'ready-to-wrap', { updatedAt: 3 }),
      row('same-a', 'needs-you', { updatedAt: 3 }),
    ])

    expect(result.open.map(({ goal }) => goal.id)).toEqual(['same-a', 'same-b', 'old'])
    expect(result.wrapped.map(({ goal }) => goal.id)).toEqual(['wrapped'])
    expect(projectGoals('/none', [])).toEqual({ open: [], wrapped: [] })
  })

  it.each([
    ['working', 'Working', 'info'],
    ['needs-you', 'Needs you', 'warning'],
    ['ready-to-wrap', 'Ready to wrap', 'brand'],
  ] as const)('names %s without turning readiness into an evidence verdict', (activity, label, tone) => {
    expect(goalWords(row('g', activity))).toEqual({ label, tone })
  })

  it('names wrapping and wrapped from lifecycle', () => {
    expect(goalWords(row('g', 'working', { state: 'wrapping' }))).toEqual({ label: 'Wrapping', tone: 'info' })
    expect(goalWords(row('g', null, { state: 'wrapped' }))).toEqual({ label: 'Wrapped', tone: 'neutral' })
  })

  it('allows only open Goals to mutate', () => {
    expect(goalActions(goal('open'))).toEqual({ disabled: false, reason: null })
    expect(goalActions(goal('wrapping', { state: 'wrapping' }))).toEqual({
      disabled: true,
      reason: 'The desk is finishing this receipt.',
    })
    expect(goalActions(goal('wrapped', { state: 'wrapped' }))).toEqual({
      disabled: true,
      reason: 'This Goal is wrapped. Its receipt is kept here.',
    })
  })
})

describe('Goal transition notifications', () => {
  const prefs = { enabled: true, goalNeedsYou: true, goalReadyToWrap: true }

  it('announces the two real open-Goal transitions', () => {
    expect(goalNotification(row('g', 'working'), row('g', 'needs-you'), prefs, false)).toEqual({
      kind: 'goalNeedsYou', goal: 'g', title: 'A Goal needs you', body: 'Finish g',
    })
    expect(goalNotification(row('g', 'working'), row('g', 'ready-to-wrap'), prefs, false)).toEqual({
      kind: 'goalReadyToWrap', goal: 'g', title: 'A Goal is ready to wrap', body: 'Finish g',
    })
  })

  it.each([
    [null, row('g', 'needs-you'), prefs, false],
    [row('g', 'needs-you'), row('g', 'needs-you'), prefs, false],
    [row('g', 'working'), row('g', 'needs-you'), prefs, true],
    [row('g', 'working'), row('other', 'needs-you'), prefs, false],
    [row('g', 'working'), row('g', 'needs-you', { state: 'wrapping' }), prefs, false],
    [row('g', 'working'), row('g', 'needs-you'), { ...prefs, enabled: false }, false],
    [row('g', 'working'), row('g', 'needs-you'), { ...prefs, goalNeedsYou: false }, false],
  ] as const)('suppresses startup, repeats, focus, mismatches and disabled preferences', (previous, next, chosen, focused) => {
    expect(goalNotification(previous, next, chosen, focused)).toBeNull()
  })
})

describe('goalName', () => {
  it('names a trigger’s Goal by its subject, never by the trigger’s own id', () => {
    const origin = { kind: 'trigger' as const, trigger: 'triage-issue', event: 'e1' }
    expect(goalName(goal('g', { sentence: 'Issue #42, from trigger triage-issue', origin }))).toBe('Issue #42')
    expect(goalName(goal('g', { sentence: 'Pull request #7, from trigger triage-issue', origin }))).toBe('Pull request #7')
  })

  it('leaves a person’s sentence whole, even one that happens to end the same way', () => {
    expect(goalName(goal('g', { sentence: 'Ship it, from trigger triage-issue' }))).toBe('Ship it, from trigger triage-issue')
    expect(goalName(goal('g'))).toBe('Finish g')
  })
})
