import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Hiding a model is a preference of this desk, kept by the host so it holds
 * across windows and launches. It changes what the picker offers and nothing
 * the agent is told.
 */
let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async () => null) as never)
})

describe('hiding a model', () => {
  const cursor = runtimeId('cursor')
  const written = () =>
    vi
      .mocked(store.transport.request)
      .mock.calls.filter(([method]) => method === 'app/state/set')
      .map(([, params]) => params)

  it('takes it out of the picker and writes the preference through the host', () => {
    store.setModelHidden(cursor, 'claude-opus-5', true)
    expect(store.getSnapshot().hiddenModels[cursor]).toEqual(['claude-opus-5'])
    expect(written().at(-1)).toEqual({ patch: { hiddenModels: { cursor: ['claude-opus-5'] } } })

    // Hiding what is hidden is not a change, and is not written again.
    store.setModelHidden(cursor, 'claude-opus-5', true)
    expect(written()).toHaveLength(1)

    store.setModelHidden(cursor, 'claude-opus-5', false)
    expect(store.getSnapshot().hiddenModels[cursor]).toEqual([])
    expect(written().at(-1)).toEqual({ patch: { hiddenModels: { cursor: [] } } })
  })

  it('keeps one agent’s list apart from another’s', () => {
    store.setModelHidden(cursor, 'gpt-5.6-sol', true)
    store.setModelHidden(runtimeId('claude-code'), 'haiku', true)
    expect(store.getSnapshot().hiddenModels).toEqual({ cursor: ['gpt-5.6-sol'], 'claude-code': ['haiku'] })
  })
})
