import { afterEach, expect, it } from 'vitest'

import { beginResize, endResize, markDragging } from './resizing'

/**
 * What the window is owed when a drag does not end in pairs.
 *
 * `data-hd-resizing` turns off every transition in the window, the text
 * caret and every guest frame, and it is counted rather than set: two
 * pointers can hold two seams. The failure that follows from counting is a
 * caller that begins twice and ends once — a second `pointerdown` on a seam
 * before the first drag is over — and the state it leaves is the worst this
 * file can produce, for the rest of the session (#252).
 *
 * The seams in this repository now refuse that second `pointerdown`. These
 * pin the net under them, which is what covers a seam this file cannot
 * reach: a vendored one, a plugin's, a copy written next year.
 */

const flag = (): string | null => document.documentElement.getAttribute('data-hd-resizing')

/** A seam, marked as being dragged — the mark every seam here sets. */
const seamHeld = (): HTMLElement => {
  const node = document.body.appendChild(document.createElement('div'))
  markDragging(node, true)
  return node
}

const lift = (pointerId: number): void => {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId }))
}

afterEach(() => {
  for (const node of document.querySelectorAll('[data-dragging]')) node.remove()
  lift(99)
  expect(flag(), 'a test left the window suppressed').toBeNull()
})

it('a drag still under a pointer keeps the window suppressed (#252)', () => {
  // The other half of the rule, and the one that makes the first mean
  // something: a pointer lifting elsewhere must not end a live drag.
  const seam = seamHeld()
  beginResize('horizontal')
  expect(flag()).toBe('horizontal')

  lift(7)
  expect(flag()).toBe('horizontal')

  markDragging(seam, false)
  endResize()
  expect(flag()).toBeNull()
  seam.remove()
})

it('two drags at once give the window back when the second one ends (#252)', () => {
  const first = seamHeld()
  beginResize('vertical')
  const second = seamHeld()
  beginResize('horizontal')
  expect(flag()).toBe('vertical')

  markDragging(first, false)
  endResize()
  lift(1)
  // The second is still held, and the count is what says so.
  expect(flag()).toBe('vertical')

  markDragging(second, false)
  endResize()
  expect(flag()).toBeNull()
  first.remove()
  second.remove()
})

it('two begins and one end leave nothing suppressed once the pointers are gone (#252)', () => {
  const seam = seamHeld()
  beginResize('vertical')
  // The second pointer: another finger, or a pen beside a mouse. One `stop`
  // runs however many went down, so only one `endResize` is ever reached.
  beginResize('vertical')
  // The control, true before this was fixed and after: a drag in flight is
  // suppressed. Without it a passing test below could be a flag never set.
  expect(flag()).toBe('vertical')

  markDragging(seam, false)
  endResize()
  // Still held by the count, with nothing holding it.
  expect(flag()).toBe('vertical')

  lift(2)
  expect(flag()).toBeNull()
  seam.remove()
})
