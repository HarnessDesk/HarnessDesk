import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { SortableHandle } from '../ui/sortable-list'
import {
  MessageQueueActions,
  MessageQueueFrame,
  MessageQueueHeader,
  MessageQueueList,
  MessageQueueRow,
  MessageQueueTiming,
} from './MessageQueue'

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

it('owns the queued-message frame, rows and state marks', () => {
  act(() => root.render(
    <MessageQueueFrame paused>
      <MessageQueueHeader>Two messages waiting</MessageQueueHeader>
      <MessageQueueList announcement="Moved it to position 1 of 1">
        <MessageQueueRow sending dragging drop>
          <SortableHandle ref={() => {}} onPointerDown={() => {}} onMouseDown={() => {}} onPointerUp={() => {}} aria-label="Move it" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="" disabled={false} />
          <MessageQueueTiming tone="next">next</MessageQueueTiming>
          <MessageQueueActions><button>Remove</button></MessageQueueActions>
        </MessageQueueRow>
      </MessageQueueList>
    </MessageQueueFrame>,
  ))

  expect(container.querySelector('[data-slot="message-queue"]')?.hasAttribute('data-paused')).toBe(true)
  expect(container.querySelector('[data-slot="message-queue-header"]')?.textContent).toBe('Two messages waiting')
  // The list and its rows are the sortable list's: the queue draws only its inset and hover.
  expect(container.querySelector('[data-slot="sortable-list"]')?.tagName).toBe('OL')
  expect(container.querySelector('[data-slot="sortable-announcer"]')?.textContent).toBe('Moved it to position 1 of 1')
  const row = container.querySelector('[data-slot="sortable-row"]')
  expect(row?.tagName).toBe('LI')
  expect(row?.hasAttribute('data-sending')).toBe(true)
  expect(row?.hasAttribute('data-dragging')).toBe(true)
  expect(row?.hasAttribute('data-drop')).toBe(true)
  expect(container.querySelector('[data-slot="sortable-handle"]')?.tagName).toBe('BUTTON')
  expect(container.querySelector('[data-slot="message-queue-timing"]')?.getAttribute('data-tone')).toBe('next')
  expect(container.querySelector('[data-slot="message-queue-actions"] button')?.textContent).toBe('Remove')
})
