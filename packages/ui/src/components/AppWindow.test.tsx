import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AppWindow, AppWindowMode, WindowNavItem } from './AppWindow'
import { Menu, MenuItem, Popover, useEscapeSurface } from '../design'

/**
 * A settings nav is a list of equal rows.
 *
 * Its labels are not all ours: a runtime supplies its own word for a page —
 * "Skills & commands" is what every ACP agent calls that one — and a label
 * long enough to wrap made its row half again as tall as the eleven around
 * it, on three of the four agents HarnessDesk ships with. The row cuts now
 * rather than wrapping, and the height stays the height.
 */

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

const render = (node: Parameters<Root['render']>[0]): void => {
  act(() => root.render(node))
}

const frame = () => act(async () => {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
})

it('takes focus and hides the covered desk, then restores both when it closes', async () => {
  const content = (open: boolean) => (
    <>
      <button data-testid="desk">Open settings</button>
      {open && <AppWindow label="Settings"><button>Inside settings</button></AppWindow>}
    </>
  )
  render(content(false))
  const desk = container.querySelector<HTMLButtonElement>('[data-testid="desk"]')!
  desk.focus()
  await act(async () => root.render(content(true)))
  await frame()
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]')!
  expect(dialog).not.toBeNull()
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.activeElement).toBe(dialog)
  expect(desk.closest('[aria-hidden="true"], [inert]')).not.toBeNull()
  await act(async () => root.render(content(false)))
  await frame()
  expect(desk.closest('[aria-hidden="true"], [inert]')).toBeNull()
  expect(document.activeElement).toBe(desk)
})

it('keeps embedded preview windows named without hiding or focusing other frames', async () => {
  render(<button data-testid="other-frame">Other frame</button>)
  const other = container.querySelector<HTMLButtonElement>('button')!
  other.focus()
  await act(async () => root.render(<>
    <button data-testid="other-frame">Other frame</button>
    <AppWindowMode.Provider value="embedded">
      <AppWindow label="Settings"><button>Settings control</button></AppWindow>
      <AppWindow label="Dashboard"><button>Dashboard control</button></AppWindow>
    </AppWindowMode.Provider>
  </>))
  await frame()
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2)
  expect(container.querySelector('[aria-modal="true"]')).toBeNull()
  expect(other.closest('[aria-hidden="true"], [inert]')).toBeNull()
  expect(document.activeElement).toBe(other)
})

it('spends one Escape on its nested menu and the next on the window before covered handlers', async () => {
  let closeWindow = () => {}
  const Surface = () => {
    useEscapeSurface(true, () => closeWindow())
    return <AppWindow label="Settings">
      <Popover label="Actions">{close => <Menu close={close}><MenuItem label="Choose" onSelect={() => {}} /></Menu>}</Popover>
    </AppWindow>
  }
  const Harness = () => {
    const [open, setOpen] = useState(true)
    closeWindow = () => setOpen(false)
    return <><button>Covered desk</button>{open && <Surface />}</>
  }
  await act(async () => root.render(<Harness />))
  await frame()
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')!
  await act(async () => trigger.click())
  const escape = async () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => document.activeElement!.dispatchEvent(event))
    return event
  }
  const heard: boolean[] = []
  const coveredHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') heard.push(event.defaultPrevented) }
  window.addEventListener('keydown', coveredHandler)
  try {
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await escape()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).not.toBeNull()
    await escape()
    expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).toBeNull()
    expect(heard.every(Boolean)).toBe(true)
  } finally {
    window.removeEventListener('keydown', coveredHandler)
  }
})

it('cuts a label the runtime chose rather than wrapping its row', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="Skills & commands"
      count={25}
      trail={<span>Cursor</span>}
      selected={false}
      onClick={() => {}}
    />,
  )
  const label = [...container.querySelectorAll('span')].find(
    (span) => span.textContent === 'Skills & commands',
  )
  expect(label).toBeDefined()
  const style = getComputedStyle(label as HTMLElement)
  expect(style.whiteSpace).toBe('nowrap')
  expect(style.textOverflow).toBe('ellipsis')
  expect(style.overflow).toBe('hidden')
})

it('keeps the trailing values out of the label’s space', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="Skills & commands"
      count={25}
      selected={false}
      onClick={() => {}}
    />,
  )
  const count = [...container.querySelectorAll('span')].find((span) => span.textContent === '25')
  // `flex: none` on the count is what stops the browser shrinking the number
  // instead of the label it sits beside.
  expect(getComputedStyle(count as HTMLElement).flexGrow).toBe('0')
  expect(getComputedStyle(count as HTMLElement).flexShrink).toBe('0')
})
