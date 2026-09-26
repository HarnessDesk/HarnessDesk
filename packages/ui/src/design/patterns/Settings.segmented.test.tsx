import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Segmented } from './Settings'
import css from './Settings.module.css?raw'

/**
 * `Segmented` documents its own look as "a filled track with the chosen
 * answer lifted out of it" (see the pattern's own JSDoc, above the
 * component). It rendered instead as the app's quiet `--hd-hover` wash —
 * grey on grey, with the unchosen answers at tertiary ink rather than
 * secondary — because the vendored `ToggleGroup` primitive it sits on
 * presses with `data-pressed:bg-accent data-pressed:text-accent-foreground`
 * (shadcn's registry default), and Tailwind's generated sheet loads after
 * every CSS module: at equal specificity between that utility and this
 * file's own `.segItem[data-pressed]`, the utility won.
 *
 * This pins the two things that regressed: the attribute the CSS relies on
 * (`data-pressed`, not `aria-checked` or a re-vendored spelling), and the
 * three tokens the chosen segment actually renders with — so a future
 * re-vendoring of `toggle-group.tsx`, or a stale `cn()` merge, fails a test
 * instead of quietly reintroducing the wash.
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

const OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
] as const

const draw = () => {
  act(() => {
    root.render(
      <Segmented options={OPTIONS} value="day" onChange={() => {}} label="Range" />,
    )
  })
  const items = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const [chosen, unchosen] = items
  if (!chosen || !unchosen) throw new Error('expected two segments')
  return { chosen, unchosen }
}

it('marks only the chosen segment with the attribute the CSS relies on', () => {
  const { chosen, unchosen } = draw()
  expect(chosen.hasAttribute('data-pressed')).toBe(true)
  expect(unchosen.hasAttribute('data-pressed')).toBe(false)
})

it('lifts the chosen segment on the card, its own shadow, and primary ink — never the hover wash', () => {
  const { chosen } = draw()
  // Pinned against `design/ui/toggle-group.tsx`'s `toggleVariants`: a
  // re-vendoring that brings back `bg-accent`/`text-accent-foreground` fails
  // here rather than only being visible in a screenshot.
  expect(chosen.className).toContain('data-pressed:bg-(--hd-card)')
  expect(chosen.className).toContain('data-pressed:text-(--hd-foreground)')
  expect(chosen.className).toContain('data-pressed:shadow-(--hd-shadow-sm)')
  expect(chosen.className).not.toContain('data-pressed:bg-accent')
  expect(chosen.className).not.toContain('data-pressed:text-accent-foreground')
})

it('keeps an unchosen answer at secondary ink — explanation, not a count', () => {
  expect(css).toMatch(/\.segItem\s*\{[^}]*color:\s*var\(--hd-secondary-foreground\)/s)
  expect(css).not.toMatch(/\.segItem\s*\{[^}]*color:\s*var\(--hd-muted-foreground\)/s)
})

it('agrees with the Tailwind utilities on the same three tokens, so load order cannot put them out of sync', () => {
  expect(css).toMatch(
    /\.segItem\[data-pressed\]\s*\{[^}]*background:\s*var\(--hd-card\)[^}]*color:\s*var\(--hd-foreground\)[^}]*box-shadow:\s*var\(--hd-shadow-sm\)/s,
  )
})
