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
  it('does not draw git headers, but still counts the hunks after them', () => {
    const diff = [
      'diff --git a/file.txt b/file.txt',
      'index 1111111..2222222 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,1 +1,1 @@',
      '-old one',
      '+new one',
      '@@ -10,1 +10,1 @@',
      '-old two',
      '+new two',
    ].join('\n')

    act(() => {
      root.render(<DiffView diff={diff} />)
    })

    expect(container.textContent).not.toContain('diff --git')
    expect(container.textContent).not.toContain('index 1111111')
    expect(container.textContent).not.toContain('--- a/file.txt')
    expect(container.textContent).not.toContain('+++ b/file.txt')
    expect(container.textContent).toContain('Hunk 1 of 2')
  })

  it.each([
    [
      'binary change',
      ['diff --git a/pic.bin b/pic.bin', 'index 1111111..2222222 100644', 'Binary files a/pic.bin and b/pic.bin differ'].join('\n'),
      'Binary files a/pic.bin and b/pic.bin differ',
    ],
    [
      'rename-only change',
      ['diff --git a/old.txt b/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new.txt'].join('\n'),
      'rename to new.txt',
    ],
    [
      'mode-only change',
      ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n'),
      'new mode 100755',
    ],
  ])('keeps the meaningful metadata for a %s', (_name, diff, expected) => {
    act(() => {
      root.render(<DiffView diff={diff} />)
    })

    expect(container.textContent).toContain(expected)
    expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('keeps a metadata-only file when a later file has content', () => {
    const diff = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      'diff --git a/file.txt b/file.txt',
      'index 1111111..2222222 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n')

    act(() => {
      root.render(<DiffView diff={diff} />)
    })

    expect(container.textContent).toContain('rename from old.txt')
    expect(container.textContent).toContain('rename to new.txt')
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
    expect(container.textContent).not.toContain('index 1111111')
  })

  it('uses one line-number column and no hunk navigation inline', () => {
    act(() => {
      root.render(<DiffView diff={makeDiffWithHunks(2)} inline />)
    })

    expect(container.textContent).not.toContain('Hunk 1 of 2')
    expect(container.querySelectorAll('tr[class*="_add_"] td[class*="_gutter_"]')).toHaveLength(2)
  })

  it('omits the redundant separator for one hunk starting at the first new line', () => {
    act(() => {
      root.render(<DiffView diff={'--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two'} />)
    })

    expect(container.textContent).not.toContain('@@ -0,0 +1,2 @@')
    expect(container.textContent).toContain('one')
    expect(container.textContent).toContain('two')
  })

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
