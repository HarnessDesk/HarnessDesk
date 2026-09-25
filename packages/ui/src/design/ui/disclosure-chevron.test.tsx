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

it('turns the other way at a row end: down folded, up open, and not by a button', () => {
  act(() => root.render(
    <Button>
      Usage
      <DisclosureChevron open={false} placement="trailing" />
      <DisclosureChevron open placement="trailing" />
    </Button>,
  ))
  const [folded, open] = chevrons()
  for (const chevron of [folded, open]) {
    expect(chevron?.getAttribute('data-placement')).toBe('trailing')
    const cls = chevron?.getAttribute('class') ?? ''
    // A half turn of its own; a button's quarter turn of `[data-chevron]`
    // would point an open trailing fold sideways.
    expect(cls).toContain('data-[open]:rotate-180')
    expect(cls).not.toContain('data-[open]:rotate-90')
    expect(chevron?.hasAttribute('data-chevron')).toBe(false)
  }
  // The glyph points down at rest (lucide's chevron-down), not right.
  expect(folded?.getAttribute('class')).toContain('lucide-chevron-down')
  expect(open?.hasAttribute('data-open')).toBe(true)
  expect(chevrons()[0]?.getAttribute('width')).toBe('13')
})

it('keeps the leading fold for every existing consumer by default', () => {
  act(() => root.render(<DisclosureChevron open={false} />))
  const [chevron] = chevrons()
  expect(chevron?.getAttribute('data-placement')).toBe('leading')
  expect(chevron?.getAttribute('class')).toContain('lucide-chevron-right')
})
