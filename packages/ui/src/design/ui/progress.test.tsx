import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Progress, ProgressRing, ProgressStack } from './progress'

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

describe('remaining progress', () => {
  it('fills with the amount left and owns the warning thresholds', () => {
    act(() => root.render(<Progress value={12} measure="remaining" label="12% left" />))
    const progress = container.querySelector<HTMLElement>('[data-slot="progress"]')
    const fill = container.querySelector<HTMLElement>('[data-slot="progress-fill"]')
    expect(progress?.dataset['measure']).toBe('remaining')
    expect(progress?.dataset['tone']).toBe('warning')
    expect(fill?.style.width).toBe('12%')
    expect(progress?.textContent).toContain('12% left')

    act(() => root.render(<Progress value={0} measure="remaining" label={false} />))
    expect(container.querySelector<HTMLElement>('[data-slot="progress"]')?.dataset['tone']).toBe('danger')
    expect(container.querySelector<HTMLElement>('[data-slot="progress-track"]')?.dataset['empty']).toBe('')
  })

  it('reports an unknown remainder without announcing zero', () => {
    act(() => root.render(<Progress value={null} measure="remaining" aria-label="Weekly allowance" />))
    const progress = container.querySelector<HTMLElement>('[data-slot="progress"]')
    expect(progress?.getAttribute('aria-valuenow')).toBeNull()
    expect(progress?.getAttribute('aria-valuetext')).toBe('not reported')
    expect(progress?.dataset['unknown']).toBe('')
  })
})

describe('progress variants', () => {
  it('draws a labelled ring, including the unknown state', () => {
    act(() => root.render(<ProgressRing value={66} size={28} tone="warning" label="Context window" />))
    const ring = container.querySelector<HTMLElement>('[data-slot="progress-ring"]')
    expect(ring?.getAttribute('role')).toBe('progressbar')
    expect(ring?.getAttribute('aria-label')).toBe('Context window')
    expect(ring?.getAttribute('aria-valuenow')).toBe('66')
    expect(ring?.dataset['tone']).toBe('warning')

    act(() => root.render(<ProgressRing value={null} size={16} label="Context window unknown" />))
    expect(container.querySelector<HTMLElement>('[data-slot="progress-ring"]')?.dataset['unknown']).toBe('')
  })

  it('draws a composed reading as named parts', () => {
    act(() =>
      root.render(
        <ProgressStack
          label="What is in context"
          parts={[
            { id: 'instructions', value: 60 },
            { id: 'tools', value: 40 },
          ]}
        />,
      ),
    )
    const stack = container.querySelector<HTMLElement>('[data-slot="progress-stack"]')
    expect(stack?.getAttribute('role')).toBe('img')
    expect(stack?.getAttribute('aria-label')).toBe('What is in context')
    expect(stack?.querySelectorAll('[data-slot="progress-stack-part"]')).toHaveLength(2)
  })
})

describe('ProgressStack colours', () => {
  it('keeps the brand ramp for parts of one thing, and a kind colour for kinds', () => {
    act(() => root.render(
      <>
        <ProgressStack label="What is in context" parts={[{ id: 'a', value: 60 }, { id: 'b', value: 40 }]} />
        <ProgressStack
          label="Measured time by kind of step"
          parts={[{ id: 'reasoning', value: 70, tint: 'violet' }, { id: 'fileChange', value: 30, tone: 'success' }]}
        />
      </>,
    ))
    const [ramp, kinds] = [...container.querySelectorAll<HTMLElement>('[data-slot="progress-stack"]')]
    const rampParts = [...(ramp?.querySelectorAll<HTMLElement>('[data-slot="progress-stack-part"]') ?? [])]
    expect(rampParts.map((part) => part.dataset['part'])).toEqual(['0', '1'])
    const kindParts = [...(kinds?.querySelectorAll<HTMLElement>('[data-slot="progress-stack-part"]') ?? [])]
    expect(kindParts[0]?.dataset['part']).toBeUndefined()
    expect(kindParts[0]?.className).toContain('bg-(--hd-tint-violet-ink)')
    expect(kindParts[1]?.className).toContain('bg-(--hd-success)')
    expect(kindParts[0]?.style.width).toBe('70%')
  })
})
