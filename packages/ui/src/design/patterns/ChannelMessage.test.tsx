import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ChannelMessage, ChannelNotice, ChannelSignal } from './ChannelMessage'

/**
 * The channel's rows, read by the parts they are made of.
 *
 * The room's chat sits one keystroke from an agent's transcript, so its rows
 * are the transcript's own parts: a transcript item for the rhythm, the room's
 * identity tile for the face, `Text` roles and a `MetaList` for the words, a
 * `Chip` in the tone a delivery's trouble is. What is pinned here is what a
 * later edit would quietly break: the attribution read as one run at the left,
 * the spine every aside keeps so the log does not turn into two lists, and the
 * envelope held back until asked.
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
  const found = container.querySelector('[data-channel="message"]')
  if (!found) throw new Error('no channel row')
  return found as HTMLElement
}

it('a message is a transcript item with the sender’s identity tile for a face', () => {
  render(<ChannelMessage from="Reviewer" brand="codex" tint="green" at="03:35 PM" state="delivered" text="Looks right." />)
  expect(row().dataset.slot).toBe('turn-item')
  const tile = row().querySelector('[data-slot="icon-tile"]')
  expect(tile?.getAttribute('data-tint')).toBe('green')
  expect(tile?.getAttribute('aria-hidden')).toBe('true')
  // The name is the subject of the row, said in words beside the face.
  expect(row().querySelector('[data-slot="text"][data-role="subject"]')?.textContent).toBe('Reviewer')
})

it('reads the attribution as one run at the left: name, who it reached, when, how it went', () => {
  render(
    <ChannelMessage
      from="Reviewer"
      to="Builder"
      at="03:35 PM"
      state="delivered"
      text="Looks right."
    />,
  )
  const text = row().textContent ?? ''
  expect(text.indexOf('Reviewer')).toBeLessThan(text.indexOf('to Builder'))
  expect(text.indexOf('to Builder')).toBeLessThan(text.indexOf('03:35 PM'))
  // The time and the outcome are one list of facts, in that order.
  const facts = row().querySelector('[data-slot="meta-list"]')
  expect([...(facts?.children ?? [])].map((one) => one.textContent)).toEqual(['03:35 PM', 'delivered'])
})

it('delivery is said out loud, and an answer says where it landed', () => {
  render(<ChannelMessage from="R" at="1" state="delivered" text="x" />)
  expect(row().textContent).toContain('delivered')

  render(<ChannelMessage from="R" at="1" state="shown" text="x" />)
  // `shown` is the loop guard working, not a delivery that failed: the answer
  // is recorded here on purpose. Naming it by what it is not made three
  // working replies read as three errors in a live run.
  expect(row().textContent).toContain('in the room')
  expect(row().textContent).not.toContain('not sent')
})

it('says a delivery’s trouble in the tone it is', () => {
  const toneOf = (): string | null =>
    row().querySelector('[data-slot="chip"]')?.getAttribute('data-tone') ?? null
  render(<ChannelMessage from="R" at="1" state="refused" reason="no such name" text="x" />)
  expect(toneOf()).toBe('danger')
  render(<ChannelMessage from="R" at="1" state="held" reason="held for you" text="x" onDeliver={() => {}} />)
  expect(toneOf()).toBe('warning')
  render(<ChannelMessage from="R" at="1" state="queued" text="x" />)
  expect(toneOf()).toBe('neutral')
  // Delivered is the expected outcome: a whisper, never a chip.
  render(<ChannelMessage from="R" at="1" state="delivered" text="x" />)
  expect(row().querySelector('[data-slot="chip"]')).toBeNull()
})

it('a grouped message keeps the body, drops the header, and keeps its time in the face’s gutter', () => {
  render(<ChannelMessage from="Reviewer" at="03:35 PM" state="delivered" text="And one more." grouped />)
  expect(row().hasAttribute('data-grouped')).toBe(true)
  expect(row().querySelector('[data-slot="icon-tile"]')).toBeNull()
  expect(row().querySelector('[data-role="subject"]')).toBeNull()
  expect(row().querySelector('[data-slot="text"][data-role="meta"]')?.textContent).toBe('03:35 PM')
  expect(row().textContent).toContain('And one more.')
})

it('holds the envelope back until asked', () => {
  render(
    <ChannelMessage
      from="R"
      at="1"
      state="delivered"
      text="x"
      envelope="the exact words"
    />,
  )
  const peek = container.querySelector('[data-slot="channel-peek"]') as HTMLElement
  // Faded, never removed: it stays in the accessibility tree and stays
  // tabbable, which `hidden` would not.
  expect(peek.getAttribute('aria-expanded')).toBe('false')
  expect(peek.className).toContain('opacity-0')
  expect(peek.className).toContain('group-hover:opacity-100')

  act(() => peek.click())
  expect(peek.getAttribute('aria-expanded')).toBe('true')
  expect(peek.className).not.toContain('opacity-0')
  expect(container.querySelector('[data-slot="code-text"]')?.textContent).toBe('the exact words')
})

it('a signal is the light register of a transcript item, and keeps the face column open', () => {
  render(<ChannelSignal by="You" said="added #1" at="03:29 PM" />)
  const signal = container.querySelector('[data-channel="signal"]') as HTMLElement
  expect(signal.dataset.slot).toBe('turn-item')
  // The spine: an empty cell as wide as a message's face, so a signal's
  // sentence starts on the same line as a message's name.
  expect(signal.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  expect(signal.firstElementChild?.textContent).toBe('')

  // The same register as a grouped message — one line, not a card — and a
  // step lighter than a message that opens with its sender.
  const rhythmOf = (node: Element | null): string | undefined =>
    node?.className.split(/\s+/).find((one) => one.startsWith('py-'))
  const signalRhythm = rhythmOf(signal)
  render(<ChannelMessage from="R" at="1" state="delivered" text="x" grouped />)
  expect(rhythmOf(row())).toBe(signalRhythm)
  render(<ChannelMessage from="R" at="1" state="delivered" text="x" />)
  expect(rhythmOf(row())).not.toBe(signalRhythm)
})

it('puts a signal’s time at the end of its sentence, not on a right edge', () => {
  // These sentences wrap to three lines. A floated column put the time beside
  // the *first* of them, on an edge nothing else in the room lines up with.
  render(
    <ChannelSignal
      by="Reviewer"
      said="completed #1 — verify never builds the renderer"
      at="03:31 PM"
    />,
  )
  const sentence = container.querySelector('[data-channel="signal"] > [data-slot="text"]')
  expect(sentence?.textContent?.endsWith('03:31 PM')).toBe(true)
})

it('a notice names the member, the cause in its tone, and the runtime’s own words', () => {
  render(
    <ChannelNotice
      about="Opus"
      cause="limit"
      text="You've hit your usage limit. It resets at 3:20 PM."
      at="02:41 PM"
    />,
  )
  // The chip is what separates "still reading" from "stopped": a grey sentence
  // in a busy channel is exactly the reading this row exists to prevent.
  const notice = container.querySelector('[data-channel="notice"]') as HTMLElement
  const chip = notice.querySelector('[data-slot="chip"]')
  expect(chip?.textContent).toBe('usage limit')
  expect(chip?.getAttribute('data-tone')).toBe('warning')
  expect(notice.textContent).toContain('Opus')
  expect(notice.textContent).toContain('resets at 3:20 PM')
  // And it keeps the channel's spine, like every other aside.
  expect(notice.firstElementChild?.getAttribute('aria-hidden')).toBe('true')

  render(<ChannelNotice about="Opus" cause="gone" text="left" at="02:42 PM" />)
  expect(container.querySelector('[data-channel="notice"] [data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
})

it('draws a face of the caller’s own in the face’s place, on no tint', () => {
  // The control first: a person without one gets initials on the sender tint.
  render(<ChannelMessage from="You" at="10:02" text="ship it" state="delivered" />)
  const plain = row().querySelector('[data-slot="icon-tile"]')
  expect(plain?.textContent).toBe('Y')
  expect(plain?.querySelector('[data-slot="monogram"]')).not.toBeNull()
  expect(plain?.getAttribute('data-tint')).toBe('blue')

  render(<ChannelMessage from="You" at="10:02" text="ship it" state="delivered" face={<img data-face="" alt="" />} />)
  const tile = row().querySelector('[data-slot="icon-tile"]')
  expect(tile?.querySelector('img[data-face]')).not.toBeNull()
  expect(tile?.textContent).toBe('')
  expect(tile?.hasAttribute('data-tint')).toBe(false)
})
