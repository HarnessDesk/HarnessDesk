import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TurnItem, TurnWorkHeaderLabel, TurnWorkLive } from './TurnWork'

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

const slot = (name: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`)]

describe('the rhythm of transcript items', () => {
  it('gives an item four pixels in the ordinary register and one in the light one', () => {
    act(() => root.render(
      <>
        <TurnItem>Ordinary</TurnItem>
        <TurnItem register="light">Light</TurnItem>
      </>,
    ))
    const [ordinary, light] = slot('turn-item')
    expect(ordinary?.className).toContain('py-(--hd-space-1)')
    expect(light?.className).toContain('py-(--hd-space-px)')
  })
})

describe('the work header', () => {
  it('says where the turn stands in its ink, in tabular figures', () => {
    act(() => root.render(
      <>
        <TurnWorkHeaderLabel>Worked for 3s</TurnWorkHeaderLabel>
        <TurnWorkHeaderLabel state="running">Working for 3s</TurnWorkHeaderLabel>
        <TurnWorkHeaderLabel state="trouble">Worked for 3s</TurnWorkHeaderLabel>
      </>,
    ))
    const [done, running, trouble] = slot('turn-work-header-label')
    for (const label of [done, running, trouble]) expect(label?.className).toContain('tabular-nums')
    expect(done?.className).not.toContain('text-(')
    expect(running?.className).toContain('text-(--hd-secondary-foreground)')
    expect(trouble?.className).toContain('text-(--hd-warning-ink)')
  })
})

it('announces the live line politely, as tall as a step row, and stills it for reduced motion', () => {
  act(() => root.render(<TurnWorkLive>Reading c.ts</TurnWorkLive>))
  const [live] = slot('turn-work-live')
  expect(live?.getAttribute('role')).toBe('status')
  expect(live?.getAttribute('aria-live')).toBe('polite')
  expect(live?.className).toContain('min-h-(--hd-control-h)')
  expect(live?.textContent).toBe('Reading c.ts')
  const words = live?.firstElementChild
  expect(words?.className).toContain('animate-[shimmer_')
  expect(words?.className).toContain('motion-reduce:animate-none')
})
