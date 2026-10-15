import { useEffect, useMemo } from 'react'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { emptyWorkbench } from '../state/workbench'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { TopBarProvider } from '../panels/top-bar'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { Sidebar } from '../components/Sidebar'
import { Notices } from '../components/Notices'
import { Toaster } from '../design'
import { PREVIEW_SESSION_KEY, store as fixture } from './harness'

/** The real composer, project menu and toast host with placeholder data only. */
export const ProjectPolishFrame = () => {
  const theme = useTheme()
  const store = useMemo(() => {
    const own = new AppStore('ws://localhost:0/')
    const base = fixture.getSnapshot()
    const workbench = { ...emptyWorkbench(), main: {
      root: { kind: 'pane' as const, id: 'polish-conversation', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } },
      focused: 'polish-conversation', expanded: null,
    } }
    const saved = { path: '/workspace/saved-project', name: 'saved-project', lastOpenedAt: 1,
      repo: { root: '/workspace/saved-project', worktree: false } }
    Object.assign(own.getSnapshot(), { ...base, home: '/workspace', notices: [], inbox: [],
      workbench, layout: workbench.main, activeSessionKey: PREVIEW_SESSION_KEY,
      workspaces: [saved], preferencesLoaded: true, health: { state: 'ready' },
      agentNotices: [],
      runtimes: base.runtimes.map(info => ({ ...info, capabilities: { ...info.capabilities, account: true } })),
      account: { accounts: [], signInMethods: [{ id: 'browser', label: 'Browser', flow: 'browser' }] },
      accountsByRuntime: { [base.activeRuntime!]: { accounts: [], signInMethods: [{ id: 'browser', label: 'Browser', flow: 'browser' }] } },
      sessions: new Map([[PREVIEW_SESSION_KEY, base.sessions.get(PREVIEW_SESSION_KEY)!]]),
      workspace: saved, teams: new Map(), goals: new Map(), history: [], historyIdentity: [],
    })
    own.transport.request = (async (method: string) => {
      if (method === 'app/state/get') return {}
      if (method === 'session/list') return { data: [], nextCursor: null }
      if (method === 'workspace/recent') return [saved]
      if (method === 'session/tasks') return []
      return null
    }) as typeof own.transport.request
    return own
  }, [])
  useEffect(() => {
    Object.assign(window, { projectPolishStore: store })
    return () => { delete (window as Window & { projectPolishStore?: AppStore }).projectPolishStore }
  }, [store])
  return <StoreProvider store={store}><ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}><div className="h-screen overflow-hidden bg-background" data-frame-id="project-polish">
    <TopBarProvider><ShellHostsProvider><Workbench sidebar={<Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} /><ShellOutlets activeOwner={null} /></ShellHostsProvider></TopBarProvider>
    <Notices /><Toaster theme={theme} />
  </div></ShellProvider></StoreProvider>
}
