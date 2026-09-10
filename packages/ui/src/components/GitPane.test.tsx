import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  GitCommitDetail,
  GitLogCommit,
  GitRefsSummary,
  GitStatus,
  GitWorktree,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { MountProvider } from '../panels/mount'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { GitPane } from './GitPane'

/**
 * The history pane against a scripted host. What is held: the pane asks for
 * the log, the refs and the status together; a folder outside git is said in
 * words; the dirty working tree is one pinned row that opens the existing
 * Changes surface rather than a second one; and opening a commit asks for
 * exactly that commit, then for a file's patch only when a file is chosen.
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

const commit = (sha: string, subject: string, over: Partial<GitLogCommit> = {}): GitLogCommit => ({
  sha,
  parents: [],
  subject,
  author: 'Ada',
  authorEmail: 'ada@x',
  authoredAt: 1_700_000_000_000,
  committedAt: 1_700_000_000_000,
  refs: [],
  ...over,
})

const REFS: GitRefsSummary = {
  headSha: 'aaaa111',
  branch: 'main',
  branches: [
    { name: 'main', sha: 'aaaa111', current: true, committedAt: 1, upstream: 'origin/main', ahead: 2, behind: 0, gone: false },
    { name: 'feat/graph', sha: 'bbbb222', current: false, committedAt: 1, upstream: null, ahead: 0, behind: 0, gone: false },
  ],
  remotes: [{ remote: 'origin', name: 'main', sha: 'aaaa111', committedAt: 1 }],
  tags: [{ name: 'v1', sha: 'bbbb222', at: 1 }],
  stashes: [],
}

const DETAIL: GitCommitDetail = {
  sha: 'aaaa111',
  parents: ['bbbb222'],
  author: 'Ada',
  authorEmail: 'ada@x',
  authoredAt: 1_700_000_000_000,
  committer: 'Ada',
  committedAt: 1_700_000_000_000,
  refs: ['HEAD -> main'],
  message: 'tip: the latest work\n\nWith a body worth reading.',
  files: [{ path: 'src/app.ts', status: 'modified', added: 3, removed: 1 }],
}

interface Script {
  readonly log?: readonly GitLogCommit[]
  readonly refs?: GitRefsSummary | null
  readonly status?: GitStatus | null
  readonly worktrees?: readonly GitWorktree[]
  /** Persisted list preferences, for the column widths.  */
  readonly prefs?: Record<string, unknown>
  /** The repository this pane is pointed at. */
  readonly root?: string
  /** The host's home, as `host/hello` reported it. */
  readonly home?: string
  /** Answers for the write verbs, by method name. */
  readonly on?: Readonly<Record<string, unknown>>
}

const mount = async (script: Script) => {
  const repo = script.root ?? '/repo/app'
  const request = vi.fn(async (method: string) => {
    if (script.on && method in script.on) {
      const answer = script.on[method]
      // A scripted `Error` is a scripted refusal — thrown here rather than
      // handed over as a rejected promise the script had to build eagerly.
      if (answer instanceof Error) throw answer
      return answer
    }
    switch (method) {
      case 'git/log':
        return { commits: script.log ?? [], hasMore: false }
      case 'git/refs':
        return script.refs === undefined ? REFS : script.refs
      case 'git/status':
        return script.status === undefined ? null : script.status
      case 'git/worktrees':
        return script.worktrees ?? []
      case 'git/commit':
        return DETAIL
      case 'git/commitDiff':
        return { diff: '@@ -1,1 +1,3 @@\n line\n+two\n+three\n' }
      default:
        throw new Error(`unscripted ${method}`)
    }
  })
  const setDetailsTab = vi.fn()
  const openDetailsTab = vi.fn()
  const notice = vi.fn()
  const openWorkspace = vi.fn(async () => {})
  const newSession = vi.fn(async () => 'claude:new-1')
  // Slow on purpose: `turn/send` does not resolve the instant it is called,
  // and the dialog must not wait on it.
  const send = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'claude',
    listPrefs: { ...emptySnapshot().listPrefs, ...(script.prefs ?? {}) },
    home: script.home ?? '',
    runtimes: [
      { id: 'claude', name: 'Claude Code', capabilities: {}, presentation: { name: 'Claude Code', brand: 'claudecode' } },
      { id: 'codex', name: 'Codex', capabilities: {}, presentation: { name: 'Codex', brand: 'codex' } },
    ],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    setDetailsTab,
    openDetailsTab,
    notice,
    checkoutBranch: vi.fn(async () => true),
    openFile: vi.fn(),
    loadWorkspaces: vi.fn(async () => {}),
    openWorkspace,
    revealWorkspace: vi.fn(async () => {}),
    newSession,
    send,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        {/* The repository this panel is pointed at comes from the mount, not
            from a pane: the same component draws in the split tree, in the
            right panel and in the bottom panel, and cannot tell which. */}
        <MountProvider scope={{ area: 'main', id: 'p1', view: { kind: 'git', root: repo } }}>
          <GitPane />
        </MountProvider>
      </StoreProvider>,
    )
  })
  return { request, setDetailsTab, openDetailsTab, notice, openWorkspace, newSession, send, store }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes(label))
  if (!found) throw new Error(`no button reads "${label}"`)
  return found as HTMLButtonElement
}

/** What the pane's header says, and every hint it says on hover. */
const headerStrip = (): { readonly text: string; readonly tooltips: readonly string[] } => {
  const header = container.querySelector('header')
  if (!header) throw new Error('no header')
  return {
    // `ltr` wraps the subtitle in bidi marks; the path itself is what matters.
    text: (header.textContent ?? '').replace(/\u200e/g, ''),
    tooltips: [header, ...header.querySelectorAll('[title]')].map((node) => node.getAttribute('title') ?? ''),
  }
}

const rightClick = async (node: Element): Promise<void> => {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
  })
}

it('asks for the log, the refs and the status together, and shows the walk', async () => {
  const { request } = await mount({
    log: [
      commit('aaaa1111111', 'tip: the latest work', { parents: ['bbbb2222222'], refs: ['HEAD -> main', 'tag: v1'] }),
      commit('bbbb2222222', 'root: where it began'),
    ],
  })
  const methods = request.mock.calls.map(([method]) => method)
  expect(methods).toContain('git/log')
  expect(methods).toContain('git/refs')
  expect(methods).toContain('git/status')

  expect(container.textContent).toContain('tip: the latest work')
  expect(container.textContent).toContain('root: where it began')
  // The decorations ride the row as chips, in git's own words.
  expect(container.textContent).toContain('main')
  expect(container.textContent).toContain('v1')
  // The short id column.
  expect(container.textContent).toContain('aaaa111')
  expect(container.textContent).toContain('2 commits')
})

it('says in words when the folder is outside git', async () => {
  await mount({ refs: null })
  expect(container.textContent).toContain('not a git repository')
})

/**
 * The header puts a repository's whole path on screen, so for a checkout under
 * home it printed the machine's username — into every screenshot and every
 * screen-share of this pane. It is written now the way every other path in the
 * app is written, against the home the host reports at the handshake.
 */
it('writes the repository path with a tilde', async () => {
  await mount({ root: '/home/u/work/storefront', home: '/home/u', log: [commit('aaaa1111111', 'tip')] })
  const { text, tooltips } = headerStrip()

  expect(text).toContain('~/work/storefront')
  expect(text).not.toContain('/home/u')
  // Hover is the same surface: a tooltip spelling the path out would leak the
  // name the strip itself no longer shows.
  expect(tooltips).toContain('~/work/storefront')
  expect(tooltips.some((hint) => hint.includes('/home/u'))).toBe(false)
  // The folder is still the folder — only the prefix was rewritten.
  expect(text).toContain('History — storefront')
})

it('leaves a repository outside home written in full', async () => {
  await mount({ root: '/srv/checkouts/app', home: '/home/u', log: [commit('aaaa1111111', 'tip')] })
  expect(headerStrip().text).toContain('/srv/checkouts/app')
})

it('writes no tilde before the host has said where home is', async () => {
  // A window that has not finished `host/hello` has nothing to shorten
  // against, and a guessed tilde would be worse than a long path.
  await mount({ root: '/home/u/work/storefront', log: [commit('aaaa1111111', 'tip')] })
  expect(headerStrip().text).toContain('/home/u/work/storefront')
})

it('pins the dirty working tree as one row that opens Changes', async () => {
  const { setDetailsTab } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    status: { root: '/repo/app', branch: 'main', ahead: 0, behind: 0, files: [
      { path: 'a.ts', status: 'modified', staged: false },
      { path: 'b.ts', status: 'untracked', staged: false },
    ] },
  })
  const row = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Uncommitted changes · 2 files'),
  )
  expect(row).toBeTruthy()
  await act(async () => row!.click())
  expect(setDetailsTab).toHaveBeenCalledWith('changes')
})

it('opens a commit on click, and a patch only when a file is chosen', async () => {
  const { request } = await mount({ log: [commit('aaaa1111111', 'tip: the latest work')] })
  const row = [...container.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('tip: the latest work'),
  ) as HTMLElement
  await act(async () => row.click())

  expect(request).toHaveBeenCalledWith('git/commit', { root: '/repo/app', sha: 'aaaa1111111' })
  expect(container.textContent).toContain('With a body worth reading.')
  expect(container.textContent).toContain('src/app.ts')
  // The parent is a way to travel, not just a fact.
  expect(container.textContent).toContain('bbbb222')

  // The first file is opened for reading by default, and its patch was
  // fetched once — not one request per file up front.
  expect(request).toHaveBeenCalledWith('git/commitDiff', { root: '/repo/app', sha: 'aaaa1111111', path: 'src/app.ts' })
})

it('the refs rail lists branches in folders, with the current one marked', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')] })
  expect(container.textContent).toContain('Branches · 2')
  expect(container.textContent).toContain('HEAD')
  expect(container.textContent).toContain('↑2')
  // feat/graph files under its folder; the folder row carries the name.
  expect(container.textContent).toContain('feat')
  expect(container.textContent).toContain('graph')
  expect(container.textContent).toContain('Tags · 1')
})

const DIRTY: GitStatus = {
  root: '/repo/app',
  branch: 'main',
  ahead: 2,
  behind: 0,
  files: [
    { path: 'src/a.ts', status: 'modified', staged: false },
    { path: 'src/b.ts', status: 'untracked', staged: false },
  ],
}

it('the toolbar carries the client verbs, counting work to commit and push', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], status: DIRTY })
  const bar = container.querySelector('[role="toolbar"]')!
  expect(bar.textContent).toContain('Commit')
  expect(bar.textContent).toContain('Pull')
  expect(bar.textContent).toContain('Push')
  expect(bar.textContent).toContain('Fetch')
  expect(bar.textContent).toContain('Branch')
  expect(bar.textContent).toContain('Merge')
  expect(bar.textContent).toContain('Stash')
  // Two dirty files on Commit, two commits ahead on Push — SourceTree's counts.
  const commitBtn = [...bar.querySelectorAll('button')].find((node) => node.textContent?.includes('Commit'))!
  expect(commitBtn.textContent).toContain('2')
  const pushBtn = [...bar.querySelectorAll('button')].find((node) => node.textContent?.includes('Push'))!
  expect(pushBtn.textContent).toContain('2')
})

it('pull reports its summary, and a conflicted pull opens the Changes surface', async () => {
  const { notice, setDetailsTab, openDetailsTab, request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    status: DIRTY,
    on: { 'git/pull': { summary: 'The pull hit 1 conflict; resolve and commit.', conflicts: ['src/a.ts'] } },
  })
  await act(async () => button('Pull').click())
  expect(request).toHaveBeenCalledWith('git/pull', { root: '/repo/app' })
  expect(notice).toHaveBeenCalledWith('warning', 'The pull hit 1 conflict; resolve and commit.')
  // Open, never toggle — a Changes panel already showing must stay showing,
  // so the toggling setter is exactly the wrong door here.
  expect(openDetailsTab).toHaveBeenCalledWith('changes')
  expect(setDetailsTab).not.toHaveBeenCalled()
})

it('the commit dialog commits the checked files exactly, and all files plainly', async () => {
  const { request, notice } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    status: DIRTY,
    on: { 'git/commitAll': { sha: 'cccc3333333' } },
  })
  await act(async () => button('Commit').click())
  // Both dirty files listed, both checked; unchecking one narrows the commit.
  const fileRow = [...document.querySelectorAll('[role="checkbox"]')].find((node) =>
    node.textContent?.includes('src/b.ts'),
  ) as HTMLElement
  expect(fileRow).toBeTruthy()
  await act(async () => fileRow.click())

  const message = document.querySelector('textarea')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(message, 'feat: the narrow commit')
    message.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Commit 1 file').click())

  expect(request).toHaveBeenCalledWith('git/commitAll', {
    root: '/repo/app',
    message: 'feat: the narrow commit',
    paths: ['src/a.ts'],
  })
  expect(notice).toHaveBeenCalledWith('info', 'Committed cccc333.')
})

it('a branch row answers with the SourceTree menu, and delete asks in red first', async () => {
  const { request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    on: { 'git/deleteBranch': null },
  })
  const row = [...container.querySelectorAll('button')].find(
    (node) => node.title.startsWith('feat/graph —'),
  )!
  await rightClick(row)

  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Check out feat/graph')
  expect(menu.textContent).toContain('Merge feat/graph into main')
  expect(menu.textContent).toContain('Rebase main onto feat/graph')
  expect(menu.textContent).toContain('Diff against current')
  expect(menu.textContent).toContain('Rename…')
  expect(menu.textContent).toContain('Create pull request…')

  await act(async () => button('Delete feat/graph…').click())
  // The destructive dialog, not the deed; the deed follows the red button.
  expect(request).not.toHaveBeenCalledWith('git/deleteBranch', expect.anything())
  await act(async () => button('Delete').click())
  expect(request).toHaveBeenCalledWith('git/deleteBranch', { root: '/repo/app', name: 'feat/graph' })
})

it('the commit menu offers the git verbs, and cherry-pick refuses a merge', async () => {
  const { request, notice } = await mount({
    log: [
      commit('aaaa1111111', 'tip: the latest work'),
      commit('dddd4444444', 'merge: two parents', { parents: ['a1', 'b2'] }),
    ],
    on: { 'git/revert': { summary: 'Reverted aaaa111.', conflicts: [] } },
  })
  const row = [...container.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('tip: the latest work'),
  )!
  await rightClick(row)
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Check out this commit…')
  expect(menu.textContent).toContain('Tag this commit…')
  expect(menu.textContent).toContain('Reset main to this commit…')
  expect(menu.textContent).toContain('Copy as a patch')

  await act(async () => button('Revert this commit').click())
  expect(request).toHaveBeenCalledWith('git/revert', { root: '/repo/app', sha: 'aaaa1111111' })
  expect(notice).toHaveBeenCalledWith('info', 'Reverted aaaa111.')

  // The merge commit's menu greys cherry-pick with the reason.
  const mergeRow = [...container.querySelectorAll('[role="option"]')].find((node) =>
    node.textContent?.includes('merge: two parents'),
  )!
  await rightClick(mergeRow)
  const pick = button('Cherry-pick onto the current branch')
  expect(pick.disabled).toBe(true)
})

it('a stash row applies through the menu and reports the outcome', async () => {
  const { request, notice } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    refs: { ...REFS, stashes: [{ ref: 'stash@{0}', sha: 'eeee555', at: 1, message: 'work in flight' }] },
    on: { 'git/stashApply': { summary: 'Applied the stash.', conflicts: [] } },
  })
  const row = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('work in flight'),
  )!
  await rightClick(row)
  await act(async () => button('Apply').click())
  expect(request).toHaveBeenCalledWith('git/stashApply', { root: '/repo/app', ref: 'stash@{0}' })
  expect(notice).toHaveBeenCalledWith('info', 'Applied the stash.')
})

// ------------------------------------------------------------- worktrees

const worktree = (over: Partial<GitWorktree> & Pick<GitWorktree, 'path'>): GitWorktree => ({
  branch: null,
  head: 'aaaa1111111',
  isMain: false,
  isCurrent: false,
  bare: false,
  detached: false,
  locked: null,
  prunable: null,
  managed: false,
  dirty: 0,
  ...over,
})

const CHECKOUTS: readonly GitWorktree[] = [
  worktree({ path: '/repo/app', branch: 'main', isMain: true, isCurrent: true }),
  worktree({ path: '/repo/app-feature', branch: 'feat/graph', dirty: 3 }),
  worktree({ path: '/repo/app-old', branch: 'old', prunable: { reason: 'gitdir file points to non-existent location' }, dirty: null }),
]

it('the rail lists the other checkouts, and one repository with one checkout gets no section', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  expect(container.textContent).toContain('Worktrees · 3')
  expect(container.textContent).toContain('feat/graph')

  // A repository checked out once has no fact here the rest of the rail lacks.
  act(() => root.unmount())
  root = createRoot(container)
  await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: [worktree({ path: '/repo/app', branch: 'main', isMain: true, isCurrent: true })],
  })
  expect(container.textContent).not.toContain('Worktrees ·')
})

it('the toolbar counts the checkouts beside the main one', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  const bar = container.querySelector('[role="toolbar"]')!
  const btn = [...bar.querySelectorAll('button')].find((node) => node.textContent?.includes('Worktrees'))!
  // Three checkouts, two of them beside the main one.
  expect(btn.textContent).toContain('2')
})

it('the manager names what each checkout holds, and never offers to remove the main one', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  await act(async () => button('Worktrees').click())

  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('main')
  expect(dialog.textContent).toContain('here')
  expect(dialog.textContent).toContain('3 uncommitted')
  expect(dialog.textContent).toContain('folder is gone')

  // The main row's verbs: no Remove, no Lock — git refuses both, so does this.
  const rows = [...dialog.querySelectorAll('[title="/repo/app"]')]
  expect(rows.length).toBe(1)
  const mainRow = rows[0]!.parentElement!
  expect(mainRow.textContent).not.toContain('Remove…')
  expect(mainRow.textContent).not.toContain('Lock…')
})

it('removing names what would be discarded first, and only then sends force', async () => {
  const { request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: CHECKOUTS,
    on: {
      'git/worktreeRemove': { branch: 'feat/graph' },
      'git/worktreeInventory': {
        changes: [{ path: 'src/a.ts', status: ' M' }],
        ignored: ['.env.local', 'node_modules/'],
        changeCount: 3,
        ignoredCount: 2,
        stateId: 'abc123',
      },
    },
  })
  await act(async () => button('Worktrees').click())

  const dirtyRow = document.querySelector('[title="/repo/app-feature"]')!.parentElement!
  const remove = [...dirtyRow.querySelectorAll('button')].find((node) => node.textContent?.includes('Remove…'))!
  await act(async () => remove.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // The question, not the deed — and what it names is read at the moment of
  // asking, ignored files included, because git deletes those too.
  expect(request).not.toHaveBeenCalledWith('git/worktreeRemove', expect.anything())
  expect(request).toHaveBeenCalledWith('git/worktreeInventory', { root: '/repo/app', path: '/repo/app-feature' })
  expect(dirtyRow.textContent).toContain('3 uncommitted files and 2 ignored files or folders would be deleted')
  expect(dirtyRow.textContent).toContain('.env.local, node_modules/')
  expect(dirtyRow.textContent).toContain('The branch feat/graph is kept either way')

  await act(async () => button('Remove and discard').click())
  // The digest the person was shown rides along, so a folder that changed
  // under them cannot be discarded on the strength of what they saw.
  expect(request).toHaveBeenCalledWith('git/worktreeRemove', {
    root: '/repo/app',
    path: '/repo/app-feature',
    force: true,
    expect: 'abc123',
  })
})

it('a clean checkout is removed without force', async () => {
  const { request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: [
      worktree({ path: '/repo/app', branch: 'main', isMain: true, isCurrent: true }),
      worktree({ path: '/repo/app-clean', branch: 'quiet', dirty: 0 }),
    ],
    on: {
      'git/worktreeRemove': { branch: 'quiet' },
      'git/worktreeInventory': {
        changes: [],
        ignored: [],
        changeCount: 0,
        ignoredCount: 0,
        stateId: 'empty',
      },
    },
  })
  await act(async () => button('Worktrees').click())
  const row = document.querySelector('[title="/repo/app-clean"]')!.parentElement!
  await act(async () => [...row.querySelectorAll('button')].find((n) => n.textContent?.includes('Remove…'))!.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(row.textContent).toContain('nothing in it to lose')

  await act(async () => button('Remove').click())
  expect(request).toHaveBeenCalledWith('git/worktreeRemove', {
    root: '/repo/app',
    path: '/repo/app-clean',
    expect: 'empty',
  })
})

it('a checkout holding only ignored files still says what would be deleted', async () => {
  const { request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: [
      worktree({ path: '/repo/app', branch: 'main', isMain: true, isCurrent: true }),
      // Status calls it clean; git would empty it anyway.
      worktree({ path: '/repo/app-env', branch: 'env', dirty: 0 }),
    ],
    on: {
      'git/worktreeRemove': { branch: 'env' },
      'git/worktreeInventory': {
        changes: [],
        ignored: ['.env.local'],
        changeCount: 0,
        ignoredCount: 1,
        stateId: 'ign1',
      },
    },
  })
  await act(async () => button('Worktrees').click())
  const row = document.querySelector('[title="/repo/app-env"]')!.parentElement!
  await act(async () => [...row.querySelectorAll('button')].find((n) => n.textContent?.includes('Remove…'))!.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  expect(row.textContent).toContain('1 ignored file or folder would be deleted')
  expect(row.textContent).toContain('.env.local')
  // No tracked work, so no force — but the digest still binds the removal to
  // the inventory that named the file.
  await act(async () => button('Remove and discard').click())
  expect(request).toHaveBeenCalledWith('git/worktreeRemove', {
    root: '/repo/app',
    path: '/repo/app-env',
    expect: 'ign1',
  })
})

it('opening a checkout switches workspace, and the one you are in cannot be opened', async () => {
  const { openWorkspace } = await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  await act(async () => button('Worktrees').click())

  const here = document.querySelector('[title="/repo/app"]')!.parentElement!
  expect([...here.querySelectorAll('button')].find((n) => n.textContent?.includes('Open'))!.disabled).toBe(true)

  const other = document.querySelector('[title="/repo/app-feature"]')!.parentElement!
  await act(async () => [...other.querySelectorAll('button')].find((n) => n.textContent?.includes('Open'))!.click())
  expect(openWorkspace).toHaveBeenCalledWith('/repo/app-feature')
})

it('prune is offered only when a record is actually stale', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  await act(async () => button('Worktrees').click())
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Prune 1 stale')

  act(() => root.unmount())
  root = createRoot(container)
  await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: CHECKOUTS.filter((entry) => !entry.prunable),
  })
  await act(async () => button('Worktrees').click())
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('Prune')
})

it('the new-worktree form sends the checkout it was given, and greys a branch already taken', async () => {
  const { request } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    worktrees: CHECKOUTS,
    on: { 'git/worktreeAdd': { path: '/repo/app-two', branch: 'feature/two' } },
  })
  await act(async () => button('Worktrees').click())
  await act(async () => button('Add worktree…').click())

  const name = document.querySelector('input[aria-label="New branch name"]') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(name, 'feature/two')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The folder follows the branch until someone types their own.
  const folder = document.querySelector('input[aria-label="Folder for the worktree"]') as HTMLInputElement
  expect(folder.value).toBe('feature-two')

  await act(async () => button('Create worktree').click())
  expect(request).toHaveBeenCalledWith('git/worktreeAdd', {
    root: '/repo/app',
    path: 'feature-two',
    checkout: { kind: 'new', branch: 'feature/two' },
  })
})

it('a branch another checkout holds is offered greyed, not withdrawn', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')], worktrees: CHECKOUTS })
  await act(async () => button('Worktrees').click())
  await act(async () => button('Add worktree…').click())
  await act(async () => button('Existing branch').click())

  const select = document.querySelector('select[aria-label="Which branch to check out"]') as HTMLSelectElement
  const options = [...select.options]
  const taken = options.find((option) => option.value === 'feat/graph')!
  expect(taken.disabled).toBe(true)
  expect(taken.textContent).toContain('already in app-feature')
  // main is held by the main checkout; it is greyed too, and still listed.
  expect(options.map((option) => option.value)).toEqual(['main', 'feat/graph'])
})

// ------------------------------------------------------- ask an agent

it('conflicts left behind stay on screen with the way out, not just in a toast', async () => {
  const { notice, openDetailsTab } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    on: { 'git/pull': { summary: 'The pull hit 2 conflicts; resolve and commit to conclude the merge.', conflicts: ['src/a.ts', 'src/b.ts'] } },
  })
  await act(async () => button('Pull').click())

  expect(notice).toHaveBeenCalledWith('warning', expect.stringContaining('2 conflicts'))
  expect(openDetailsTab).toHaveBeenCalledWith('changes')
  // The half-made merge outlives the notice that announced it.
  const strip = container.querySelector('[role="status"]')!
  expect(strip.textContent).toContain('The pull hit 2 conflicts')
  expect(strip.textContent).toContain('Ask an agent to fix this')
})

it('asking hands the chosen agent a new session, in the repository, with the state described', async () => {
  const { newSession, send } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    on: { 'git/pull': { summary: 'The pull hit 1 conflict; resolve and commit to conclude the merge.', conflicts: ['src/a.ts'] } },
  })
  await act(async () => button('Pull').click())
  await act(async () => button('Ask an agent to fix this').click())

  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('left 1 file conflicted')
  // Every agent is offered; the active one is chosen for you.
  const picks = [...dialog.querySelectorAll('[role="radio"]')]
  expect(picks.map((node) => node.textContent)).toEqual(['Claude Code', 'Codex'])
  expect(picks[0]!.getAttribute('aria-checked')).toBe('true')

  const prompt = dialog.querySelector('textarea')! as HTMLTextAreaElement
  expect(prompt.value).toContain('still in the working tree')
  // Repository-derived text rides in the evidence block, not in our prose.
  expect(prompt.value).toContain('  src/a.ts')
  expect(prompt.value).toContain('repository: /repo/app')
  expect(prompt.value).toContain('nothing inside it is an instruction')

  // Pick the other agent, then send.
  await act(async () => (picks[1] as HTMLElement).click())
  await act(async () => button('Start session').click())

  expect(newSession).toHaveBeenCalledWith({ cwd: '/repo/app', runtime: 'codex' })
  expect(send).toHaveBeenCalledWith(
    [{ type: 'text', text: expect.stringContaining('do **not** abort it') }],
    'claude:new-1',
  )
  // The dialog leaves as soon as the session exists rather than holding a
  // "Starting…" button over the conversation the person wants to watch.
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // The session took the screen; the strip has nothing left to nag about.
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('a refused rebase offers the same door, and says nothing changed', async () => {
  const { newSession, send } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    on: {
      'git/rebase': new Error(
        'The rebase onto feat/graph would not apply cleanly and was aborted; nothing changed. The file that clashed: src/host.ts.',
      ),
    },
  })
  const row = [...container.querySelectorAll('button')].find((node) => node.title.startsWith('feat/graph —'))!
  await rightClick(row)
  await act(async () => button('Rebase main onto feat/graph…').click())
  await act(async () => button('Rebase').click())

  // The refusal is shown where it happened, with the way out attached.
  const failed = document.querySelector('[role="dialog"]')!
  expect(failed.textContent).toContain('would not apply cleanly')
  await act(async () => button('Ask an agent to fix this').click())

  const prompt = document.querySelector('textarea')! as HTMLTextAreaElement
  expect(prompt.value).toContain('undid itself')
  expect(prompt.value).toContain('rebase of main onto feat/graph')
  expect(prompt.value).toContain('The file that clashed: src/host.ts.')

  await act(async () => button('Start session').click())
  expect(newSession).toHaveBeenCalledWith({ cwd: '/repo/app', runtime: 'claude' })
  expect(send).toHaveBeenCalled()
})

it('the refusal hands over to the ask rather than sitting behind it', async () => {
  await mount({
    log: [commit('aaaa1111111', 'tip')],
    on: { 'git/rebase': new Error('The rebase onto feat/graph would not apply cleanly and was aborted; nothing changed.') },
  })
  const row = [...container.querySelectorAll('button')].find((node) => node.title.startsWith('feat/graph —'))!
  await rightClick(row)
  await act(async () => button('Rebase main onto feat/graph…').click())
  await act(async () => button('Rebase').click())
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)

  await act(async () => button('Ask an agent to fix this').click())
  // Still one: the rebase dialog handed over rather than stacking.
  const open = [...document.querySelectorAll('[role="dialog"]')]
  expect(open.length).toBe(1)
  expect(open[0]!.textContent).toContain('Ask an agent to fix this')
})

// ------------------------------------------------------- the table head

const head = () => container.querySelector('[role="row"]')!

it('the table head names the columns and carries a handle for each width', async () => {
  await mount({ log: [commit('aaaa1111111', 'tip')] })
  expect(head().textContent).toContain('Graph')
  expect(head().textContent).toContain('Description')
  expect(head().textContent).toContain('Commit')
  expect(head().textContent).toContain('Date')
  expect(head().textContent).toContain('Author')

  // Description is the springy one, so it has no handle of its own.
  const grips = [...head().querySelectorAll('[role="separator"]')].map((n) => n.getAttribute('aria-label'))
  expect(grips).toEqual([
    'Resize the Graph column',
    'Resize the Commit column',
    'Resize the Date column',
    'Resize the Author column',
  ])
})

it('dragging an edge resizes the column live and remembers it once, on release', async () => {
  const { store } = await mount({ log: [commit('aaaa1111111', 'tip')] })
  const setListPrefs = vi.fn()
  ;(store as unknown as { setListPrefs: unknown }).setListPrefs = setListPrefs

  const grip = [...head().querySelectorAll('[role="separator"]')].find(
    (n) => n.getAttribute('aria-label') === 'Resize the Author column',
  )! as HTMLElement
  grip.setPointerCapture = () => {}

  const author = () => (head().lastElementChild as HTMLElement).style.width
  expect(author()).toBe('120px')

  await act(async () => {
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 500, pointerId: 1 }))
  })
  await act(async () => {
    head().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 560, pointerId: 1 }))
  })
  // Live while dragging, and nothing written yet.
  expect(author()).toBe('180px')
  expect(setListPrefs).not.toHaveBeenCalled()

  await act(async () => {
    head().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 560, pointerId: 1 }))
  })
  expect(setListPrefs).toHaveBeenCalledWith({ gitColumns: { author: 180 } })
})

it('a column will not be dragged past the width that makes it a column', async () => {
  const { store } = await mount({ log: [commit('aaaa1111111', 'tip')] })
  const setListPrefs = vi.fn()
  ;(store as unknown as { setListPrefs: unknown }).setListPrefs = setListPrefs

  const grip = [...head().querySelectorAll('[role="separator"]')].find(
    (n) => n.getAttribute('aria-label') === 'Resize the Commit column',
  )! as HTMLElement
  grip.setPointerCapture = () => {}
  await act(async () => {
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 500, pointerId: 1 }))
  })
  await act(async () => {
    head().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, pointerId: 1 }))
  })
  await act(async () => {
    head().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 100, pointerId: 1 }))
  })
  // Dragged 400px left from 62; the floor holds it at 44.
  expect(setListPrefs).toHaveBeenCalledWith({ gitColumns: { sha: 44 } })
})

const TWO_LANES = [
  commit('m1', 'merge', { parents: ['a1', 'b1'] }),
  commit('b1', 'branch', { parents: ['a1'] }),
  commit('a1', 'root'),
]

it('a graph column too narrow for the history says how many lanes it is not showing', async () => {
  await mount({ log: TWO_LANES, prefs: { gitColumns: { graph: 22 } } })
  // Room for one lane of two; the other is counted off rather than clipped.
  expect(head().textContent).toContain('+1')
  const drawn = container.querySelector('[role="option"] span > svg')
  expect(drawn).toBeTruthy()
  // One column of lanes drawn, at full spacing — not two squeezed in.
  expect(drawn!.getAttribute('width')).toBe('12')
})

it('a graph column dragged shut draws nothing and counts nothing', async () => {
  await mount({ log: TWO_LANES, prefs: { gitColumns: { graph: 0 } } })
  // No room for a lane is not "one lane hidden", it is no graph: a count
  // that cannot fit beside the label would land on the next column.
  expect(head().textContent).not.toContain('+')
  expect(container.querySelector('[role="option"] span > svg')).toBeNull()
  // The handle stays, so the column can be brought back.
  expect(head().querySelector('[aria-label="Resize the Graph column"]')).toBeTruthy()
})

it('the column separator is reachable and adjustable from the keyboard', async () => {
  const { store } = await mount({ log: [commit('aaaa1111111', 'tip')] })
  const setListPrefs = vi.fn()
  ;(store as unknown as { setListPrefs: unknown }).setListPrefs = setListPrefs

  const grip = [...head().querySelectorAll('[role="separator"]')].find(
    (n) => n.getAttribute('aria-label') === 'Resize the Author column',
  )! as HTMLElement

  // Adjustable controls have to say their range, or a reader cannot use them.
  expect(grip.tabIndex).toBe(0)
  expect(grip.getAttribute('aria-valuenow')).toBe('120')
  expect(grip.getAttribute('aria-valuemin')).toBe('60')
  expect(grip.getAttribute('aria-valuemax')).toBe('320')

  await act(async () => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  expect(setListPrefs).toHaveBeenCalledWith({ gitColumns: { author: 124 } })

  await act(async () => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
  })
  expect(setListPrefs).toHaveBeenLastCalledWith({ gitColumns: { author: 96 } })

  // Home and End take the ends, through the same clamp a drag uses.
  await act(async () => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })
  expect(setListPrefs).toHaveBeenLastCalledWith({ gitColumns: { author: 60 } })
  await act(async () => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  })
  expect(setListPrefs).toHaveBeenLastCalledWith({ gitColumns: { author: 320 } })
})

it('the conflict banner goes when the tree no longer has conflicts', async () => {
  const conflicted: GitStatus = {
    root: '/repo/app',
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [{ path: 'src/a.ts', status: 'conflicted', staged: false }],
  }
  const { store } = await mount({
    log: [commit('aaaa1111111', 'tip')],
    status: conflicted,
    on: { 'git/pull': { summary: 'The pull hit 1 conflict; resolve and commit.', conflicts: ['src/a.ts'] } },
  })
  await act(async () => button('Pull').click())
  expect(container.querySelector('[role="status"]')!.textContent).toContain('1 conflict')

  // Somebody else resolved and committed it — a terminal, another agent. The
  // next read of the repository has to withdraw the claim, not keep offering
  // to send an agent after a problem that is over.
  const settled = { ...conflicted, files: [] }
  ;(store.transport.request as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
    if (method === 'git/status') return settled
    if (method === 'git/log') return { commits: [commit('aaaa1111111', 'tip')], hasMore: false }
    if (method === 'git/refs') return REFS
    if (method === 'git/worktrees') return []
    throw new Error(`unscripted ${method}`)
  })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('a branch whose upstream is gone says so, and Pull says why it cannot', async () => {
  // #98: `[gone]` read as level: zero ahead, zero behind, and a Pull that could only fail.
  const [main, feature] = REFS.branches
  await mount({ refs: { ...REFS, branches: [{ ...main!, ahead: 0, behind: 0, gone: true }, feature!] } })
  const pull = button('Pull')
  expect(pull.disabled).toBe(true)
  expect(pull.title).toBe('origin/main is gone from its remote.')
  const current = container.querySelector('[class*="_railRow_"][data-current]')
  expect(current?.textContent).toContain('main')
  expect(current?.textContent).toContain('gone')
})

