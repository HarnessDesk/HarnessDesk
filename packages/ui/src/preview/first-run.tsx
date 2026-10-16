/** Synthetic first-run desk: no native picker, host, or real account data. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { runtimeId, type AgentTemplateInfo } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { previewStore, runtime } from './harness'
import '../styles/app.css'

const names = ['Alpha', 'Beta', 'Gamma']
const infos = names.map(name => ({ ...runtime(name.toLowerCase(), name), presentation: { name } }))
const templates: readonly AgentTemplateInfo[] = infos.slice(1).map(info => ({
  key: info.id, name: info.presentation.name, available: true, registered: false,
  requires: { command: `${info.id}-cli`, found: true },
}))
const store = previewStore({
  status: 'open', theme: 'system', runtimes: [infos[0]!], activeRuntime: runtimeId('alpha'),
  health: { state: 'ready' }, healthByRuntime: { alpha: { state: 'ready' } },
  workspace: null, workspaces: [], worktrees: [], activeSessionKey: null, sessions: new Map(), history: [],
  teams: new Map(), goals: new Map(), draftOptions: [], tasks: new Map(), approvals: [], inbox: [], usage: [],
})
store.agentCatalog = async () => new URLSearchParams(location.search).has('none') ? [] : templates
store.addAgent = async ({ template }) => {
  const added = infos.find(info => info.id === template)!
  store.patch({ runtimes: [...store.getSnapshot().runtimes, added] })
  return added.id
}
store.selectRuntime = async id => { store.patch({ activeRuntime: id }) }
const folder = { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }
const request = store.transport.request.bind(store.transport)
store.transport.request = (async (method, params) => method === 'workspace/browse'
  ? { path: folder.path, parent: '/work', entries: [] }
  : request(method, params)) as typeof store.transport.request
store.openWorkspace = async () => { store.patch({ workspace: folder, workspaces: [folder] }); return true }
store.queue = async input => {
  document.documentElement.dataset.sentFolder = store.getSnapshot().workspace?.path ?? ''
  document.documentElement.dataset.sentText = input.flatMap(one => one.type === 'text' ? [one.text] : []).join(' ')
  return true
}
createRoot(document.getElementById('root')!).render(<StrictMode><StoreProvider store={store}><App /></StoreProvider></StrictMode>)
