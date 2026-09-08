import { describe, expect, test } from 'vitest'

import { sessionKey, type Session } from '@harnessdesk/protocol'

import { paneStatus } from './pane-status'

const KEY = sessionKey('r', 's')

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's',
    runtime: 'r',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
    ...overrides,
  }) as Session

describe('paneStatus', () => {
  test('a pending approval outranks everything — it is the one state that needs a person', () => {
    const running = session({ status: { type: 'active' }, turns: [{ id: 't', items: [], status: 'inProgress' }] as never })
    expect(paneStatus(running, [{ key: KEY, approval: { id: 'a' } as never }], KEY)).toBe('waiting')
  })

  test('an approval for another conversation does not count', () => {
    const other = sessionKey('r', 'other')
    expect(paneStatus(session(), [{ key: other, approval: { id: 'a' } as never }], KEY)).toBe('idle')
  })

  test('an in-progress turn is running', () => {
    expect(paneStatus(session({ turns: [{ id: 't', items: [], status: 'inProgress' }] as never }), [], KEY)).toBe('running')
  })

  test('a failed last turn stays failed even once the session is idle', () => {
    expect(paneStatus(session({ turns: [{ id: 't', items: [], status: 'failed' }] as never }), [], KEY)).toBe('failed')
  })

  test('an empty pane is idle', () => {
    expect(paneStatus(null, [], null)).toBe('idle')
  })
})
