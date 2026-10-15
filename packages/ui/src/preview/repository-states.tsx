import { useMemo } from 'react'
import { sessionKey, runtimeId, sessionId, turnId, type FileChange, type HostMethodName, type Turn } from '@harnessdesk/protocol'
import { PaneColumn, Text } from '../design'
import { PlaceControl } from '../components/ComposerControls'
import { CommitDialog } from '../components/GitDialogs'
import { TurnFiles } from '../components/TurnFiles'
import { StoreProvider, useSnapshot, useStore } from '../state/context'
import { AppStore } from '../state/store'
import { useTheme } from '../state/theme'

const ROOT = '/work/storefront'
const KEY = sessionKey(runtimeId('demo'), sessionId('repository-states'))
const SHA = 'c0ffee1234567890abcdef1234567890abcdef1234'
const changes: readonly FileChange[] = [
  { path: `${ROOT}/src/cart.ts`, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
  { path: `${ROOT}/src/retry.ts`, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
]
const turn: Turn = { id: turnId('repository-turn'), status: 'completed', items: [], diff: null }

const RepositorySurface = ({ unborn }: { unborn: boolean }) => {
  useTheme()
  const store = useStore()
  const snapshot = useSnapshot()
  return <main className="min-h-screen bg-background text-foreground">
    <PaneColumn inset="reading" page>
      <Text role="subject">{unborn ? 'Start a conversation in storefront' : 'Update the cart and retry handling'}</Text>
      {unborn ? <PlaceControl /> : <TurnFiles turn={turn} changes={changes} root={ROOT} />}
    </PaneColumn>
    {snapshot.commitFor && <CommitDialog root={snapshot.commitFor} onDone={done => {
      store.askCommit(null)
      if (done) void store.loadWorkspaces()
    }} />}
  </main>
}

/** Placeholder-only boundary, exercising the real store, menu, dialog and card. */
export const RepositoryStatesPreview = () => {
  const query = new URLSearchParams(location.search)
  const scene = query.get('repository-states')
  const unborn = scene === 'unborn'
  const store = useMemo(() => {
    const store = new AppStore('ws://localhost:0/')
    let committed = !unborn
    const workspace = () => ({ path: ROOT, name: 'storefront', lastOpenedAt: 1,
      git: { branch: query.has('before') && unborn ? null : 'main', sha: committed ? SHA : null },
      repo: { root: ROOT, worktree: false },
    })
    Object.assign(store.getSnapshot(), { status: 'open', activeSessionKey: KEY,
      workspace: workspace(), workspaces: [workspace()],
      theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    })
    store.transport.request = (async (method: HostMethodName) => {
      if (method === 'session/turnCommit') return { sha: scene === 'committed' ? SHA : null }
      if (method === 'git/status') return { root: ROOT, branch: 'main', ahead: 0, behind: 0,
        files: [{ path: 'README.md', status: 'untracked', staged: false }],
      }
      if (method === 'git/commitAll') { committed = true; return { sha: SHA } }
      if (method === 'workspace/recent') return [workspace()]
      if (method === 'worktree/list') return []
      return null
    }) as typeof store.transport.request
    return store
  }, [])
  return <StoreProvider store={store}><RepositorySurface unborn={unborn} /></StoreProvider>
}
