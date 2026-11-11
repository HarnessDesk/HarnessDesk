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
    if (typeof answer === 'function') return (answer as () => Promise<unknown>)()
    return answer ?? null
  })
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
  // The kept inbox and the notice policy have answered; one test below holds them back.
  Object.assign(store.getSnapshot(), { preferencesLoaded: true })
})

/** A request answered when the test says, to put a push in the middle of it. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const status = (next: 'open' | 'reconnecting'): void =>
  (store.transport as unknown as { handlers: { onStatus(status: string): void } }).handlers.onStatus(next)

/** A wire refusal as the transport hands it on: its sentence, its code and its data. */
const refusal = (message: string, code: string, data: unknown): Error => Object.assign(new Error(message), { code, data })

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

  it('binds "Switch to B" to B: the answer carries the target the card named', async () => {
    push(incident())
    answers['carryOn/decide'] = { incident: incident({ state: 'moved' }) }
    await store.decideCarryOn({ incidentId: 'incident-1', choice: 'switch', always: false, target: runtimeId('alpha-2') })
    expect(request).toHaveBeenCalledWith('carryOn/decide', { incidentId: 'incident-1', choice: 'switch', always: false, target: 'alpha-2' })
  })

  it('applies the incident a stale refusal carries before saying it, and never retries', async () => {
    push(incident())
    // The host's candidates moved on: the card is redrawn with the ones it has now.
    const now = incident({ others: [{ runtime: runtimeId('beta'), name: 'Beta', mode: 'handoff', tier: 0 }] })
    answers['carryOn/decide'] = refusal('That account is no longer a candidate.', 'carryOnStale', { incident: now })
    await expect(store.decideCarryOn({ incidentId: 'incident-1', choice: 'switch', always: false, target: runtimeId('alpha-2') })).rejects.toThrow('no longer a candidate')
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.others).toEqual(now.others)

    // Answered in another window: the refusal says there is nothing left to ask, and the card goes.
    answers['carryOn/decide'] = refusal('This was already answered.', 'carryOnStale', { incident: null })
    await expect(store.decideCarryOn({ incidentId: 'incident-1', choice: 'stop', always: true })).rejects.toThrow('already answered')
    expect(store.getSnapshot().carryOnIncidents.has(KEY)).toBe(false)
    expect(store.getSnapshot().inbox.find(entry => entry.id === 'carry-on:incident-1:asked')?.read).toBe(true)
    expect(request.mock.calls.filter(([method]) => method === 'carryOn/decide')).toHaveLength(2)
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('ask')
  })

  it('a list read across a push keeps the push, whichever way it went', async () => {
    push(incident())
    const read = deferred<unknown>()
    answers['carryOn/list'] = () => read.promise
    const loading = store.loadCarryOn()
    // Answered while the list was on its way: the list's older "asked" must not bring the card back.
    push(null)
    read.resolve({ incidents: [incident()] })
    await loading
    expect(store.getSnapshot().carryOnIncidents.has(KEY)).toBe(false)

    const again = deferred<unknown>()
    answers['carryOn/list'] = () => again.promise
    const second = store.loadCarryOn()
    // Opened while the list was on its way: a list from before it must not erase it.
    push(incident({ incidentId: 'incident-2' }))
    again.resolve({ incidents: [] })
    await second
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.incidentId).toBe('incident-2')
  })

  it('a list from a connection that dropped is not applied', async () => {
    const read = deferred<unknown>()
    answers['carryOn/list'] = () => read.promise
    const loading = store.loadCarryOn()
    status('reconnecting')
    read.resolve({ incidents: [incident()] })
    await loading
    expect(store.getSnapshot().carryOnIncidents.has(KEY)).toBe(false)
  })

  it('an answer that arrives after a newer push does not replace it', async () => {
    push(incident())
    const answer = deferred<unknown>()
    answers['carryOn/decide'] = () => answer.promise
    const deciding = store.decideCarryOn({ incidentId: 'incident-1', choice: 'switch', always: false, target: runtimeId('alpha-2') })
    push(incident({ state: 'moved', to: { name: 'Alpha', account: 'personal' }, mode: 'sameThread' }))
    answer.resolve({ incident: incident({ state: 'sending' }) })
    await deciding
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.state).toBe('moved')
  })

  it('an answer sent after a list set out outranks it, whichever comes back first', async () => {
    push(incident())
    // The list comes back first, still saying "asked"; the Stop sent after it set out must still land.
    const read = deferred<unknown>()
    answers['carryOn/list'] = () => read.promise
    const loading = store.loadCarryOn()
    const answer = deferred<unknown>()
    answers['carryOn/decide'] = () => answer.promise
    const deciding = store.decideCarryOn({ incidentId: 'incident-1', choice: 'stop', always: false })
    read.resolve({ incidents: [incident()] })
    await loading
    answer.resolve({ incident: incident({ state: 'stopped' }) })
    await deciding
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.state).toBe('stopped')

    // The other way round: the answer first, then the older list.
    push(incident({ incidentId: 'incident-2' }))
    const later = deferred<unknown>()
    answers['carryOn/list'] = () => later.promise
    const second = store.loadCarryOn()
    answers['carryOn/decide'] = { incident: incident({ incidentId: 'incident-2', state: 'stopped' }) }
    await store.decideCarryOn({ incidentId: 'incident-2', choice: 'stop', always: false })
    later.resolve({ incidents: [incident({ incidentId: 'incident-2' })] })
    await second
    expect(store.getSnapshot().carryOnIncidents.get(KEY)).toMatchObject({ incidentId: 'incident-2', state: 'stopped' })
  })

  it('a stale refusal to an answer sent after a list set out clears the card the list put back', async () => {
    push(incident())
    const read = deferred<unknown>()
    answers['carryOn/list'] = () => read.promise
    const loading = store.loadCarryOn()
    const answer = deferred<unknown>()
    answers['carryOn/decide'] = () => answer.promise
    const deciding = store.decideCarryOn({ incidentId: 'incident-1', choice: 'stop', always: false })
    read.resolve({ incidents: [incident()] })
    await loading
    answer.reject(refusal('This was already answered.', 'carryOnStale', { incident: null }))
    await expect(deciding).rejects.toThrow('already answered')
    expect(store.getSnapshot().carryOnIncidents.has(KEY)).toBe(false)
  })

  it('a list keeps the inbox in step: a question asked while away is kept, one answered while away is read', async () => {
    // A question kept before this window went away, answered elsewhere since.
    store.keep({ id: 'carry-on:incident-0:asked', kind: 'usage:carry-on', tone: 'warning', title: 'Alpha · work reached its usage limit. Choose how to carry on.', at: 1 })
    answers['carryOn/list'] = { incidents: [incident()] }
    await store.loadCarryOn()
    const inbox = store.getSnapshot().inbox
    expect(inbox.find(entry => entry.id === 'carry-on:incident-1:asked')).toMatchObject({ read: false })
    expect(inbox.find(entry => entry.id === 'carry-on:incident-0:asked')).toMatchObject({ read: true })
  })

  it('holds inbox work until the kept inbox and the notice policy have answered', async () => {
    Object.assign(store.getSnapshot(), { preferencesLoaded: false })
    push(incident())
    expect(store.getSnapshot().carryOnIncidents.get(KEY)?.state).toBe('asked')
    expect(store.getSnapshot().inbox.some(entry => entry.kind === 'usage:carry-on')).toBe(false)
    answers['app/state/get'] = { inbox: [] }
    await store.loadPreferences()
    expect(store.getSnapshot().inbox.find(entry => entry.id === 'carry-on:incident-1:asked')).toMatchObject({ read: false })
  })

  /** The host's preferences, as a write leaves them: what a read made after the write answers. */
  const host = (initial: Record<string, unknown>) => {
    const prefs: Record<string, unknown> = { ...initial }
    const reads: ReturnType<typeof deferred<unknown>>[] = []
    let flowing = false
    // Each read is answered by the test, with the preferences as they stood when it was sent.
    answers['app/state/get'] = () => {
      const read = deferred<unknown>()
      const sent = { ...prefs }
      reads.push(read)
      if (flowing) read.resolve(undefined)
      return read.promise.then(() => sent)
    }
    /** From here on every read is answered as soon as it is sent. */
    const flow = (): void => {
      flowing = true
      for (const read of reads) read.resolve(undefined)
    }
    return { prefs, reads, flow }
  }

  it('reads both levels of the rule, and drops a read that a write here overtook', async () => {
    answers['app/state/get'] = { carryOn: { onLimit: 'wait', otherAgents: true }, accountPools: { alpha: { whenOut: 'stop' } } }
    await store.loadCarryOnPolicy()
    expect(store.getSnapshot().accountPools[RUNTIME]?.whenOut).toBe('stop')

    const { prefs, reads } = host({ carryOn: { onLimit: 'wait', otherAgents: true }, accountPools: { alpha: { whenOut: 'stop' } } })
    answers['app/state/set'] = (async () => { Object.assign(prefs, { accountPools: { alpha: { whenOut: 'next' } } }); return null }) as never
    const loading = store.loadCarryOnPolicy()
    store.setAccountPool(RUNTIME, { whenOut: 'next' })
    reads[0]!.resolve(undefined)
    // The overtaken read is asked again, and the second answer has the write in it.
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.resolve(undefined)
    await loading
    expect(store.getSnapshot().accountPools[RUNTIME]?.whenOut).toBe('next')
  })

  it('a read sent while a write is in flight never undoes the selection shown', async () => {
    const { prefs, reads, flow } = host({ carryOn: { onLimit: 'ask', otherAgents: true } })
    const write = deferred<unknown>()
    answers['app/state/set'] = () => write.promise
    const writing = store.setCarryOnPolicy({ onLimit: 'stop', otherAgents: true })
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop')

    // Sent and answered while the write is still out: it predates the write.
    const early = store.loadCarryOnPolicy()
    reads[0]!.resolve(undefined)
    await early
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop')

    // Sent while the write is out, answered after it settled: still from before it.
    const late = store.loadCarryOnPolicy()
    Object.assign(prefs, { carryOn: { onLimit: 'stop', otherAgents: true } })
    write.resolve(null)
    await writing
    reads[1]!.resolve(undefined)
    flow()
    await late
    await vi.waitFor(() => expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop'))
  })

  it('a reconnect read that runs before a queued write flushes does not undo it', async () => {
    Object.assign(store.getSnapshot(), { status: 'open' })
    const write = deferred<unknown>()
    answers['app/state/set'] = () => write.promise
    answers['carryOn/list'] = { incidents: [] }
    const writing = store.setCarryOnPolicy({ onLimit: 'stop', otherAgents: true })
    status('reconnecting')
    // The host still has Ask: the queued write has not reached it yet.
    answers['app/state/get'] = { carryOn: { onLimit: 'ask', otherAgents: true } }
    status('open')
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'app/state/get').length).toBeGreaterThan(0))
    await Promise.resolve()
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop')
    answers['app/state/get'] = { carryOn: { onLimit: 'stop', otherAgents: true } }
    write.resolve(null)
    await writing
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'app/state/get').length).toBeGreaterThan(1))
    expect(store.getSnapshot().carryOnPolicy.onLimit).toBe('stop')
  })

  it('reads the rules again on reconnect, so an "Always" the host wrote while the link was down is not undone', async () => {
    Object.assign(store.getSnapshot(), { status: 'open' })
    status('reconnecting')
    answers['app/state/get'] = { carryOn: { onLimit: 'ask', otherAgents: true }, accountPools: { alpha: { whenOut: 'stop' } } }
    answers['carryOn/list'] = { incidents: [] }
    status('open')
    await vi.waitFor(() => expect(store.getSnapshot().accountPools[RUNTIME]?.whenOut).toBe('stop'))
  })
})
