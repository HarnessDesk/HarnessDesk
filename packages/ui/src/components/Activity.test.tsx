import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore, type AuditRow } from '../state/store'
import { Activity } from './Activity'

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

const DAY = 86_400_000
const noon = new Date(2026, 8, 25, 12).getTime()
const ROWS: readonly AuditRow[] = [
  { at: noon, runtime: 'codex', sessionId: 's1', kind: 'turn/completed' },
  { at: noon - DAY, runtime: 'codex', sessionId: 's2', kind: 'turn/completed' },
]

it('heads each day of the log with the inspector’s one group line', async () => {
  const snapshot = emptySnapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAudit: async () => ROWS,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <Activity query="" onFoot={() => {}} />
      </StoreProvider>,
    )
  })

  const days = [...container.querySelectorAll('[data-slot="inspector-group"]')]
  expect(days).toHaveLength(2)
  // The day is the group line's own label: the muted role, in the secondary ink.
  const label = days[0]?.querySelector('[data-slot="text"]')
  expect(label?.getAttribute('data-role')).toBe('muted')
  expect(label?.getAttribute('data-ink')).toBe('secondary')
  expect(label?.textContent).toContain('25')
})

const mountWith = async (runtimes: unknown[]): Promise<void> => {
  const snapshot = { ...emptySnapshot(), runtimes } as unknown as ReturnType<typeof emptySnapshot>
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAudit: async () => ROWS.slice(0, 1),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <Activity query="" onFoot={() => {}} />
      </StoreProvider>,
    )
  })
}

it('draws the agent that acted as a face, which follows the shape chosen for faces', async () => {
  await mountWith([{ id: 'codex', presentation: { name: 'Agent runtime' }, capabilities: {} }])
  const tile = container.querySelector('[data-slot="icon-tile"]')
  expect(tile?.className).toContain('rounded-(--hd-face-radius)')
})

it('keeps the event glyph a plain square when the agent cannot be named, so it is never taken for someone', async () => {
  await mountWith([])
  const tile = container.querySelector('[data-slot="icon-tile"]')
  expect(tile).not.toBeNull()
  expect(tile?.className).not.toContain('rounded-(--hd-face-radius)')
  expect(tile?.className).toContain('rounded-(--hd-radius-sm)')
})
