/** Synthetic chats desk: all folders and identities are placeholders. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { runtimeId, sessionId, sessionKey, turnId, itemId, type Session, type SessionSummary } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { only } from '../state/layout'
import { StoreProvider } from '../state/context'
import { previewStore, runtime } from './harness'
import '../styles/app.css'

const info = runtime('alpha', 'Alpha')
const root = '/demo/chats'
const params = new URLSearchParams(location.search)
const summary = (id: string, cwd: string, title: string): SessionSummary => ({
  id: sessionId(id), runtime: info.id, cwd, title, preview: title, createdAt: 1, updatedAt: 2,
  status: { type: 'notLoaded' }, archived: false, git: null, repo: null,
})
const history = params.has('empty') ? [] : [summary('chat', `${root}/2026-10-16-demo01`, 'Plan a weekend project'),
  summary('unknown', '', 'Explain a retry budget')]
const store = previewStore({
  status: 'open', theme: 'system', runtimes: [info], activeRuntime: runtimeId('alpha'),
  health: { state: 'ready' }, healthByRuntime: { alpha: { state: 'ready' } },
  workspace: null, workspaces: [], worktrees: [], activeSessionKey: null, sessions: new Map(), history,
  historyIdentity: history, teams: new Map(), goals: new Map(), draftOptions: [], tasks: new Map(),
  approvals: [], inbox: [], usage: [], chatsFolder: root, chatsFolderRoots: [root],
})
store.agentCatalog = async () => []
store.clearDraftFolder = () => store.patch({ workspace: null, worktrees: [], draftPlace: { kind: 'chats' } })
store.setChatsFolder = async path => { store.patch({ chatsFolder: path ?? root, chatsFolderRoots: [root, '/demo/custom'] }); return true }
const folder = { path: '/demo/custom', name: 'custom', lastOpenedAt: 1, git: null, repo: null }
const request = store.transport.request.bind(store.transport)
store.transport.request = (async (method, args) => method === 'workspace/browse'
  ? { path: folder.path, parent: '/demo', entries: [] } : request(method, args)) as typeof store.transport.request
store.openWorkspace = async () => { store.patch({ workspace: folder, workspaces: [folder], draftPlace: null }); return true }
store.queue = async input => {
  document.documentElement.dataset.sentFolder = store.getSnapshot().workspace?.path ?? `${root}/2026-10-16-demo02`
  document.documentElement.dataset.sentText = input.flatMap(one => one.type === 'text' ? [one.text] : []).join(' ')
  return true
}
if (params.get('view') === 'chat') {
  const chat = { ...summary('chat', `${root}/2026-10-16-demo01`, 'Plan a weekend project'),
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('chat-turn'), status: 'completed',
      startedAt: 1, completedAt: 2, items: [
        { id: itemId('question'), type: 'userMessage', content: [{ type: 'text', text: 'Plan a weekend project' }] },
        { id: itemId('answer'), type: 'assistantMessage', text: 'Start with a small prototype, then check the result.' },
      ] }] } as Session
  const key = sessionKey(chat.runtime, chat.id)
  const workbench = store.getSnapshot().workbench
  const main = only(workbench.main, { kind: 'conversation', session: key })
  store.patch({ sessions: new Map([[key, chat]]), activeSessionKey: key, layout: main,
    workbench: { ...workbench, main, navigation: { ...workbench.navigation,
      current: { kind: 'work', view: { kind: 'conversation', session: key } } } } })
}
if (params.get('view') === 'settings') {
  const workbench = store.getSnapshot().workbench
  store.patch({ workbench: { ...workbench, navigation: { ...workbench.navigation,
    current: { kind: 'settings', route: { kind: 'section', section: 'general', focus: null } } } } })
}
createRoot(document.getElementById('root')!).render(<StrictMode><StoreProvider store={store}><App /></StoreProvider></StrictMode>)
