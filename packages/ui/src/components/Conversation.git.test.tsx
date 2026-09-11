import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionId, sessionKey, type Session, type WorkspaceEntry, type Worktree } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GitControl } from './Conversation'

/**
 * The header's git chip: where a conversation runs, said in the header.
 *
 * Two facts it has to get right that nothing else in the header can. Which
 * branch a worktree is on, when the agent reports no git at all — every ACP
 * agent — which left the chip naming the folder and its menu saying "Not a
 * git branch". And whether the folder is a worktree, said by its glyph as
 * well as its badge, because a narrow header folds the words away and keeps
 * only the glyph.
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

const ROOT = '/code/storefront'
const TREE = '/state/worktrees/storefront-1a/checkout-retry'
const KEY = sessionKey('fake', sessionId('s-1'))
const MAIN = {
  path: ROOT,
  name: 'storefront',
  lastOpenedAt: 1,
  git: { branch: 'main' },
  repo: { root: ROOT, worktree: false },
} as WorkspaceEntry

const worktrees = (managed: boolean): Worktree[] => [
  { path: ROOT, branch: 'main', head: 'a', isMain: true, managed: false },
  { path: TREE, branch: 'harnessdesk/checkout-retry', head: 'b', isMain: false, managed },
]

/** A conversation as an ACP agent reports it: a folder, and no `git`. */
const conversation = (cwd: string): Session =>
  ({ id: sessionId('s-1'), runtime: 'fake', cwd, status: { type: 'idle' }, createdAt: 1, updatedAt: 1, turns: [], itemsLoaded: true }) as unknown as Session

const rig = (over: Partial<AppSnapshot>): void => {
  const snapshot = { ...emptySnapshot(), status: 'open', workspace: MAIN, workspaces: [MAIN], ...over } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    listBranches: vi.fn(async () => []),
    setDetailsTab: vi.fn(),
    openGitHistory: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} />
      </StoreProvider>,
    )
  })
}

const chip = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[title*=" · worktree — "], button[title*=" · local — "], button[title*=" · new worktree off "]')

const glyph = (): string => chip()?.querySelector('svg')?.getAttribute('class') ?? ''

const menu = (): string[] => {
  act(() => {
    chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent ?? '')
}

const inTree = { activeSessionKey: KEY, sessions: new Map([[KEY, conversation(TREE)]]) }

it('names the branch of the worktree a conversation runs in, though its agent reports no git', () => {
  rig({ ...inTree, worktrees: worktrees(false) })

  expect(chip()?.textContent).toContain('harnessdesk/checkout-retry')
  expect(chip()?.textContent).toContain('worktree')
  expect(glyph()).toContain('lucide-git-branch')
  expect(chip()?.title).toBe(`harnessdesk/checkout-retry · worktree — ${TREE}`)
})

it('wears a laptop for the main checkout, and no worktree badge', () => {
  rig({ activeSessionKey: KEY, sessions: new Map([[KEY, conversation(ROOT)]]), worktrees: worktrees(true) })

  expect(chip()?.textContent).toBe('main')
  expect(glyph()).toContain('lucide-laptop')
  expect(chip()?.title).toBe(`main · local — ${ROOT}`)
})

it('names the worktree a draft is pointed at, not the folder the window has open', () => {
  // The composer's Work in chip says the draft starts there; the header must
  // not name a second folder for the same draft.
  rig({ draftPlace: { kind: 'existing', path: TREE, branch: 'harnessdesk/checkout-retry' }, worktrees: worktrees(true) })

  expect(chip()?.textContent).toContain('harnessdesk/checkout-retry')
  expect(chip()?.title).toBe(`harnessdesk/checkout-retry · worktree — ${TREE}`)
})

it("offers to bring back, or remove, a worktree HarnessDesk made", () => {
  rig({ ...inTree, worktrees: worktrees(true) })

  const rows = menu()
  expect(rows).toContain('Bring it back to the main checkout…')
  expect(rows).toContain('Remove this worktree…')
})

it('offers neither for a worktree it did not make, though it still says it is one', () => {
  rig({ ...inTree, worktrees: worktrees(false) })

  expect(chip()?.textContent).toContain('worktree')
  const rows = menu()
  expect(rows).not.toContain('Bring it back to the main checkout…')
  expect(rows).not.toContain('Remove this worktree…')
})

it('names the worktree a draft is armed to cut, not the folder it will be cut from', () => {
  // The composer says New worktree; the header above it must not say Local.
  rig({ draftPlace: { kind: 'worktree', root: ROOT, name: 'checkout retry' }, worktrees: worktrees(true) })

  expect(glyph()).toContain('lucide-git-branch-plus')
  expect(chip()?.title).toBe(`harnessdesk/checkout-retry · new worktree off ${ROOT}`)
  expect(chip()?.textContent).toContain('harnessdesk/checkout-retry')
})

it('keeps its git verbs for a draft in the folder the window has open', () => {
  rig({ worktrees: worktrees(true) })

  expect(menu()).toContain('History')
})

it('offers no git verbs for a draft pointed at a worktree, which the host reads only once a conversation runs there', () => {
  rig({ draftPlace: { kind: 'existing', path: TREE, branch: 'harnessdesk/checkout-retry' }, worktrees: worktrees(true) })

  const rows = menu()
  expect(rows).not.toContain('History')
  expect(rows.some((row) => row.includes('harnessdesk/checkout-retry'))).toBe(false)
  expect(rows).toContain('Starts in this worktree when the message goes')
})

it('offers no git verbs for a draft armed with a new worktree, which does not exist yet', () => {
  rig({ draftPlace: { kind: 'worktree', root: ROOT, name: 'checkout retry' }, worktrees: worktrees(true) })

  const rows = menu()
  expect(rows).not.toContain('History')
  expect(rows.some((row) => row.includes('harnessdesk/checkout-retry'))).toBe(false)
  expect(rows).toContain('The worktree is made when the message goes')
})

it('names the branch a draft is pointed at from the draft, though the worktree list could not be read', () => {
  // The list is emptied on any failed read; the draft carries its own branch.
  rig({ draftPlace: { kind: 'existing', path: TREE, branch: 'harnessdesk/checkout-retry' }, worktrees: [] })

  expect(chip()?.title).toBe(`harnessdesk/checkout-retry · worktree — ${TREE}`)
  expect(glyph()).toMatch(/lucide-git-branch(\s|$)/)
  expect(chip()?.textContent).toContain('harnessdesk/checkout-retry')
})
