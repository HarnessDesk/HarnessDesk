import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ConversationThread } from './ConversationShell'

/**
 * The dock floats over the thread and the thread reserves its measured height
 * as bottom padding. Reserving is not enough on its own: when a notice joins
 * the dock after the thread was scrolled to its end, the end moves and the
 * last message is left under the dock unless the thread follows it.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
interface Watcher { readonly callback: () => void, watching: boolean }
let watchers: Watcher[]
const resize = { forEach: (run: (callback: () => void) => void) => watchers.filter(watcher => watcher.watching).forEach(watcher => run(watcher.callback)), get length() { return watchers.filter(watcher => watcher.watching).length } }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  watchers = []
  vi.stubGlobal('ResizeObserver', class {
    readonly #watcher: Watcher
    constructor(callback: () => void) { this.#watcher = { callback, watching: false }; watchers.push(this.#watcher) }
    observe() { this.#watcher.watching = true }
    disconnect() { this.#watcher.watching = false }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const box = (element: HTMLElement, sizes: { scrollHeight: number, clientHeight: number }) => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => sizes.scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => sizes.clientHeight })
}

it('keeps its end in view when the dock over it grows, while the reader is at the end', () => {
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  thread.scrollTop = 400
  act(() => thread.dispatchEvent(new Event('scroll')))

  sizes.scrollHeight = 1600
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(1600)
})

it('keeps following when the scroll it made is reported only after the thread grew again', () => {
  // A scroll event is delivered with the next frame, and a window in the background waits long for one: by then a
  // reply may have grown the thread, so the scroll the thread made itself reads as "not at the end". It is not the
  // reader leaving, and the next reply is still followed.
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  thread.scrollTop = 400
  act(() => thread.dispatchEvent(new Event('scroll')))

  sizes.scrollHeight = 1600
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(1600)
  sizes.scrollHeight = 2600
  act(() => thread.dispatchEvent(new Event('scroll')))
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(2600)
})

it('keeps following when the browser moves the thread down itself, as scroll anchoring does (#2149)', () => {
  // Content above the reader changes height (a row near the top, a card under an earlier reply) while a reply grows
  // the end. The browser shifts scrollTop down to keep what is in view still, and reports that as a scroll that is
  // neither the thread's own nor at the end. Nobody scrolled up, so the new reply is still followed.
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  thread.scrollTop = 400
  act(() => thread.dispatchEvent(new Event('scroll')))

  sizes.scrollHeight = 2000
  thread.scrollTop = 440
  act(() => thread.dispatchEvent(new Event('scroll')))
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(2000)
})

it('keeps following when content above shrinks and the browser moves the thread up, with no scroll by the person (#2149)', () => {
  // A card above the view folds while a reply grows the end. Scroll anchoring moves scrollTop up by what folded, which
  // reads as a scroll up; the content changed under it and nobody scrolled, so the reply is still followed.
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  thread.scrollTop = 400
  act(() => thread.dispatchEvent(new Event('scroll')))

  sizes.scrollHeight = 1600
  thread.scrollTop = 300
  act(() => thread.dispatchEvent(new Event('scroll')))
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(1600)
})

it('lets go of the end when the person scrolls up while the content changes', () => {
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  thread.scrollTop = 400
  act(() => thread.dispatchEvent(new Event('scroll')))

  act(() => thread.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })))
  sizes.scrollHeight = 1600
  thread.scrollTop = 300
  act(() => thread.dispatchEvent(new Event('scroll')))
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(300)
})

it('leaves a reader who scrolled up where they are', () => {
  act(() => root.render(<ConversationThread keepEnd><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  const sizes = { scrollHeight: 1200, clientHeight: 800 }
  box(thread, sizes)
  // The thread starts at its end; the reader scrolls up from there.
  act(() => resize.forEach(callback => callback()))
  thread.scrollTop = 100
  act(() => thread.dispatchEvent(new Event('scroll')))

  sizes.scrollHeight = 1600
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(100)
})

it('starts at its end before anyone scrolls, still calls the screen\'s own onScroll, and does nothing unasked', () => {
  const onScroll = vi.fn()
  act(() => root.render(<ConversationThread keepEnd onScroll={onScroll}><p>last message</p></ConversationThread>))
  const thread = container.firstElementChild as HTMLElement
  box(thread, { scrollHeight: 900, clientHeight: 800 })
  act(() => resize.forEach(callback => callback()))
  expect(thread.scrollTop).toBe(900)
  act(() => thread.dispatchEvent(new Event('scroll')))
  expect(onScroll).toHaveBeenCalledTimes(1)

  act(() => root.render(<ConversationThread><p>last message</p></ConversationThread>))
  expect(resize).toHaveLength(0)
})
