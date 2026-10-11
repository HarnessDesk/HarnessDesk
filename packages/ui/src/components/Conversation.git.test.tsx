import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NO_CAPABILITIES,
  runtimeId,
  sessionId,
  sessionKey,
  type GoalView,
  type RuntimeInfo,
  type Session,
  type SessionKey,
  type WorkspaceEntry,
  type Worktree,
} from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GitControl } from './Conversation'
import { BranchCreateDialog } from './BranchCreateDialog'
import { ConversationDetails } from '../panels/work-details'
import { Menu, Popover } from '../design'

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
  vi.restoreAllMocks()
})

it.each([false, true])('a successful branch switch closes only its canonical menu (embedded=%s)', async embedded => {
  const snapshot = { ...emptySnapshot(), workspace: MAIN, workspaces: [MAIN], status: 'open' } as AppSnapshot
  const checkoutBranch = vi.fn(async () => true)
  const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => {})
  const store = {
    subscribe: () => () => {}, getSnapshot: () => snapshot,
    listBranches: async () => [{ name: 'main', current: true, committedAt: 1 }, { name: 'feature/retry', current: false, committedAt: 2 }],
    checkoutBranch,
  } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}>
    {embedded
      ? <Popover title="Member actions" label="Member actions">{close => <Menu close={close}><GitControl menu menuClose={close} onCreateBranch={() => {}} onRemoveWorktree={() => {}} onBringHome={() => {}} /></Menu>}</Popover>
      : <GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} />}
  </StoreProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>(`button[title="${embedded ? 'Member actions' : 'Folder actions'}"]`)!.click())
  const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(one => one.textContent === label)!
  if (embedded) await act(async () => row('Folder actions').click())
  await act(async () => row('main').click())
  const branch = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(one => one.textContent?.startsWith('feature/retry'))!
  expect(branch).not.toBeUndefined()
  await act(async () => branch.click())
  expect(checkoutBranch).toHaveBeenCalledWith(ROOT, 'feature/retry', { create: false })
  expect(closeWindow).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).toBeNull()
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
    seatRecord: vi.fn(async () => null),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ConversationDetails session={snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) ?? null : null} placeAction={<GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} />} />
      </StoreProvider>,
    )
  })
}

const fact = (label: string): string => {
  const value = [...container.querySelectorAll('[data-slot="summary-item"]')]
    .find(one => one.querySelector('dt')?.textContent === label)?.querySelector('[data-slot="summary-value"]')
  return value?.querySelector('[data-slot="middle-truncate"] .sr-only')?.textContent ?? value?.textContent ?? ''
}

it('names an armed draft in Details as a branch off its source folder', () => {
  rig({ draftPlace: { kind: 'worktree', root: ROOT, name: 'checkout retry' }, worktrees: worktrees(true) })
  expect(fact('Branch')).toContain('harnessdesk/checkout-retry')
  expect(fact('Folder')).toContain(ROOT)
  expect(container.querySelector('[data-slot="summary-note"]')?.textContent).toContain('Source folder; the worktree is made when the message goes')
  expect(chip()?.getAttribute('aria-label')).toBe('Folder actions')
})

const chip = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('button[aria-label="Folder actions"]')

const menu = (): string[] => {
  act(() => {
    chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .map((row) => row.querySelector('[data-menu-label]')?.textContent ?? '')
}

const inTree = { activeSessionKey: KEY, sessions: new Map([[KEY, conversation(TREE)]]) }

it('names the branch of the worktree a conversation runs in, though its agent reports no git', () => {
  rig({ ...inTree, worktrees: worktrees(false) })

  expect(fact('Branch')).toContain('harnessdesk/checkout-retry')
  expect(fact('Folder')).toContain(TREE)
  expect(fact('Folder')).toContain(TREE)
  expect(chip()?.title).toBe('Folder actions')
  expect(fact('Folder')).toContain(TREE)
})

it('reports the fresh branch and folder for the main checkout', () => {
  rig({ activeSessionKey: KEY, sessions: new Map([[KEY, conversation(ROOT)]]), worktrees: worktrees(true) })

  expect(fact('Branch')).toBe('main')
  expect(fact('Folder')).toContain(ROOT)
  expect(chip()?.title).toBe('Folder actions')
})

it('names the worktree a draft is pointed at, not the folder the window has open', () => {
  // The composer's Work in chip says the draft starts there; the header must
  // not name a second folder for the same draft.
  rig({ draftPlace: { kind: 'existing', path: TREE, branch: 'harnessdesk/checkout-retry' }, worktrees: worktrees(true) })

  expect(fact('Branch')).toContain('harnessdesk/checkout-retry')
  expect(chip()?.title).toBe('Folder actions')
  expect(fact('Folder')).toContain(TREE)
})

it("offers to bring back, or remove, a worktree HarnessDesk made", () => {
  rig({ ...inTree, worktrees: worktrees(true) })

  const rows = menu()
  expect(rows).toContain('Bring it back to the main checkout…')
  expect(rows).toContain('Remove this worktree…')
})

it('offers neither for a worktree it did not make, though it still says it is one', () => {
  rig({ ...inTree, worktrees: worktrees(false) })

  expect(fact('Folder')).toContain(TREE)
  const rows = menu()
  expect(rows).not.toContain('Bring it back to the main checkout…')
  expect(rows).not.toContain('Remove this worktree…')
})

it('names the worktree a draft is armed to cut, not the folder it will be cut from', () => {
  // The composer says New worktree; the header above it must not say Local.
  rig({ draftPlace: { kind: 'worktree', root: ROOT, name: 'checkout retry' }, worktrees: worktrees(true) })

  expect(container.querySelector('[data-slot="summary-note"]')?.textContent).toContain('Source folder; the worktree is made when the message goes')
  expect(fact('Folder')).toContain(ROOT)
  expect(fact('Branch')).toContain('harnessdesk/checkout-retry')
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
  const refused = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((row) => row.querySelector('[data-menu-label]')?.textContent === 'Starts in this worktree when the message goes')!
  expect(refused.querySelector('[data-menu-hint]')?.textContent).toBe('Where it starts is chosen in the composer, under Work in.')
  expect(refused.getAttribute('aria-disabled')).toBe('true')
})

it('offers no git verbs for a draft armed with a new worktree, which does not exist yet', () => {
  rig({ draftPlace: { kind: 'worktree', root: ROOT, name: 'checkout retry' }, worktrees: worktrees(true) })

  const rows = menu()
  expect(rows).not.toContain('History')
  expect(rows.some((row) => row.includes('harnessdesk/checkout-retry'))).toBe(false)
  expect(rows).toContain('The worktree is made when the message goes')
  const refused = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((row) => row.querySelector('[data-menu-label]')?.textContent === 'The worktree is made when the message goes')!
  expect(refused.querySelector('[data-menu-hint]')?.textContent).toBe('Where it starts is chosen in the composer, under Work in.')
  expect(refused.getAttribute('aria-disabled')).toBe('true')
})

it('names the branch a draft is pointed at from the draft, though the worktree list could not be read', () => {
  // The list is emptied on any failed read; the draft carries its own branch.
  rig({ draftPlace: { kind: 'existing', path: TREE, branch: 'harnessdesk/checkout-retry' }, worktrees: [] })

  expect(chip()?.title).toBe('Folder actions')
  expect(fact('Folder')).toContain(TREE)
  expect(fact('Branch')).toContain('harnessdesk/checkout-retry')
})

it("reviews its own conversation's changes — a room column's member, not the one the window has focused", () => {
  // A member's column in a room mounts this chip too, while the window's
  // focus is on another conversation entirely.
  const codex = runtimeId('codex')
  const member = sessionKey(codex, sessionId('member'))
  const focused = sessionKey(codex, sessionId('focused'))
  const review = vi.fn(async () => {})
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: MAIN,
    workspaces: [MAIN],
    runtimes: [{ id: codex, name: 'Codex', presentation: { name: 'Codex' }, capabilities: { ...NO_CAPABILITIES, review: true } } as unknown as RuntimeInfo],
    activeRuntime: codex,
    activeSessionKey: focused,
    sessions: new Map([
      [member, { ...conversation(ROOT), id: sessionId('member'), runtime: codex }],
      [focused, { ...conversation(ROOT), id: sessionId('focused'), runtime: codex }],
    ]),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, review } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider scope={{ paneId: 'room:member', view: { kind: 'conversation', session: member }, sessionKey: member }}>
          <GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} />
        </PaneProvider>
      </StoreProvider>,
    )
  })

  expect(menu()).toContain('Review uncommitted changes')
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === 'Review uncommitted changes',
  )
  act(() => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(review).toHaveBeenCalledWith({ type: 'uncommitted', delivery: 'detached' }, member)
})

/**
 * A wrapped Team's conversations are its record, and the host refuses to start
 * a review in one. The row says so rather than offering what can only fail —
 * and it is the *pane's* conversation that decides, not the one the window
 * happens to have focused.
 */
describe('in a wrapped Team', () => {
  const codex = runtimeId('codex')
  const kept = sessionKey(codex, sessionId('kept'))
  const loose = sessionKey(codex, sessionId('loose'))

  /** `focused` is the conversation the window has open; `pane` is the one this chip belongs to. */
  const open = (focused: SessionKey, pane: SessionKey) => {
    const review = vi.fn(async () => {})
    const snapshot = {
      ...emptySnapshot(),
      status: 'open',
      workspace: MAIN,
      workspaces: [MAIN],
      runtimes: [{ id: codex, name: 'Codex', presentation: { name: 'Codex' }, capabilities: { ...NO_CAPABILITIES, review: true } } as unknown as RuntimeInfo],
      activeRuntime: codex,
      activeSessionKey: focused,
      sessions: new Map([
        [kept, { ...conversation(ROOT), id: sessionId('kept'), runtime: codex }],
        [loose, { ...conversation(ROOT), id: sessionId('loose'), runtime: codex }],
      ]),
      goals: new Map([['record', {
        goal: { state: 'wrapped' },
        members: [],
        receipt: { members: [{ session: { runtime: 'codex', sessionId: 'kept' } }], answers: [] },
      } as unknown as GoalView]]),
    } as AppSnapshot
    const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, review } as unknown as AppStore
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <PaneProvider scope={{ paneId: `room:${pane}`, view: { kind: 'conversation', session: pane }, sessionKey: pane }}>
            <GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} />
          </PaneProvider>
        </StoreProvider>,
      )
    })
    menu()
    const row = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.startsWith('Review uncommitted changes'),
    )
    if (!row) throw new Error('no Review uncommitted changes in the menu')
    return { review, row }
  }

  it('refuses to review a kept conversation, says why, and starts nothing', () => {
    const { review, row } = open(loose, kept)

    // A row refused for a reason is `aria-disabled`, not natively disabled, so
    // it keeps the focus and its reason can be read.
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.title).toBe('This Team is wrapped')
    expect(row.textContent).toContain('This Team is wrapped')
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(review).not.toHaveBeenCalled()
  })

  it('still reviews a conversation outside it, though the window has the kept one focused', () => {
    const { review, row } = open(kept, loose)

    expect(row.getAttribute('aria-disabled')).not.toBe('true')
    expect(row.textContent).not.toContain('This Team is wrapped')
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(review).toHaveBeenCalledWith({ type: 'uncommitted', delivery: 'detached' }, loose)
  })
})


it.each([false, true])('requests creation from the persistent owner after closing (embedded=%s)', async embedded => {
  const snapshot = { ...emptySnapshot(), workspace: MAIN, workspaces: [MAIN], status: 'open' } as AppSnapshot
  const onCreateBranch = vi.fn()
  const checkoutBranch = vi.fn(async () => true)
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    listBranches: async () => [{ name: 'main', current: true, committedAt: 1 }], checkoutBranch,
  } as unknown as AppStore
  const Host = () => {
    const [creatingRoot, setCreatingRoot] = useState<string | null>(null)
    const create = (root: string) => { onCreateBranch(root); setCreatingRoot(root) }
    return <>
      {embedded
        ? <Popover title="Member actions" label="Member actions">{close => <Menu close={close}><GitControl menu menuClose={close} onCreateBranch={create} onRemoveWorktree={() => {}} onBringHome={() => {}} /></Menu>}</Popover>
        : <GitControl onCreateBranch={create} onRemoveWorktree={() => {}} onBringHome={() => {}} />}
      {creatingRoot && <BranchCreateDialog root={creatingRoot} onDone={() => {}} onClose={() => setCreatingRoot(null)} />}
    </>
  }
  await act(async () => root.render(<StoreProvider store={store}><Host /></StoreProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>(`button[title="${embedded ? 'Member actions' : 'Folder actions'}"]`)!.click())
  const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(one => one.textContent === label)!
  if (embedded) await act(async () => row('Folder actions').click())
  await act(async () => row('main').click())
  await act(async () => row('Create and checkout new branch…').click())
  expect(onCreateBranch).toHaveBeenCalledWith(ROOT)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(checkoutBranch).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Create and checkout new branch')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Keep current branch')!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})


it('standalone Folder actions retains its Create dialog after its popup unmounts', async () => {
  const snapshot = { ...emptySnapshot(), workspace: MAIN, workspaces: [MAIN], status: 'open' } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, listBranches: async () => [], checkoutBranch: vi.fn(async () => true) } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><GitControl onRemoveWorktree={() => {}} onBringHome={() => {}} /></StoreProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>('button[title="Folder actions"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'main')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Create and checkout new branch…')!.click())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
