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
  expect(heading?.closest('[data-sticky]')?.textContent).toBe('What is leftThe selected account is out of quota.Range')
  expect(heading?.nextElementSibling?.getAttribute('data-slot')).toBe('section-description')

  // The card label is the one group label, not a style of its own.
  expect(label?.className).toContain('text-(length:--hd-text-sm)')
  expect(label?.className).toContain('text-(--hd-secondary-foreground)')
  expect(css).not.toMatch(/\.sectionName\s*\{[^}]*font-size/s)
  expect(css).toMatch(/\.sectionName\[data-level='heading'\]\s*\{[^}]*font-size:\s*var\(--hd-text-lg\)[^}]*font-weight:\s*var\(--hd-weight-semibold\)/s)
})
