import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Button } from './button'
import { DisclosureChevron } from './disclosure-chevron'

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

const chevrons = (): SVGElement[] => [...container.querySelectorAll<SVGElement>('[data-slot="disclosure-chevron"]')]

it('owns the quarter turn, the size and the ink of every disclosure', () => {
  act(() => root.render(
    <>
      <DisclosureChevron open={false} />
      <DisclosureChevron open size="sm" />
      <DisclosureChevron open tone="warning" size="lg" />
    </>,
  ))
  const [closed, open, trouble] = chevrons()
  expect(closed?.hasAttribute('data-open')).toBe(false)
  expect(open?.hasAttribute('data-open')).toBe(true)
  for (const chevron of [closed, open, trouble]) {
    const cls = chevron?.getAttribute('class') ?? ''
    expect(cls).toContain('data-[open]:rotate-90')
    expect(cls).toContain('transition-transform')
    expect(chevron?.getAttribute('aria-hidden')).toBe('true')
    /* The same attribute a button already turns, so the two cannot add up. */
    expect(chevron?.hasAttribute('data-chevron')).toBe(true)
  }
  expect(closed?.getAttribute('width')).toBe('13')
  expect(open?.getAttribute('width')).toBe('12')
  expect(trouble?.getAttribute('width')).toBe('14')
  expect(closed?.getAttribute('class')).toContain('text-(--hd-muted-foreground)')
  expect(trouble?.getAttribute('class')).toContain('text-(--hd-warning-ink)')
})

it('turns once inside a button, by the one rotate property both spell', () => {
  act(() => root.render(<Button><DisclosureChevron open /> Show</Button>))
  const [chevron] = chevrons()
  const button = container.querySelector('button')
  expect(button?.className).toContain('[&_[data-chevron][data-open]]:rotate-90')
  expect(chevron?.getAttribute('class')).not.toMatch(/rotate-180|transform:/)
})
