import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Session, SessionKey, WorkspaceEntry, Worktree } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PlaceControl } from './ComposerControls'

/**
 * "Local, or a worktree?" — answered where the message is written.
 *
 * The control is only worth having if it is right in the two cases a person
 * cannot see for themselves: a folder that is already a worktree must never
 * be called Local, and a worktree chosen for the draft must say it will be
 * made, not claim to exist.
 */

// ComposerControls imports Dialog through the full design barrel.
vi.mock('../design', async (importOriginal) => ({ ...(await importOriginal<typeof import('../design')>()), Dialog: () => null }))

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

const MAIN = {
  path: '/code/harness-desk',
  name: 'harness-desk',
  lastOpenedAt: 1,
  git: { branch: 'main', sha: 'abc1234' },
  repo: { root: '/code/harness-desk', worktree: false },
} as WorkspaceEntry

const rig = (over: Partial<AppSnapshot> = {}, chooseFolder = false): AppStore => {
  const snapshot = { ...emptySnapshot(), status: 'open', workspace: MAIN, workspaces: [MAIN], ...over } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    refreshWorkspaceGit: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    startDraftIn: vi.fn(),
    askNewWorktree: vi.fn(),
    askCommit: vi.fn(),
    loadWorktrees: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PlaceControl onChooseProject={chooseFolder ? () => {} : undefined} />
      </StoreProvider>,
    )
  })
  return store
}

const trigger = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('button[title^="Starts in"]')

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const open = (): void => click(trigger()!)

const row = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((entry) =>
    entry.textContent?.startsWith(text),
  )

it('defaults a project draft to its own worktree and makes Local an explicit choice', () => {
  rig()

  expect(trigger()?.textContent).toContain('New worktree')
  expect(trigger()?.title).toBe('Starts in a new worktree on its own branch, made when you send')

  open()
  const popup = document.querySelector('[data-popup-kind="wide-menu"]')!
  expect(popup.getAttribute('data-menu-icons')).toBe('none')
  expect(popup.querySelector('[data-menu-icon]')).toBeNull()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
  expect(row('New worktree')?.getAttribute('aria-checked')).toBe('true')
})

it('shows the selected project folder beside the folder icon', () => {
  rig({
    workspace: { ...MAIN, path: '/work/storefront', name: 'storefront' },
    draftPlace: { kind: 'existing', path: '/work/storefront', branch: 'main' },
  })

  expect(trigger()?.textContent).toContain('storefront')
  const glyphs = [...trigger()!.querySelectorAll('svg')]
  expect(glyphs.length).toBeGreaterThan(0)
  expect(glyphs.every(glyph => Number(glyph.getAttribute('width')) >= 12)).toBe(true)
})

it('names the carried source folder when a handoff intentionally continues there', () => {
  rig({ draftHandoff: { cwd: MAIN.path } as AppSnapshot['draftHandoff'] })
  expect(trigger()?.textContent).not.toContain('New worktree')
  expect(trigger()?.title).toBe(`Starts in ${MAIN.path}`)
})

it('keeps the full path on hover while the long folder label can truncate', () => {
  const path = '/work/this-is-a-very-long-storefront-folder-name'
  rig({ workspace: { ...MAIN, path, name: path.split('/').at(-1)! }, draftPlace: { kind: 'existing', path, branch: 'main' } })

  const label = trigger()?.querySelector<HTMLElement>('[data-slot="text"]')
  expect(label?.textContent).toBe(path.split('/').at(-1))
  expect(label?.getAttribute('title')).toBe(path)
  expect(label?.className).toContain('truncate')
})

it('is gone once the conversation exists — the header says where a session runs', () => {
  const key = 'codex:s-1' as SessionKey
  rig({ activeSessionKey: key, sessions: new Map([[key, { cwd: MAIN.path } as Session]]) })

  expect(trigger()).toBeNull()
})

it('never calls a folder that is itself a worktree Local', () => {
  rig({
    draftPlace: { kind: 'existing', path: '/code/harness-desk-parser', branch: 'feat/parser' },
    workspace: {
      ...MAIN,
      path: '/code/harness-desk-parser',
      git: { branch: 'feat/parser' },
      repo: { root: MAIN.path, worktree: true },
    } as WorkspaceEntry,
  })

  expect(trigger()?.textContent).not.toContain('Local')
  expect(trigger()?.textContent).toContain('parser')
  expect(trigger()?.textContent).toContain('worktree')
  expect(trigger()?.title).toBe('Starts in the worktree on feat/parser')

  open()
  expect(row('This worktree')?.getAttribute('aria-checked')).toBe('true')
  expect(row('Local')).toBeUndefined()
})

it('shows a worktree armed for the draft as one that will be made, and when', () => {
  rig({ draftPlace: { kind: 'worktree', root: MAIN.path, name: 'Parser fix', base: 'main' } })

  expect(trigger()?.textContent).toContain('New worktree')
  expect(trigger()?.title).toBe('Starts in a new worktree on harnessdesk/parser-fix, made when you send')

  open()
  const armed = row('New worktree')
  expect(armed?.getAttribute('aria-checked')).toBe('true')
  expect(armed?.textContent).toContain('harnessdesk/parser-fix')
  expect(armed?.textContent).toContain('Made when you send, from main.')
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
})

it('asks for a name and a starting point rather than making a worktree', () => {
  const store = rig()

  open()
  click(row('New worktree…')!)

  expect(store.askNewWorktree).toHaveBeenCalledWith(MAIN.path)
  expect(store.startDraftIn).not.toHaveBeenCalled()
})

it('points an armed draft back at the open folder', () => {
  const store = rig({ draftPlace: { kind: 'worktree', root: MAIN.path, name: 'Parser fix' } })

  open()
  click(row('Local')!)

  expect(store.startDraftIn).toHaveBeenCalledWith(null)
})

it("offers HarnessDesk's own worktrees of this project to start in", () => {
  const worktrees = [
    { path: MAIN.path, branch: 'main', head: 'a', isMain: true, managed: false },
    { path: '/state/worktrees/harness-desk-1a/parser', branch: 'harnessdesk/parser', head: 'b', isMain: false, managed: true },
    { path: '/code/mine', branch: 'mine', head: 'c', isMain: false, managed: false },
  ] as Worktree[]
  const store = rig({ worktrees })

  open()
  expect(row('mine')).toBeUndefined()
  click(row('harnessdesk/parser')!)

  expect(store.startDraftIn).toHaveBeenCalledWith({
    kind: 'existing',
    path: '/state/worktrees/harness-desk-1a/parser',
    branch: 'harnessdesk/parser',
  })
})

it('omits worktree controls for a folder with no repository', () => {
  rig({ workspace: { ...MAIN, git: null, repo: null } as WorkspaceEntry })

  expect(container.querySelector('button')).toBeNull()
  expect(row('New worktree')).toBeUndefined()
})

it('names a worktree by the end of its branch, where branches differ, and the whole of it on hover', () => {
  // A real one from this machine: forty characters that squeezed the agent
  // and the model off the row, cut at the end that told it apart.
  const branch = 'claude/gemini-antigravity-cli-test-c48596'
  rig({ draftPlace: { kind: 'existing', path: '/code/harness-desk/.claude/worktrees/c48596', branch } })

  const word = [...trigger()!.querySelectorAll('span')].find((span) => span.textContent?.startsWith('gemini'))
  expect(word?.textContent).toBe('gemini-antigravity-cli-test-c48596')
  expect(trigger()?.textContent).not.toContain('claude/')
  expect(trigger()?.title).toBe(`Starts in the worktree on ${branch}`)
})

/**
 * The main checkout, from a worktree of it.
 *
 * The list this control draws worktrees from is filtered to HarnessDesk's
 * own — `managed` — and the main checkout never is: it was there before the
 * app was. So from a linked worktree the menu could name a new worktree and
 * every sibling worktree, and not the place the branch came from (#255).
 *
 * Both directions are the test. The row has to appear from a worktree, and
 * it has to stay away in the main checkout, where the open folder is already
 * the first row and a second one for the same path is a choice between a
 * place and itself.
 */

const TREE = '/state/worktrees/harness-desk-1a/parser'
const SIBLING = '/state/worktrees/harness-desk-1a/promo'
const IN_TREE = {
  ...MAIN,
  path: TREE,
  name: 'parser',
  git: { branch: 'harnessdesk/parser' },
  repo: { root: MAIN.path, worktree: true },
} as WorkspaceEntry
const CHECKOUTS = [
  { path: MAIN.path, branch: 'main', head: 'a', isMain: true, managed: false },
  { path: TREE, branch: 'harnessdesk/parser', head: 'b', isMain: false, managed: true },
  { path: SIBLING, branch: 'harnessdesk/promo', head: 'c', isMain: false, managed: true },
] as Worktree[]
const SAID = 'Agent cannot open this conversation: its folder no longer exists.'

it('offers the main checkout from a worktree of it, which the managed-only list never could', () => {
  const store = rig({ workspace: IN_TREE, worktrees: CHECKOUTS })

  open()
  const home = row('Main checkout')
  expect(home).toBeDefined()
  expect(home?.getAttribute('aria-disabled')).toBe('false')
  click(home!)

  expect(store.startDraftIn).toHaveBeenCalledWith({ kind: 'existing', path: MAIN.path, branch: 'main' })
})

it('gives the main checkout no row pointing at itself', () => {
  // The control on the test above, and the one a fix that simply always
  // added the row would fail.
  rig({ worktrees: CHECKOUTS })

  open()
  expect(row('Main checkout')).toBeUndefined()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
})

it('draws a draft pointed at the main checkout as a place, not as a worktree', () => {
  rig({
    workspace: IN_TREE,
    worktrees: CHECKOUTS,
    draftPlace: { kind: 'existing', path: MAIN.path, branch: 'main' },
  })

  expect(trigger()?.title).toBe('Starts in the main checkout, on main')
  expect(trigger()?.textContent).toContain('main')
  expect(trigger()?.textContent).not.toContain('worktree')
})

it('greys a place whose folder the app has proof is gone, rather than dropping its row', () => {
  rig({ workspace: IN_TREE, worktrees: CHECKOUTS, foldersGone: new Map([[MAIN.path, SAID]]) })

  open()
  expect(row('Main checkout')?.getAttribute('aria-disabled')).toBe('true')
  expect(row('Main checkout')?.textContent).toContain(SAID)
  // The control: one question, asked of each row's own folder and no other.
  expect(row('harnessdesk/promo')?.getAttribute('aria-disabled')).toBe('false')
})

it('asks that of the worktrees under it too, not only of the main checkout', () => {
  rig({ workspace: IN_TREE, worktrees: CHECKOUTS, foldersGone: new Map([[SIBLING, SAID]]) })

  open()
  expect(row('harnessdesk/promo')?.getAttribute('aria-disabled')).toBe('true')
  expect(row('Main checkout')?.getAttribute('aria-disabled')).toBe('false')
})

it('calls the main checkout by its own name when it is on a detached HEAD', () => {
  /* The word beside the glyph read `chosen`; the badge one line below it
     reads `chosenMain`. With a branch the two could never be caught
     disagreeing — `leaf` answered with the branch either way — but a main
     checkout on a detached HEAD fell through to `leaf`'s worktree fallback,
     so the chip wore the laptop, said "Starts in the main checkout" on
     hover, and read `Worktree` (#301). `Local` is what this same place is
     called under this same glyph when it is the folder that is open. */
  rig({
    workspace: IN_TREE,
    worktrees: [{ path: MAIN.path, branch: null, head: 'a', isMain: true, managed: false }, ...CHECKOUTS.slice(1)] as Worktree[],
    draftPlace: { kind: 'existing', path: MAIN.path, branch: null },
  })

  expect(trigger()?.textContent).toContain('Local')
  expect(trigger()?.textContent).not.toContain('Worktree')
  // The control on the half that was already right: the hover sentence drops
  // its branch clause rather than inventing one, before and after the fix.
  expect(trigger()?.title).toBe('Starts in the main checkout')
})

it('still calls a worktree on a detached HEAD a worktree', () => {
  /* The control on the fix: the fallback it moves off the main checkout is
     the right answer for the rows that really are worktrees, and stays
     theirs. Passes both before and after. */
  rig({
    workspace: IN_TREE,
    worktrees: CHECKOUTS,
    draftPlace: { kind: 'existing', path: SIBLING, branch: null },
  })

  expect(trigger()?.textContent).toContain('Worktree')
  expect(trigger()?.title).toBe('Starts in the worktree on a detached HEAD')
})

it('opens Commit for an unborn repository in place of New worktree', () => {
  const store = rig({ workspace: { ...MAIN, git: { branch: 'main', sha: null } } })
  open()
  expect(document.body.textContent).toContain('Make a first commit to work in a worktree')
  expect(row('New worktree')).toBeUndefined()
  const commit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!
  click(commit)
  expect(store.askCommit).toHaveBeenCalledWith(MAIN.path)
})

it('keeps repository controls when fresh Git status arrives before repository identity', () => {
  rig({ workspace: { ...MAIN, repo: null } as WorkspaceEntry })
  open()
  expect(row('New worktree')).toBeDefined()
})

it('keeps the place control while repository facts have not been read', () => {
  rig({ workspace: { path: MAIN.path, name: MAIN.name, lastOpenedAt: 1 } as WorkspaceEntry })
  expect(trigger()).not.toBeNull()
  expect(trigger()?.textContent).toContain('Checking Git…')
  open()
  expect(row('Local')).toBeDefined()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
  expect(row('New worktree')).toBeDefined()
})

it('keeps a linked worktree as the default without an explicit draftPlace', () => {
  rig({ workspace: { ...MAIN, path: '/review-tree', checkoutRoot: '/review-tree', repo: { root: MAIN.path, worktree: true }, git: { branch: 'review' } } })
  expect(trigger()?.title).toBe('Starts in this worktree, on review')
  expect(trigger()?.textContent).not.toContain('New worktree')
  open()
  expect(row('This worktree')?.getAttribute('aria-checked')).toBe('true')
})

it('keeps an opened monorepo package in its selected subfolder', () => {
  rig({ workspace: { ...MAIN, path: `${MAIN.path}/packages/widget`, checkoutRoot: MAIN.path } })
  expect(trigger()?.title).toBe('Starts in widget, on main')
  expect(trigger()?.textContent).not.toContain('New worktree')
})

it('shows checking instead of promising Local while Git facts are unread', () => {
  rig({ workspace: { ...MAIN, git: undefined } })
  expect(trigger()?.textContent).toContain('Checking Git')
  expect(trigger()?.title).toContain('checking Git')
  open()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
})

it('names a handoff source in the folder picker until a place is chosen',()=>{
 const draftHandoff={cwd:'/work/source-project'} as AppSnapshot['draftHandoff']
 rig({draftHandoff},true)
 expect(container.querySelector('button[title="/work/source-project"]')?.textContent).toContain('source-project')
 expect(trigger()?.title).toBe('Starts in /work/source-project')
 rig({draftHandoff,draftPlace:{kind:'local'}},true)
 expect(container.querySelector(`button[title="${MAIN.path}"]`)?.textContent).toContain(MAIN.name)
})
