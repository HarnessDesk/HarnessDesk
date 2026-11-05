import { describe, expect, it } from 'vitest'
import { leadPresence, leadReadingWords, leadWakeLine } from './lead-presence'
import { createLeadState } from '../state/lead'
import { leadProjection } from '../preview/lead-fixture'

describe('the Lead between turns', () => {
  it('keeps ordinary replies ready without inventing a running goal', () => {
    const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
    state.changed({ method: 'lead/changed', params: leadProjection({ thread: { ...leadProjection().thread, state: 'planning',
      messages: [{ version: 1, id: 'm', revision: 1, role: 'user', text: 'Hello' }] } }) })
    expect(leadPresence(state.state)).toMatchObject({ word: 'Ready', goalActive: false, quiet: true })
  })
  it('is quiet with no folder open, and the first projection clears it', async () => {
    const refused = Object.assign(new Error('lead-project-missing'), { code: 'lead-project-missing' })
    let open = false
    const state = createLeadState({ request: async () => { if (!open) throw refused; return leadProjection() } } as never, () => true)
    await expect(state.readThread()).rejects.toBe(refused)
    expect(state.state.projectMissing).toBe(true)
    expect(leadPresence(state.state)).toMatchObject({ word: 'No folder open', quiet: true, goalActive: false })
    open = true
    await state.readThread()
    expect(state.state.projectMissing).toBeUndefined()
  })
  it('speaks up when the person is needed', () => {
    const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
    state.changed({ method: 'lead/changed', params: leadProjection({ waitReason: 'lead-chat-effect-uncertain', wayOut: null, thread: { ...leadProjection().thread, state: 'stopped' } }) })
    expect(leadPresence(state.state).quiet).toBe(false)
  })
  it('keeps unacknowledged chat uncertainty actionable after an automatic stop', () => {
    const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
    state.changed({ method: 'lead/changed', params: leadProjection({ waitReason: 'lead-chat-effect-uncertain', wayOut: null,
      thread: { ...leadProjection().thread, state: 'stopped' } }) })
    expect(leadPresence(state.state)).toMatchObject({ mood: 'alert', word: '1 needs you', needs: 1, goalActive: false })
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

it('uses the host stage for the one Lead item instead of inferring a wait from thread state', () => {
  const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
  state.changed({ method: 'lead/changed', params: leadProjection({ stage: 'working', stageReason: 'running',
    thread: { ...leadProjection().thread, state: 'waiting-for-user' }, wayOut: 'resume' }) })
  expect(leadPresence(state.state).needs).toBe(0)
  state.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, stage: 'you-blocked', stageReason: 'failed' }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: '1 needs you' })
  state.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, stage: 'you-review', stageReason: 'result-ready' }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: 'Done · ready to accept' })
})
