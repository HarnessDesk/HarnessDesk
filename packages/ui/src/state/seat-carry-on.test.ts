import { expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, type CarryOnIncidentView, type WireNotification } from '@harnessdesk/protocol'

import { createSeatCarryOnState } from './seat-carry-on'

const view = (sessionId: string, owner: CarryOnIncidentView['owner'], state: CarryOnIncidentView['state'] = 'asked'): CarryOnIncidentView => ({
  incidentId: `i-${sessionId}`, runtime: runtimeId('codex'), sessionId, owner, state, cause: 'limit',
  from: { runtime: runtimeId('codex'), name: 'Builder' }, openedAt: 1, choices: { wait: false }, others: [], alwaysScope: 'desk',
} as unknown as CarryOnIncidentView)

it('keeps only seat incidents, by session, and drops one the host says is over', async () => {
  const request = vi.fn(async (method: string) => method === 'carryOn/list'
    ? { incidents: [view('a', 'seat'), view('b', 'chat'), view('c', 'lead')] }
    : { incident: view('a', 'seat', 'sending') })
  const seats = createSeatCarryOnState({ request } as never)
  const heard = vi.fn()
  seats.subscribe(heard)
  await seats.refresh()
  expect([...seats.state.keys()]).toEqual([sessionKey('codex', 'a')])

  const changed = (incident: CarryOnIncidentView | null, sessionId: string): WireNotification =>
    ({ method: 'carryOn/changed', params: { incident, key: { runtime: runtimeId('codex'), sessionId } } }) as WireNotification
  seats.changed(changed(view('d', 'chat'), 'd'))
  seats.changed(changed(view('e', 'seat'), 'e'))
  expect([...seats.state.keys()]).toEqual([sessionKey('codex', 'a'), sessionKey('codex', 'e')])
  seats.changed(changed(null, 'e'))
  expect([...seats.state.keys()]).toEqual([sessionKey('codex', 'a')])

  await seats.decide({ incidentId: 'i-a', choice: 'switch', always: false })
  expect(request).toHaveBeenLastCalledWith('carryOn/decide', { incidentId: 'i-a', choice: 'switch', always: false })
  expect(seats.state.get(sessionKey('codex', 'a'))?.state).toBe('sending')
  expect(heard).toHaveBeenCalled()
})
