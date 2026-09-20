import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Dot } from './Settings'
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

describe('Dot', () => {
  it('names its state and optional activity motion', () => {
    act(() => root.render(<Dot state="signin" pulse />))

    const dot = container.querySelector('[data-slot="dot"][data-state="signin"]')
    expect(dot?.hasAttribute('data-pulse')).toBe(true)
  })

  it('keeps a navigation status at the seven-pixel sidebar size and ink', () => {
    act(() => root.render(<Dot state="available" variant="navigation" />))

    const dot = container.querySelector<HTMLElement>('[data-slot="dot"]')
    expect(dot?.dataset['variant']).toBe('navigation')
    expect(css).toMatch(/\.dot\[data-variant='navigation'\]\s*\{[^}]*width:\s*7px[^}]*height:\s*7px/s)
    expect(css).toMatch(/\.dot\[data-variant='navigation'\]\[data-state='available'\]\s*\{[^}]*var\(--hd-sidebar-muted-foreground\)/s)
  })
})
