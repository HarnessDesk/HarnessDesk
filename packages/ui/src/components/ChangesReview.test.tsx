import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ChangesReview } from './ChangesReview'

/**
 * The review workspace: the tree grouped by folder with its ± counts, and
 * the one hunk action — "revise this hunk" quotes the hunk into the composer
 * and hands the window back. Staging stays git's: nothing here writes.
 */

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

const TREE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' kept',
  '@@ -10,1 +10,2 @@',
  ' context',
  '+another',
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1 +1,2 @@',
  ' hi',
  '+there',
].join('\n')

const STATUS = {
  root: '/w',
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/a.ts', status: 'modified', staged: false },
    { path: 'docs/guide.md', status: 'modified', staged: false },
  ],
}

const answer = async (method: string): Promise<unknown> => {
  if (method === 'git/status') return STATUS
  return { diff: TREE_DIFF }
}
const request = vi.fn(answer)

const mount = (onClose: () => void): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    openFile: vi.fn(),
    notice: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ChangesReview onClose={onClose} />
      </StoreProvider>,
    )
  })
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the review workspace', () => {
  it('groups the tree by folder and counts each file', async () => {
    mount(() => {})
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('docs')
    expect(text).toContain('src')
    expect(text).toContain('a.ts')
    expect(text).toContain('guide.md')
    // src/a.ts gained two lines and lost one, across two hunks.
    expect(text).toContain('+2')
    expect(text).toContain('−1')
    // The header totals the whole read: 2 files, +3 −1, on the branch.
    expect(text).toContain('2 files')
    expect(text).toContain('+3 −1')
    expect(text).toContain('on main')
  })

  it('revise-this-hunk quotes the hunk into the composer and closes', async () => {
    const onClose = vi.fn()
    const composed: string[] = []
    const listen = (event: Event): void => {
      composed.push((event as CustomEvent<string>).detail)
    }
    window.addEventListener('harnessdesk:compose', listen)
    try {
      mount(onClose)
      await flush()
      const revise = [...container.querySelectorAll('button')].filter((button) =>
        button.textContent?.includes('Revise this hunk'),
      )
      // One action per hunk: two in src/a.ts, one in docs/guide.md.
      expect(revise.length).toBe(3)
      act(() => {
        revise[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(composed.length).toBe(1)
      expect(composed[0]).toContain('Please revise this hunk of docs/guide.md')
      expect(composed[0]).toContain('@@ -1 +1,2 @@')
      expect(composed[0]).toContain('+there')
      expect(composed[0]).not.toContain('diff --git')
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('harnessdesk:compose', listen)
    }
  })
})

describe('which view a file is in (#180)', () => {
  it('lists a file staged and changed again in each view, and a conflict in the working tree only', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'git/status'
        ? {
            ...STATUS,
            files: [
              { path: 'both.txt', status: 'modified', staged: true },
              { path: 'both.txt', status: 'modified', staged: false },
              { path: 'conflict.txt', status: 'conflicted', staged: false },
              // Staged and not changed since: in the staged view only.
              { path: 'ready.txt', status: 'added', staged: true },
            ],
          }
        : { diff: '' },
    )
    try {
      mount(() => {})
      await flush()
      const working = container.textContent ?? ''
      expect(working).toContain('both.txt')
      expect(working).toContain('conflict.txt')
      expect(working).not.toContain('ready.txt')

      const tab = [...container.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === 'Staged')
      expect(tab, 'the Staged tab').toBeTruthy()
      act(() => {
        tab?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        tab?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      })
      await flush()
      const stagedView = container.textContent ?? ''
      expect(stagedView).toContain('both.txt')
      expect(stagedView).toContain('ready.txt')
      expect(stagedView).not.toContain('conflict.txt')
    } finally {
      request.mockImplementation(answer)
    }
  })
})
