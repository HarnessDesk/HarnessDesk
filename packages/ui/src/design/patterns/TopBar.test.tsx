import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TopBar, type TopBarProps } from './TopBar'
import { Dot } from './Settings'
import { MenuItem } from './Menu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (props: Partial<TopBarProps> = {}) => act(() => root.render(<TopBar place="Checkout retry" more={() => null} {...props} />))

test('the shared top bar has no bottom hairline', () => {
  render()
  expect(host.querySelector('header')?.hasAttribute('data-rule')).toBe(false)
  expect(host.querySelector('header')?.classList.contains('border-b')).toBe(false)
})
test('an empty More menu has no trigger', () => {
  render()
  expect(host.querySelector('[data-topbar="more"] button')).toBeNull()
})
test('state precedes the intrinsic title and never folds away', () => {
  render({ state: <Dot title="Working" aria-label="Working" pulse /> })
  const place = host.querySelector('[data-topbar="place"]')!
  expect(place.firstElementChild?.getAttribute('data-topbar')).toBe('state')
  expect(place.lastElementChild?.hasAttribute('data-topbar-title')).toBe(true)
  expect(place.querySelector('[data-slot="dot"]')?.hasAttribute('data-pulse')).toBe(true)
  expect(host.querySelector('[data-slot="top-bar"]')?.getAttribute('data-fold')).toBe('0')
})
test('the title menu runs subject verbs and closes', async () => {
  const rename = vi.fn()
  render({ placeTitle: 'The whole brief', placeMenu: close => <MenuItem icon={<span />} label="Rename" onSelect={() => { rename(); close() }} /> })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar-title] button')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
  expect(rename).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(host.querySelector('[data-topbar-title]')?.getAttribute('title')).toBe('The whole brief')
})
test('changed More rows remain live without replacing the title', async () => {
  render({ more: close => <MenuItem icon={<span />} label="Original" onSelect={close} /> })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  render({ more: close => <MenuItem icon={<span />} label="Current" onSelect={close} /> })
  expect(document.querySelector('[role="menu"]')?.textContent).toBe('Current')
  expect(host.querySelector('[data-topbar-title]')?.textContent).toBe('Checkout retry')
})
test('disabled compatibility actions preserve their refusal in More', async () => {
  const run = vi.fn()
  render({ verb: { label: 'Start a Team', disabled: 'Choose a project first', run } })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(row.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a project first')
  await act(async () => row.click())
  expect(run).not.toHaveBeenCalled()
})
test('the same fixed slots survive publications without tabs, views or worded verbs', () => {
  for (const place of ['Short', 'A long conversation title that must truncate within the design measure']) {
    render({ place, tabs: [{ value: 'board', label: 'Board', count: 7, run: () => {} }], tab: 'board',
      view: { content: () => null }, verb: { label: 'New job', run: () => {} }, tools: <button aria-label="Changes" /> })
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(host.querySelector('[data-topbar="view"] button, [data-topbar="verb"] button')).toBeNull()
    expect([...host.querySelector('[data-slot="top-bar"]')!.children].map(node => node.getAttribute('data-topbar'))).toEqual(['lead', 'place', 'spacer', 'tools'])
    expect(host.querySelector('[data-topbar="tools"] button')?.getAttribute('aria-label')).toBe('Changes')
  }
})

test('protects the measured long-title floor by moving crowded controls to More, then restores them when widened', async () => {
  let width = 302
  const bounds = HTMLElement.prototype.getBoundingClientRect
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-slot="top-bar"]')) return new DOMRect(0, 0, width, 40)
    if (this.matches('[data-topbar-title]')) return new DOMRect(0, 0, this.style.position === 'fixed' ? 420 : 180, 28)
    if (this.matches('[data-topbar-full-lead]')) return new DOMRect(0, 0, 84, 28)
    if (this.matches('[data-topbar-full-tools]')) return new DOMRect(0, 0, 160, 28)
    if (this.matches('[data-topbar="more"]')) return new DOMRect(0, 0, 28, 28)
    return bounds.call(this)
  })
  const terminal = vi.fn()
  try {
    render({ place: 'A long comparison title that keeps its measured floor', lead: <button>Wide navigation</button>, tools: <button>Terminal door</button>,
      compact: { lead: <button>Sidebar</button>, more: close => <MenuItem icon={<span />} label="Terminal" onSelect={() => { terminal(); close() }} /> } })
    const row = host.querySelector<HTMLElement>('[data-slot="top-bar"]')!
    expect(row.getAttribute('data-fold')).toBe('1')
    expect(row.style.getPropertyValue('--topbar-title-floor')).toBe('180px')
    expect(host.querySelector('[data-topbar-full-tools]')?.hasAttribute('hidden')).toBe(true)
    expect(host.querySelector('[data-topbar-full-lead]')?.hasAttribute('hidden')).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Terminal')!.click())
    expect(terminal).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    width = 900
    act(() => window.dispatchEvent(new Event('resize')))
    expect(row.getAttribute('data-fold')).toBe('0')
    expect(host.querySelector('[data-topbar-full-tools]')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('[data-topbar-full-lead]')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('[data-topbar-compact-lead]')?.hasAttribute('hidden')).toBe(true)
  } finally { measure.mockRestore() }
})

for (const afterWidth of [302, 0]) test(`restores the full controls when compact support is removed at width ${afterWidth}`, () => {
  let width = 302
  const bounds = HTMLElement.prototype.getBoundingClientRect
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-slot="top-bar"]')) return new DOMRect(0, 0, width, 40)
    if (this.matches('[data-topbar-title]')) return new DOMRect(0, 0, 420, 28)
    if (this.matches('[data-topbar-full-lead]')) return new DOMRect(0, 0, 84, 28)
    if (this.matches('[data-topbar-full-tools]')) return new DOMRect(0, 0, 160, 28)
    return bounds.call(this)
  })
  try {
    const tools = <button>Terminal door</button>
    render({ tools, compact: { lead: <button>Sidebar</button>, more: close => <MenuItem label="Terminal" onSelect={close} /> } })
    const row = host.querySelector('[data-slot="top-bar"]')!
    expect(row.getAttribute('data-fold')).toBe('1')
    expect(host.querySelector('[data-topbar-full-tools]')?.hasAttribute('hidden')).toBe(true)
    width = afterWidth
    render({ tools })
    expect(row.getAttribute('data-fold')).toBe('0')
    expect(host.querySelector('[data-topbar-full-tools]')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('[data-topbar-compact-lead]')).toBeNull()
    expect(host.querySelector('[data-topbar="more"] button')).toBeNull()
  } finally { measure.mockRestore() }
})

test('equivalent parent renders keep one measurement subscription without cloning the controls again', () => {
  const disconnect = vi.fn(), observe = vi.fn(), unobserve = vi.fn()
  const observer = vi.fn(function () { return { observe, unobserve, disconnect } })
  vi.stubGlobal('ResizeObserver', observer)
  const bounds = HTMLElement.prototype.getBoundingClientRect
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-slot="top-bar"]')) return new DOMRect(0, 0, 900, 40)
    if (this.matches('[data-topbar-title]')) return new DOMRect(0, 0, 180, 28)
    if (this.matches('[data-topbar-full-lead], [data-topbar-full-tools]')) return new DOMRect(0, 0, 84, 28)
    return bounds.call(this)
  })
  const clone = vi.spyOn(Node.prototype, 'cloneNode')
  const fresh = () => ({ lead: <button>Navigation</button>, tools: <button>Terminal</button>,
    state: <Dot title="Working" />, compact: { lead: <button>Sidebar</button>, more: (close: () => void) => <MenuItem label="Terminal" onSelect={close} /> } })
  try {
    render(fresh())
    const clones = clone.mock.calls.length
    const observations = observe.mock.calls.length
    expect(clones).toBeGreaterThan(0)
    render(fresh())
    expect(observer).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalledTimes(observations)
    expect(clone).toHaveBeenCalledTimes(clones)
  } finally { clone.mockRestore(); geometry.mockRestore(); vi.unstubAllGlobals() }
})

test('content changes remeasure the title and hidden full controls without replacing the observer', () => {
  const disconnect = vi.fn(), observe = vi.fn(), unobserve = vi.fn()
  const observer = vi.fn(function () { return { observe, unobserve, disconnect } })
  vi.stubGlobal('ResizeObserver', observer)
  const bounds = HTMLElement.prototype.getBoundingClientRect
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-slot="top-bar"]')) return new DOMRect(0, 0, 320, 40)
    if (this.matches('[data-topbar-title]')) return new DOMRect(0, 0, this.textContent === 'Short' ? 40 : 420, 28)
    if (this.matches('[data-topbar-full-lead]')) return new DOMRect(0, 0, 84, 28)
    if (this.matches('[data-topbar-full-tools]')) return new DOMRect(0, 0, this.textContent === 'Terminal' ? 84 : 180, 28)
    return bounds.call(this)
  })
  const compact = { lead: <button>Sidebar</button>, more: (close: () => void) => <MenuItem label="Terminal" onSelect={close} /> }
  try {
    render({ place: 'Short', lead: <button>Navigation</button>, tools: <button>Terminal</button>, compact })
    const row = host.querySelector<HTMLElement>('[data-slot="top-bar"]')!
    expect(row.getAttribute('data-fold')).toBe('0')
    expect(row.style.getPropertyValue('--topbar-title-floor')).toBe('40px')
    render({ place: 'A long comparison title', lead: <button>Navigation</button>, tools: <button>Terminal</button>, compact })
    expect(row.getAttribute('data-fold')).toBe('1')
    expect(row.style.getPropertyValue('--topbar-title-floor')).toBe('180px')
    render({ place: 'Short', lead: <button>Navigation</button>, tools: <button>Terminal and Browser</button>, compact })
    expect(row.style.getPropertyValue('--topbar-title-floor')).toBe('40px')
    expect(row.getAttribute('data-fold')).toBe('1')
    render({ place: 'Short', lead: <button>Navigation</button>, tools: <button>Terminal</button>, compact })
    expect(row.getAttribute('data-fold')).toBe('0')
    expect(observer).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
  } finally { geometry.mockRestore(); vi.unstubAllGlobals() }
})
