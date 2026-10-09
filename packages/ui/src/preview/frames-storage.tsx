import { useMemo } from 'react'
import { NO_CAPABILITIES, runtimeId, sessionId, type StorageCleanupPreview, type StorageUsage, type RuntimeInfo } from '@harnessdesk/protocol'
import { Settings } from '../components/Settings'
import { StoreProvider } from '../state/context'
import { Frame } from './main'
import { previewStore } from './harness'

const alpha: RuntimeInfo = { id: runtimeId('alpha'), name: 'Alpha', capabilities: NO_CAPABILITIES, presentation: { name: 'Alpha' } }
const changes = { modified: 0, untracked: 0, files: [], ignored: [], ignoredCount: 0, unpushedCommits: 0 }
const candidates: StorageCleanupPreview['candidates'] = [
  { runtime: alpha.id, sessionId: sessionId('clean-a'), title: 'Trace the slow startup', path: '/preview/worktrees/startup', bytes: 1.8 * 1024 ** 3, changes, clean: true },
  { runtime: alpha.id, sessionId: sessionId('clean-b'), title: 'Review the project picker', path: '/preview/worktrees/project-picker', bytes: 0.7 * 1024 ** 3, changes, clean: true },
  { runtime: alpha.id, sessionId: sessionId('dirty'), title: 'Finish the saved draft', path: '/preview/worktrees/saved-draft', bytes: 0.9 * 1024 ** 3,
    changes: { ...changes, modified: 1, untracked: 1, files: ['src/draft.ts', 'notes.txt'], ignoredCount: 2, ignored: ['.env', 'node_modules/'] }, clean: false },
]
const keptWorktrees = [
  { runtime: alpha.id, sessionId: sessionId('removed'), title: 'Document the import flow', path: '/preview/worktrees/import-flow', changes: { ...changes, modified: 2, files: ['README.md', 'src/import.ts'], ignoredCount: 1, ignored: ['.env'] } },
  { runtime: alpha.id, sessionId: sessionId('deleted'), title: 'Check the saved draft', path: '/preview/worktrees/saved-draft', changes: { ...changes, untracked: 1, files: ['notes.txt'], ignoredCount: 1, ignored: ['node_modules/'] } },
]
const StorageFrame = ({ scene }: { scene: string }) => {
  const own = useMemo(() => {
    const store = previewStore({ runtimes: [alpha], activeRuntime: alpha.id, workspaces: [], accountsByRuntime: {}, history: [] })
    const usage: StorageUsage = { database: { bytes: 148 * 1024 ** 2, computing: false }, snapshots: { count: 3, bytes: 420 * 1024 ** 2, computing: false },
      cachedPreviews: { count: 18, bytes: 86 * 1024 ** 2 }, worktrees: { count: 24, bytes: 8.6 * 1024 ** 3, kept: 2, computing: scene === 'measuring' } }
    store.subscribeStorageUsage = () => () => {}
    const original = store.transport.request
    store.transport.request = (async (method, params) => {
      if (method === 'storage/usage') return usage
      if (method === 'storage/kept') return keptWorktrees
      if (method === 'storage/cleanupPreview') return { candidates, cleanBytes: 2.5 * 1024 ** 3, inventoryToken: 'synthetic-confirmation' }
      if (method === 'session/worktreePreview') return { changes: keptWorktrees.find(row => row.sessionId === (params as { sessionId: string }).sessionId)!.changes, stamp: 'synthetic-discard' }
      return original(method, params as never)
    }) as typeof store.transport.request
    return store
  }, [scene])
  return <Frame id={`storage-${scene}`} title={`Storage — ${scene}`}>
    <div className="relative h-[700px]" style={{ transform: 'translateZ(0)' }}><StoreProvider store={own}>
      <Settings section="storage" onSection={() => {}} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider></div>
  </Frame>
}
export const StorageFrames = () => {
  const scene = new URLSearchParams(window.location.search).get('storage')
  return <div className="grid gap-4 p-4">{(scene ? [scene] : ['page', 'measuring']).map(scene => <StorageFrame key={scene} scene={scene} />)}</div>
}
