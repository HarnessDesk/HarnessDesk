import { describe, expect, it } from 'vitest'
import { leadPresence, leadReadingWords, leadWakeLine } from './lead-presence'
import { createLeadState } from '../state/lead'
import { leadProjection } from '../preview/lead-fixture'

describe('the Lead between turns', () => {
  it('keeps ordinary replies ready without inventing a running goal', () => {
    const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
    state.changed({ method: 'lead/changed', params: leadProjection({ thread: { ...leadProjection().thread, state: 'planning',
      messages: [{ version: 1, id: 'm', revision: 1, role: 'user', text: 'Hello' }] } }) })
    expect(leadPresence(state.state)).toMatchObject({ word: 'Ready', goalActive: false })
  })
  it('says how often it looked and whether it let everything pass', () => {
    expect(leadWakeLine(null)).toBeNull()
    expect(leadWakeLine({ checked: 0, quiet: 0, lastCheckedAt: null, readings: [] })).toBeNull()
    expect(leadWakeLine({ checked: 3, quiet: 3, lastCheckedAt: 1, readings: [] })).toBe('Checked 3 times · nothing new · stayed quiet')
    expect(leadWakeLine({ checked: 1, quiet: 0, lastCheckedAt: 1, readings: [] })).toBe('Checked 1 time · 1 worth a look')
  })
  it('reads each run in a phrase, with how long a stuck one has been quiet', () => {
    expect(leadReadingWords({ checked: 1, quiet: 1, lastCheckedAt: 1, readings: [
      { runId: 'a', kind: 'advanced' }, { runId: 'b', kind: 'stuck', quietMinutes: 24 }, { runId: 'c', kind: 'plan-only' }] }))
      .toEqual(['Run 1 moving', 'Run 2 stuck · quiet 24 min', 'Run 3 planned, nothing done'])
  })
})
