import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type HostMethodName, type Session, type SessionKey, type WorkspaceEntry, type Worktree } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot, type AppSnapshot } from '../state/store'
import { PlaceControl } from './ComposerControls'
import { Composer } from './Composer'
import { NEW_SESSION_DRAFT_KEY } from '../state/drafts'
import { emptyWorkbench } from '../state/workbench'
import { only } from '../state/layout'
import { destinationOf, visitDestination } from '../state/destinations'

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

it('gives the non-repository reason when repository identity is known', () => {
  rig({ workspace: { ...MAIN, repo: null, git: { branch: null } } })
  open()
  expect(row('New worktree')?.textContent).toContain('This folder is not one.')
})

it('hides the place control for a confirmed non-repository with no Git facts', () => {
  rig({ workspace: { ...MAIN, repo: null, git: null } })
  expect(trigger()).toBeNull()
})

it('keeps the place control while repository facts have not been read', () => {
  rig({ workspace: { path: MAIN.path, name: MAIN.name, lastOpenedAt: 1 } as WorkspaceEntry })
  expect(trigger()).not.toBeNull()
  expect(trigger()?.textContent).toContain('Checking Git…')
  open()
  expect(row('Local')).toBeDefined()
  expect(row('Local')?.getAttribute('aria-checked')).toBe('false')
  expect(row('New worktree')).toBeDefined()
  expect(row('New worktree')?.textContent).toContain('Repository information is unavailable.')
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
 rig({draftHandoff,draftPlace:{kind:'existing',path:MAIN.path,branch:'main'}},true)
 expect(container.querySelector(`button[title="${MAIN.path}"]`)?.textContent).toContain(MAIN.name)
})

/**
 * Choosing a folder from the picker is the person's say over where the draft
 * starts, and a hand-off only says where the work *was*. These run the real
 * store, because the defect lived in how its reducer treats a workspace
 * switch while a hand-off is carried: a stub store cannot have it.
 */
const AGENT = runtimeId('codex')
const SOURCE = '/work/source-project'
const CURRENT = { path: '/work/current-project', name: 'current-project', lastOpenedAt: 1, git: { branch: 'main', sha: 'abc1234' }, repo: { root: '/work/current-project', worktree: false } } as WorkspaceEntry
const PICKED = { path: '/work/picked-project', name: 'picked-project', lastOpenedAt: 2, git: { branch: 'main', sha: 'def5678' }, repo: { root: '/work/picked-project', worktree: false } } as WorkspaceEntry

/** A real store with CURRENT open, optionally holding a draft handed off from a conversation that ran in SOURCE, and PlaceControl wired as the app wires it. */
const pickerRig = async (handoff: boolean, composer = false, picked: WorkspaceEntry | null | 'failure' = PICKED, savedLayout = false, picker: 'native' | 'in-app' = 'native'): Promise<AppStore> => {
  const conversation = (id: string, cwd: string): Session =>
    ({ id: sessionId(id), runtime: AGENT, cwd, status: { type: 'idle' }, createdAt: 0, updatedAt: 0, itemsLoaded: true, turns: [] }) as unknown as Session
  const answers: Partial<Record<HostMethodName, unknown>> = {
    'runtime/sessionDefaults': [],
    'workspace/open': CURRENT,
    'workspace/recent': [CURRENT, PICKED],
    'workspace/pick': picked,
    'worktree/list': [],
    'git/status': { branch: 'main', headSha: 'abc', files: [] },
    'session/read': conversation('source', SOURCE),
    'session/resume': conversation('source', SOURCE),
    'session/create': conversation('next', PICKED.path),
  }
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params?: { path?: string }) => {
    if (method === 'workspace/open' && params?.path === PICKED.path) return PICKED
    if (method === 'workspace/pick' && picked === 'failure') throw new Error('picker unavailable')
    return answers[method] ?? null
  }) as never)
  await store.selectRuntime(AGENT)
  await store.openWorkspace(CURRENT.path)
  if (savedLayout) {
    const saved = emptyWorkbench()
    const view = { kind: 'conversation' as const, session: sessionKey(AGENT, sessionId('saved-target')) }
    answers['app/state/get'] = { layouts: { [PICKED.path]: { ...saved, sidebar: { ...saved.sidebar, size: 312 }, main: only(saved.main, view), navigation: visitDestination(saved.navigation, destinationOf(view)) } } }
    await store.loadPreferences()
  }
  if (handoff) {
    await store.openSession(sessionId('source'), { runtime: AGENT })
    await store.handOff(AGENT, 'summary', sessionKey(AGENT, sessionId('source')), { cwd: SOURCE })
    expect(store.getSnapshot().draftHandoff?.cwd).toBe(SOURCE)
  }
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {composer ? <Composer onChooseProject={async (options) => { try { return picker === 'native' ? await store.pickWorkspace(options) : Boolean(await store.openWorkspace(PICKED.path, options)) } catch { return false } }} /> : <PlaceControl onChooseProject={options => store.pickWorkspace(options)} />}
      </StoreProvider>,
    )
  })
  return store
}

it.each([
  { savedLayout: false, picker: 'native' as const }, { savedLayout: true, picker: 'native' as const },
  { savedLayout: false, picker: 'in-app' as const }, { savedLayout: true, picker: 'in-app' as const },
])('Add preserves a hand-off with $picker selection and saved layout $savedLayout', async ({ savedLayout, picker }) => {
  const store = await pickerRig(true, true, PICKED, savedLayout, picker)
  store.resizePanel('sidebar', 224)
  const carried = store.getSnapshot().draftHandoff
  const input = container.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep the hand-off draft.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { text: '', attachments: [{ name: 'Carry note', kind: 'note', path: 'note:handoff', text: 'Keep this context.' }] } }))
    input.setSelectionRange(5, 8)
  })
  await act(async () => { container.querySelector<HTMLButtonElement>('button[title="Add"]')!.click() })
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent?.includes('Change project folder'))!
  await act(async () => { choice.click() })
  expect(store.getSnapshot().workspace?.path).toBe(PICKED.path)
  expect(store.getSnapshot().draftHandoff).toBe(carried)
  expect(store.getSnapshot().activeSessionKey).toBeNull()
  expect(store.getSnapshot().workbench.sidebar.size).toBe(savedLayout ? 312 : emptyWorkbench().sidebar.size)
  const current = container.querySelector('textarea')!
  expect(current.value).toBe('Keep the hand-off draft.')
  expect([current.selectionStart, current.selectionEnd]).toEqual([5, 8])
  expect(store.drafts.live(NEW_SESSION_DRAFT_KEY)?.attachments).toEqual([expect.objectContaining({ name: 'Carry note', kind: 'note', path: 'note:handoff', text: 'Keep this context.' })])
  await store.queue([{ type: 'text', text: current.value }])
  const create = vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'session/create').at(-1)
  expect(create?.[1]).toMatchObject({ options: { cwd: PICKED.path } })
})

it.each(['native', 'in-app'] as const)('ordinary Add project selection still restores its saved conversation with %s', async picker => {
  const store = await pickerRig(false, true, PICKED, true, picker)
  await act(async () => { container.querySelector<HTMLButtonElement>('button[title="Add"]')!.click() })
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent?.includes('Change project folder'))!
  await act(async () => { choice.click() })
  expect(store.getSnapshot().workspace?.path).toBe(PICKED.path)
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, sessionId('saved-target')))
  expect(store.getSnapshot().draftHandoff).toBeNull()
})

it.each(['success', 'cancel', 'failure'] as const)('Add preserves the hand-off draft on picker %s', async (result) => {
  const success = result === 'success'
  const store = await pickerRig(true, true, success ? PICKED : result === 'failure' ? 'failure' : null)
  const input = container.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Take it from here.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.setSelectionRange(5, 7)
  })
  await act(async () => { container.querySelector<HTMLButtonElement>('button[title="Add"]')!.click() })
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent?.includes('Change project folder'))!
  expect(choice).toBeTruthy()
  await act(async () => {
    choice.click()
  })
  expect(store.getSnapshot().draftHandoff?.cwd).toBe(SOURCE)
  expect(input.value).toBe('Take it from here.')
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 7])
  const folderTitle = folderTrigger()?.title
  await store.queue([{ type: 'text', text: input.value }])
  const create = vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'session/create').at(-1)
  expect(create?.[1]).toMatchObject({ options: { cwd: success ? PICKED.path : SOURCE } })
  expect(folderTitle).toBe(success ? PICKED.path : SOURCE)
})

const folderTrigger = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('button[title$="-project"]')

/** Presses Choose folder… in the open menu and lets the whole pick finish. */
const chooseFolder = async (): Promise<void> => {
  const choose = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.startsWith('Choose folder'))
  expect(choose).toBeDefined()
  await act(async () => {
    choose!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it.each(['the folder picker', 'the Work in menu'])('lets Choose folder… in %s override the folder a hand-off names', async (via) => {
  const store = await pickerRig(true)
  // The hand-off's folder is what the draft would start in, and it says so.
  expect(folderTrigger()?.title).toBe(SOURCE)
  expect(trigger()?.title).toBe(`Starts in ${SOURCE}`)

  click(via === 'the folder picker' ? folderTrigger()! : trigger()!)
  await chooseFolder()
  expect(store.getSnapshot().workspace?.path).toBe(PICKED.path)

  // The person's choice is the place now: the picker names it, the control
  // says where the message goes, and nothing still points at the hand-off's.
  expect(folderTrigger()?.title).toBe(PICKED.path)
  expect(folderTrigger()?.textContent).toContain('picked-project')
  expect(trigger()?.title).toBe('Starts in picked-project, on main')
  expect(store.getSnapshot().draftPlace).toMatchObject({ kind: 'existing', path: PICKED.path })

  // And the conversation is made where the label says, not where the packet
  // named — the hand-off itself still travels with it.
  expect(store.getSnapshot().draftHandoff?.cwd).toBe(SOURCE)
  await store.queue([{ type: 'text', text: 'Take it from here.' }])
  const create = vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'session/create').at(-1)
  expect(create?.[1]).toMatchObject({ options: { cwd: PICKED.path } })
})

it('leaves the new folder’s own default alone when no hand-off is carried', async () => {
  const store = await pickerRig(false)
  click(trigger()!)
  await chooseFolder()
  expect(store.getSnapshot().workspace?.path).toBe(PICKED.path)
  // Nothing outranked the workspace, so nothing is pinned: the draft still
  // starts in a worktree of its own, as it does for any folder.
  expect(store.getSnapshot().draftPlace).toBeNull()
  expect(trigger()?.title).toBe('Starts in a new worktree on its own branch, made when you send')
})
