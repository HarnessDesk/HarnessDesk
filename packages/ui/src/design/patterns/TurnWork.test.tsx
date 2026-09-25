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

it('keeps a ticking trail out of the live region, so only the words are announced', () => {
  act(() => root.render(<TurnWorkLive data-line="" trail="· 4.2s">Codex is working</TurnWorkLive>))
  const line = container.querySelector('[data-line]')!
  const [live] = slot('turn-work-live')
  expect(live?.getAttribute('role')).toBe('status')
  expect(live?.textContent).toBe('Codex is working')
  // The line reads whole; the clock is beside the region, never in it.
  expect(line.textContent).toBe('Codex is working· 4.2s')
  expect(line.getAttribute('role')).toBeNull()
  const trail = container.querySelector('[data-slot="turn-work-live-trail"]')
  expect(trail?.closest('[role="status"]')).toBeNull()
  expect(trail?.className).toContain('tabular-nums')
})

it('draws a settled line in the same box and ink, without the shimmer', () => {
  act(() => root.render(<TurnWorkLive settled>Waiting on you</TurnWorkLive>))
  const [live] = slot('turn-work-live')
  expect(live?.hasAttribute('data-settled')).toBe(true)
  expect(live?.className).toContain('text-base')
  expect(live?.className).toContain('min-h-(--hd-control-h)')
  expect(live?.firstElementChild?.className).not.toContain('animate-[shimmer_')
})
