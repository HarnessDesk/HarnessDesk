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

// PlaceControl renders neither primitive, but ComposerControls imports them
// through the full design barrel.
vi.mock('../design', () => ({ Btn: () => null, Dialog: () => null }))

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
  git: { branch: 'main' },
  repo: { root: '/code/harness-desk', worktree: false },
} as WorkspaceEntry

const rig = (over: Partial<AppSnapshot> = {}): AppStore => {
  const snapshot = { ...emptySnapshot(), status: 'open', workspace: MAIN, workspaces: [MAIN], ...over } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    startDraftIn: vi.fn(),
    askNewWorktree: vi.fn(),
    loadWorktrees: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PlaceControl />
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

it('says Local on a draft in the main checkout, and names the folder and branch on hover', () => {
  rig()

  expect(trigger()?.textContent).toContain('Local')
  expect(trigger()?.title).toBe('Starts in harness-desk, on main')

  open()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('true')
  expect(row('New worktree')?.getAttribute('aria-checked')).toBe('false')
})

it('is gone once the conversation exists — the header says where a session runs', () => {
  const key = 'codex:s-1' as SessionKey
  rig({ activeSessionKey: key, sessions: new Map([[key, { cwd: MAIN.path } as Session]]) })

  expect(trigger()).toBeNull()
})

it('never calls a folder that is itself a worktree Local', () => {
  rig({
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
  expect(trigger()?.title).toBe('Starts in this worktree, on feat/parser')

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

it('says why a folder with no repository has no worktree, rather than hiding the row', () => {
  rig({ workspace: { ...MAIN, git: null, repo: null } as WorkspaceEntry })

  open()
  const unavailable = row('New worktree')
  expect(unavailable?.disabled).toBe(true)
  expect(unavailable?.textContent).toContain('Worktrees need a git repository.')
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
