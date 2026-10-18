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

it.each(['Working', 'Needs you', 'Approval', 'Queued message', 'Question', 'Wrapping', 'Wrapped'])('names %s once while the chip and compact dot remain decorative', (label) => {
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
  expect(full?.querySelector('[data-slot="chip"]')?.getAttribute('data-variant')).toBe('quiet')
  expect(compact?.querySelector('[data-slot="dot"]')?.getAttribute('data-variant')).toBe('navigation')
})


it('compact priority state has one named dot and no hidden chip', () => {
  act(() => root.render(<SidebarMenuState label="Needs you" title="Needs you · 1 held message" tone="warning" state="limit" compact />))
  const state = container.querySelector('[data-slot="sidebar-menu-state"]')!
  expect(state.getAttribute('aria-label')).toBe('Needs you')
  expect(state.getAttribute('title')).toBe('Needs you · 1 held message')
  expect(state.querySelectorAll('[data-slot="dot"]')).toHaveLength(1)
  expect(state.querySelector('[data-slot="dot"]')?.getAttribute('data-variant')).toBe('navigation')
  expect(state.querySelector('[data-slot="chip"]')).toBeNull()
  expect(state.querySelector('[data-sidebar-menu-state-full]')).toBeNull()
})


it('unseen news has a named compact blue state', () => {
  act(() => root.render(<SidebarMenuState label="New" tone="info" state="new" compact />))
  const state = container.querySelector('[data-slot="sidebar-menu-state"]')!
  expect(state.getAttribute('aria-label')).toBe('New')
  expect(state.querySelector('[data-slot="dot"]')?.getAttribute('data-state')).toBe('new')
  expect(state.querySelector('[data-slot="chip"]')).toBeNull()
})
