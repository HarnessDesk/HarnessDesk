import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type Session, type SessionSummary } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * A conversation open in this window is named by what the person asked, in the
 * palette as in the sidebar, before the host's history list has a preview for it.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const show = async (summaryFields: Partial<SessionSummary>, liveFields: Record<string, unknown>): Promise<string> => {
  const summary = { id: 's1', runtime: 'codex', title: null, preview: null, cwd: '/w/game', updatedAt: 1, ...summaryFields } as unknown as SessionSummary
  const live = { title: undefined, preview: undefined, turns: [], ...liveFields } as unknown as Session
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [],
    history: [summary],
    sessions: new Map([[sessionKey('codex', 's1'), live]]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: async () => {},
    transport: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
    openSession: vi.fn(async () => {}),
  } as unknown as AppStore
  const host = { close: () => {}, chooseFolder: () => {}, openSettings: () => {}, openUsage: () => {}, openAgents: () => {}, openFrontDoor: () => {} }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return document.body.textContent ?? ''
}

const ask = { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Build a small arcade game' }] }] }

it('names an open, untitled conversation by its first ask', async () => {
  const text = await show({}, { turns: [ask] })
  expect(text).toContain('Build a small arcade game')
  expect(text).not.toContain('Untitled session')
})

it('keeps the history title when the open session has not been titled', async () => {
  const text = await show({ title: 'Release checklist' }, { turns: [ask] })
  expect(text).toContain('Release checklist')
})

it('keeps the history preview when the open session has nothing to say yet', async () => {
  const text = await show({ preview: 'Fix the flaky test' }, { turns: [] })
  expect(text).toContain('Fix the flaky test')
  expect(text).not.toContain('Untitled session')
})
