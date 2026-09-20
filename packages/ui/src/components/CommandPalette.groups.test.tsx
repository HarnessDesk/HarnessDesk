import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { SessionSummary } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * Group headers in the command palette must never be duplicated or interleaved (#386).
 *
 * When results from different groups (Actions, Sessions, Files, etc.) have interleaving
 * relevance scores, results must be grouped so each group header appears at most once
 * and entries within each group remain contiguous.
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

const mount = async (history: readonly SessionSummary[]): Promise<void> => {
  const request = vi.fn(async () => ({ data: [], nextCursor: null }))
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [],
    history,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: async () => {},
    transport: { request },
    openSession: vi.fn(async () => {}),
  } as unknown as AppStore
  const host = {
    close: () => {},
    chooseFolder: () => {},
    openSettings: () => {},
    openUsage: () => {},
    openAgents: () => {},
  }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('does not render duplicate or interleaved group headers when filtering (#386)', async () => {
  // Session 1: title starts with "settings" -> inLabel = 0 -> score 100
  // Action "Settings › Runtimes": label starts with "settings" -> score 100
  // Session 2: title "workspace tools", preview mentions "settings" -> inExtra >= 0 -> score 30
  // In a flat sort by score, Session 1 (100) and Actions (100) interleave with Session 2 (30),
  // causing "Sessions", then "Actions", then "Sessions" again.
  const history: SessionSummary[] = [
    {
      id: 'session-high',
      runtime: 'codex',
      title: 'settings setup',
      preview: 'configuring app',
      cwd: '/repo',
      status: { type: 'notLoaded' },
      createdAt: 1,
      updatedAt: 200,
    },
    {
      id: 'session-low',
      runtime: 'codex',
      title: 'workspace tools',
      preview: 'adjusting settings here',
      cwd: '/repo',
      status: { type: 'notLoaded' },
      createdAt: 2,
      updatedAt: 100,
    },
  ] as unknown as SessionSummary[]

  await mount(history)
  type('settings')

  const groupElements = [...container.querySelectorAll('[data-slot="group-label"]')]
  const headers = groupElements.map((el) => el.textContent?.trim() ?? '')

  // Headers must not have duplicates
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const h of headers) {
    if (seen.has(h)) duplicates.push(h)
    seen.add(h)
  }

  expect(duplicates, `expected no duplicate headers, found: ${JSON.stringify(headers)}`).toEqual([])
})
