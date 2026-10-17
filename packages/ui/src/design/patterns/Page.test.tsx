import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'

import { Page } from './Page'
import css from './Page.module.css?raw'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['reading', 'wide', 'canvas'] as const)('keeps the %s page gutter on all four sides', (width) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width={width}>content</Page>))
    const page = container.firstElementChild as HTMLElement
    expect(page.dataset['width']).toBe(width)
    expect(page.dataset['inset']).toBe(width === 'canvas' ? 'canvas' : 'reading')
    expect(page.style.padding).toBe(width === 'canvas' ? 'var(--hd-space-2) var(--hd-space-2)' : 'var(--page-top, var(--hd-space-6)) var(--hd-space-6) var(--hd-space-6)')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it('starts a page that opens with its title at the body top, so the title stands on the wordmark line', () => {
  const rule = css.slice(css.indexOf(".page:has(> [data-slot='page-options']"), css.indexOf('--page-top: 0px'))
  expect(rule).toContain(".page:has(> [data-slot='page-options']:first-child > [data-page-head])")
  expect(rule).toContain(".page:has(> :first-child > [data-slot='page-options']:first-child > [data-page-head])")
})

it('separates page blocks by the page stack step', () => {
  expect(css).toMatch(/\.page\s*\{[^}]*gap:\s*var\(--hd-page-stack\)/s)
})

it('fills its destination body only when a page needs remaining-space alignment', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width="wide" fill>content</Page>))
    expect((container.firstElementChild as HTMLElement).dataset['fill']).toBe('')
    expect(css).toMatch(/\.page\[data-fill\]\s*\{[^}]*min-height:\s*100%/s)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it('scrolls itself only when asked, keeping its whole height inside the scroll box', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width="reading">content</Page>))
    expect(container.querySelector('[data-slot="page-scroll"]')).toBeNull()
    act(() => root.render(<Page width="reading" fill scroll>content</Page>))
    const box = container.firstElementChild as HTMLElement
    expect(box.dataset['slot']).toBe('page-scroll')
    expect((box.firstElementChild as HTMLElement).dataset['slot']).toBe('page')
    expect(css).toMatch(/\.scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s)
    expect(css).toMatch(/\.scroll > \.page\s*\{[^}]*flex-shrink:\s*0/s)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it('lets a window own its gutter while retaining the shared page stack', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width="reading" gutter="none">content</Page>))
    const page = container.firstElementChild as HTMLElement
    expect(page.dataset['gutter']).toBe('none')
    expect(page.dataset['width']).toBe('reading')
    expect(page.dataset['inset']).toBeUndefined()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it('lets a canvas page use the shared page top inset without changing its frame', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width="canvas" measure="wide" topInset="page">content</Page>))
    const page = container.firstElementChild as HTMLElement
    expect(page.dataset['topInset']).toBe('page')
    expect(page.dataset['width']).toBe('canvas')
    expect(page.dataset['inset']).toBe('canvas')
    expect(page.style.paddingTop).toBe('var(--page-top, calc(var(--hd-page-gutter) - var(--hd-space-2) + var(--hd-space-px)))')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
