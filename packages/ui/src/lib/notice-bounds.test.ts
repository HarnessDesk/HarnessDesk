import { describe, expect, it } from 'vitest'

import {
  NOTICE_BAR_SELECTOR,
  NOTICE_FLOOR,
  NOTICE_MIN_WIDTH,
  boxesOverlap,
  noticePlacement,
  type BoxLike,
} from './notice-bounds'

/*
 * Every rect below is a plausible one for its scenario, not a live
 * measurement: jsdom's own `getBoundingClientRect` cannot produce one, which
 * is why this is a unit test on the rects rather than a rendered one. The
 * shapes come from the stylesheets: `.main[data-hidden]` is `flex: 0 0 0`
 * (a zero-width pane, still in the row), a zoomed dock is `flex: 1`, and a
 * narrow window's `.right` is `position: absolute; inset: 0` over the main
 * area. The bars are the heights the design system gives them: a panel's
 * strip and a tool's header at 38, a browser's address bar at 40.
 */

const box = (left: number, top: number, right: number, bottom: number): BoxLike => ({ left, top, right, bottom })

/** A window 1440 × 900, sidebar 240 wide; the stack is positioned in the whole of it. */
const WINDOW = box(0, 0, 1440, 900)
const CONTENT = box(240, 0, 1440, 900)

/** A panel's strip, then a browser's header and address bar under it, over `[left, right]`. */
const browserBars = (left: number, right: number): BoxLike[] => [
  box(left, 0, right, 38),
  box(left, 38, right, 76),
  box(left, 76, right, 116),
]

/** The tallest a card is likely to be: two lines and a button row. */
const CARD_HEIGHT = 120

/** The stack's own box, as the page would lay it out, for one card. */
const stackOf = (container: BoxLike, placement: ReturnType<typeof noticePlacement>): BoxLike =>
  box(
    container.left + placement.left,
    container.top + placement.top,
    container.right - placement.right,
    container.top + placement.top + CARD_HEIGHT,
  )

/** The two promises every shape must keep: readable, and clear of every bar. */
const expectReadableAndClear = (container: BoxLike, content: BoxLike, stack: BoxLike, bars: readonly BoxLike[]) => {
  expect(stack.right - stack.left).toBeGreaterThanOrEqual(Math.min(NOTICE_MIN_WIDTH, content.right - content.left))
  expect(stack.left).toBeGreaterThanOrEqual(content.left)
  expect(stack.right).toBeLessThanOrEqual(content.right)
  for (const bar of bars) expect(boxesOverlap(stack, bar), JSON.stringify(bar)).toBe(false)
  expect(stack.top - container.top).toBeGreaterThanOrEqual(NOTICE_FLOOR)
}

describe('NOTICE_BAR_SELECTOR', () => {
  it('finds every bar a pane can stand at its top: the design system’s bars and any header', () => {
    const host = document.createElement('div')
    host.innerHTML = [
      '<header data-slot="bar"></header>',
      '<div data-slot="bar"></div>',
      '<header data-slot="dock-panel-bar"></header>',
      '<header data-slot="tool-pane-header"></header>',
      '<div data-slot="tool-pane-bar"></div>',
      '<div data-slot="toolbar"></div>',
      '<header class="conversation"></header>',
    ].join('')
    expect(host.querySelectorAll(NOTICE_BAR_SELECTOR)).toHaveLength(7)
  })
})

describe('noticePlacement', () => {
  it('rides a conversation that fills the content area, just under the header strip', () => {
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars: [] })
    expect(placement).toEqual({ left: 240, right: 0, top: NOTICE_FLOOR })
  })

  it('stops at the seam when a docked browser sits beside the conversation, and does not drop for bars it does not cross', () => {
    const bars = browserBars(900, 1440)
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: box(240, 0, 899, 900), bars })
    expect(placement).toEqual({ left: 240, right: 541, top: NOTICE_FLOOR })
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('a zoomed right panel: rides the panel below its strip and address bar, never a sliver over Reload', () => {
    // The main area is zero wide at the panel's left edge, and unmarked:
    // `noticeArea` hands the notices to the panel being read.
    const bars = browserBars(240, 1440)
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars })
    expect(placement).toEqual({ left: 240, right: 0, top: 124 })
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('a zoomed bottom panel: rides it below its strip and the terminal’s own bar', () => {
    const bars = [box(240, 0, 1440, 38), box(240, 38, 1440, 70)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars })
    expect(placement).toEqual({ left: 240, right: 0, top: 78 })
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('an expanded second pane: rides the pane on screen, below its strip and its tools', () => {
    // The hidden first half's bars are filtered out before they get here
    // (`checkVisibility`), so only the expanded pane's own count.
    const bars = [box(240, 0, 1440, 38), box(240, 38, 1440, 74)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars })
    expect(placement.top).toBe(82)
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('a 900px window with the right panel open: rides the panel laid over the whole main area, below its toolbar', () => {
    const container = box(0, 0, 900, 700)
    const content = box(0, 0, 900, 700)
    const bars = browserBars(0, 900)
    const placement = noticePlacement({ container, content, host: content, bars })
    expect(placement).toEqual({ left: 0, right: 0, top: 124 })
    expectReadableAndClear(container, content, stackOf(container, placement), bars)
  })

  it('a pane dragged thinner than a card widens around its centre, inside the content area, and drops below what it now crosses', () => {
    const bars = browserBars(441, 1440)
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: box(240, 0, 440, 900), bars })
    // Centred on 340 it would start at 140, inside the sidebar; held at 240.
    expect(placement.left).toBe(240)
    expect(WINDOW.right - placement.right - (WINDOW.left + placement.left)).toBe(NOTICE_MIN_WIDTH)
    expect(placement.top).toBe(124)
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('a zero-width host — a collapsed pane — is never a zero-width stack', () => {
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: box(240, 0, 240, 900), bars: [] })
    expect(WINDOW.right - placement.right - (WINDOW.left + placement.left)).toBe(NOTICE_MIN_WIDTH)
    expect(placement.left).toBe(240)
  })

  it('with no host marked (a zoomed sidebar) falls back to the content area, still clear of every bar', () => {
    const bars = [box(240, 0, 1440, 38)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: null, bars })
    expect(placement).toEqual({ left: 240, right: 0, top: NOTICE_FLOOR })
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('takes the content area’s whole width when even that is narrower than a card', () => {
    const container = box(0, 0, 360, 700)
    const placement = noticePlacement({ container, content: container, host: box(0, 0, 0, 700), bars: [] })
    expect(placement).toMatchObject({ left: 0, right: 0 })
  })

  it('a room with one member: clears the room’s own header and the member conversation’s header stacked under it', () => {
    // The room's `Bar as="header"` (`data-slot="bar"`), then the nested
    // conversation's own `<header>`, each 46 tall — two bars, one run.
    const bars = [box(240, 0, 1440, 46), box(240, 46, 1440, 92)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars })
    expect(placement.top).toBe(100)
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
  })

  it('clears any number of stacked bars, however they meet, and none it only touches', () => {
    const bars = [box(240, 0, 1440, 46), box(240, 46, 1440, 92), box(240, 95, 1440, 131), box(240, 131, 1440, 170)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars })
    expect(placement.top).toBe(178)
    expectReadableAndClear(WINDOW, CONTENT, stackOf(WINDOW, placement), bars)
    // A single header ending exactly where the stack starts is not in its way.
    expect(noticePlacement({ container: WINDOW, content: CONTENT, host: CONTENT, bars: [box(240, 0, 1440, 46)] }).top).toBe(NOTICE_FLOOR)
  })

  it('ignores a bar that is not in the run from the host’s top — a bottom panel’s strip, a hidden tab’s empty box', () => {
    const bars = [box(240, 600, 1440, 638), box(240, 0, 240, 0)]
    const placement = noticePlacement({ container: WINDOW, content: CONTENT, host: box(240, 0, 1440, 600), bars })
    expect(placement.top).toBe(NOTICE_FLOOR)
  })
})
