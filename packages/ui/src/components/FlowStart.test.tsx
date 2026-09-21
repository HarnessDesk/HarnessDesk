import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowDryRun } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { FlowStart } from './FlowStart'

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

const DRY: FlowDryRun = {
  flow: { inputs: [] } as unknown as FlowDryRun['flow'],
  problems: [],
  seats: [
    { role: 'fixer', index: 0, seat: 'Codex', runtime: 'codex', permission: 'read', turns: 1 },
    { role: 'lander', index: 0, seat: 'Codex', runtime: 'codex', permission: 'merge', turns: 1 },
  ],
  seatingTurns: 2,
  commands: [],
  trace: [],
  settled: true,
}

it('each seat in the dry run wears its role’s ceiling, on the ladder and asked', async () => {
  const store = {
    subscribe: () => () => {},
    listFlows: vi.fn().mockResolvedValue([{ path: '.harnessdesk/flows/fix.yml', name: 'Fix' }]),
    readFlow: vi.fn().mockResolvedValue('name: Fix\n'),
    dryRunFlow: vi.fn().mockResolvedValue(DRY),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FlowStart root="/repo" onChange={() => {}} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
  const select = container.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, '.harnessdesk/flows/fix.yml')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})

  const chips = [...container.querySelectorAll('[data-ceiling]')]
  expect(chips.map((one) => one.textContent)).toEqual(['Edit · asked', 'Merge · asked'])
  expect(chips.every((one) => one.querySelector('[data-tone]')?.getAttribute('data-tone') === 'warning')).toBe(true)
  expect(container.textContent).toContain('asked their ceilings, not held to them')
  expect(container.textContent).toContain('its read lets a seat edit and commit, so it reads as Edit')
  expect(container.querySelector('[data-permission]')).toBeNull()
})
