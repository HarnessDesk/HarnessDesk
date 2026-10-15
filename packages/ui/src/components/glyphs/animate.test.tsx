import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { BellIcon, BranchIcon, FetchIcon, SettingsIcon } from '../Icons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let lessMotion = false
const preference = new EventTarget()
Object.defineProperty(preference, 'matches', { get: () => lessMotion })
const reduceMotion = (value: boolean) => act(() => {
  lessMotion = value
  preference.dispatchEvent(new Event('change'))
})

beforeEach(() => {
  lessMotion = false
  vi.stubGlobal('matchMedia', () => preference)
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

it('draws the plain Lucide drawing, with nothing scheduled, until a pointer reaches the control', () => {
  vi.useFakeTimers()
  try {
    mount(<button type="button"><SettingsIcon /></button>)
    // A motion component asks for a frame as it mounts; an icon nobody hovers must not.
    expect(vi.getTimerCount()).toBe(0)
    expect(gear().getAttribute('class')).toBe('lucide lucide-settings')
  } finally {
    vi.useRealTimers()
  }
})

it('swaps to the animated drawing in place the first time the control is hovered', async () => {
  mount(<button type="button"><SettingsIcon size={20} /></button>)
  const before = gear()
  hover()
  await wait(50)
  expect(gear()).not.toBe(before)
  expect(gear().getAttribute('class')).toBe('lucide lucide-settings')
  expect(gear().getAttribute('width')).toBe('20')
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
  lessMotion = true
  mount(<button type="button"><SettingsIcon /></button>)
  hover()
  await wait(150)
  expect(turned()).toBe(false)
})

it('immediately rests an active glyph when the system changes to reduced motion', async () => {
  mount(<button type="button"><SettingsIcon /></button>)
  hover()
  await wait(100)
  expect(turned()).toBe(true)
  reduceMotion(true)
  await wait(40)
  expect(turned()).toBe(false)
  await wait(100)
  expect(turned()).toBe(false)
  reduceMotion(false)
  await wait(100)
  expect(turned()).toBe(true)
})

it('resets delayed path animations as well as the outer frame for reduced motion', async () => {
  mount(<button type="button"><BranchIcon /></button>)
  hover()
  await wait(150)
  reduceMotion(true)
  await wait(40)
  for (const path of gear().querySelectorAll('path, line, circle')) {
    expect(path.getAttribute('opacity')).toBe('1')
  }
  await wait(500)
  for (const path of gear().querySelectorAll('path, line, circle')) {
    expect(path.getAttribute('opacity')).toBe('1')
  }
})

it.each([
  <a href="#" aria-disabled="true"><SettingsIcon /></a>,
  <div role="tab" aria-disabled="true"><SettingsIcon /></div>,
  <div data-icon-host aria-disabled="true"><SettingsIcon /></div>,
  <button type="button" disabled data-icon-host><SettingsIcon /></button>,
  <fieldset disabled><button type="button" data-icon-host><SettingsIcon /></button></fieldset>,
])('does not wake disabled host %#, even inside another host', (control) => {
  mount(<div role="option">{control}</div>)
  const before = gear()
  hover()
  expect(gear()).toBe(before)
})

it('only wakes glyphs owned by the nearest host, including after the swap', async () => {
  mount(<div role="tab"><SettingsIcon /><button type="button"><BellIcon /></button></div>)
  const tab = container.querySelector('[role="tab"]')!
  const button = container.querySelector('button')!
  const bell = button.querySelector('svg')!
  act(() => { tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  await wait(50)
  expect(button.querySelector('svg')).toBe(bell)
  expect(turned()).toBe(true)
  act(() => { bell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(button.querySelector('svg')).not.toBe(bell)
})

it('does not restart animation when the pointer moves between children of one host', async () => {
  mount(<button type="button"><SettingsIcon /><span>Settings</span></button>)
  hover()
  await wait(50)
  const live = gear()
  act(() => { container.querySelector('span')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(gear()).toBe(live)
  await wait(50)
  expect(turned()).toBe(true)
})

it('moves the Fetch arrow on hover and returns it to its resting drawing on leave', async () => {
  mount(<button type="button"><FetchIcon /></button>)
  hover()
  await wait(150)
  const arrow = gear().querySelector('g')!
  expect(arrow.style.transform).toMatch(/translateY\((?!0px)/)
  act(() => { document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  await wait(400)
  expect(['none', 'translateY(0px)']).toContain(arrow.style.transform)
})

it.each([SettingsIcon, FetchIcon])('preserves absolute stroke width across the lazy swap (%#)', (Icon) => {
  mount(<button type="button"><Icon size={12} strokeWidth={3} absoluteStrokeWidth /></button>)
  expect(gear().getAttribute('stroke-width')).toBe('6')
  hover()
  expect(gear().getAttribute('stroke-width')).toBe('6')
})

it.each([SettingsIcon, FetchIcon])('preserves non-scaling strokes on every drawing element (%#)', (Icon) => {
  mount(<button type="button"><Icon nonScalingStroke /></button>)
  const check = () => {
    const paths = [...gear().querySelectorAll('path, circle')]
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every(path => path.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  }
  check()
  hover()
  check()
})
