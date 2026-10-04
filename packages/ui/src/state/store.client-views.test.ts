import { expect, it } from 'vitest'
import type { WireNotification } from '@harnessdesk/protocol'
import { AppStore } from './store'

it('keeps host activity by Team and conversation, replaces it, and drops removed Teams', () => {
  const store = new AppStore('ws://localhost:0/')
  const emit = (notification: WireNotification) => (store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }).handlers.onNotification(notification)
  const activity = { goal: 'team', seat: 'agent:alpha', role: 'writer', card: 1, state: 'working' as const,
    doing: { kind: 'tool' as const, tool: 'Read', target: 'src/demo.ts' }, since: 100 }
  emit({ method: 'seat/activity', params: activity })
  expect([...store.getSnapshot().seatActivities.values()]).toEqual([activity])
  emit({ method: 'seat/activity', params: { ...activity, state: 'idle', doing: null } })
  emit({ method: 'seat/activity', params: { ...activity, goal: 'other' } })
  emit({ method: 'team/removed', params: { room: 'team' } })
  expect([...store.getSnapshot().seatActivities.values()]).toEqual([{ ...activity, goal: 'other' }])
})
