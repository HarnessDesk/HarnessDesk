import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar'
import { SidebarMenuState } from './SidebarMenuState'

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

it('names the state once while the chip and compact dot remain decorative', () => {
  act(() => root.render(
    <SidebarMenu><SidebarMenuItem trailingMarks={2}>
      <SidebarMenuButton label={<span>Checkout <SidebarMenuState label="Needs you" tone="warning" state="limit" /></span>} />
    </SidebarMenuItem></SidebarMenu>,
  ))
  const state = container.querySelector('[data-slot="sidebar-menu-state"]')
  expect(state?.getAttribute('role')).toBe('img')
  expect(state?.getAttribute('aria-label')).toBe('Needs you')
  expect(state?.getAttribute('title')).toBe('Needs you')
  expect(state?.closest('[data-slot="sidebar-menu-label"]')).not.toBeNull()
  const full = state?.querySelector('[data-sidebar-menu-state-full]')
  const compact = state?.querySelector('[data-sidebar-menu-state-compact]')
  expect(full?.getAttribute('aria-hidden')).toBe('true')
  expect(compact?.getAttribute('aria-hidden')).toBe('true')
  expect(full?.querySelector('[data-slot="chip"]')?.textContent).toBe('Needs you')
  expect(compact?.querySelector('[data-slot="dot"]')?.getAttribute('data-variant')).toBe('navigation')
})
