import { expect, it, vi } from 'vitest'
import { AppStore } from './store'

const main = { path: '/work/main', name: 'main', lastOpenedAt: 1, git: { branch: 'main', sha: 'unchanged' } }
const tree = { path: '/work/tree', name: 'tree', lastOpenedAt: 0, git: { branch: 'topic', sha: null } }
const status = (sha: string | null) => ({ root: tree.path, branch: 'topic', headSha: sha, files: [], ahead: 0, behind: 0 })
const rig = () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: main, workspaces: [main, tree] })
  return store
}

it('refreshes another checkout without switching folders or reordering recents', async () => {
  const store = rig()
  vi.spyOn(store.transport, 'request').mockResolvedValue(status('beef123') as never)
  await store.refreshWorkspaceGit(tree.path)
  expect(store.getSnapshot().workspace).toBe(main)
  expect(store.getSnapshot().workspaces).toEqual([main, { ...tree, git: { branch: 'topic', sha: 'beef123' } }])
})

it('keeps the newest read when an older Git answer arrives last', async () => {
  const store = rig()
  let resolve!: (value: unknown) => void
  vi.spyOn(store.transport, 'request').mockReturnValueOnce(new Promise(done => { resolve = done }) as never)
    .mockResolvedValueOnce(status('beef123') as never)
  const old = store.refreshWorkspaceGit(tree.path)
  await store.refreshWorkspaceGit(tree.path)
  resolve(status(null))
  await old
  expect(store.getSnapshot().workspaces[1]?.git?.sha).toBe('beef123')
  expect(store.getSnapshot().workspaceGitFacts.get(tree.path)?.sha).toBe('beef123')
})

it('preserves established facts when a Git read fails', async () => {
  const store = rig()
  const snapshot = store.getSnapshot()
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('Unavailable'))
  await store.refreshWorkspaceGit(tree.path)
  expect(store.getSnapshot()).toBe(snapshot)
})

it('retains a confirmed non-repository answer for a root absent from recents', async () => {
  const store = rig()
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  await store.refreshWorkspaceGit('/work/plain')
  expect(store.getSnapshot().workspaceGitFacts.has('/work/plain')).toBe(true)
  expect(store.getSnapshot().workspaceGitFacts.get('/work/plain')).toBeNull()
})
