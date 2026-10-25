import { describe, expect, it } from 'vitest'
import { leadReadingWords, leadWakeLine } from './lead-presence'

describe('the Lead between turns', () => {
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
