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
 *
 * `AD` is the pair no word fits: added to the index, then deleted from the
 * tree, it is in no commit and in no tree. The row says it records nothing,
 * carries no box to check, and is left out of the pathspecs the commit is
 * asked with (#248).
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
  // AD: added, then deleted from the tree. The commit records nothing at all.
  { path: 'ghost.txt', status: 'added', staged: true },
  { path: 'ghost.txt', status: 'deleted', staged: false },
]

/** Renders the dialog over one `git/status` answer; returns the transport spy. */
const show = async (files: readonly GitFileStatus[]) => {
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === 'git/status'
      ? { root: '/w', branch: 'main', ahead: 0, behind: 0, files }
      : { sha: 'c0ffee1234567890' },
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
  return request
}

const rows = (): Element[] => [
  ...document.body.querySelectorAll('[aria-label="Files to commit"] [data-status]'),
]

const statusOf = (path: string): string | null | undefined =>
  rows()
    .find((node) => node.closest('[aria-label="Files to commit"] > *')?.textContent?.includes(path))
    ?.getAttribute('data-status')

const boxes = (): Element[] => [
  ...document.body.querySelectorAll('[aria-label="Files to commit"] [role="checkbox"]'),
]

const commitButton = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((one) => one.textContent?.startsWith('Commit'))

/** Types into the controlled textarea the way a person does. */
const write = (text: string): void => {
  const box = document.body.querySelector('textarea')
  if (!box) throw new Error('no message box')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('labels each path by what committing it records (#180, #248)', async () => {
  await show(FILES)
  expect(rows()).toHaveLength(4)
  expect(statusOf('notes.md')).toBe('deleted')
  expect(statusOf('new.ts')).toBe('added')
  // The control: `MM` reads modified whatever the rule around it does.
  expect(statusOf('both.txt')).toBe('modified')
  expect(statusOf('ghost.txt')).toBe('nothing')
})

it('gives no box to a row the commit records nothing for (#248)', async () => {
  await show(FILES)
  // Three of the four rows are choices; the fourth is an explanation.
  expect(boxes()).toHaveLength(3)
  expect(boxes().some((box) => box.textContent?.includes('ghost.txt'))).toBe(false)
  expect(commitButton()?.textContent).toBe('Commit 3 files')
})

it('leaves a path that records nothing out of the commit it asks for (#248)', async () => {
  const request = await show(FILES)
  write('a message')
  await act(async () => {
    commitButton()?.click()
    await Promise.resolve()
  })
  const asked = request.mock.calls.find(([method]) => method === 'git/commitAll')?.[1] as
    | { readonly paths?: readonly string[] }
    | undefined
  // Pathspecs, not the all-files branch: `git add -A` would erase the staged
  // add, where the pathspec commit leaves it alone.
  expect(asked?.paths).toEqual(['notes.md', 'new.ts', 'both.txt'])
})

it('cannot be asked to commit a path that records nothing on its own (#248)', async () => {
  await show(FILES.filter((file) => file.path === 'ghost.txt'))
  expect(statusOf('ghost.txt')).toBe('nothing')
  // A message, so the button's other guard is not the one under test.
  write('a message')
  expect(commitButton()?.textContent).toBe('Commit 0 files')
  expect(commitButton()?.disabled).toBe(true)
})
