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

it.each(['Working', 'Needs you', 'Approval', 'Queued message', 'Question', 'Wrapping', 'Ready to wrap', 'Wrapped'])('names %s once while the chip and compact dot remain decorative', (label) => {
  act(() => root.render(
    <SidebarMenu><SidebarMenuItem trailingMarks={2}>
      <SidebarMenuButton label={<span>Checkout <SidebarMenuState label={label} tone="warning" state="limit" /></span>} />
    </SidebarMenuItem></SidebarMenu>,
  ))
  const state = container.querySelector('[data-slot="sidebar-menu-state"]')
  expect(state?.getAttribute('role')).toBe('img')
  expect(state?.getAttribute('aria-label')).toBe(label)
  expect(state?.getAttribute('title')).toBe(label)
  expect(state?.closest('[data-slot="sidebar-menu-label"]')).not.toBeNull()
  const full = state?.querySelector('[data-sidebar-menu-state-full]')
  const compact = state?.querySelector('[data-sidebar-menu-state-compact]')
  expect(full?.getAttribute('aria-hidden')).toBe('true')
  expect(compact?.getAttribute('aria-hidden')).toBe('true')
  expect(full?.querySelector('[data-slot="chip"]')?.textContent).toBe(label)
  expect(compact?.querySelector('[data-slot="dot"]')?.getAttribute('data-variant')).toBe('navigation')
})
