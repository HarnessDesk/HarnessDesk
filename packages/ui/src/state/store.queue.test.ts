import { beforeEach, describe, expect, it } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type AgentEvent,
  type SessionQueue,
} from '@harnessdesk/protocol'

import type { TransportEvents } from '../lib/transport'
import { AppStore } from './store'

/**
 * The renderer's copy of the queue.
 *
 * It is a projection and nothing more: the host sends the whole list every
 * time, so the store replaces rather than patches, and a conversation with
 * nothing waiting has no entry at all — which is what lets every reader ask
 * `queues.get(key)` and treat "nothing" as nothing.
 */

let store: AppStore
const RUNTIME = runtimeId('alpha')
const KEY = sessionKey(RUNTIME, 's1')

const queue = (...lines: string[]): SessionQueue => ({
  status: 'waiting',
  reason: null,
  messages: lines.map((line, index) => ({
    id: `q${index}`,
    input: [{ type: 'text' as const, text: line }],
    queuedAt: 0,
    state: 'queued' as const,
  })),
})

/** The socket's own callback, which is the only way an event enters the store. */
const feed = (event: AgentEvent): void => {
  const transport = store.transport as unknown as { handlers: TransportEvents }
  transport.handlers.onEvent(RUNTIME, event)
}

beforeEach(() => {
  // Never connected: the socket queues, and nothing here reaches the wire.
  store = new AppStore('ws://localhost:0/')
})

describe('the queue in the store', () => {
  it('starts with nothing, and takes the whole list the host sends', () => {
    expect(store.getSnapshot().queues.size).toBe(0)
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: queue('a', 'b') })
    expect(store.getSnapshot().queues.get(KEY)?.messages.map((message) => message.id)).toEqual(['q0', 'q1'])
  })

  it('replaces rather than merging, so a reorder is not two lists at once', () => {
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: queue('a', 'b') })
    const reordered: SessionQueue = { ...queue(), messages: [...queue('a', 'b').messages].reverse() }
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: reordered })
    expect(store.getSnapshot().queues.get(KEY)?.messages.map((message) => message.id)).toEqual(['q1', 'q0'])
  })

  it('drops the entry entirely once the queue has drained', () => {
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: queue('a') })
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: queue() })
    expect(store.getSnapshot().queues.has(KEY)).toBe(false)
  })

  it('keeps a pause and its reason, which is the whole point of the state', () => {
    feed({
      type: 'session/queue',
      sessionId: sessionId('s1'),
      queue: { ...queue('a'), status: 'paused', reason: 'The turn was stopped.' },
    })
    const stored = store.getSnapshot().queues.get(KEY)
    expect(stored?.status).toBe('paused')
    expect(stored?.reason).toBe('The turn was stopped.')
  })

  it('keeps one conversation’s queue out of another’s', () => {
    feed({ type: 'session/queue', sessionId: sessionId('s1'), queue: queue('mine') })
    feed({ type: 'session/queue', sessionId: sessionId('s2'), queue: queue('theirs') })
    expect(store.getSnapshot().queues.get(KEY)?.messages).toHaveLength(1)
    expect(store.getSnapshot().queues.get(sessionKey(RUNTIME, 's2'))?.messages).toHaveLength(1)
  })
})
