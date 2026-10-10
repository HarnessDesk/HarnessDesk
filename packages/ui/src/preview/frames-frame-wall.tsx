import { useMemo, useState } from 'react'
import { AgentsWindow } from '../components/AgentsWindow'
import { AppWindowMode } from '../components/AppWindow'
import { Settings, type Section } from '../components/Settings'
import { Sidebar } from '../components/Sidebar'
import { TeamsWindow } from '../components/TeamsWindow'
import { Usage, type DashboardView } from '../components/Usage'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import type { PaneView } from '../state/layout'
import type { AppSnapshot, AppStore } from '../state/store'
import { useTheme } from '../state/theme'
import { emptyWorkbench } from '../state/workbench'
import { PREVIEW_SESSION_KEY, previewStore } from './harness'
import { overviewTeamStore } from './team-overview-fixture'
import { teamsPageStore } from './teams-page-fixture'
import { usagePreviewStore } from './usage-fixture'

/**
 * The frame wall: the real workbench and sidebar, with one destination in
 * main, for `e2e/ui-system/frame-wall.spec.ts` to capture. A page that the
 * app still draws over the workbench (Teams, Agents, Dashboard, Settings) is
 * drawn here the same way, so the wall shows the app as it is.
 * Placeholder fixtures only.
 */
export const FRAME_WALL_DESTINATIONS = ['conversation', 'draft', 'team', 'teams', 'agents', 'dashboard', 'settings'] as const
type Destination = (typeof FRAME_WALL_DESTINATIONS)[number]

const mainShowing = (view: PaneView) =>
  ({ root: { kind: 'pane' as const, id: 'wall-main', view }, focused: 'wall-main', expanded: null })

/** `view` in main, the left column standing, the right panel closed. */
const showing = (store: AppStore, view: PaneView, session: AppSnapshot['activeSessionKey']): AppStore => {
  const main = mainShowing(view)
  Object.assign(store.getSnapshot(), {
    workbench: { ...emptyWorkbench(), main },
    layout: main,
    sidebarCollapsed: false,
    sidebarFloating: false,
    activeSessionKey: session,
  })
  return store
}

const storeFor = (destination: Destination): AppStore => {
  switch (destination) {
    case 'conversation': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    case 'draft': return showing(previewStore(), { kind: 'conversation', session: null }, null)
    case 'team': return showing(overviewTeamStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'teams': return teamsPageStore('active')
    case 'dashboard': return usagePreviewStore()
    case 'agents':
    case 'settings': return previewStore()
  }
}

/** The page the app draws over the workbench for this destination, if any. */
const PageOver = ({ destination }: { destination: Destination }) => {
  const [section, setSection] = useState<Section>('general')
  const [view, setView] = useState<DashboardView>('overview')
  const [focus, setFocus] = useState<string | null>(null)
  if (destination === 'teams') return <TeamsWindow onClose={() => {}} />
  if (destination === 'agents') return <AgentsWindow focus={focus} onClose={() => {}} onFocus={setFocus} />
  if (destination === 'dashboard') return <Usage view={view} scope={null} onView={setView} onScope={() => {}} onClose={() => {}} onSignIn={() => {}} />
  if (destination === 'settings') return <Settings section={section} onSection={(next) => setSection(next)} onClose={() => {}} onSignIn={() => {}} />
  return null
}

export const FrameWall = () => {
  useTheme()
  const requested = new URLSearchParams(location.search).get('frame-wall')
  const destination: Destination = FRAME_WALL_DESTINATIONS.find((one) => one === requested) ?? 'conversation'
  const store = useMemo(() => storeFor(destination), [destination])
  return <StoreProvider store={store}>
    <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
      <AppWindowMode.Provider value="modal">
        <div data-frame-id="frame-wall" data-destination={destination} className="h-screen bg-background">
          <Workbench sidebar={<Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />
          <PageOver destination={destination} />
        </div>
      </AppWindowMode.Provider>
    </ShellProvider>
  </StoreProvider>
}
