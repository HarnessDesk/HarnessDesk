import { describe, expect, it } from 'vitest'

import { runtimeId, sessionKey, type CarryOnIncidentView, type TeamEntry } from '@harnessdesk/protocol'

import { latestLimitNotices, seatCarryOnAlways, seatCarryOnChoices } from './seat-carry-on'

const incident = (over: Partial<CarryOnIncidentView> = {}): CarryOnIncidentView => ({
  incidentId: 'i', runtime: runtimeId('codex'), sessionId: 's', owner: 'seat', state: 'asked', cause: 'limit',
  from: { runtime: runtimeId('codex'), name: 'Builder' }, openedAt: 1, resetsAt: 5,
  choices: { target: { runtime: runtimeId('codex'), name: 'Builder', account: 'account 2', mode: 'sameThread', tier: 0 }, wait: true },
  others: [], alwaysScope: 'desk', ...over,
} as CarryOnIncidentView)

describe('seatCarryOnAlways', () => {
  it('says where the rule lands: the desk, or the stuck agent', () => {
    expect(seatCarryOnAlways(incident())).toBe('Always do this')
    expect(seatCarryOnAlways(incident({ alwaysScope: 'agent' }))).toBe(`Always do this for ${incident().from.name}`)
  })
})

describe('seatCarryOnChoices', () => {
  it('names a sibling account for the same conversation, and a new agent for a handoff', () => {
    expect(seatCarryOnChoices(incident(), () => '5:10 PM')!.map((one) => [one.choice, one.label, one.title])).toEqual([
      ['switch', 'Switch to Builder · account 2', "Continue this seat's conversation on Builder · account 2"],
      ['wait', 'Wait until reset', 'Try again on this account at 5:10 PM'],
      ['stop', 'Stop', 'Leave this seat stopped'],
    ])
    const handoff = incident({ choices: { target: { runtime: runtimeId('claude'), name: 'Checker', mode: 'handoff', tier: 1 }, wait: true } })
    expect(seatCarryOnChoices(handoff, () => '')![0]!.label).toBe('Continue in Checker')
  })

  it('offers nothing unless the incident is asking', () => {
    expect(seatCarryOnChoices(undefined, () => '')).toBeNull()
    for (const state of ['deciding', 'waiting-reset', 'sending', 'moved', 'stopped', 'cleared'] as const)
      expect(seatCarryOnChoices(incident({ state }), () => '')).toBeNull()
  })

  it('keeps wait and stop when no candidate passed', () => {
    expect(seatCarryOnChoices(incident({ choices: { wait: false } }), () => '')!.map((one) => [one.choice, one.disabled])).toEqual([['wait', true], ['stop', false]])
  })
})

describe('latestLimitNotices', () => {
  const notice = (id: string, sessionId: string, cause: 'limit' | 'auth' = 'limit'): TeamEntry => ({
    id, at: 1, kind: 'notice', cause, text: '', about: { kind: 'agent', runtime: runtimeId('codex'), sessionId, title: 't' },
  })
  it('keeps one notice per member, the latest limit one', () => {
    const found = latestLimitNotices([notice('a', 's1'), notice('b', 's2'), notice('c', 's1'), notice('d', 's2', 'auth')])
    expect([...found]).toEqual([['c', sessionKey('codex', 's1')], ['b', sessionKey('codex', 's2')]])
  })
})
