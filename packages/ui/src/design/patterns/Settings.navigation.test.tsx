import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { NavigationGroupHeader, Text } from './Settings'
import css from './Settings.module.css?raw'

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

it('owns the navigation group label box and yields its label while filtering', () => {
  act(() => root.render(
    <NavigationGroupHeader label="Workspaces" filtering>
      <button type="button">Filter</button>
    </NavigationGroupHeader>,
  ))

  const header = container.querySelector<HTMLElement>('[data-slot="navigation-group-header"]')
  expect(header?.dataset['filtering']).toBe('')
  expect(header?.querySelector('[data-slot="navigation-group-label"]')?.textContent).toBe('Workspaces')
  expect(css).toMatch(/\.navigationGroupHeader\s*\{[^}]*padding:\s*var\(--hd-label-space, var\(--hd-space-1-5\)\) var\(--hd-bar-pad\) var\(--hd-space-1\) var\(--hd-bar-ink\)/s)
  expect(css).toMatch(/\.navigationGroupHeader\[data-filtering\] \.navigationGroupLabel\s*\{[^}]*display:\s*none/s)
})

it('gives navigation metadata the rail ink without changing its role', () => {
  act(() => root.render(<Text role="meta" ink="navigation">12</Text>))
  const meta = container.querySelector('[data-slot="text"]')
  expect(meta?.getAttribute('data-role')).toBe('meta')
  expect(meta?.getAttribute('data-ink')).toBe('navigation')
  expect(meta?.className).toContain('text-(--hd-sidebar-muted-foreground)')
})
