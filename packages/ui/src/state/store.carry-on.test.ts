import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, type CarryOnIncidentView, type HostMethodName, type SessionId, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * The store's half of carry-on: the live incidents a card reads, the inbox's
 * kept copy of each state worth reading later, and an "Always do this"
 * answer mirrored at the level the incident named.
 */

const RUNTIME = runtimeId('alpha')
const SESSION = 'thread-1' as SessionId
const KEY = sessionKey(RUNTIME, SESSION)

const incident = (patch: Partial<CarryOnIncidentView> = {}): CarryOnIncidentView => ({
  incidentId: 'incident-1',
  runtime: RUNTIME,
  sessionId: SESSION,
  owner: 'chat',
  state: 'asked',
  cause: 'credits',
  from: { name: 'Alpha', account: 'work' },
  openedAt: Date.now(),
  choices: { wait: false },
  others: [],
  alwaysScope: 'desk',
  ...patch,
})

let store: AppStore
let request: ReturnType<typeof vi.fn>
let answers: Partial<Record<HostMethodName, unknown>>

const push = (next: CarryOnIncidentView | null): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification({ method: 'carryOn/changed', params: { key: { runtime: RUNTIME, sessionId: SESSION }, incident: next } } as WireNotification)
}

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  request = vi.fn(async (method: HostMethodName) => {
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return answer ?? null
  })
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

describe('carry-on in the store', () => {
  it('reads every live incident on connect, and keeps what it holds when the host cannot say', async () => {
    answers['carryOn/list'] = { incidents: [incident()] }
    await store.loadCarryOn()
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.state).toBe('asked')
    answers['carryOn/list'] = new Error('not available yet')
    await store.loadCarryOn()
    expect(store.getSnapshot().carryOnIncidents.size).toBe(1)
  })

  it('keeps one inbox copy per state, opens the conversation from it, and marks the question read once answered', () => {
    push(incident())
    push(incident())
    const asked = store.getSnapshot().inbox.filter(entry => entry.kind === 'usage:carry-on')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ id: 'carry-on:incident-1:asked', tone: 'warning', read: false, from: { runtime: RUNTIME, sessionId: SESSION, name: 'Alpha' } })
    expect(asked[0]!.title).toBe('Alpha · work reached its usage limit. Choose how to carry on.')

    push(incident({ state: 'moved', to: { name: 'Alpha', account: 'personal' }, mode: 'sameThread' }))
    const inbox = store.getSnapshot().inbox
    expect(inbox.find(entry => entry.id === 'carry-on:incident-1:asked')?.read).toBe(true)
    expect(inbox.find(entry => entry.id === 'carry-on:incident-1:moved')).toMatchObject({ tone: 'info', title: 'Alpha · work reached its usage limit. Continued on Alpha · personal.' })

    push(null)
    expect(store.getSnapshot().carryOnIncidents.has(KEY)).toBe(false)
  })

  it('leaves a seat’s and a Lead chat’s incident to their own surfaces', () => {
    push(incident({ owner: 'seat' }))
    push(incident({ owner: 'lead', state: 'stopped' }))
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.owner).toBe('lead')
    expect(store.getSnapshot().inbox.some(entry => entry.kind === 'usage:carry-on')).toBe(false)
  })

  it('mirrors "Always do this" at the desk or at the agent, as the incident said', async () => {
    push(incident())
    answers['carryOn/decide'] = { incident: incident({ state: 'stopped' }) }
    await store.decideCarryOn({ incidentId: 'incident-1', choice: 'stop', always: true })
    expect(store.getSnapshot().carryOnPolicy).toEqual({ onLimit: 'stop', otherAgents: true })
    expect(request).toHaveBeenCalledWith('carryOn/decide', { incidentId: 'incident-1', choice: 'stop', always: true })

    push(incident({ incidentId: 'incident-2', alwaysScope: 'agent' }))
    answers['carryOn/decide'] = { incident: incident({ incidentId: 'incident-2', state: 'waiting-reset', alwaysScope: 'agent' }) }
    await store.decideCarryOn({ incidentId: 'incident-2', choice: 'wait', always: true })
    expect(store.getSnapshot().accountPools[RUNTIME]?.whenOut).toBe('wait')
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop')
  })

  it('throws a refusal for the card to say, and changes nothing', async () => {
    push(incident())
    answers['carryOn/decide'] = new Error('That account no longer has room.')
    await expect(store.decideCarryOn({ incidentId: 'incident-1', choice: 'switch', always: true })).rejects.toThrow('no longer has room')
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.state).toBe('asked')
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('ask')
  })

  it('reads the desk rule from preferences, and writes it whole', async () => {
    answers['app/state/get'] = { carryOn: { onLimit: 'wait', otherAgents: false } }
    await store.loadCarryOnPolicy()
    expect(store.getSnapshot().carryOnPolicy).toEqual({ onLimit: 'wait', otherAgents: false })
    await store.setCarryOnPolicy({ onLimit: 'switch', otherAgents: true })
    expect(request).toHaveBeenCalledWith('app/state/set', expect.objectContaining({ patch: { carryOn: { onLimit: 'switch', otherAgents: true } } }))
  })
})
