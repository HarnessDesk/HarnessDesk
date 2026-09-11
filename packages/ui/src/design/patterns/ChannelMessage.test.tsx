import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ChannelMessage, ChannelNotice, ChannelSignal } from './ChannelMessage'

/**
 * The channel's two densities.
 *
 * The same rows are read in a 360px panel and in a room pane that is the
 * conversation, and the shapes a chat log wants in those two places are not
 * the same. What is pinned here is the part that a later edit will quietly
 * break: that the room's attribution is one run at the left rather than a
 * floated column, that the marks and the type step up with it, and that the
 * signals keep the same gutter — because the gutter is the spine the whole
 * stream hangs off, and a signal that loses it turns the log into two lists.
 *
 * The panel's own shape is pinned too. It is the surface that already shipped,
 * and the reason for a density prop rather than a rewrite was that it must not
 * move.
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

const render = (node: React.ReactNode): void => {
  act(() => root.render(node))
}

const row = (): HTMLElement => {
  const found = container.querySelector('[data-density]')
  if (!found) throw new Error('no channel row')
  return found as HTMLElement
}

it('the room steps the mark, the type and the gutter up; the panel does not move', () => {
  render(<ChannelMessage from="Reviewer" at="03:35 PM" state="delivered" text="Looks right." />)
  expect(row().dataset.density).toBe('panel')
  expect(row().className).toContain('grid-cols-[24px_1fr]')
  expect(container.querySelector('[data-slot="avatar"]')?.className).toContain('size-6')

  render(
    <ChannelMessage
      from="Reviewer"
      at="03:35 PM"
      state="delivered"
      text="Looks right."
      density="room"
    />,
  )
  expect(row().dataset.density).toBe('room')
  expect(row().className).toContain('grid-cols-[36px_1fr]')
  expect(container.querySelector('[data-slot="avatar"]')?.className).toContain('size-9')
})

it('the room reads the attribution as one run; the panel floats it right', () => {
  render(
    <ChannelMessage
      from="Reviewer"
      to="Builder"
      at="03:35 PM"
      state="delivered"
      text="Looks right."
      density="room"
    />,
  )
  // Name, who it reached, when, how it went — in that order, reading left to
  // right the way a chat window has always read.
  expect(row().textContent).toContain('Reviewer')
  expect(row().textContent).toContain('to Builder')
  expect(row().textContent?.indexOf('03:35 PM')).toBeLessThan(
    row().textContent?.indexOf('delivered') ?? -1,
  )
  expect(container.querySelector('.ml-auto')).toBeNull()

  render(
    <ChannelMessage
      from="Reviewer"
      to="Builder"
      at="03:35 PM"
      state="delivered"
      text="Looks right."
    />,
  )
  // The panel keeps its floated column: at 360px the one-run reading wraps.
  expect(container.querySelector('.ml-auto')).not.toBeNull()
})

it('delivery is said out loud at both densities, and an answer says where it landed', () => {
  for (const density of ['panel', 'room'] as const) {
    render(
      <ChannelMessage from="R" at="1" state="delivered" text="x" density={density} />,
    )
    expect(row().textContent).toContain('delivered')

    render(<ChannelMessage from="R" at="1" state="shown" text="x" density={density} />)
    // `shown` is the loop guard working, not a delivery that failed: the answer
    // is recorded here on purpose. Naming it by what it is not made three
    // working replies read as three errors in a live run.
    expect(row().textContent).toContain('in the room')
    expect(row().textContent).not.toContain('not sent')
  }
})

it('the room holds the envelope back until asked; the panel keeps it up', () => {
  render(
    <ChannelMessage
      from="R"
      at="1"
      state="delivered"
      text="x"
      envelope="the exact words"
      density="room"
    />,
  )
  const peek = container.querySelector('[data-slot="channel-peek"]') as HTMLElement
  // Faded, never removed: it stays in the accessibility tree and stays
  // tabbable, which `hidden` would not.
  expect(peek.className).toContain('opacity-0')
  expect(peek.className).toContain('group-hover:opacity-100')

  render(
    <ChannelMessage from="R" at="1" state="delivered" text="x" envelope="the exact words" />,
  )
  expect(
    (container.querySelector('[data-slot="channel-peek"]') as HTMLElement).className,
  ).not.toContain('opacity-0')
})

it('a signal keeps the message gutter at whichever density it is drawn', () => {
  render(<ChannelSignal by="You" said="added #1" at="03:29 PM" />)
  expect(container.querySelector('[aria-hidden]')?.className).toContain('w-6')

  render(<ChannelSignal by="You" said="added #1" at="03:29 PM" density="room" />)
  expect(container.querySelector('[aria-hidden]')?.className).toContain('w-9')
})

it('the room puts a signal’s time at the end of its sentence, not on a right edge', () => {
  // These sentences wrap to three lines. A floated column put the time beside
  // the *first* of them, on an edge nothing else in the room lines up with.
  render(
    <ChannelSignal
      by="Reviewer"
      said="completed #1 — verify never builds the renderer"
      at="03:31 PM"
      density="room"
    />,
  )
  const sentence = container.querySelector('.min-w-0')
  expect(sentence?.textContent).toContain('03:31 PM')

  render(<ChannelSignal by="Reviewer" said="completed #1" at="03:31 PM" />)
  expect(container.querySelector('.min-w-0')?.textContent).not.toContain('03:31 PM')
})

it('a notice names the member, the cause and the runtime’s own words', () => {
  render(
    <ChannelNotice
      about="Opus"
      cause="limit"
      text="You've hit your usage limit. It resets at 3:20 PM."
      at="02:41 PM"
      density="room"
    />,
  )
  // The chip is what separates "still reading" from "stopped": a grey sentence
  // in a busy channel is exactly the reading this row exists to prevent.
  expect(container.textContent).toContain('usage limit')
  expect(container.textContent).toContain('Opus')
  expect(container.textContent).toContain('resets at 3:20 PM')
  // And it keeps the channel's spine, like every other aside.
  expect(container.querySelector('[aria-hidden]')?.className).toContain('w-9')
})

it('draws a face of the caller’s own in the face’s place, on no tint', () => {
  // The control first: a person without one gets initials on the sender tint.
  render(<ChannelMessage from="You" at="10:02" text="ship it" state="delivered" />)
  const plain = container.querySelector('[data-slot="avatar"]')
  expect(plain?.textContent).toBe('Y')
  expect(plain?.className).toContain('tint-blue')

  render(<ChannelMessage from="You" at="10:02" text="ship it" state="delivered" face={<img data-face="" alt="" />} />)
  const avatar = container.querySelector('[data-slot="avatar"]')
  expect(avatar?.querySelector('img[data-face]')).not.toBeNull()
  expect(avatar?.textContent).toBe('')
  expect(avatar?.className).not.toContain('tint-blue')
})
