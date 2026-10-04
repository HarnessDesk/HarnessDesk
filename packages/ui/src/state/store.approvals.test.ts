import { expect, it, vi } from 'vitest'
import { approvalId, runtimeId, sessionId, sessionKey, type AgentEvent } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

it('returns the transport refusal after restoring the pending approval', async () => {
  const store = new AppStore('ws://localhost:0/')
  const key = sessionKey('acp', 'session-1')
  const approval = {
    id: approvalId('approval-1'), sessionId: sessionId('session-1'), requestedAt: 1,
    type: 'command' as const, command: 'pnpm verify', cwd: '/work', actions: [],
    options: [{ id: 'yes', label: 'Allow', intent: 'approve' as const }, { id: 'no', label: 'Deny', intent: 'deny' as const }],
  }
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onEvent(runtimeId('acp'), { type: 'approval/requested', approval } as AgentEvent)
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('The approval was already answered.'))

  const result = await store.respondToApproval(key, approval.id, { type: 'option', optionId: 'yes' })

  expect(result).toEqual({ ok: false, message: 'The approval was already answered.' })
  expect(store.getSnapshot().approvals).toEqual([{ key, approval }])
})
