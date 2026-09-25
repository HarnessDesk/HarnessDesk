import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { KeyValue, KeyValueRow, MiddleTruncate } from './key-value'

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

const draw = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const found = container.firstElementChild
  if (!(found instanceof HTMLElement)) throw new Error('nothing rendered')
  return found
}

/** jsdom lays nothing out, so a width is whatever the test says it is. */
const sized = (node: Element, scroll: number, client: number): void => {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: client })
}

it('reads as an inspector: a muted key column of a shared width, and left-aligned values that wrap', () => {
  const list = draw(
    <KeyValue>
      <KeyValueRow label="Declares">When a pull request opens or is pushed, open review-pr, at most 4 at once.</KeyValueRow>
    </KeyValue>,
  )
  // A value column that can go below its longest word, so nothing runs past the container.
  expect(list.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
  const key = list.querySelector('dt')
  const value = list.querySelector('dd')
  expect(key?.className).toContain('text-(--hd-muted-foreground)')
  expect(key?.className).toContain('min-w-20')
  expect(value?.className).toContain('text-left')
  expect(value?.className).toContain('break-words')
  expect(value?.className).toContain('min-w-0')
  expect(value?.className).not.toContain('text-right')
})

it('right-aligns a value on tabular figures only when the row says numeric', () => {
  const list = draw(
    <KeyValue>
      <KeyValueRow label="Charged" numeric emphasis>$212.40</KeyValueRow>
      <KeyValueRow label="Repository">acme/widgets</KeyValueRow>
    </KeyValue>,
  )
  const [money, words] = [...list.querySelectorAll('dd')]
  expect(money?.className).toContain('text-right')
  expect(money?.className).toContain('tabular-nums')
  expect(money?.className).toContain('font-semibold')
  expect(words?.className).not.toContain('text-right')
  expect(words?.className).not.toContain('tabular-nums')
})

it('gives a path up in the middle, keeping its last segment whole', () => {
  const path = '~/work/storefront/.harnessdesk/triggers/review-every-pull-request.json'
  const list = draw(
    <KeyValue>
      <KeyValueRow label="Source" kind="path">{path}</KeyValueRow>
    </KeyValue>,
  )
  const line = list.querySelector<HTMLElement>('[data-slot="middle-truncate"]')
  if (!line) throw new Error('no path line')
  expect(line.className).toContain('overflow-hidden')
  expect(line.className).toContain('whitespace-nowrap')
  const head = line.querySelector('[data-part="head"]')
  const tail = line.querySelector('[data-part="tail"]')
  expect(head?.textContent).toBe('~/work/storefront/.harnessdesk/triggers')
  expect(head?.className).toContain('truncate')
  expect(tail?.textContent).toBe('/review-every-pull-request.json')
  // Only the head gives way; the name keeps itself whole while it can.
  expect(tail?.className).toContain('shrink-0')
  expect(head?.className).toContain('min-w-6')
  expect(line.textContent).toBe(path)
})

it('names the whole path in title while it is cut, and nothing once it fits', () => {
  const path = '/Users/shane/code/HarnessDesk/.harnessdesk/triggers/review.json'
  const line = draw(<MiddleTruncate>{path}</MiddleTruncate>)
  const head = line.querySelector('[data-part="head"]')
  const tail = line.querySelector('[data-part="tail"]')
  if (!head || !tail) throw new Error('no parts')
  sized(head, 300, 120)
  sized(tail, 80, 80)
  act(() => { line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(line.getAttribute('title')).toBe(path)
  sized(head, 120, 120)
  act(() => { line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(line.hasAttribute('title')).toBe(false)
})

it('keeps the panel variant compact and left-aligned', () => {
  const list = draw(
    <KeyValue variant="panel">
      <KeyValueRow variant="panel" label="Branch">main</KeyValueRow>
    </KeyValue>,
  )
  expect(list.className).toContain('text-sm')
  expect(list.querySelector('dt')?.className).toContain('text-xs')
  expect(list.querySelector('dt')?.className).not.toContain('min-w-20')
  expect(list.querySelector('dd')?.className).toContain('text-left')
})
