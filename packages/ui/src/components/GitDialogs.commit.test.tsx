import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { GitConclusion, GitFileStatus } from '@harnessdesk/protocol'

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
 *
 * Which of the two shapes the commit is asked in is the other half, and it is
 * decided on the repository's state: a merge, cherry-pick or revert is
 * concluded by one commit of the whole tree, whatever the rows say. Reading
 * the shape off the rows instead meant an `AD` row — a row with no box, so
 * never one of the chosen — forced pathspecs, and pathspecs during a merge are
 * `fatal: cannot do a partial commit during a merge` (measured, git 2.50.1).
 *
 * Whether there is a commit at all is a third question, and answering it with
 * the same count shut the door the other way. Measured on git 2.50.1:
 *
 *     git merge side            # CONFLICT (content): Merge conflict in a.txt
 *     printf 'main\n' > a.txt   # resolved to what HEAD already holds
 *     git add a.txt
 *     git status --porcelain    # prints nothing at all
 *     git rev-parse MERGE_HEAD  # 43df4dc…, the merge is still there
 *     git commit -m settle      # succeeds: one commit, two parents
 *
 * So an empty file list during a conclusion is not a clean tree that owes git
 * nothing — it is the commit git is waiting for, and the only way to finish
 * (#248). With nothing underway, an empty list still means what it says.
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
const show = async (files: readonly GitFileStatus[], concluding: GitConclusion | null = null) => {
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === 'git/status'
      ? { root: '/w', branch: 'main', ahead: 0, behind: 0, files, concluding }
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

/** The parameters the dialog asked `git/commitAll` with, after pressing it. */
const commitAsked = async (
  request: Awaited<ReturnType<typeof show>>,
): Promise<{ readonly paths?: readonly string[] } | undefined> => {
  write('a message')
  await act(async () => {
    commitButton()?.click()
    await Promise.resolve()
  })
  return request.mock.calls.find(([method]) => method === 'git/commitAll')?.[1] as
    | { readonly paths?: readonly string[] }
    | undefined
}

it('concludes a merge with the whole tree, whatever the rows record (#248)', async () => {
  const asked = await commitAsked(await show(FILES, 'merge'))
  /* No pathspecs at all. The `AD` row carries no box, so it was never one of
     the chosen and the old rule read that as "not everything" — which sent
     `git commit -- notes.md new.ts both.txt` into a merge, where git answers
     `fatal: cannot do a partial commit during a merge` and the merge cannot
     be concluded at all while that path sits there. */
  expect(asked).toEqual({ root: '/w', message: 'a message' })
  expect(asked && 'paths' in asked).toBe(false)
})

it('gives a merge conclusion no box to untick, and says why (#248)', async () => {
  await show(FILES, 'merge')
  expect(boxes()).toHaveLength(0)
  expect(document.body.textContent).toContain('A merge is concluded by a single commit of the whole tree')
  // The rows still account for every path, and `AD` still says what it records.
  expect(rows()).toHaveLength(4)
  expect(statusOf('ghost.txt')).toBe('nothing')
  expect(commitButton()?.textContent).toBe('Commit 3 files')
})

it('names the operation it is concluding (#248)', async () => {
  await show(FILES, 'cherry-pick')
  expect(document.body.textContent).toContain('A cherry-pick is concluded by')
})

it('asks a merge with no moot row for everything, as it always did (#248)', async () => {
  /* The control for the rule above: with no row that records nothing, the old
     inference and the new decision agree, so this passes either way. It is
     the `AD` row that separated them. */
  const asked = await commitAsked(await show(FILES.filter((file) => file.path !== 'ghost.txt'), 'merge'))
  expect(asked && 'paths' in asked).toBe(false)
})

// ------------------------------------------------- a conclusion with no rows

it('commits a conclusion that has nothing left to record (#248)', async () => {
  const request = await show([], 'merge')
  // A message, so the button's other guard is not the one under test.
  write('a message')
  expect(commitButton()?.textContent).toBe('Commit the merge')
  expect(commitButton()?.disabled).toBe(false)
  await act(async () => {
    commitButton()?.click()
    await Promise.resolve()
  })
  const asked = request.mock.calls.find(([method]) => method === 'git/commitAll')?.[1]
  // The plain commit, which is the one git takes here and writes as the merge.
  expect(asked).toEqual({ root: '/w', message: 'a message' })
})

it('tells a clean tree what the conclusion still owes (#248)', async () => {
  await show([], 'merge')
  expect(document.body.textContent).toContain('the merge still needs this commit')
  /* Not the ordinary empty tree's line: with a merge underway it is a claim
     the button beside it contradicts. */
  expect(document.body.textContent).not.toContain('there is nothing to commit')
  /* And the note is no longer suppressed for having no rows to point at — nor
     does it promise files below when there are none below. */
  expect(document.body.textContent).toContain('A merge is concluded by a single commit of the whole tree')
  expect(document.body.textContent).not.toContain('every file below goes in')
})

it('commits a cherry-pick that has nothing left to record (#248)', async () => {
  const asked = await commitAsked(await show([], 'cherry-pick'))
  expect(asked).toEqual({ root: '/w', message: 'a message' })
  expect(document.body.textContent).toContain('the cherry-pick still needs this commit')
})

it('commits a revert that has nothing left to record (#248)', async () => {
  const asked = await commitAsked(await show([], 'revert'))
  expect(asked).toEqual({ root: '/w', message: 'a message' })
  expect(document.body.textContent).toContain('the revert still needs this commit')
})

it('concludes a merge whose only row records nothing (#248)', async () => {
  /* The same shut door one row along: a row, so not the empty tree, and no
     choice in it, so the count is zero all the same. */
  const request = await show(FILES.filter((file) => file.path === 'ghost.txt'), 'merge')
  expect(rows()).toHaveLength(1)
  expect(boxes()).toHaveLength(0)
  expect(commitButton()?.textContent).toBe('Commit the merge')
  expect(document.body.textContent).not.toContain('every file below goes in')
  expect(await commitAsked(request)).toEqual({ root: '/w', message: 'a message' })
})

it('has nothing to commit with a clean tree and nothing underway (#248)', async () => {
  /* The control: true before the fix and after it. A clean tree that owes git
     nothing is the one empty case where a shut button is the honest answer. */
  const request = await show([])
  write('a message')
  expect(document.body.textContent).toContain('The working tree is clean — there is nothing to commit.')
  expect(commitButton()?.textContent).toBe('Commit 0 files')
  expect(commitButton()?.disabled).toBe(true)
  await act(async () => {
    commitButton()?.click()
    await Promise.resolve()
  })
  expect(request.mock.calls.some(([method]) => method === 'git/commitAll')).toBe(false)
})
