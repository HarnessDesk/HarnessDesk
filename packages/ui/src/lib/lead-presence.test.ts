import { describe, expect, it } from 'vitest'
import { leadPresence, leadReadingWords, leadWakeLine, withDeskNeeds } from './lead-presence'
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

it('keeps the Resume wait when the table prioritizes waiting-for-user over activity', () => {
  const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
  state.changed({ method: 'lead/changed', params: leadProjection({ requestInFlight: true,
    thread: { ...leadProjection().thread, state: 'waiting-for-user' }, wayOut: 'resume' }) })
  expect(state.state.stage).toBe('you-answer')
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: '1 needs you' })
  state.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, stage: 'you-blocked', stageReason: 'failed' }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: '1 needs you' })
  state.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, stage: 'you-review', stageReason: 'result-ready' }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: 'Done · ready to accept' })
})

it('keeps the existing action count and result-ready wording under host stages', () => {
  const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
  const personActions = [1, 2].map(n => ({ kind: 'check' as const, id: `check-${n}`, runId: 'run', name: 'Check', command: 'node --test' }))
  state.changed({ method: 'lead/changed', params: leadProjection({ personActions, wayOut: 'resume' }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 3, word: '3 need you' })
  state.changed({ method: 'lead/changed', params: leadProjection({ revision: 11, waitReason: 'lead-result-awaiting-person',
    thread: { ...leadProjection().thread, state: 'waiting-for-user' } }) })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: 'Done · ready to accept' })
})

it('falls back to the old count and wording when an older host omits stage', () => {
  const state = createLeadState({ request: async () => leadProjection() } as never, () => true)
  const { stage: _stage, stageReason: _reason, ...old } = leadProjection({ wayOut: 'resume',
    thread: { ...leadProjection().thread, state: 'waiting-for-user' } })
  state.changed({ method: 'lead/changed', params: old as ReturnType<typeof leadProjection> })
  expect(leadPresence(state.state)).toMatchObject({ needs: 1, word: '1 needs you' })
})

it('a paused Lead with desk work waiting stays Paused and asleep, with the count beside the word', () => {
  const paused = { mood: 'sleeping', word: 'Paused', needs: 0, goalActive: false, quiet: false } as const
  expect(withDeskNeeds(paused, 2)).toMatchObject({ mood: 'sleeping', word: 'Paused · 2 need you', needs: 2 })
  expect(withDeskNeeds(paused, 1).word).toBe('Paused · 1 needs you')
  expect(withDeskNeeds(paused, 0)).toBe(paused)
  const resting = { mood: 'calm', word: 'Ready', needs: 0, goalActive: false } as unknown as Parameters<typeof withDeskNeeds>[0]
  expect(withDeskNeeds(resting, 1).word).toBe('1 needs you')
})
