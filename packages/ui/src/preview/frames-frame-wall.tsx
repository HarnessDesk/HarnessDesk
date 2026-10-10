import { runTeamStore, equivalentRunFixture, type RunScene } from './run-view-fixture'
import { sidebarStructureFixture } from './sidebar-structure-fixture'
import { useMemo, useState } from 'react'
import { contributionId, pluginInstanceId, GLOBAL_SCOPE, itemId, turnId, type UiContribution, type BackgroundTask, type RuntimeId } from '@harnessdesk/protocol'
import { installPanelComponent } from '../slots/PanelBlocks'

installPanelComponent()
import { gitWorktrees } from './git-fixture'
import { TopBar, Chip, Button, Menu, MenuItem } from '../design'
import { PlusIcon, PlanIcon, DiffIcon, HistoryIcon, GlobeIcon, PanelIcon } from '../components/Icons'
import { PopupWall } from './popup-wall'
import { AgentsWindow } from '../components/AgentsWindow'
import { ChangesReview } from '../components/ChangesReview'
import { AppWindowMode } from '../components/AppWindow'
import { Settings, type Section } from '../components/Settings'
import { Sidebar } from '../components/Sidebar'
import { TeamsWindow } from '../components/TeamsWindow'
import { Usage, type DashboardView } from '../components/Usage'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { TopBarProvider } from '../panels/top-bar'
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
export const FRAME_WALL_DESTINATIONS = ['conversation', 'draft', 'team', 'team-trigger', 'team-receipt', 'team-run-recorded', 'team-run-not-reached', 'team-run-repeated', 'team-run-equivalent', 'teams', 'agents', 'agent', 'dashboard', 'settings', 'settings-general', 'settings-runtimes', 'library', 'plugins', 'changes-review', 'left-work'] as const
type Destination = (typeof FRAME_WALL_DESTINATIONS)[number]
type PageOwner = 'teams' | 'agents' | 'dashboard' | 'settings' | 'changes-review'
const pageFor = (destination: Destination): PageOwner | null => {
  if (destination === 'agent' || destination === 'agents') return 'agents'
  if (['settings', 'settings-general', 'settings-runtimes', 'library', 'plugins'].includes(destination)) return 'settings'
  if (destination === 'changes-review') return 'changes-review'
  if (destination === 'teams' || destination === 'dashboard') return destination
  return null
}
const sectionFor = (destination: Destination): Section => destination === 'settings-runtimes' ? 'runtimes'
  : destination === 'library' ? 'library' : destination === 'plugins' ? 'plugins' : 'general'

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
    case 'left-work': return showing(previewStore(sidebarStructureFixture(previewStore().getSnapshot())),
      { kind: 'room', room: 'structure-team' }, null)
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
    case 'agent':
    case 'settings':
    case 'settings-general':
    case 'settings-runtimes':
    case 'library':
    case 'plugins':
    case 'changes-review': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
  }
}

/** The page the app draws over the workbench for this destination, if any. */
const FrameDestination = ({ destination }: { destination: Destination }) => {
  const [page, setPage] = useState<PageOwner | null>(() => pageFor(destination))
  const [section, setSection] = useState<Section>(() => sectionFor(destination))
  const [view, setView] = useState<DashboardView>('overview')
  const [scope, setScope] = useState<RuntimeId | null>(null)
  const [focus, setFocus] = useState<string | null>(() => destination === 'agent' ? 'implementer' : null)
  const close = () => setPage(null)
  const settings = (next: Section = 'general') => { setSection(next); setPage('settings') }
  const agents = (id: string | null = null) => { setFocus(id); setPage('agents') }
  const usage = () => { setView('overview'); setScope(null); setPage('dashboard') }
  return <TopBarProvider><ShellHostsProvider>
    <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: usage,
      openRuntimes: () => settings('runtimes'), openAgents: agents, reviewImports: () => {} }}>
      <AppWindowMode.Provider value="modal">
        <div data-frame-id="frame-wall" data-destination={destination} className="h-screen bg-background">
          <Workbench suspended={page !== null} sidebar={<Sidebar onOpenSettings={settings} onOpenPlugins={() => settings('plugins')}
            onOpenAgents={agents} onOpenTeams={() => setPage('teams')} onOpenUsage={usage} onBrowseFolders={() => {}}
            onSignIn={() => {}} onSearch={() => {}} activeDestination={page === 'settings' && section === 'plugins' ? 'plugins' : page === 'changes-review' || page === 'settings' ? null : page} />} />
          {page === 'teams' && <TeamsWindow onClose={close} />}
          {page === 'agents' && <AgentsWindow focus={focus} onClose={close} onFocus={setFocus} />}
          {page === 'dashboard' && <Usage view={view} scope={scope} onView={setView} onScope={setScope} onClose={close} onSignIn={() => {}} />}
          {page === 'settings' && <Settings section={section} onSection={setSection} onClose={close} onSignIn={() => {}} />}
          {page === 'changes-review' && <ChangesReview onClose={close} />}
          <ShellOutlets activeOwner={page} />
          <PopupWall />
        </div>
      </AppWindowMode.Provider>
    </ShellProvider>
  </ShellHostsProvider></TopBarProvider>
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
    if (query.get('frame-conversation-actions') === '1') {
      Object.assign(snapshot, { runtimes: snapshot.runtimes.map(runtime => ({
        ...runtime, capabilities: { ...runtime.capabilities, memory: true, compaction: true, undo: true },
      })) })
    }
    if (query.get('frame-sidebar-hidden') === '1') Object.assign(snapshot, { sidebarCollapsed: true, sidebarFloating: false })
    if (query.get('frame-status') === 'tasks') {
      const task: BackgroundTask = { id: 'frame-task', label: 'Review the checkout', kind: 'command', state: 'running',
        command: 'node review.mjs', cwd: '/work/storefront', stoppable: false }
      Object.assign(snapshot, { tasks: new Map([[PREVIEW_SESSION_KEY, [task]]]) })
    }
    if (query.get('frame-status') === 'reconnecting') Object.assign(snapshot, { status: 'reconnecting' })
    if (destination === 'team' && query.get('frame-member-actions') === '1') {
      Object.assign(snapshot, { runtimes: snapshot.runtimes.map(runtime => ({
        ...runtime, capabilities: { ...runtime.capabilities, compaction: true, undo: true },
      })) })
    }
    if (destination === 'draft' && detailsCase === 'armed') {
      Object.assign(snapshot, { draftPlace: { kind: 'worktree', root: snapshot.workspace?.path ?? '/work/storefront', name: 'checkout retry', base: 'main' } })
    }
    // This explicit range state has recorded synthetic source facts. The
    // parent Team fixture still keeps its unavailable Changes reason.
    if (destination === 'team' && query.get('frame-work-range') === '1') {
      Object.assign(snapshot, {
        worktrees: [{ ...gitWorktrees()[0]!, path: '/work/storefront', branch: 'retry-checkout' }],
        flowExecutions: new Map([...snapshot.flowExecutions].map(([id, execution]) => [id, {
          ...execution, target: { kind: 'branch' as const, label: 'Retry checkout', base: '1111111', head: '2222222', pr: null, dirty: false },
        }])),
      })
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
    if (destination === 'conversation' && session && query.get('frame-browser-driving') === '1') {
      Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, {
        ...session, status: { type: 'active' as const }, turns: [...session.turns, {
          id: turnId('frame-browser-turn'), status: 'inProgress' as const,
          items: [{ id: itemId('frame-browser-call'), type: 'toolCall' as const, tool: 'browser_click',
            source: { kind: 'builtin' as const }, status: 'inProgress' as const, args: { selector: 'Checkout' } }],
        }],
      }) })
    }
    const tool = query.get('frame-tool'), path = query.get('frame-tool-path')
    if (tool === 'file' && path) next.openFile(path)
    else if (tool === 'preview' && path) next.openPreview(path)
    else if (tool === 'git') next.openGitHistory()
    else if (tool === 'tasks' || tool === 'trajectory' || tool === 'agents' || tool === 'activity' || tool === 'changes') next.openDetailsTab(tool)
    if (tool === 'plugin' || tool === 'plugin-unavailable') {
      const contribution: UiContribution = {
        id: contributionId('frame.plugin'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE,
        kind: 'ui', slot: 'details.tab', label: 'Recorded work', order: 0, component: 'hd.panel',
        mounts: tool === 'plugin' ? ['right'] : ['bottom'],
        data: { title: 'Recorded work', blocks: [{ type: 'markdown', text: 'Synthetic work facts · 長い記録' }] },
      }
      Object.assign(next.getSnapshot(), { contributions: [contribution] })
      next.showViewIn('right', { kind: 'plugin', contribution: contribution.id, label: contribution.label, mounts: contribution.mounts! })
    }
    if (query.get('frame-terminal') === '1') void next.openTerminal()
    return next
  }, [destination, location.search])
  if (requested === 'topbar') return <TopBarProbe />
  return <StoreProvider store={store}>
    <FrameDestination destination={destination} />
  </StoreProvider>
}
