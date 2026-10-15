import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { BellIcon, SettingsIcon } from '../Icons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  // Leaving the window is how a pointer that stopped on a control lets go of it.
  document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// The gear turns the whole drawing, so the turn shows on the element itself.
const gear = () => container.querySelector('svg') as SVGElement
const turned = () => /rotate\((?!0(deg)?\))/.test(gear().style.transform)
const mount = (node: ReactNode) => act(() => root.render(node))
const hover = () => act(() => { gear().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

it('draws in the frame Lucide would, so a screen cannot tell which drew it', () => {
  const markup = renderToStaticMarkup(<BellIcon size={14} />)
  expect(markup).toContain('class="lucide lucide-bell"')
  expect(markup).toContain('width="14"')
  expect(markup).toContain('viewBox="0 0 24 24"')
  expect(markup).toContain('stroke="currentColor"')
  expect(markup).toContain('aria-hidden="true"')
  expect(renderToStaticMarkup(<BellIcon aria-label="Alerts" />)).not.toContain('aria-hidden')
})

it('plays while the pointer is over the control that holds the glyph', async () => {
  mount(<button type="button"><SettingsIcon /></button>)
  expect(turned()).toBe(false)
  hover()
  await wait(150)
  expect(turned()).toBe(true)
})

it('stays still when nothing around it can be clicked', async () => {
  mount(<div><SettingsIcon /></div>)
  hover()
  await wait(150)
  expect(turned()).toBe(false)
})

it('stays still inside a control that is switched off', async () => {
  mount(<button type="button" disabled><SettingsIcon /></button>)
  hover()
  await wait(150)
  expect(turned()).toBe(false)
})

it('stays still for a person who asked the system for less motion', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
  mount(<button type="button"><SettingsIcon /></button>)
  hover()
  await wait(150)
  expect(turned()).toBe(false)
})
