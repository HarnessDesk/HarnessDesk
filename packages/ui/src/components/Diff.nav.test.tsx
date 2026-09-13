import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DiffView } from './Diff'

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

const makeDiffWithHunks = (hunkCount: number) => {
  const parts = ['--- file.txt', '+++ file.txt']
  for (let i = 1; i <= hunkCount; i++) {
    parts.push(`@@ -${i * 10},1 +${i * 10},1 @@`)
    parts.push(`-old ${i}`)
    parts.push(`+new ${i}`)
  }
  return parts.join('\n')
}

describe('DiffView hunk navigation (#390)', () => {
  it('resets or clamps hunk index when diff changes to one with fewer hunks', () => {
    const diff8 = makeDiffWithHunks(8)
    const diff2 = makeDiffWithHunks(2)

    act(() => {
      root.render(<DiffView diff={diff8} />)
    })

    const getNextButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Next hunk"]')
    const getPrevButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Previous hunk"]')

    // Navigate to hunk 8 (index 7)
    for (let i = 0; i < 7; i++) {
      act(() => {
        getNextButton()?.click()
      })
    }

    expect(container.textContent).toContain('Hunk 8 of 8')
    expect(getNextButton()?.disabled).toBe(true)
    expect(getPrevButton()?.disabled).toBe(false)

    // Now update diff to have only 2 hunks
    act(() => {
      root.render(<DiffView diff={diff2} />)
    })

    // Navigation must not be permanently disabled / stuck.
    // The hunk index should clamp to hunk 2 (index 1), enabling the Previous button and disabling the Next button.
    expect(container.textContent).toContain('Hunk 2 of 2')
    expect(getNextButton()?.disabled).toBe(true)
    const prev = getPrevButton()
    expect(prev?.disabled).toBe(false)

    act(() => {
      prev?.click()
    })

    expect(container.textContent).toContain('Hunk 1 of 2')
    expect(getPrevButton()?.disabled).toBe(true)
    expect(getNextButton()?.disabled).toBe(false)
  })
})
