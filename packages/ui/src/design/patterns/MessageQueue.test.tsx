import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  MessageQueueActions,
  MessageQueueFrame,
  MessageQueueGrip,
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
      <MessageQueueList>
        <MessageQueueRow sending dragging drop>
          <MessageQueueGrip>grip</MessageQueueGrip>
          <MessageQueueTiming tone="next">next</MessageQueueTiming>
          <MessageQueueActions><button>Remove</button></MessageQueueActions>
        </MessageQueueRow>
      </MessageQueueList>
    </MessageQueueFrame>,
  ))

  expect(container.querySelector('[data-slot="message-queue"]')?.hasAttribute('data-paused')).toBe(true)
  expect(container.querySelector('[data-slot="message-queue-header"]')?.textContent).toBe('Two messages waiting')
  expect(container.querySelector('[data-slot="message-queue-list"]')?.tagName).toBe('OL')
  const row = container.querySelector('[data-slot="message-queue-row"]')
  expect(row?.tagName).toBe('LI')
  expect(row?.hasAttribute('data-sending')).toBe(true)
  expect(row?.hasAttribute('data-dragging')).toBe(true)
  expect(row?.hasAttribute('data-drop')).toBe(true)
  expect(container.querySelector('[data-slot="message-queue-grip"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="message-queue-timing"]')?.getAttribute('data-tone')).toBe('next')
  expect(container.querySelector('[data-slot="message-queue-actions"] button')?.textContent).toBe('Remove')
})
