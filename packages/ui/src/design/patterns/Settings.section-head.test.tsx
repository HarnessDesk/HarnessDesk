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

/*
 * A `SectionHead` sits above whatever body it names, which is a `Rows` card
 * as often as it is a `Note` or a plain button (ProjectTriggers' own body,
 * `.sectionHead`'s inset is earned by that card, and applying it whether or
 * not the body is one put a Note-bodied head's label 17px right of a body
 * that starts flush with the page. jsdom does not resolve `:has()` against
 * layout, so this reads the rule's own selector rather than a computed
 * style; `e2e/ui-system/page-grammar.spec.ts` measures the two cases live.
 */
it('earns its card inset only when a Rows card is the very next thing it names', () => {
  expect(css).toMatch(/\.sectionHead:has\(\+ \[data-slot='rows'\]\)\s*\{[^}]*padding-inline:/s)
  // The bare `.sectionHead` rule — the one every head gets — carries no
  // inline padding of its own; only the conditional one does.
  const bare = /\.sectionHead\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
  expect(bare).not.toMatch(/padding-inline/)
})
