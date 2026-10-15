import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlusIcon } from '../../components/Icons'
import { TopBar, type TopBarProps } from './TopBar'
import { Menu, MenuItem, MenuToggle } from './Menu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const noop = () => {}
const base: TopBarProps = {
  place: 'Checkout retry',
  state: <span>Ready</span>,
  tabs: [{ value: 'overview', label: 'Overview', run: noop }, { value: 'board', label: 'Board', run: noop }],
  tab: 'overview',
  verb: { label: 'New job', icon: <PlusIcon />, run: noop },
  more: () => null,
}
const view = { content: () => null }
let container: HTMLDivElement
let root: Root
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let availableTitle: number
let intrinsicTitle: number
let resizeCallbacks: (() => void)[]
let measuredStages: number[]

// jsdom has no flex layout. Hold the observed outer row at 720 while its
// rendered slots consume room: state + verb words cost 40, expanded tabs
// cost 100 more than the menu, View costs 28, and the two breadcrumbs differ.
const titleWidth = (row: Element): number => {
  const parent = row.querySelector('[data-topbar="place"] > button')?.textContent
  return availableTitle
    - (row.querySelector('[data-topbar="view"] button') ? 28 : 0)
    - (parent === 'Teams ›' ? 50 : parent ? 120 : 0)
    + (row.querySelector('[data-topbar="state"]') ? 0 : 20)
    + (row.querySelector('[data-topbar="verb"]')?.textContent?.includes('New job') ? 0 : 20)
    + (row.querySelector('[role="tablist"]') ? 0 : 100)
    - (row.querySelector('[data-topbar="verb"] button')?.textContent === 'Decide this run' ? 110 : 0)
}
beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  availableTitle = 200
  intrinsicTitle = 400
  measuredStages = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // No resize is delivered: only the intrinsic slot inputs change.
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(node: Element) { if (node.matches('[data-slot="top-bar"]')) resizeCallbacks.push(this.callback) }
    disconnect() {} unobserve() {}
  })
  const computedStyle = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const result = computedStyle(node, pseudo)
    if (node.matches('[data-slot="top-bar"]')) {
      const property = result.getPropertyValue.bind(result)
      vi.spyOn(result, 'getPropertyValue').mockImplementation(name => name === '--hd-bar-title-min' ? '180px' : property(name))
    }
    return result
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('[data-topbar-title]')) {
      const stage = Number(this.closest('[data-slot="top-bar"]')!.getAttribute('data-fold'))
      if (stage !== measuredStages.at(-1)) measuredStages.push(stage)
    }
    const width = this.matches('[data-topbar-title]') && (this as HTMLElement).style.flexShrink === '0' ? intrinsicTitle
      : this.matches('[data-topbar-title], [data-topbar="place"]') ? Math.min(intrinsicTitle, titleWidth(this.closest('[data-slot="top-bar"]')!))
      : this.matches('[data-slot="top-bar"]') ? 720 : 0
    return new DOMRect(0, 0, width, 40)
  })
  // A clipped flex child need not overflow its wrapper. scrollWidth then
  // reports the rounded allocated box, rather than the title's natural width.
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return Math.round(this.getBoundingClientRect().width)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = (changes: Partial<TopBarProps>): number[] => {
  measuredStages = []
  act(() => root.render(<StrictMode><TopBar {...base} {...changes} /></StrictMode>))
  const row = container.querySelector('[data-slot="top-bar"]')!
  const stages = [Number(row.getAttribute('data-fold'))]
  for (let pass = 0; frames.size && pass < 10; pass++) {
    const pending = [...frames.values()]
    frames.clear()
    act(() => { for (const callback of pending) callback(pass) })
    const stage = Number(row.getAttribute('data-fold'))
    if (stage !== stages.at(-1)) stages.push(stage)
  }
  expect(frames.size).toBe(0)
  expect(row.getBoundingClientRect().width).toBe(720)
  return measuredStages
}

test('the shared top bar has no bottom hairline', () => {
  render({})
  const header = container.querySelector('header')!
  expect(header.hasAttribute('data-rule')).toBe(false)
  expect(header.classList.contains('border-b')).toBe(false)
})
const expectFloor = (stage: number): void => {
  const row = container.querySelector('[data-slot="top-bar"]')!
  expect(Number(row.getAttribute('data-fold'))).toBe(stage)
  expect(container.querySelector('[data-topbar-title]')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(180)
  expect(container.querySelector('[data-topbar="state"]') === null).toBe(stage > 0)
  expect(container.querySelector('[data-topbar="verb"]')?.textContent).toBe(stage ? '' : 'New job')
  expect(container.querySelector('[role="tablist"]') === null).toBe(stage === 2)
}

test('adding and removing View remeasures the title at the same outer width', () => {
  expect(render({})).toEqual([0])
  expectFloor(0)
  expect(render({ view })).toEqual([0, 1])
  expectFloor(1)
  expect(render({})).toEqual([0])
  expectFloor(0)
})

test('breadcrumb insertion, label changes and removal use the same two fold stages', () => {
  expect(render({})).toEqual([0])
  expectFloor(0)
  expect(render({ parent: { label: 'Teams', run: noop } })).toEqual([0, 1])
  expectFloor(1)
  expect(render({ parent: { label: 'Engineering teams', run: noop } })).toEqual([0, 1, 2])
  expectFloor(2)
  expect(render({ parent: { label: 'Teams', run: noop } })).toEqual([0, 1])
  expectFloor(1)
  expect(render({})).toEqual([0])
  expectFloor(0)
})

test('a fractional title width below 180 uses the first fold to protect the full floor', () => {
  availableTitle = 179.75
  expect(render({})).toEqual([0, 1])
  expectFloor(1)
})

test('a standing tools column remeasures during a seam drag at the same outer width', () => {
  const observed = new Set<Element>()
  let resized = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(node: Element) {
      observed.add(node)
      if (node.matches('[data-slot="top-bar"]')) resized = this.callback
    }
    disconnect() {}
  })
  render({ tools: <button>Details</button>, rightColumnWidth: 460 })
  expectFloor(0)
  const tools = container.querySelector('[data-topbar="tools"]')!
  expect(observed.has(tools)).toBe(true)
  expect(observed.has(container.querySelector('[data-topbar-title]')!)).toBe(false)
  availableTitle = 160
  act(() => resized())
  for (let pass = 0; frames.size && pass < 10; pass++) {
    const pending = [...frames.values()]
    frames.clear()
    act(() => { for (const callback of pending) callback(pass) })
  }
  expectFloor(1)
  expect(container.querySelector('[data-slot="top-bar"]')!.getBoundingClientRect().width).toBe(720)
})


test('a refused destination stays reachable with its reason and refuses click and keyboard activation', () => {
  const run = vi.fn()
  render({ tabs: [{ value: 'overview', label: 'Overview', run: noop }, { value: 'run', label: 'Run', disabled: 'This Team has no Run yet', run }] })
  const tab = container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!
  expect(tab.disabled).toBe(false)
  expect(tab.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(tab.getAttribute('aria-describedby')!)?.textContent).toBe('This Team has no Run yet')
  expect(tab.className).not.toContain('aria-disabled:pointer-events-none')
  act(() => tab.focus())
  expect(document.activeElement).toBe(tab)
  act(() => {
    tab.click()
    for (const key of ['Enter', ' ']) tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  expect(run).not.toHaveBeenCalled()
  expect(tab.hasAttribute('data-active')).toBe(false)
})

test('a verb without an icon keeps its words through both folds and expanding restores focused tabs', () => {
  availableTitle = 180
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(container.querySelector('[data-slot="top-bar"]')?.getAttribute('data-fold')).toBe('2')
  expect(container.querySelector('[data-topbar="verb"]')?.textContent).toBe('Decide this run')
  availableTitle = 300
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  const tab = container.querySelector<HTMLButtonElement>('[data-team-page="overview"]')!
  act(() => tab.focus())
  availableTitle = 180
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(document.activeElement).toBe(container.querySelector('[data-topbar="tabs"] button'))
  availableTitle = 300
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(document.activeElement).toBe(container.querySelector('[data-team-page="overview"]'))
  expect(container.querySelector('[data-topbar="state"]')?.textContent).toBe('Ready')
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
})

test('a worded verb folds last into the first More item with its action and returns when room grows', async () => {
  const run = vi.fn()
  const slots: Partial<TopBarProps> = {
    verb: { label: 'Decide this run', run },
    more: () => <MenuItem icon={<PlusIcon />} label="Existing action" onSelect={noop} />,
  }
  // Native reserve leaves 137.82 after the first two stages; only removing
  // the 110px worded button can bring the actual modeled title above 180.
  availableTitle = 107.82
  expect(render(slots)).toEqual([0, 1, 2, 3])
  const row = container.querySelector('[data-slot="top-bar"]')!
  expect(row.getAttribute('data-fold')).toBe('3')
  expect(row.querySelector('[data-topbar-title]')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(180)
  expect(row.querySelector('[data-topbar="verb"] button')).toBeNull()
  expect(row.querySelectorAll('button[title="Destination views"]')).toHaveLength(1)
  const more = row.querySelector<HTMLButtonElement>('button[title="More"]')!
  await act(async () => more.click())
  const menu = document.body.querySelector('[role="menu"]')!
  const first = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  expect(first.textContent).toBe('Decide this run')
  expect(first.nextElementSibling?.getAttribute('role')).toBe('separator')
  await act(async () => first.click())
  expect(run).toHaveBeenCalledTimes(1)
  availableTitle = 400
  act(() => resizeCallbacks.forEach(callback => callback()))
  expect(row.getAttribute('data-fold')).toBe('0')
  expect(row.querySelector('[data-topbar="verb"] button')?.textContent).toBe('Decide this run')
  await act(async () => more.click())
  expect(document.body.querySelector('[role="menu"] [role="menuitem"]')?.textContent).toBe('Existing action')
})

test('a folded worded verb preserves its refusal reason and cannot invoke the action', async () => {
  const run = vi.fn()
  availableTitle = 107.82
  render({ verb: { label: 'Decide this run', disabled: 'No recorded Run', run } })
  const more = container.querySelector<HTMLButtonElement>('button[title="More"]')!
  await act(async () => more.click())
  const first = document.body.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')!
  expect(first).not.toBeNull()
  expect(first.textContent).toContain('Decide this run')
  expect(first.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(first.getAttribute('aria-describedby')!)?.textContent).toBe('No recorded Run')
  await act(async () => first.click())
  expect(run).not.toHaveBeenCalled()
})


test('fresh equivalent slot publications keep an open folded destination menu and use current actions', async () => {
  const oldBoard = vi.fn()
  const currentBoard = vi.fn()
  const slots = (run: () => void): Partial<TopBarProps> => ({
    parent: { label: 'Engineering teams', run: () => {} },
    state: <span>Ready</span>,
    tabs: [
      { value: 'overview', label: 'Overview', run: () => {} },
      { value: 'board', label: 'Board', run },
    ],
    verb: { label: 'New job', icon: <PlusIcon />, run: () => {} },
  })
  render(slots(oldBoard))
  expectFloor(2)
  const trigger = container.querySelector<HTMLButtonElement>('button[title="Destination views"]')!
  await act(async () => trigger.click())
  const menu = document.body.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')

  // A live store update republishes new arrays, JSX and closures, while all
  // visible values and the measured room remain the same.
  render(slots(currentBoard))
  expectFloor(2)
  expect(container.querySelector('button[title="Destination views"]')).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.body.querySelector('[role="menu"]')).toBe(menu)
  const board = menu!.querySelector<HTMLButtonElement>('[role="menuitemradio"][data-team-page="board"]')
  expect(board).not.toBeNull()
  await act(async () => board!.click())
  expect(currentBoard).toHaveBeenCalledTimes(1)
  expect(oldBoard).not.toHaveBeenCalled()

  // Real room growth still settles to expanded tabs; holding a popup cannot
  // suppress legitimate measurement or strand its keyboard focus.
  await act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  availableTitle = 400
  render(slots(currentBoard))
  expectFloor(0)
  expect(container.querySelector('button[title="Destination views"]')).toBeNull()
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('[role="tab"][data-team-page="overview"]'))
})

test('a live equivalent publication keeps the settled title and destination layout before the next paint', () => {
  const slots = (): Partial<TopBarProps> => ({
    parent: { label: 'Engineering teams', run: () => {} },
    state: <span>Ready</span>,
    tabs: base.tabs!.map(tab => ({ ...tab, run: () => {} })),
    verb: { label: 'New job', icon: <PlusIcon />, run: () => {} },
  })
  render(slots())
  expectFloor(2)
  const trigger = container.querySelector('button[title="Destination views"]')

  // A native frame can paint after a live registration's layout effects,
  // before any queued RAF. It must never see expanded tabs plus a ghost menu.
  act(() => root.render(<StrictMode><TopBar {...base} {...slots()} /></StrictMode>))
  expectFloor(2)
  expect(container.querySelector('button[title="Destination views"]')).toBe(trigger)
  expect(container.querySelectorAll('button[title="Destination views"]')).toHaveLength(1)
})


test('settling a destination fold preserves the current View menu focus', async () => {
  const filters = { content: (close: () => void) => <Menu close={close}>
    <MenuToggle label="Open" checked={false} onChange={() => {}} />
  </Menu> }
  render({ view: filters })
  expectFloor(1)
  const trigger = container.querySelector<HTMLButtonElement>('button[title="View"]')!
  await act(async () => trigger.click())
  const option = document.body.querySelector<HTMLElement>('[role="switch"]')!
  expect(option).not.toBeNull()
  act(() => option.focus())
  expect(document.activeElement).toBe(option)

  // An already open real View popup owns focus while the same row measures
  // its new room. Destination folding must not move focus into its own menu.
  availableTitle = 100
  act(() => resizeCallbacks.forEach(callback => callback()))
  expectFloor(2)
  expect(document.activeElement).toBe(option)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.body.querySelector('[role="switch"]')).toBe(option)
})

test('a subject with verbs makes its title the menu button', () => {
  const rename = vi.fn()
  render({ place: 'Retry the checkout call', placeTitle: 'Retry the checkout call. Keep the wait under ten seconds.',
    placeMenu: close => <MenuItem icon={<PlusIcon />} label="Rename…" onSelect={() => { rename(); close() }} /> })
  const title = container.querySelector<HTMLElement>('[data-topbar-title]')!
  expect(title.getAttribute('title')).toBe('Retry the checkout call. Keep the wait under ten seconds.')
  const trigger = title.querySelector<HTMLButtonElement>('button')!
  expect(trigger.getAttribute('title')).toBe('Retry the checkout call. Keep the wait under ten seconds.')
  expect(trigger.querySelector('[data-topbar-place-menu]')?.textContent).toContain('Retry the checkout call')
  act(() => trigger.click())
  act(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent?.includes('Rename'))!.click())
  expect(rename).toHaveBeenCalledOnce()
})

test('a title shorter than the floor needs only its own words, not a fold', () => {
  intrinsicTitle = 60
  availableTitle = 90
  render({ place: 'Library' })
  expect(container.querySelector('[data-slot="top-bar"]')!.getAttribute('data-fold')).toBe('0')
  expect(container.querySelector('[role="tablist"]')).not.toBeNull()
})

test('a clipped long title folds even when its wrapper has no scroll overflow', () => {
  availableTitle = 96
  render({})
  expectFloor(2)
})

test('a fitting fractional short title keeps its state, tabs and verb', () => {
  intrinsicTitle = 47.6
  availableTitle = 47.6
  render({ place: 'Library' })
  expect(container.querySelector('[data-slot="top-bar"]')!.getAttribute('data-fold')).toBe('0')
  expect(container.querySelector('[data-topbar="state"]')).not.toBeNull()
  expect(container.querySelector('[role="tablist"]')).not.toBeNull()
  expect(container.querySelector('[data-topbar="verb"]')!.textContent).toBe('New job')
})

test('destination tabs use the quiet switcher look', () => {
  render({})
  expect(container.querySelector('[role="tablist"]')?.getAttribute('data-look')).toBe('quiet')
})
