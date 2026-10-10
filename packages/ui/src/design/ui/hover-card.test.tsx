import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { menusOpen, registerMenu } from './popup-state'
import { DropdownMenu, DropdownMenuTrigger } from './dropdown-menu'
import { Select } from './select'
import { PopoverSurface } from '../patterns/Popover'

import { HOVER_CARD_WIDTH_REM, HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'

/**
 * The width a caller measures is the width the card is drawn at.
 *
 * `AgentHoverCard` decides beside-or-under by asking whether
 * `HOVER_CARD_WIDTH_REM` fits next to the trigger, while the card itself is
 * drawn by a Tailwind class. The two are written in different places and
 * nothing else ties them: widen the class and every decision is made for a
 * card that no longer exists, and the symptom is a card drawn off the window
 * in exactly the narrow room the measurement is for — with a green suite.
 * Review found the gap; this is the tie.
 *
 * It ties the class, not the width the class is drawn at: Tailwind turns
 * `w-72` into a multiple of `--spacing`, and a theme that rebound that would
 * change the drawn width with this test still green. Nothing rebinds it, and
 * jsdom lays nothing out, so the width drawn — 288px at the app's 16px root —
 * is measured in the real app instead (the traces in #148).
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
  vi.useRealTimers()
})

it('is drawn at the width callers measure it by', () => {
  act(() =>
    root.render(
      <HoverCard open>
        <HoverCardTrigger render={<span />}>trigger</HoverCardTrigger>
        <HoverCardContent>card</HoverCardContent>
      </HoverCard>,
    ),
  )
  const card = document.querySelector('[data-slot="hover-card-content"]')
  expect(card, 'an open card renders its content').not.toBeNull()
  // Tailwind's spacing unit is a quarter of a rem, so 18rem is `w-72`.
  const width = [...(card?.classList ?? [])].filter((name) => /^w-\d+$/.test(name))
  expect(width).toEqual([`w-${HOVER_CARD_WIDTH_REM * 4}`])
})

it('associates a controlled open state with its trigger', () => {
  const render = (open: boolean) =>
    root.render(
      <HoverCard open={open} triggerId="subject-trigger">
        <HoverCardTrigger id="subject-trigger" render={<span />}>trigger</HoverCardTrigger>
        <HoverCardContent>card</HoverCardContent>
      </HoverCard>,
    )

  act(() => render(false))
  const trigger = container.querySelector('[data-slot="hover-card-trigger"]')
  expect(trigger?.hasAttribute('data-popup-open')).toBe(false)
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()

  act(() => render(true))
  expect(trigger?.hasAttribute('data-popup-open')).toBe(true)
  expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeNull()
})

it('keeps its inset for plain facts, and bleeds for a body that is a card of its own', () => {
  const inset = (bleed: boolean): string[] => {
    act(() =>
      root.render(
        <HoverCard open>
          <HoverCardTrigger render={<span />}>trigger</HoverCardTrigger>
          <HoverCardContent bleed={bleed}>card</HoverCardContent>
        </HoverCard>,
      ),
    )
    const card = document.querySelector('[data-slot="hover-card-content"]')
    expect(card?.hasAttribute('data-bleed')).toBe(bleed)
    return [...(card?.classList ?? [])].filter((name) => /^p-\d+$/.test(name))
  }
  expect(inset(false)).toEqual(['p-3'])
  expect(inset(true)).toEqual(['p-0'])
})

// Shared exclusion survives nested menus and cannot revive a stale controlled card.
it('suppresses a controlled card until a new trigger intent after the last menu closes', () => {
  vi.useFakeTimers()
  act(() => root.render(<HoverCard open><HoverCardTrigger render={<button type="button" />}>Facts</HoverCardTrigger><HoverCardContent>card</HoverCardContent></HoverCard>))
  expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeNull()
  let closeParent!: () => void
  let closeChild!: () => void
  try {
  act(() => { closeParent = registerMenu(Symbol('parent')); closeChild = registerMenu(Symbol('child')) })
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
  act(() => closeChild())
  expect(menusOpen()).toBe(true)
  act(() => closeParent())
  expect(menusOpen()).toBe(false)
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
  const trigger = container.querySelector('[data-slot="hover-card-trigger"]')!
  act(() => { trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); trigger.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(1000) })
  expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeNull()
  } finally { act(() => { closeChild?.(); closeParent?.() }); vi.useRealTimers() }
})
it('menu roots unregister when an open parent is unmounted', () => {
  act(() => root.render(<DropdownMenu open><DropdownMenuTrigger>Menu</DropdownMenuTrigger></DropdownMenu>))
  expect(menusOpen()).toBe(true)
  act(() => root.render(null))
  expect(menusOpen()).toBe(false)
  act(() => root.render(<Select open />))
  expect(menusOpen()).toBe(true)
  act(() => root.render(null))
  expect(menusOpen()).toBe(false)
})
it('a mounted suggestion surface suppresses cards and releases on unmount', () => {
  act(() => root.render(<PopoverSurface role="listbox">Recipients</PopoverSurface>))
  expect(menusOpen()).toBe(true)
  act(() => root.render(null))
  expect(menusOpen()).toBe(false)
})

it('opening a menu cancels a pending hover before its delayed callback', () => {
  vi.useFakeTimers()
  act(() => root.render(<HoverCard><HoverCardTrigger render={<button type="button" />}>Facts</HoverCardTrigger><HoverCardContent>card</HoverCardContent></HoverCard>))
  const trigger = container.querySelector('[data-slot="hover-card-trigger"]')!
  act(() => { trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); trigger.dispatchEvent(new MouseEvent('mouseenter')) })
  let close!: () => void
  try {
    act(() => { close = registerMenu(Symbol('pending')); vi.advanceTimersByTime(1000) })
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
    act(() => close())
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
  } finally { act(() => close?.()); vi.useRealTimers() }
})

it('a caller can refuse an uncontrolled menu opening without registering it', () => {
  const heard = vi.fn()
  act(() => root.render(<DropdownMenu onOpenChange={(next, details) => { heard(next); details.cancel() }}><DropdownMenuTrigger>Menu</DropdownMenuTrigger></DropdownMenu>))
  act(() => container.querySelector('button')!.click())
  expect(heard).toHaveBeenCalledWith(true)
  expect(menusOpen()).toBe(false)
})

it('a menu that closes before the hover delay cannot revive the queued card', () => {
  vi.useFakeTimers()
  act(() => root.render(<HoverCard><HoverCardTrigger render={<button type="button" />}>Facts</HoverCardTrigger><HoverCardContent>card</HoverCardContent></HoverCard>))
  const trigger = container.querySelector('[data-slot="hover-card-trigger"]')!
  act(() => { trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); trigger.dispatchEvent(new MouseEvent('mouseenter')) })
  let close!: () => void
  try {
    act(() => { close = registerMenu(Symbol('short-menu')) })
    act(() => vi.advanceTimersByTime(100))
    act(() => close())
    act(() => vi.advanceTimersByTime(1000))
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull()
  } finally { act(() => close?.()); vi.useRealTimers() }
})
