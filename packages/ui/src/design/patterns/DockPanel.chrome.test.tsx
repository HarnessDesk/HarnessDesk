import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  DockDropEdge,
  DockDropTarget,
  PaneSurface,
  WorkbenchCanvas,
  WorkbenchRail,
  WorkbenchScrim,
} from './DockPanel'

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

it('owns the workbench plates, dim and pane ground', () => {
  act(() => root.render(
    <WorkbenchCanvas>
      <WorkbenchRail data-floating />
      <PaneSurface />
      <WorkbenchScrim data-open />
    </WorkbenchCanvas>,
  ))

  expect(container.querySelector('[data-slot="workbench-canvas"]')?.className).toContain('bg-(--hd-background)')
  expect(container.querySelector('[data-slot="workbench-rail"]')?.className).toContain('bg-(--hd-sidebar-plate)')
  expect(container.querySelector('[data-slot="workbench-rail"]')?.className).toContain('data-[floating]:shadow-(--hd-shadow-lg)')
  expect(container.querySelector('[data-slot="pane-surface"]')?.className).toContain('bg-(--hd-background)')
  expect(container.querySelector('[data-slot="workbench-scrim"]')?.className).toContain('bg-(--hd-scrim)')
})

it('owns empty-edge drop geometry and the active target label', () => {
  act(() => root.render(
    <DockDropEdge area="bottom">
      <DockDropTarget active label="Dock in Bottom" />
    </DockDropEdge>,
  ))

  const edge = container.querySelector<HTMLElement>('[data-slot="dock-drop-edge"]')
  const target = container.querySelector<HTMLElement>('[data-slot="dock-drop-target"]')
  expect(edge?.dataset['area']).toBe('bottom')
  expect(edge?.className).toContain('data-[area=bottom]:h-30')
  expect(target?.hasAttribute('data-over')).toBe(true)
  expect(target?.className).toContain('data-[over]:border-(--hd-accent)')
  expect(target?.querySelector('[data-slot="dock-drop-label"]')?.textContent).toBe('Dock in Bottom')
})
