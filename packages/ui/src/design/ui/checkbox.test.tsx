import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Checkbox } from './checkbox'

/**
 * The box, and the box with the words it answers for.
 *
 * Pinned: with a `label` the part is one `<label>` holding the box and then
 * the words, so pressing the words ticks the box, the words name it, and
 * `className` places the whole pair; without one it is the box alone, as
 * vendored.
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

const Picked = ({ label }: { label?: string }) => {
  const [on, setOn] = useState(false)
  return <Checkbox className="place" checked={on} onCheckedChange={(next) => setOn(next === true)} label={label} />
}

it('draws the box and its words as one label the words tick', async () => {
  await act(async () => root.render(<Picked label="Codex" />))
  const label = container.firstElementChild
  expect(label?.tagName).toBe('LABEL')
  expect(label?.getAttribute('data-slot')).toBe('checkbox-label')
  expect(label?.classList.contains('place')).toBe(true)
  const box = label?.querySelector('[role="checkbox"]')
  // The box first, then the words.
  expect(label?.firstElementChild).toBe(box)
  expect(label?.textContent).toBe('Codex')
  expect(box?.classList.contains('place')).toBe(false)
  expect(box?.getAttribute('aria-checked')).toBe('false')
  const words = [...(label?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE)
  await act(async () => {
    ;(words?.parentElement as HTMLElement).click()
  })
  expect(box?.getAttribute('aria-checked')).toBe('true')
})

it('is the box alone without words', async () => {
  await act(async () => root.render(<Picked />))
  const box = container.firstElementChild
  expect(box?.getAttribute('role')).toBe('checkbox')
  expect(box?.classList.contains('place')).toBe(true)
  expect(container.querySelector('label')).toBeNull()
})

it('sets the box first and every word after it, text nodes included', async () => {
  await act(async () =>
    root.render(<Checkbox label={<>Also remove <strong>2</strong> copies</>} />),
  )
  const label = container.firstElementChild as HTMLElement
  const nodes = [...label.childNodes]
  const box = nodes.findIndex((node) => node instanceof HTMLElement && node.getAttribute('role') === 'checkbox')
  const words = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => (node.nodeType === Node.TEXT_NODE ? node.textContent?.trim() : node instanceof HTMLElement && node.textContent?.trim() && node.getAttribute('role') !== 'checkbox'))
  expect(box).toBe(0)
  expect(words.map(({ node }) => node.textContent)).toEqual(['Also remove ', '2', ' copies'])
  expect(words.every(({ index }) => index > box)).toBe(true)
  // The name the box is given is those words, in that order.
  const named = (label.querySelector('[role="checkbox"]')?.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')
  expect(named).toBe('Also remove 2 copies')
})
