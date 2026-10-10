import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Menu, MenuAccountGroup, MenuAccountRow, MenuItem, MenuLabel } from './Menu'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
it('profile and account keep the same row while exposing the account identity', () => {
  act(() => root.render(<Menu close={() => {}}><MenuItem label="Jane Doe" onSelect={() => {}} /><MenuLabel>Run new sessions as</MenuLabel><MenuAccountRow name="Scout" identity="Workspace account" onSelect={() => {}} /></Menu>))
  const rows = [...document.querySelectorAll('[role="menuitem"]')]
  expect(rows.map(row => row.querySelector('[data-menu-label]')?.textContent)).toEqual(['Jane Doe', 'Scout'])
  expect(rows.every(row => row.hasAttribute('data-menu-row'))).toBe(true)
  expect(document.querySelector('[data-identity]')?.getAttribute('title')).toBe('Workspace account')
})
it('a heading names its group without introducing a choice or another icon gutter', () => {
  act(() => root.render(<Menu close={() => {}}><MenuAccountGroup label="Agent" mark={<span data-mark />}><MenuAccountRow name="One" onSelect={() => {}} /><MenuAccountRow name="Two" onSelect={() => {}} /></MenuAccountGroup></Menu>))
  const group = document.querySelector('[role="group"]')!
  expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Agent')
  expect(group.querySelector('[data-mark]')).toBeNull()
  expect([...group.querySelectorAll('[role="menuitem"]')].map(row => row.textContent)).toEqual(['One', 'Two'])
})
it('removing a heading keeps its account row under the same parent', () => {
  const draw = (heading: boolean) => <Menu close={() => {}}><MenuAccountGroup label="Agent" mark={null} heading={heading}><MenuAccountRow name="One" onSelect={() => {}} /></MenuAccountGroup></Menu>
  act(() => root.render(draw(true)))
  const item = document.querySelector('[role="menuitem"]')!, parent = item.parentElement
  act(() => root.render(draw(false)))
  expect(document.querySelector('[role="group"]')).toBeNull()
  expect(document.querySelector('[role="menuitem"]')).toBe(item)
  expect(item.parentElement).toBe(parent)
})
it('keeps an embedded menu in flow', () => {
  act(() => root.render(<Menu close={() => {}}><MenuItem label="Profile" onSelect={() => {}} /></Menu>))
  const positioner = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-positioner"]')!
  expect(positioner.style.position).toBe('static')
  expect(positioner.style.inset).toBe('auto')
  expect(positioner.style.transform).toBe('none')
})
