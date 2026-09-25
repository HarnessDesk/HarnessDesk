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
  it('is the neutral light when it is given no state', () => {
    act(() => root.render(<Dot />))
    const dot = container.querySelector<HTMLElement>('[data-slot="dot"]')
    expect(dot?.hasAttribute('data-state')).toBe(false)
    const base = (/(?:^|\n)\.dot \{([^}]*)\}/.exec(css)?.[1] ?? '')
    expect(base).toMatch(/background:\s*var\(--hd-muted-foreground\)/)
  })

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

  it('hangs a member’s presence off its tile’s corner, ringed in the ground the tile stands on', () => {
    act(() => root.render(<Dot state="ready" variant="presence" pulse aria-hidden />))
    const light = container.querySelector<HTMLElement>('[data-slot="dot"]')
    expect(light?.dataset['variant']).toBe('presence')
    expect(light?.dataset['ground']).toBe('background')
    expect(css).toMatch(/\.dot\[data-variant='presence'\]\s*\{[^}]*position:\s*absolute[^}]*width:\s*7px[^}]*box-shadow:\s*0 0 0 2px var\(--hd-background\)/s)

    // On a card the ring is the card's popover ground, not the page's.
    act(() => root.render(<Dot state="ready" variant="presence" ground="popover" />))
    expect(container.querySelector<HTMLElement>('[data-slot="dot"]')?.dataset['ground']).toBe('popover')
    expect(css).toMatch(/\.dot\[data-variant='presence'\]\[data-ground='popover'\]\s*\{[^}]*var\(--hd-popover\)/s)

    // A ground only means something to a presence light.
    act(() => root.render(<Dot state="ready" ground="popover" />))
    expect(container.querySelector('[data-slot="dot"]')?.hasAttribute('data-ground')).toBe(false)
  })

  it('stills its pulse for a reader who asked for less motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dot\[data-pulse\]\s*\{\s*animation:\s*none/s)
  })
})
