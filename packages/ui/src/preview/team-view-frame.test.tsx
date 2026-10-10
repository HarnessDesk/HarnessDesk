import { installTopBarTestLayout } from '../test/top-bar-layout'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { GoalFindings } from '../components/GoalFindings'
import { StoreProvider } from '../state/context'
import { previewStore, PREVIEW_ROOM } from './harness'
import { PREVIEW_GOAL } from './goal-fixture'
import { TeamViewFrame } from './TeamViewFrame'

installTopBarTestLayout()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('scopes standalone Board and Findings controls independently without changing their synthetic workbench', async () => {
  const store = previewStore()
  const before = store.getSnapshot().workbench
  await act(async () => root.render(<StoreProvider store={store}>
    <section data-testid="board"><TeamViewFrame room={PREVIEW_ROOM} page="board"><TeamBoardPane room={PREVIEW_ROOM} /></TeamViewFrame></section>
    <section data-testid="findings"><TeamViewFrame room={PREVIEW_GOAL.goal.id} page="findings"><GoalFindings goal={PREVIEW_GOAL.goal.id} /></TeamViewFrame></section>
  </StoreProvider>))
  const board = container.querySelector('[data-testid="board"]')!
  const findings = container.querySelector('[data-testid="findings"]')!
  expect(board.querySelector('[data-topbar="verb"] button')?.getAttribute('aria-label')).toBe('New job')
  expect(findings.querySelector('[data-topbar="verb"] button')?.getAttribute('aria-label')).toBe('Decide this run')
  expect(container.querySelector('[data-slot="view-bar"]')).toBeNull()
  await act(async () => board.querySelector<HTMLButtonElement>('[data-topbar="view"] button')!.click())
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  const list = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'List')!
  await act(async () => list.click())
  expect(board.querySelector('table[aria-label="Jobs"]')).not.toBeNull()
  expect(findings.querySelector('[aria-label="Findings summary"]')).not.toBeNull()
  expect(store.getSnapshot().workbench).toBe(before)
  expect(store.getSnapshot().workbench.frameTools).toBe(before.frameTools)
})
