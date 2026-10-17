/** Synthetic host answers around the real store, including a renderer restart. */
import { createRoot } from 'react-dom/client'
import { itemId, sessionId, turnId, type HostMethodName, type Session, type WorkspaceEntry } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { previewStore, runtime } from './harness'
import '../styles/app.css'

const storageKey = 'chats-review-host'
const scene = new URLSearchParams(location.search).get('scene')
const project = { path: '/demo/project', name: 'project', lastOpenedAt: 1, git: null }
const managed = '/demo/chats/2026-10-16-ABC123'
const info = runtime('alpha', 'Alpha')
const root = '/demo/chats'
const host = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as {
  preferences: Record<string, unknown>; workspaces: WorkspaceEntry[]; sessions: Session[]
} | null
const state: { preferences: Record<string, unknown>; workspaces: WorkspaceEntry[]; sessions: Session[] } = host ?? { preferences: { chatsFolder: root, chatsFolderRoots: [managed] }, workspaces: [{ path: managed, name: 'Managed chat', lastOpenedAt: 2, git: null }, project], sessions: [] }
const save = () => sessionStorage.setItem(storageKey, JSON.stringify(state))
const fixture = previewStore({
  status: 'open', theme: 'system', runtimes: [info], activeRuntime: info.id,
  health: { state: 'ready' }, healthByRuntime: { alpha: { state: 'ready' } },
  workspace: null, workspaces: [], worktrees: [], activeSessionKey: null, sessions: new Map(),
  history: state.sessions, historyIdentity: state.sessions, teams: new Map(), goals: new Map(),
  draftOptions: [], tasks: new Map(), approvals: [], inbox: [], usage: [],
  chatsFolder: root, chatsFolderRoots: [],
})
const store = new AppStore('ws://localhost:0/')
Object.assign(store.getSnapshot(), fixture.getSnapshot())
const fallback = fixture.transport.request.bind(fixture.transport)
store.transport.request = (async (method: HostMethodName, params: unknown) => {
  if (method === 'app/state/get') return state.preferences
  if (method === 'app/state/set') {
    const patch = (params as { patch: Record<string, unknown> }).patch
    if (patch.chatsFolder === '/demo') throw new Error('Chats folder contains an opened project.')
    Object.assign(state.preferences, patch)
    save()
    return state.preferences
  }
  if (method === 'workspace/browse') return { path: '/demo', parent: '/', entries: [project] }
  if (method === 'workspace/recent') return state.workspaces
  if (method === 'workspace/open') {
    const { path } = params as { path: string }
    const workspace = { path, name: path.split('/').at(-1)!, lastOpenedAt: 1, git: null, repo: null }
    state.workspaces = [workspace, ...state.workspaces.filter(one => one.path !== path)]
    save()
    return workspace
  }
  if (method === 'runtime/sessionDefaults' || method === 'worktree/list' || method === 'lane/list') return []
  if (method === 'git/status') return (params as { root: string }).root === project.path
    ? { root: project.path, branch: 'main', headSha: 'abcd1234', files: [], ahead: 0, behind: 0 } : null
  if (method === 'session/create') {
    const { options } = params as { options: { cwd?: string } }
    const id = sessionId(`chat-${state.sessions.length + 1}`)
    const session: Session = {
      runtime: info.id, id, cwd: options.cwd ?? `${root}/2026-10-16-${id}`,
      title: 'Plan a weekend project', status: { type: 'idle' }, createdAt: 1, updatedAt: 2,
      itemsLoaded: true, turns: [{ id: turnId('turn'), status: 'completed', items: [
        { id: itemId('question'), type: 'userMessage', content: [{ type: 'text', text: 'Plan a weekend project' }] },
        { id: itemId('answer'), type: 'assistantMessage', text: 'Start with a small prototype, then check the result.' },
      ] }],
    }
    state.preferences.chatsFolderRoots = [...(state.preferences.chatsFolderRoots as string[]), session.cwd]
    state.sessions.push(session)
    save()
    return session
  }
  if (method === 'session/read' || method === 'session/resume') {
    const { runtime, sessionId } = params as { runtime: string; sessionId: string }
    return state.sessions.find(one => one.runtime === runtime && one.id === sessionId)
  }
  if (method === 'turn/queue' || method === 'turn/send') return null
  return fallback(method, params as never)
}) as typeof store.transport.request
Object.assign(window, { chatsStore: store })
await store.loadWorkspaces()
await store.loadPreferences()
if (scene === 'repository') await store.openWorkspace(project.path)
if (scene === 'settings' || scene === 'folders') {
  const workbench = store.getSnapshot().workbench
  Object.assign(store.getSnapshot(), { workbench: { ...workbench, navigation: { ...workbench.navigation,
    current: { kind: 'settings', route: { kind: 'section', section: scene === 'settings' ? 'general' : 'workspaces', focus: null } } } } })
}
document.documentElement.dataset.chatsReady = 'true'
createRoot(document.getElementById('root')!).render(<StoreProvider store={store}><App /></StoreProvider>)
