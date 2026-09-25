import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Tick } from './spark'

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

it('draws a strip entry as a stroke whose emphasis is an attribute, not a colour', () => {
  act(() => root.render(
    <>
      <Tick emphasis="strong" />
      <Tick />
    </>,
  ))
  const [strong, quiet] = [...container.querySelectorAll<HTMLElement>('[data-slot="tick"]')]
  expect(strong?.dataset['emphasis']).toBe('strong')
  expect(strong?.className).toContain('bg-(--hd-foreground)')
  expect(quiet?.dataset['emphasis']).toBe('quiet')
  expect(quiet?.className).toContain('bg-(--hd-muted-foreground)')
  for (const tick of [strong, quiet]) {
    expect(tick?.getAttribute('aria-hidden')).toBe('true')
    expect(tick?.className).toContain('h-(--hd-space-0-5)')
    /* The length is the caller's: a strip magnifies by width. */
    expect(tick?.className).not.toMatch(/(^|\s)w-/)
    expect(tick?.getAttribute('style')).toBeNull()
  }
})
