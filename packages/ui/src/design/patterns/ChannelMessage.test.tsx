import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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

it('a message uses a plain runtime glyph and keeps the full sender name on hover', () => {
  render(<ChannelMessage from="Reviewer" fromTitle="Reviewer · Scripted agent · long model selection" brand="codex" tint="green" at="03:35 PM" state="delivered" text="Looks right." />)
  expect(row().dataset.slot).toBe('turn-item')
  expect(row().querySelector('[data-slot="icon-tile"]')?.getAttribute('data-variant')).toBe('bare')
  expect(row().querySelector('[data-slot="icon-tile"] svg')).not.toBeNull()
  // The name is a member's, said in words beside the face.
  expect(row().querySelector('[data-slot="text"][data-role="row"]')?.textContent).toBe('Reviewer')
  expect(row().querySelector('[data-slot="text"][data-role="row"]')?.getAttribute('title')).toBe('Reviewer · Scripted agent · long model selection')
})

it('places the current person on the right using the transcript bubble and keeps outbound facts', () => {
  render(<ChannelMessage own from="You" to="Reviewer" toTitle="Reviewer · complete model name" at="03:35 PM" state="queued" reason="Waiting for the current turn" text="Please check this." />)
  expect(row().hasAttribute('data-own')).toBe(true)
  expect(row().querySelector('[data-slot="message"]')?.getAttribute('data-align')).toBe('end')
  expect(row().querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe('secondary')
  expect(row().querySelector('[data-slot="channel-sender"]')?.className).toContain('sr-only')
  expect(row().querySelector('[data-channel-recipient]')?.getAttribute('aria-label')).toBe('To Reviewer · complete model name')
  expect(row().textContent).toContain('03:35 PM')
  expect(row().textContent).toContain('queued')
  expect(row().textContent).toContain('Waiting for the current turn')
})

it('keeps an agent named You on the left and bounds rich replies to the shared reading column', () => {
  render(<ChannelMessage from="You" to="Builder" at="03:35 PM" state="delivered" text="A reply" body={<p><a href="https://example.com">Evidence</a><code>result</code></p>} />)
  expect(row().hasAttribute('data-own')).toBe(false)
  const message = row().querySelector('[data-slot="message"]')!
  expect(message.getAttribute('data-align')).toBe('start')
  expect(message.className).toContain('max-w-(--hd-column)')
  expect(row().querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe('ghost')
  expect(row().querySelector('a')?.textContent).toBe('Evidence')
  expect(row().querySelector('code')?.textContent).toBe('result')
})

it('keeps a grouped own message on the right with its own timestamp and delivery', () => {
  render(<ChannelMessage own grouped from="You" at="03:36 PM" state="delivered" text="And this too." />)
  expect(row().querySelector('[data-slot="message"]')?.getAttribute('data-align')).toBe('end')
  expect(row().querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe('secondary')
  expect(row().querySelector('[data-slot="channel-head"]')).toBeNull()
  expect(row().firstElementChild?.textContent).toBe('')
  expect(row().textContent).toContain('03:36 PM, delivered')
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
  // Delivery stays available on the timestamp but leaves the visible line.
  const facts = row().querySelector('[data-slot="meta-list"]')
  expect([...(facts?.children ?? [])].map((one) => one.textContent)).toEqual(['03:35 PM, delivered'])
  expect(facts?.querySelector('span')?.getAttribute('title')).toBe('delivered')
  expect(facts?.querySelector('.sr-only')?.textContent).toBe(', delivered')
})

it('delivery is said out loud, and an answer says where it landed', () => {
  render(<ChannelMessage from="R" at="1" state="delivered" text="x" />)
  expect(row().querySelector('[data-slot="meta-list"]')?.textContent).toContain('delivered')
  expect(row().querySelector('[data-slot="meta-list"] > span')?.getAttribute('title')).toBe('delivered')

  render(<ChannelMessage from="R" at="1" state="shown" text="x" />)
  // `shown` is the loop guard working, not a delivery that failed: the answer
  // is recorded here on purpose. Naming it by what it is not made three
  // working replies read as three errors in a live run.
  expect(row().querySelector('[data-slot="meta-list"] > span')?.getAttribute('title')).toBe('in the room')
  expect(row().querySelector('.sr-only')?.textContent).toBe(', in the room')
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
  expect(row().querySelector('[data-role="member"]')).toBeNull()
  // The time is all that shows, but the delivery state stays reachable on it,
  // hover and screen reader both, as on a full header.
  const time = row().querySelector('[data-slot="text"][data-role="meta"]')
  expect(time?.textContent).toBe('03:35 PM, delivered')
  expect(time?.getAttribute('title')).toBe('delivered')
  expect(time?.querySelector('.sr-only')?.textContent).toBe(', delivered')
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

it('keeps a signal timestamp separate from its compact activity sentence', () => {
  // These sentences wrap to three lines. A floated column put the time beside
  // the *first* of them, on an edge nothing else in the room lines up with.
  render(
    <ChannelSignal
      by="Reviewer"
      said="completed #1 — verify never builds the renderer"
      at="03:31 PM"
    />,
  )
  const sentence = container.querySelector('[data-slot="channel-event-head"] > [data-slot="text"]')
  expect(sentence?.textContent).not.toContain('03:31 PM')
  expect(container.querySelector('[data-slot="channel-event-head"]')?.lastElementChild?.textContent).toBe('03:31 PM')
})

it('keeps a signal’s report under its sentence, folded when long', () => {
  // Joined into the sentence, a completion's report made every signal a slab.
  const report = 'PR #1559 updated; all 12 findings have committed repair claims. '.repeat(4)
  render(<ChannelSignal by="Implementer" said="completed #3 — Answer review round 1" detail={report} at="03:34 PM" />)
  const sentence = container.querySelector('[data-slot="channel-event-head"] > [data-slot="text"]')
  expect(container.querySelector('[data-slot="channel-event-head"]')?.lastElementChild?.textContent).toBe('03:34 PM')
  expect(sentence?.textContent).not.toContain('repair claims')
  const detail = container.querySelector('[data-slot="signal-detail"]')!
  expect(detail.textContent).toContain('repair claims')
  expect(detail.querySelector('p')?.className).toContain('line-clamp-2')
  expect(detail.querySelector('button')?.textContent).toBe('Show all')
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
  expect(plain?.querySelector('svg')).not.toBeNull()
  expect(plain?.getAttribute('data-variant')).toBe('bare')

  render(<ChannelMessage from="You" at="10:02" text="ship it" state="delivered" face={<img data-face="" alt="" />} />)
  const tile = row().querySelector('[data-slot="icon-tile"]')
  expect(tile?.querySelector('img[data-face]')).not.toBeNull()
  expect(tile?.textContent).toBe('')
  expect(tile?.hasAttribute('data-tint')).toBe(false)
})

it('offers "Show more" only when nine rendered lines do not hold the message, and says so on the toggle', () => {
  const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
  const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(252)
  try {
    const long = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n')
    render(<ChannelMessage from="Reviewer" at="03:35 PM" state="delivered" text={long} />)
    const more = container.querySelector<HTMLButtonElement>('[data-slot="channel-more"]')
    expect(more?.textContent).toBe('Show more')
    expect(more?.getAttribute('aria-expanded')).toBe('false')
    act(() => more?.click())
    const toggled = container.querySelector<HTMLButtonElement>('[data-slot="channel-more"]')
    expect(toggled?.textContent).toBe('Show less')
    expect(toggled?.getAttribute('aria-expanded')).toBe('true')
  } finally {
    scrollHeight.mockRestore()
    clientHeight.mockRestore()
  }
})

it('reserves the sender and timestamp while a long recipient list gives up its own width', () => {
  render(<ChannelMessage from="You" to="3 agents" toTitle="Reviewer with a long model name, Builder with a long model name, Auditor" at="03:35 PM" state="delivered" text="Check the result." />)
  const sender = row().querySelector('[data-slot="channel-sender"]')!
  expect(sender.textContent).toBe('You')
  expect(sender.className).toContain('shrink-0')
  const recipient = row().querySelector('[data-channel-recipient]')!
  expect(recipient.textContent).toBe('to 3 agents')
  expect(recipient.getAttribute('title')).toContain('Reviewer with a long model name')
  expect(recipient.getAttribute('aria-label')).toContain('Auditor')
  expect(row().querySelector('[data-slot="meta-list"]')?.className).toContain('shrink-0')
})
