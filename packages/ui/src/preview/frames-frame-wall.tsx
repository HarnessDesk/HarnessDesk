import { runTeamStore, equivalentRunFixture, type RunScene } from './run-view-fixture'
import { useMemo, useState } from 'react'
import { itemId, turnId } from '@harnessdesk/protocol'
import { TopBar, Chip, Button, Menu, MenuItem } from '../design'
import { PlusIcon, PlanIcon, DiffIcon, HistoryIcon, GlobeIcon, PanelIcon } from '../components/Icons'
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
import { teamRecordStore } from './frames-team-record'
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
export const FRAME_WALL_DESTINATIONS = ['conversation', 'draft', 'team', 'team-trigger', 'team-receipt', 'team-run-recorded', 'team-run-not-reached', 'team-run-repeated', 'team-run-equivalent', 'teams', 'agents', 'dashboard', 'settings'] as const
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

export const triggerTeamStore = (): AppStore => {
  const source = overviewTeamStore('running').getSnapshot()
  const goal = source.goals.get('overview-team')!
  return previewStore({ ...source, goals: new Map(source.goals).set('overview-team', {
    ...goal, goal: { ...goal.goal, origin: { kind: 'trigger', trigger: 'fixture-trigger', event: 'fixture-event' } },
  }) })
}

const frameRunStore = (scene: RunScene) => {
  const source = runTeamStore(scene)
  const own = previewStore(source.getSnapshot())
  return new Proxy(own, { get(target, key) {
    if (key === 'flowCatalog' || key === 'flowSource' || key === 'flowExecutionSource' || key === 'readGoalInsight' || key === 'teamPeers') return Reflect.get(source, key)
    return Reflect.get(target, key)
  } })
}

const frameEquivalentRunStore = () => {
  const store = frameRunStore('complete')
  const fixture = equivalentRunFixture()
  const snapshot = store.getSnapshot()
  const team = snapshot.teams.get('overview-team')!
  const goal = snapshot.goals.get(team.id)!
  const board = { ...team, intents: fixture.cards, channel: fixture.signals ?? [] }
  Object.assign(snapshot, { teams: new Map(snapshot.teams).set(team.id, board),
    goals: new Map(snapshot.goals).set(team.id, { ...goal, board }),
    flowExecutions: new Map([[fixture.execution.id, fixture.execution]]), boardEvidence: new Map() })
  return store
}

const storeFor = (destination: Destination): AppStore => {
  switch (destination) {
    case 'conversation': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    case 'draft': return showing(previewStore(), { kind: 'conversation', session: null }, null)
    case 'team-run-recorded': return showing(frameRunStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-not-reached': return showing(frameRunStore('empty'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-equivalent': return showing(frameEquivalentRunStore(), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-repeated': return showing(frameRunStore('many'), { kind: 'room', room: 'overview-team' }, null)
    case 'team': return showing(overviewTeamStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-trigger': return showing(triggerTeamStore(), { kind: 'room', room: 'overview-team' }, null)
    case 'team-receipt': return showing(teamRecordStore('wrapped'), { kind: 'room', room: 'overview-team' }, null)
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

const TopBarProbe = () => {
  const [tab, setTab] = useState('findings')
  return <div data-frame-id="frame-wall" className="h-screen bg-background">
    <TopBar place="Checkout retry · 長いチーム名" tab={tab}
      state={<Chip tone="warning">Needs you</Chip>}
      verb={{ label: 'New job', icon: <PlusIcon />, run: () => {} }}
      view={{ content: close => <Menu close={close}><MenuItem label="All" onSelect={close} /><MenuItem label="Open" onSelect={close} /></Menu> }}
      tools={<><Button variant="ghost" size="icon-sm" title="Details"><PlanIcon /></Button><Button variant="ghost" size="icon-sm" title="Changes"><DiffIcon /></Button><Button variant="ghost" size="icon-sm" title="Activity"><HistoryIcon /></Button><Button variant="ghost" size="icon-sm" title="Browser"><GlobeIcon /></Button><Button variant="ghost" size="icon-sm" title="Toggle panel"><PanelIcon /></Button></>}
      tabs={['Overview', 'Run', 'Board', 'Chat', 'Findings', 'Runs'].map(label => ({
        value: label.toLowerCase(), label, run: () => setTab(label.toLowerCase()),
      }))} more={() => null} />
  </div>
}

export const FrameWall = () => {
  useTheme()
  const requested = new URLSearchParams(location.search).get('frame-wall')
  const destination: Destination = FRAME_WALL_DESTINATIONS.find((one) => one === requested) ?? 'conversation'
  const query = new URLSearchParams(location.search)
  const store = useMemo(() => {
    const next = storeFor(destination)
    // Additional Details states for the same real frame; all data is synthetic.
    const detailsCase = query.get('frame-details-case')
    const snapshot = next.getSnapshot()
    if (destination === 'team' && query.get('frame-member-actions') === '1') {
      Object.assign(snapshot, { runtimes: snapshot.runtimes.map(runtime => ({
        ...runtime, capabilities: { ...runtime.capabilities, compaction: true, undo: true },
      })) })
    }
    if (destination === 'draft' && detailsCase === 'armed') {
      Object.assign(snapshot, { draftPlace: { kind: 'worktree', root: snapshot.workspace?.path ?? '/work/storefront', name: 'checkout retry', base: 'main' } })
    }
    const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)
    if (destination === 'conversation' && session && ['active', 'complete', 'cleared', 'asked'].includes(detailsCase ?? '')) {
      const plan = [
        { step: 'Review the checkout and the recorded changes', status: 'completed' as const },
        { step: 'Check the long account-recovery path and retry behavior', status: detailsCase === 'complete' ? 'completed' as const : 'inProgress' as const },
        { step: 'Report the evidence and the remaining limitations', status: detailsCase === 'complete' ? 'completed' as const : 'pending' as const },
      ]
      const turns = [...session.turns, { id: turnId('frame-plan'), status: 'completed' as const, plan, items: [{
        id: itemId('frame-subagents'), type: 'subagent' as const, action: 'spawn', status: 'completed' as const,
        prompt: 'Check the recovery path against the recorded changes.',
        members: [{ sessionId: 'frame-review', nickname: 'Recovery reviewer', role: 'Review', state: 'completed', openable: false }],
      }] }]
      if (detailsCase === 'cleared') turns.push({ id: turnId('frame-plan-cleared'), status: 'completed', plan: [], items: [] })
      Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, {
        ...session, turns,
        ...(detailsCase === 'asked' ? { settings: { ...session.settings, cwd: session.cwd, model: session.settings?.model ?? 'model-a', ceiling: { level: 'read', hold: 'asked' } } } : {}),
      }) })
    }
    const tool = query.get('frame-tool'), path = query.get('frame-tool-path')
    if (tool === 'file' && path) next.openFile(path)
    else if (tool === 'preview' && path) next.openPreview(path)
    else if (tool === 'git') next.openGitHistory()
    else if (tool === 'tasks' || tool === 'trajectory' || tool === 'agents' || tool === 'activity' || tool === 'changes') next.openDetailsTab(tool)
    if (query.get('frame-terminal') === '1') void next.openTerminal()
    return next
  }, [destination, location.search])
  if (requested === 'topbar') return <TopBarProbe />
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
