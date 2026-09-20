import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import css from './Settings.module.css?raw'
import { Keycap, PageHead, SearchMatch, Text } from './Settings'

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

it('names its role and carries tone, truncation, and numeric semantics', () => {
  act(() =>
    root.render(
      <Text as="strong" role="figure" tone="warning" truncate numeric>
        12%
      </Text>,
    ),
  )
  const text = container.firstElementChild as HTMLElement | null
  expect(text?.tagName).toBe('STRONG')
  expect(text?.dataset['slot']).toBe('text')
  expect(text?.dataset['role']).toBe('figure')
  expect(text?.dataset['tone']).toBe('warning')
  expect(text?.className).toContain('text-(--hd-warning-ink)')
  expect(text?.className).not.toContain('text-(--hd-foreground)')
  expect(text?.className).toContain('truncate')
  expect(text?.className).toContain('tabular-nums')
})

it('keeps the wordmark and navigation-name roles distinct from page and row titles', () => {
  act(() =>
    root.render(
      <>
        <Text role="wordmark">HarnessDesk</Text>
        <Text role="navigation" tint="violet" fade>Make the webhook receiver reliable</Text>
      </>,
    ),
  )

  const wordmark = container.querySelector<HTMLElement>('[data-role="wordmark"]')
  const navigation = container.querySelector<HTMLElement>('[data-role="navigation"]')
  expect(wordmark?.className).toContain('text-(length:--hd-heading)')
  expect(wordmark?.className).toContain('font-semibold')
  expect(navigation?.className).toContain('font-normal')
  expect(navigation?.className).toContain('text-(--hd-tint-violet-ink)')
  expect(navigation?.dataset['tint']).toBe('violet')
  expect(navigation?.className).toContain('[mask-image:var(--hd-fade)]')
  expect(navigation?.className).not.toContain('truncate')
})

it('page titles match the wordmark: 20px semibold (owner decision 2026-09-19)', () => {
  act(() =>
    root.render(
      <>
        <PageHead title="General" />
        <Text role="page">Appearance</Text>
      </>,
    ),
  )

  const pageRole = container.querySelector<HTMLElement>('[data-role="page"]')
  expect(pageRole?.className).toContain('text-(length:--hd-heading)')
  expect(pageRole?.className).toContain('leading-(--hd-line-heading)')
  expect(pageRole?.className).toContain('font-semibold')
  expect(css).toMatch(/\.pageTitle\s*{[^}]*font-size:\s*var\(--hd-heading\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*line-height:\s*var\(--hd-line-heading\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*font-weight:\s*var\(--hd-weight-semibold\)/s)
})

it('page title and wordmark compute the same size, line-height and weight', () => {
  act(() =>
    root.render(
      <>
        <Text role="wordmark">HarnessDesk</Text>
        <Text role="page">General</Text>
      </>,
    ),
  )

  const wordmark = container.querySelector<HTMLElement>('[data-role="wordmark"]')
  const page = container.querySelector<HTMLElement>('[data-role="page"]')
  expect(wordmark).toBeTruthy()
  expect(page).toBeTruthy()
  expect(page?.className).toContain('text-(length:--hd-heading)')
  expect(wordmark?.className).toContain('text-(length:--hd-heading)')
  expect(page?.className).toContain('leading-(--hd-line-heading)')
  expect(wordmark?.className).toContain('leading-(--hd-line-heading)')
  expect(page?.className).toContain('font-semibold')
  expect(wordmark?.className).toContain('font-semibold')
})

it('owns the keycap and matched-text roles used by search surfaces', () => {
  act(() => root.render(
    <>
      <Keycap>esc</Keycap>
      <SearchMatch>sett</SearchMatch>
    </>,
  ))

  expect(container.querySelector('kbd[data-slot="keycap"]')?.textContent).toBe('esc')
  expect(container.querySelector('mark[data-slot="search-match"]')?.textContent).toBe('sett')
})
