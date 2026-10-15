import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { WorkspaceMenu } from './WorkspaceMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['unlisted', 'alias'])('refreshes the project menu independently of recent-folder paths: %s', async kind => {
  const path = '/work/storefront'
  const store = new AppStore('ws://localhost:0/')
  const recent = kind === 'alias' ? [{ path: '/work/link', realPath: path, name: 'storefront', lastOpenedAt: 1, git: { branch: 'main', sha: null } }] : []
  Object.assign(store.getSnapshot(), { workspaces: recent, health: { state: 'ready' } })
  let resolve!: (value: unknown) => void
  const request = vi.spyOn(store.transport, 'request').mockReturnValueOnce(new Promise(done => { resolve = done }) as never)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const group = { root: path, name: 'storefront', sessions: [], folders: [path], updatedAt: 0 }
  try {
    await act(async () => root.render(<StoreProvider store={store}>
      <WorkspaceMenu group={group} current={false} actualRoot={path} at={{ x: 10, y: 10 }} onClose={() => {}} onNewWorktree={() => {}} />
    </StoreProvider>))
    expect(request).toHaveBeenCalledWith('git/status', { root: path })
    await act(async () => { resolve({ root: path, branch: 'main', headSha: null, files: [], ahead: 0, behind: 0 }) })
    await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())) })
    expect(store.getSnapshot().workspaceGitFacts.get(path)).toEqual({ branch: 'main', sha: null })
    expect(document.body.textContent).toContain('Make a first commit to work in a worktree')
    const commit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!
    const askCommit = vi.spyOn(store, 'askCommit').mockImplementation(() => {})
    act(() => commit.click())
    expect(askCommit).toHaveBeenCalledWith(path)
    request.mockResolvedValueOnce({ root: path, branch: 'main', headSha: 'beef123', files: [], ahead: 0, behind: 0 } as never)
    await act(async () => store.refreshWorkspaceGit(path))
    await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())) })
    expect(document.body.textContent).not.toContain('Make a first commit to work in a worktree')
    const worktree = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.startsWith('New worktree'))
    expect(worktree?.getAttribute('aria-disabled')).not.toBe('true')
    expect(worktree).toBeDefined()
    request.mockRejectedValueOnce(new Error('Unavailable'))
    await act(async () => store.refreshWorkspaceGit(path))
    expect(store.getSnapshot().workspaceGitFacts.get(path)?.sha).toBe('beef123')
    request.mockResolvedValueOnce(null as never)
    await act(async () => store.refreshWorkspaceGit(path))
    await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())) })
    expect(document.body.textContent).not.toContain('New worktree')
    expect(document.body.textContent).not.toContain('Make a first commit to work in a worktree')
    expect(store.getSnapshot().workspaces).toEqual(recent)
    expect(store.getSnapshot().workspace).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
