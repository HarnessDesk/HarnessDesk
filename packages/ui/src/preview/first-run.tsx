/** Isolated preview.html entry, mounted by first-run.spec.ts without changing the shared frame wall. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { runtimeId, type AgentTemplateInfo } from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { previewStore, runtime } from './harness'
import '../styles/app.css'

const names = ['Alpha', 'Beta', 'Gamma']
const infos = names.map(name => ({ ...runtime(name.toLowerCase(), name), presentation: { name, historySource: `${name} CLI` } }))
const templates: readonly AgentTemplateInfo[] = infos.slice(1).map(info => ({
  key: info.id, name: info.presentation.name, available: true, registered: false,
  requires: { command: `${info.id}-cli`, found: true },
}))
const store = previewStore({
  status: 'open', theme: 'system', runtimes: [infos[0]!], activeRuntime: runtimeId('alpha'),
  health: { state: 'ready' }, healthByRuntime: { alpha: { state: 'ready' } },
  workspace: null, workspaces: [], activeSessionKey: null, sessions: new Map(), draftOptions: [],
})
store.agentCatalog = async () => new URLSearchParams(location.search).has('none') ? [] : templates
store.addAgent = async ({ template }) => {
  const added = infos.find(info => info.id === template)!
  store.patch({ runtimes: [...store.getSnapshot().runtimes, added] })
  return added.id
}
store.selectRuntime = async id => { store.patch({ activeRuntime: id }) }
const Preview = () => {
  useTheme()
  return <div className="flex h-screen flex-col bg-background text-foreground" data-frame-id="first-run">
    <PaneProvider scope={{ paneId: 'first-run', view: { kind: 'conversation', session: null }, sessionKey: null }}>
      <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
    </PaneProvider>
  </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><StoreProvider store={store}><Preview /></StoreProvider></StrictMode>)
