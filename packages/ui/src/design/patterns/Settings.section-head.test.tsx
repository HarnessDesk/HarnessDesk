import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { SectionHead } from './Settings'
import css from './Settings.module.css?raw'

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

it('keeps card labels distinct from an explicit page-section heading', () => {
  act(() =>
    root.render(
      <>
        <SectionHead name="Your data" />
        <SectionHead
          level="heading"
          name="What is left"
          description="The selected account is out of quota."
          action={<button>Range</button>}
          sticky
        />
      </>,
    ),
  )
  const [label, heading] = container.querySelectorAll<HTMLElement>('[data-slot="section-name"]')
  expect(label?.dataset['level']).toBe('label')
  expect(label?.tagName).toBe('H2')
  expect(heading?.dataset['level']).toBe('heading')
  expect(heading?.tagName).toBe('H2')
  expect(heading?.getAttribute('data-slot')).toBe('section-name')
  const name = heading?.querySelector<HTMLElement>('[data-slot="text"]')
  expect(name?.getAttribute('data-role')).toBe('section')
  expect(name?.className).toContain('text-(length:--hd-text-lg)')
  expect(name?.className).toContain('leading-(--hd-line-lg)')
  expect(name?.className).toContain('font-semibold')
  expect(name?.className).toContain('text-(--hd-foreground)')
  expect(heading?.closest('[data-sticky]')?.textContent).toBe('What is leftThe selected account is out of quota.Range')
  expect(heading?.nextElementSibling?.getAttribute('data-slot')).toBe('section-description')
  const action = heading?.closest('[data-section-head]')?.querySelector('[data-slot="section-action"]')
  expect(action?.textContent).toBe('Range')
  expect(action?.firstElementChild?.tagName).toBe('BUTTON')

  // The card label is the one group label, not a style of its own.
  expect(label?.className).toContain('text-(length:--hd-text-sm)')
  expect(label?.className).toContain('text-(--hd-secondary-foreground)')
  expect(css).not.toMatch(/\.sectionName\s*\{[^}]*font-size/s)
  expect(css).not.toMatch(/\.sectionName\[data-level='heading'\]/)
})

it('truncates section names and moves their controls to a second row when they do not fit', () => {
  const content = /\.sectionHeadContent\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  const text = /\.sectionHeadText\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  const name = /\.sectionName\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  expect(content).toMatch(/flex-wrap:\s*wrap/)
  expect(text).toMatch(/min-width:\s*0/)
  expect(name).toMatch(/min-width:\s*0/)
  expect(name).toMatch(/overflow:\s*hidden/)
  expect(name).toMatch(/text-overflow:\s*ellipsis/)
  expect(name).toMatch(/white-space:\s*nowrap/)
})

/* Page headings keep the content edge even when the body below them is inset. */
it('keeps page section heads on one text edge regardless of their body', () => {
  expect(css).not.toMatch(/\.sectionHead:has\(\+ \[data-slot='rows'\]\)/)
  expect(css).not.toMatch(/\.sectionHead:has\(\+ \[role='radiogroup'\]\)/)
  expect(css).not.toMatch(/\.sectionHead:has\(\+ \[data-slot='table-container'\]\)/)
  expect(css).not.toMatch(/\.sectionHead:has\(\+ \[data-slot='summary-list'\]\)/)
  const bare = /\.sectionHead\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  expect(bare).not.toMatch(/padding(?:-inline)?\s*:/)
})
