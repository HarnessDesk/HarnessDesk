import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { GitFileStatus } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommitDialog } from './GitDialogs'

/**
 * The commit dialog's rows: one a path, each saying what committing it
 * records. `git/status` lists a path once for each column that changed, and
 * the commit takes the working tree, so the working tree's deletion is the
 * word a staged-then-deleted file needs (#180).
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

const FILES: GitFileStatus[] = [
  // MD: staged, then deleted in the working tree. The commit records the deletion.
  { path: 'notes.md', status: 'modified', staged: true },
  { path: 'notes.md', status: 'deleted', staged: false },
  // AM: added, then edited. The commit records an addition.
  { path: 'new.ts', status: 'added', staged: true },
  { path: 'new.ts', status: 'modified', staged: false },
  // MM, the control: modified whichever entry is read.
  { path: 'both.txt', status: 'modified', staged: true },
  { path: 'both.txt', status: 'modified', staged: false },
]

it('labels each path by what committing it records (#180)', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'git/status' ? { root: '/w', branch: 'main', ahead: 0, behind: 0, files: FILES } : null,
  )
  const snapshot: AppSnapshot = emptySnapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    notice: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <CommitDialog root="/w" onDone={() => {}} />
      </StoreProvider>,
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const rows = [...document.body.querySelectorAll('[aria-label="Files to commit"] [data-status]')]
  const statusOf = (path: string): string | null | undefined =>
    rows.find((node) => node.closest('[aria-label="Files to commit"] > *')?.textContent?.includes(path))?.getAttribute('data-status')
  expect(rows).toHaveLength(3)
  expect(statusOf('notes.md')).toBe('deleted')
  expect(statusOf('new.ts')).toBe('added')
  expect(statusOf('both.txt')).toBe('modified')
})
