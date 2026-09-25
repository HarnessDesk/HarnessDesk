import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StatePill, stateTone, type StateToneState } from './PublicationCard'

describe('stateTone', () => {
  it.each<[StateToneState, string, string]>([
    ['open', 'Open', 'success'],
    ['draft', 'Draft', 'neutral'],
    ['merged', 'Merged', 'brand'],
    ['closed', 'Closed', 'danger'],
    ['passed', 'Passed', 'success'],
    ['failed', 'Failed', 'danger'],
    ['running', 'Running', 'info'],
    ['skipped', 'Skipped', 'neutral'],
    ['timed out', 'Timed out', 'warning'],
  ])('maps %s to %s in the %s tone', (state, label, tone) => {
    expect(stateTone(state)).toEqual({ label, tone })
  })
})

describe('StatePill', () => {
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

  it.each([
    ['open', 'Open'],
    ['draft', 'Draft'],
    ['merged', 'Merged'],
    ['closed', 'Closed'],
  ] as const)('keeps the %s label as %s', (state, label) => {
    act(() => root.render(<StatePill state={state} />))
    expect(container.querySelector('[data-slot="publication-state"]')?.textContent).toBe(label)
  })
})
