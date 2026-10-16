import { expect, it, vi } from 'vitest'
import { approvalId, sessionKey, type WireNotification } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { waitingInboxFixture } from '../preview/notices-d3-fixture'

const setup = () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  const { snapshot, board, execution } = waitingInboxFixture()
  Object.assign(store.getSnapshot(), snapshot, { inbox: [] })
  const push = (notification: WireNotification) => (store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }).handlers.onNotification(notification)
  return { store, push, board, execution }
}
it('keeps a waiting pick once with the Team and step, and preserves a read across repeated pushes', () => {
  const { store, push, execution } = setup()
  const changed = { method: 'flow/execution-changed', params: { execution } } as const
  push(changed)
  expect(store.getSnapshot().inbox).toEqual([expect.objectContaining({ title: 'Retry the checkout call', body: 'Your pick is next', open: 'team:overview-team', read: false })])
  const id = store.getSnapshot().inbox[0]!.id
  store.markInboxRead(id)
  push(changed)
  expect(store.getSnapshot().inbox).toHaveLength(1)
  expect(store.getSnapshot().inbox[0]?.read).toBe(true)
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

it('keeps distinct approvals from two Seats even when their request ids match', () => {
  const { store, push, execution } = setup()
  push({ method: 'flow/execution-changed', params: { execution } })
  const members = store.getSnapshot().goals.get('overview-team')!.members
  const event = (runtime: string, value: import('@harnessdesk/protocol').AgentEvent) => (store.transport as unknown as { handlers: { onEvent(runtime: string, value: import('@harnessdesk/protocol').AgentEvent): void } }).handlers.onEvent(runtime, value)
  for (const member of members) event(member.session.runtime, { type: 'approval/requested', approval: {
    id: approvalId('same-request'), sessionId: member.session.sessionId, requestedAt: 200, type: 'permission', summary: 'Allow the check', options: [],
  } as unknown as import('@harnessdesk/protocol').Approval })
  expect(store.getSnapshot().inbox).toHaveLength(3)
  expect(new Set(store.getSnapshot().inbox.map(entry => entry.id)).size).toBe(3)
})
