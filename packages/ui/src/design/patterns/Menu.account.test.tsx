import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Menu, MenuGroup, MenuItem, MenuLabel } from './Menu'
import css from './Menu.module.css?raw'

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

it('offers the compact account-menu roles without changing ordinary rows', () => {
  act(() => {
    root.render(
      <Menu close={() => {}}>
        <MenuItem layout="profile" onSelect={() => {}}>Profile</MenuItem>
        <MenuLabel size="compact">Run new sessions as</MenuLabel>
        <MenuItem layout="account" onSelect={() => {}}>Account</MenuItem>
      </Menu>,
    )
  })

  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(rows.map((row) => row.dataset['layout'])).toEqual(['profile', 'account'])
  expect(document.querySelector<HTMLElement>('[data-size="compact"]')?.textContent).toBe('Run new sessions as')
  expect(css).toMatch(/\.row\[data-layout='profile'\]\s*\{[^}]*padding:\s*var\(--hd-space-2\)/s)
  expect(css).toMatch(/\.row\[data-layout='account'\]\s*\{[^}]*padding:\s*var\(--hd-space-1-5\) var\(--hd-space-2\)/s)
  expect(css).toMatch(/\.label\[data-size='compact'\]\s*\{[^}]*font-weight:\s*var\(--hd-weight-normal\)/s)
})

it('groups account rows under a heading that names them and is not a choice', () => {
  act(() => {
    root.render(
      <Menu close={() => {}}>
        <MenuGroup label="Agent" mark={<span data-mark />}>
          <MenuItem layout="account" onSelect={() => {}}>One</MenuItem>
          <MenuItem layout="account" onSelect={() => {}}>Two</MenuItem>
        </MenuGroup>
      </Menu>,
    )
  })

  const group = document.querySelector('[role="group"]')
  expect(group?.getAttribute('aria-label')).toBe('Agent')
  // The heading is hidden from the menu's items and from assistive tech; the group's name carries it.
  expect([...(group?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => row.textContent)).toEqual(['One', 'Two'])
  expect(group?.querySelector('[aria-hidden="true"] [data-mark]')).not.toBeNull()
  expect(css).toMatch(/\.group > \.row\[data-layout='account'\]\s*\{[^}]*margin-left:\s*var\(--hd-space-8\)/s)
})
