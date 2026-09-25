import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StepFoldBody, TurnItem, TurnWorkChevron, TurnWorkHeaderLabel, TurnWorkLive, TurnWorkReceipt } from './TurnWork'

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

  it('opens a step fold under its words in the light register and below a rule otherwise', () => {
    act(() => root.render(
      <>
        <StepFoldBody register="light"><div>step</div></StepFoldBody>
        <StepFoldBody><div>step</div></StepFoldBody>
      </>,
    ))
    const [light, ordinary] = slot('step-fold-body')
    for (const body of [light, ordinary]) expect(body?.className).toContain('[&>div]:py-0')
    expect(light?.className).toContain('pl-(--hd-space-5)')
    expect(light?.className).toContain('border-t-0')
    expect(ordinary?.className).toContain('border-t border-(--hd-border)')
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

  it('keeps a tally muted and trouble toned in the receipt and the chevron', () => {
    act(() => root.render(
      <>
        <TurnWorkReceipt>· read 2 files</TurnWorkReceipt>
        <TurnWorkReceipt tone="warning">· 1 declined</TurnWorkReceipt>
        <TurnWorkReceipt tone="danger">· 1 failed</TurnWorkReceipt>
        <TurnWorkChevron open={false} />
        <TurnWorkChevron open trouble />
      </>,
    ))
    const [tally, declined, failed] = slot('turn-work-receipt')
    expect(tally?.className).toContain('text-(--hd-muted-foreground)')
    expect(declined?.className).toContain('text-(--hd-warning-ink)')
    expect(failed?.className).toContain('text-(--hd-danger-ink)')
    const [closed, open] = slot('turn-work-chevron')
    expect(closed?.hasAttribute('data-open')).toBe(false)
    expect(closed?.getAttribute('class')).toContain('text-(--hd-muted-foreground)')
    expect(open?.hasAttribute('data-open')).toBe(true)
    expect(open?.getAttribute('class')).toContain('text-(--hd-warning-ink)')
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
