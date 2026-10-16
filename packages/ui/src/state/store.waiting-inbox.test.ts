import { expect, it, vi } from 'vitest'
import { approvalId, sessionKey, type HostMethodName, type WireNotification } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { waitingInboxFixture } from '../preview/notices-d3-fixture'
import { mergeNoticePreferences } from '../../../server/src/runtime-notices'

const setup = (saved: Record<string, unknown> = {}, fixture = waitingInboxFixture()) => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/get') return structuredClone(saved)
    if (method === 'app/state/set') {
      const { patch, noticeBase } = params as { patch: Record<string, unknown>; noticeBase: Record<string, unknown> }
      Object.assign(saved, mergeNoticePreferences(saved, patch, noticeBase))
      return structuredClone(saved)
    }
    return null
  }) as never)
  const { snapshot, board, execution } = fixture
  Object.assign(store.getSnapshot(), snapshot, { inbox: [] })
  const push = (notification: WireNotification) => (store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }).handlers.onNotification(notification)
  return { store, push, board, execution, saved, request }
}
it('keeps a waiting pick once with the Team and step, and preserves a host-backed read across repeated pushes', async () => {
  const { store, push, execution, saved } = setup()
  const changed = { method: 'flow/execution-changed', params: { execution } } as const
  push(changed)
  expect(store.getSnapshot().inbox).toEqual([expect.objectContaining({ title: 'Retry the checkout call', body: 'Your pick is next', open: 'team:overview-team', read: false })])
  const id = store.getSnapshot().inbox[0]!.id
  store.markInboxRead(id)
  await vi.waitFor(() => expect(saved['inbox']).toEqual([expect.objectContaining({ id, read: true })]))
  push(changed)
  expect(store.getSnapshot().inbox).toHaveLength(1)
  expect(store.getSnapshot().inbox[0]?.read).toBe(true)
})

it('keeps Clear the inbox cleared after the host reply and repeated live snapshots', async () => {
  const { store, push, execution, saved } = setup()
  const changed = { method: 'flow/execution-changed', params: { execution } } as const
  push(changed)
  store.clearInbox()
  await vi.waitFor(() => expect(saved['inbox']).toEqual([]))
  push(changed)
  expect(store.getSnapshot().inbox).toEqual([])
})

it('uses host receipts to keep the same cleared wait absent in another window', async () => {
  const fixture = waitingInboxFixture()
  const first = setup({}, fixture)
  first.push({ method: 'flow/execution-changed', params: { execution: fixture.execution } })
  first.store.clearInbox()
  await vi.waitFor(() => expect(first.saved['inbox']).toEqual([]))
  const second = setup(first.saved, fixture)
  await second.store.loadPreferences()
  second.push({ method: 'flow/execution-changed', params: { execution: fixture.execution } })
  await vi.waitFor(() => expect(second.store.getSnapshot().inbox).toEqual([]))
  second.push({ method: 'flow/execution-changed', params: { execution: fixture.execution } })
  expect(second.store.getSnapshot().inbox).toEqual([])
  expect(second.request.mock.calls.filter(([method]) => method === 'app/state/set')).toHaveLength(1)
})

it('admits a new occurrence after the cleared person step ends and returns', async () => {
  const { store, push, board, execution, saved } = setup()
  push({ method: 'flow/execution-changed', params: { execution } })
  store.clearInbox()
  push({ method: 'team/changed', params: { state: { ...board, intents: board.intents.map(card => ({ ...card, state: 'done' })) } } })
  push({ method: 'team/changed', params: { state: { ...board, intents: board.intents.map(card => ({ ...card, updatedAt: card.updatedAt + 1000 })) } } })
  await vi.waitFor(() => expect(saved['inbox']).toEqual([expect.objectContaining({ read: false, at: board.intents[0]!.updatedAt + 1000 })]))
  expect(store.getSnapshot().inbox).toHaveLength(1)
})

it('retains a saved read wait while Team and Run facts hydrate in separate patches', async () => {
  const { store, push, execution, board, saved } = setup()
  push({ method: 'flow/execution-changed', params: { execution } })
  store.markInboxRead(null)
  const read = store.getSnapshot().inbox.map(row => ({ ...row, read: true }))
  saved['inbox'] = read
  Object.assign(store.getSnapshot(), { inbox: [], teams: new Map(), goals: new Map(), flowExecutions: new Map(), preferencesLoaded: false })
  await store.loadPreferences()
  expect(store.getSnapshot().inbox).toEqual(read)
  push({ method: 'team/changed', params: { state: board } })
  expect(store.getSnapshot().inbox).toEqual(read)
  const fixture = waitingInboxFixture()
  await store.loadPreferences()
  push({ method: 'goal/changed', params: { view: fixture.snapshot.goals.get(board.id)! } })
  expect(store.getSnapshot().inbox).toEqual(read)
  push({ method: 'flow/execution-changed', params: { execution } })
  expect(store.getSnapshot().inbox).toEqual(read)
})

it.each(['fresh', 'read', 'ended', 'unavailable'] as const)('hydrates a %s wait on connection without opening the Team or receiving a Run push', async state => {
  const fixture = waitingInboxFixture()
  const { store, execution, board, request, push } = setup({}, fixture)
  push({ method: 'flow/execution-changed', params: { execution } })
  await Promise.resolve()
  const saved = state === 'fresh' ? [] : store.getSnapshot().inbox.map(row => ({ ...row, read: true }))
  Object.assign(store.getSnapshot(), { inbox: [], teams: new Map(), goals: new Map(), flowExecutions: new Map() })
  vi.spyOn(store.transport, 'connect').mockImplementation(() => {})
  vi.spyOn(store.transport, 'status', 'get').mockReturnValue('open')
  for (const method of ['loadHistory', 'refreshRuntime', 'loadWorkspaces', 'loadPlugins', 'loadAccounts', 'loadUsage'] as const) vi.spyOn(store, method).mockResolvedValue(undefined as never)
  request.mockImplementation((async (method: HostMethodName) => {
    if (method === 'host/hello') return { runtimes: [], home: '/fixture', stateDir: '/fixture' }
    if (method === 'app/state/get') return { inbox: saved }
    if (method === 'goal/list') return [{ ...fixture.snapshot.goals.get(board.id)!, board }]
    if (method === 'flow/executions') return state === 'ended' ? [] : [{ id: execution.id }]
    if (method === 'flow/execution') {
      if (state === 'unavailable') throw new Error('Run temporarily unavailable')
      return state === 'ended' ? { ...execution, state: 'stopped' } : execution
    }
    return null
  }) as never)
  await store.connect()
  expect(store.getSnapshot().inbox).toEqual(state === 'ended' ? [] : [expect.objectContaining({ title: board.name, body: 'Your pick is next', read: state !== 'fresh' })])
})
it.each(['answered', 'closed', 'stopped', 'settled'] as const)('clears the waiting pick when %s', state => {
  const { store, push, board, execution } = setup()
  push({ method: 'flow/execution-changed', params: { execution } })
  expect(store.getSnapshot().inbox).toHaveLength(1)
  if (state === 'answered') push({ method: 'team/changed', params: { state: { ...board, intents: board.intents.map(card => ({ ...card, state: 'done' })) } } })
  else push({ method: 'flow/execution-changed', params: { execution: state === 'closed' ? { ...execution, rounds: execution.rounds.map(round => ({ ...round, state: 'closed' })) } : { ...execution, state } } })
  expect(store.getSnapshot().inbox).toEqual([])
})

it.each(['permission', 'userInput'] as const)('keeps a Team %s request and clears it on the approval response event', type => {
  const { store, push, execution } = setup()
  const member = store.getSnapshot().goals.get('overview-team')!.members[0]!
  const key = sessionKey(member.session.runtime, member.session.sessionId)
  const approval = { id: approvalId('person-request'), sessionId: member.session.sessionId, requestedAt: 200, type, summary: 'Allow the check', options: [], questions: [] } as unknown as import('@harnessdesk/protocol').Approval
  const event = (value: import('@harnessdesk/protocol').AgentEvent) => (store.transport as unknown as { handlers: { onEvent(runtime: string, value: import('@harnessdesk/protocol').AgentEvent): void } }).handlers.onEvent(member.session.runtime, value)
  push({ method: 'flow/execution-changed', params: { execution } })
  event({ type: 'approval/requested', approval })
  expect(store.getSnapshot().inbox).toHaveLength(2)
  expect(store.getSnapshot().inbox.find(entry => entry.id.includes('person-request'))?.open).toBe('team:overview-team')
  event({ type: 'approval/resolved', sessionId: approval.sessionId, approvalId: approval.id, resolution: { outcome: 'decided', decision: { type: 'cancel' } } })
  expect(store.getSnapshot().inbox).toHaveLength(1)
  expect(store.getSnapshot().approvals.find(one => one.key === key)).toBeUndefined()
})

it('keeps distinct approvals from two Seats even when their request ids and times match, without a persistence loop', async () => {
  const { store, push, execution, request } = setup()
  push({ method: 'flow/execution-changed', params: { execution } })
  const members = store.getSnapshot().goals.get('overview-team')!.members
  const event = (runtime: string, value: import('@harnessdesk/protocol').AgentEvent) => (store.transport as unknown as { handlers: { onEvent(runtime: string, value: import('@harnessdesk/protocol').AgentEvent): void } }).handlers.onEvent(runtime, value)
  for (const member of members) event(member.session.runtime, { type: 'approval/requested', approval: {
    id: approvalId('same-request'), sessionId: member.session.sessionId, requestedAt: 200, type: 'permission', summary: 'Allow the check', options: [],
  } as unknown as import('@harnessdesk/protocol').Approval })
  expect(store.getSnapshot().inbox).toHaveLength(3)
  expect(new Set(store.getSnapshot().inbox.map(entry => entry.id)).size).toBe(3)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(request.mock.calls.filter(([method]) => method === 'app/state/set')).toHaveLength(3)
  expect(store.getSnapshot().notices).toEqual([])
})
