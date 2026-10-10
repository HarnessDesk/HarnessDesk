import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { TriggerMenu, type TriggerItem } from './TriggerMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const items: readonly TriggerItem[] = [
  { id: 'command', name: '/review-checkout', mono: true, hint: 'Review the checkout.', badge: 'command', selected: true },
  { id: 'file', name: '/workspace/storefront/catalogue.ts', pathStyle: true, hint: 'Matching workspace file', mark: <span>Optional mark</span>, badge: 'file' },
  { id: 'archived', name: 'Archived conversation', disabled: 'Restore this conversation before sending.', badge: 'session' },
]

it('uses one icon-free wide listbox with earned hints, badges and a trailing check', () => {
  const box = document.createElement('div')
  box.innerHTML = renderToStaticMarkup(<TriggerMenu title="Suggestions" items={items} activeIndex={1} onHover={() => {}} onPick={() => {}} />)
  const list = box.querySelector('[role="listbox"]')!
  expect(list.getAttribute('data-popup-kind')).toBe('wide-menu')
  expect(list.getAttribute('data-menu-icons')).toBe('none')
  const rows = [...list.querySelectorAll('[role="option"]')]
  expect(rows.every(row => row.hasAttribute('data-menu-row'))).toBe(true)
  expect(list.querySelector('[data-menu-icon]')).toBeNull()
  expect(list.textContent).not.toContain('Optional mark')
  expect(rows[0]!.getAttribute('title')).toBe('Review the checkout.')
  expect(rows[0]!.querySelector('[data-menu-hint]')).toBeNull()
  expect(rows[0]!.querySelector('[data-menu-trailing] svg')).not.toBeNull()
  expect(rows[1]!.querySelector('[data-menu-hint]')?.textContent).toBe('Matching workspace file')
  expect(rows[1]!.getAttribute('aria-selected')).toBe('true')
  expect(rows[2]!.querySelector('[data-menu-hint]')?.textContent).toBe(items[2]!.disabled)
  expect(list.querySelectorAll('[data-menu-badge]')).toHaveLength(3)
})

it('pointer picks retain typing focus, hover indexes and refuse disabled choices', async () => {
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  const onPick = vi.fn(), onHover = vi.fn()
  try {
    await act(async () => root.render(<><textarea aria-label="Composer" /><TriggerMenu items={items} activeIndex={0} onHover={onHover} onPick={onPick} /></>))
    const input = box.querySelector('textarea')!
    input.focus()
    const rows = box.querySelectorAll<HTMLButtonElement>('[role="option"]')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    rows[0]!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    await act(async () => rows[0]!.click())
    expect(onPick).toHaveBeenCalledExactlyOnceWith(items[0])
    expect(document.activeElement).toBe(input)
    await act(async () => rows[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(onHover).toHaveBeenCalledWith(1)
    await act(async () => rows[2]!.click())
    expect(onPick).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    box.remove()
  }
})

it('keeps empty messages in the canonical note slot', () => {
  expect(renderToStaticMarkup(<TriggerMenu items={[]} activeIndex={0} onHover={() => {}} onPick={() => {}} emptyLabel="No workspace matches" />)).toContain('data-menu-note="">No workspace matches')
})
