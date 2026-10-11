import { dashboardDestinationStore } from './dashboard-destination-fixture'
import { agentsDestinationStore } from './agents-destination-fixture'
import { pluginsDestinationStore } from './plugins-destination-fixture'
import { reviewPageStore, type ReviewScene } from './review-page-fixture'
import { App } from '../app/App'
import { frameDestinationStore, setFrameConnection } from './frame-destination-store'
import { framePageIds, framePageRoute } from './frame-page-route'
import { shortcutFor } from '../lib/shortcuts'
import { toggleTerminal } from '../components/TerminalToggle'
import { sidebarGeometryFixture } from './sidebar-geometry-fixture'
import { runTeamStore, equivalentRunFixture, type RunScene } from './run-view-fixture'
import { sidebarStructureFixture } from './sidebar-structure-fixture'
import { useEffect, useMemo, useState } from 'react'
import { contributionId, pluginInstanceId, GLOBAL_SCOPE, itemId, turnId, type AcpRegistryAgentInfo, type CapabilityContribution, type UiContribution, type AgentItem, type BackgroundTask, type ConfigOption, type RuntimeId } from '@harnessdesk/protocol'
import { installPanelComponent } from '../slots/PanelBlocks'

installPanelComponent()
import { gitWorktrees } from './git-fixture'
import { TopBar, Chip, Button, Menu, MenuItem } from '../design'
import { AgentIcon, PlusIcon, PlanIcon, DiffIcon, HistoryIcon, GlobeIcon, PanelIcon } from '../components/Icons'
import { PopupWall } from './popup-wall'
import { triggerGoalStatus } from './intake-fixture'
import { type Section } from '../components/Settings'
import { Sidebar } from '../components/Sidebar'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { TopBarProvider } from '../panels/top-bar'
import { StoreProvider, useStore } from '../state/context'
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
 * main, for `e2e/ui-system/frame-wall.spec.ts` to capture. Every page uses
 * the same App registry and permanent shell as navigation.
 * Placeholder fixtures only.
 */
export const FRAME_WALL_DESTINATIONS = ['navigation', 'conversation', 'draft', 'team', 'team-trigger', 'team-receipt', 'team-run-recorded', 'team-run-not-reached', 'team-run-repeated', 'team-run-equivalent', 'teams', 'agents', 'agent', 'dashboard', 'settings', 'settings-general', 'settings-runtimes', 'settings-navigation', 'settings-search', 'library', 'plugins', 'changes-review', 'left-work'] as const
type Destination = (typeof FRAME_WALL_DESTINATIONS)[number]
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
  const store = previewStore({ ...source, goals: new Map(source.goals).set('overview-team', {
    ...goal, goal: { ...goal.goal, origin: { kind: 'trigger', trigger: 'fixture-trigger', event: 'fixture-event' } },
  }) })
  return new URLSearchParams(location.search).get('popup') === 'origin-details' ? new Proxy(store, { get(target, key) {
    if (key === 'triggerGoal') return async () => triggerGoalStatus({ goal: 'overview-team', trigger: 'fixture-trigger', budget: null })
    return Reflect.get(target, key)
  } }) : store
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

const popupContent = (store: AppStore): AppStore => {
  const snapshot = store.getSnapshot()
  const contexts: readonly CapabilityContribution[] = [
    { id: contributionId('frame.context.image'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE, kind: 'context', label: 'Current page preview', form: 'resource', chip: { description: 'A synthetic view of the page.', icon: 'image' } },
    { id: contributionId('frame.context.diff'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE, kind: 'context', label: 'Working tree changes', form: 'resource', chip: { description: 'Synthetic changes for preview.', icon: 'diff' } },
    { id: contributionId('frame.context.issue'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE, kind: 'context', label: 'Issue reference', form: 'resource', chip: { description: 'A synthetic issue reference.', icon: 'issue' } },
    { id: contributionId('frame.context.check'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE, kind: 'context', label: 'Last test run', form: 'resource', chip: { description: 'A synthetic test result.', icon: 'check' } },
    { id: contributionId('frame.context.notes'), owner: pluginInstanceId('frame-fixture'), revision: 1, scope: GLOBAL_SCOPE, kind: 'context', label: 'Project notes', form: 'instructions', chip: { description: 'Synthetic project guidance.' } },
  ]
  store.listBranches = async () => ['main', 'feature/storefront-checkout-diagnostics-and-retry-policy', 'feature/catalogue', 'release/next', 'fix/search', 'feature/发布前检查'].map((name, at) => ({ name, current: at === 0, committedAt: Date.now() - (at + 1) * 60_000 }))
  if (new URLSearchParams(location.search).get('popup') === 'other-agents') {
    const missing = snapshot.runtimes.at(-1)!.id
    Object.assign(snapshot, { usage: snapshot.usage.filter(report => report.runtime !== missing) })
  }
  const names = ['Storefront catalogue review and checkout diagnostics', '发布前检查和目录兼容性说明', 'Warehouse inventory reconciliation and retry policy']
  Object.assign(snapshot, {
    runtimes: snapshot.runtimes.map((runtime, at) => ({ ...runtime, presentation: { ...runtime.presentation, name: names[at] ?? runtime.presentation.name } })),
    contributions: [...snapshot.contributions, ...contexts],
  })
  return store
}

const storeFor = (destination: Destination): AppStore => {
  switch (destination) {
    case 'left-work': return showing(previewStore(sidebarStructureFixture(previewStore().getSnapshot())),
      { kind: 'room', room: 'structure-team' }, null)
    case 'navigation': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    case 'conversation': return popupContent(showing(previewStore(new URLSearchParams(window.location.search).has('sidebar-geometry')
      ? sidebarGeometryFixture(previewStore().getSnapshot()) : undefined), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY))
    case 'draft': return popupContent(showing(previewStore(), { kind: 'conversation', session: null }, null))
    case 'team-run-recorded': return showing(frameRunStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-not-reached': return showing(frameRunStore('empty'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-equivalent': return showing(frameEquivalentRunStore(), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-repeated': return showing(frameRunStore('many'), { kind: 'room', room: 'overview-team' }, null)
    case 'team': return showing(overviewTeamStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-trigger': return showing(triggerTeamStore(), { kind: 'room', room: 'overview-team' }, null)
    case 'team-receipt': return showing(teamRecordStore('wrapped'), { kind: 'room', room: 'overview-team' }, null)
    case 'teams': {
      const fixture=teamsPageStore(new URLSearchParams(location.search).get('frame-empty')==='1'?'empty':'active')
      const session=[...fixture.getSnapshot().sessions.keys()][0]??null
      return showing(fixture,{kind:'conversation',session},session)
    }
    case 'dashboard': return usagePreviewStore()
    case 'agents':
    case 'agent':
    case 'settings':
    case 'settings-general':
    case 'settings-navigation':
    case 'settings-search':
    case 'settings-runtimes':
    case 'library':
    case 'plugins':
    case 'changes-review': return showing(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
  }
}

const TopBarProbe = () => {
  const [tab, setTab] = useState('findings')
  const [parentChoice, setParentChoice] = useState('')
  const parents = new URLSearchParams(location.search).get('frame-parents') === '1'
  return <div data-parent-choice={parentChoice} data-frame-id="frame-wall" className="h-screen bg-background">
    <TopBar place={parents ? 'Jane Doe' : 'Checkout retry · 長いチーム名'} tab={tab}
      parents={parents ? ['Settings', 'Runtimes', 'Alpha'].map(label => ({ label, run: () => setParentChoice(label) })) : undefined}
      mark={parents ? <AgentIcon /> : undefined}
      state={<Chip tone="warning">Needs you</Chip>}
      verb={parents ? { label: 'Start a conversation with this account', run: () => {} } : { label: 'New job', icon: <PlusIcon />, run: () => {} }}
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
    const complete = previewStore()
    const ids = framePageIds(complete.getSnapshot())
    const value = query.get('frame-review-scene')
    const scene: ReviewScene = value==='empty'||value==='not-repository'||value==='large' ? value : 'tree'
    const routeQuery = new URLSearchParams(query)
    if (destination === 'agent') { routeQuery.set('frame-wall','agents'); routeQuery.set('frame-detail','agent') }
    if (destination.startsWith('settings') && destination !== 'settings') { routeQuery.set('frame-wall','settings'); routeQuery.set('frame-section',sectionFor(destination)) }
    const initial = framePageRoute(routeQuery, {...ids,agent:'code-reviewer'})
    const next = destination==='dashboard' && initial?.kind==='dashboard' ? dashboardDestinationStore({...initial,borrowed:query.get('frame-borrowed')==='1',emptyUsage:query.get('frame-empty-usage')==='1',unpricedPaid:query.get('frame-unpriced-paid')==='1'})
      : destination==='agents'||destination==='agent' ? agentsDestinationStore(routeQuery)
      : destination==='plugins' ? pluginsDestinationStore(routeQuery)
      : destination==='changes-review'||destination==='navigation' && query.get('frame-review')==='1'
        ? frameDestinationStore(showing(reviewPageStore(scene), {kind:'conversation',session:PREVIEW_SESSION_KEY},PREVIEW_SESSION_KEY))
      : frameDestinationStore(storeFor(destination))
    if (initial && !['dashboard','agents','agent','plugins'].includes(destination)) next.openDestination(initial)
    if (destination==='changes-review') next.openReview()
    if (query.get('layout-registry') === '1') {
      next.acpRegistry = async () => ({
        agents: Array.from({ length: 10 }, (_, index): AcpRegistryAgentInfo => ({
          id: `preview-runtime-${index + 1}`,
          name: `Runtime ${String(index + 1).padStart(2, '0')}`,
          version: '1.0.0',
          description: 'Synthetic registry entry for layout checks.',
          run: 'npx',
          available: true,
          registered: false,
        })),
        fetchedAt: 1,
      })
    }
    // Additional Details states for the same real frame; all data is synthetic.
    const detailsCase = query.get('frame-details-case')
    const snapshot = next.getSnapshot()
    if (query.get('frame-sidebar-notice') === '1') Object.assign(snapshot, { goalMigrationPending: true })
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
    if (['connecting', 'reconnecting', 'closed'].includes(query.get('frame-status') ?? '')) Object.assign(snapshot, { status: query.get('frame-status') })
    if (destination === 'team' && query.get('frame-member-actions') === '1') {
      Object.assign(snapshot, { runtimes: snapshot.runtimes.map(runtime => ({
        ...runtime, capabilities: { ...runtime.capabilities, compaction: true, undo: true },
      })) })
    }
    if (destination === 'draft' && detailsCase === 'armed') {
      Object.assign(snapshot, { draftPlace: { kind: 'worktree', root: snapshot.workspace?.path ?? '/work/storefront', name: 'checkout retry', base: 'main' } })
    }
    if (destination === 'draft' && query.get('frame-work-in') === 'linked') {
      const workspace = snapshot.workspace
      const worktrees = gitWorktrees()
      const main = worktrees.find(entry => entry.isMain)
      if (workspace && main) Object.assign(snapshot, {
        workspace: { ...workspace, path: `${main.path}/review`, name: 'Review worktree', repo: { root: main.path, worktree: true }, git: { branch: 'feature/preview-review' } },
        worktrees,
        draftPlace: { kind: 'existing', path: main.path, branch: main.branch ?? null },
      })
    }
    if (destination === 'draft' && query.get('frame-composer-labels') === '1') {
      Object.assign(snapshot, { draftOptions: [
        { id: 'sandbox', type: 'select', category: '_permissions', label: 'Sandbox', currentValue: 'workspace', choices: [
          { value: 'read', label: 'Read only' }, { value: 'workspace', label: 'Workspace' },
        ] },
        { id: 'mode', type: 'select', category: 'mode', label: 'Mode', currentValue: 'default', choices: [
          { value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' },
        ] },
      ] })
    }
    if (['draft', 'conversation'].includes(destination) && query.get('frame-composer-values') === '1') {
      const composerValues: ConfigOption[] = [
        { id: 'sandbox', type: 'select', category: '_permissions', label: 'Sandbox', currentValue: 'workspace-write', choices: [
          { value: 'workspace-write', label: 'Workspace write' },
        ] },
        { id: 'mode', type: 'select', category: 'mode', label: 'Mode', currentValue: 'default', choices: [
          { value: 'default', label: 'Default' },
        ] },
        { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: 'gpt-5.5', choices: [
          { value: 'gpt-5.5', label: 'GPT-5.5' },
        ] },
        { id: 'reasoning_effort', type: 'select', category: 'thought_level', label: 'Reasoning effort', currentValue: 'medium', choices: [
          { value: 'medium', label: 'medium' },
        ] },
      ]
      if (destination === 'draft') Object.assign(snapshot, { draftOptions: composerValues })
      else {
        const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)
        if (session) Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, { ...session, options: composerValues }) })
      }
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
    if (query.get('frame-no-folder') === '1') Object.assign(snapshot, {workspace:null,activeSessionKey:null,sessions:new Map()})
    const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)
    if (destination === 'conversation' && session && query.get('frame-overflow') === '1') {
      const longToken = 'x'.repeat(600)
      const items: AgentItem[] = [
        { id: itemId('frame-overflow-user'), type: 'userMessage', content: [{ type: 'text', text: longToken }] },
        { id: itemId('frame-overflow-answer'), type: 'assistantMessage', text: longToken, phase: 'final' },
        { id: itemId('frame-overflow-heading'), type: 'assistantMessage', text: `# ${longToken}`, phase: 'final' },
        { id: itemId('frame-overflow-notice'), type: 'notice', text: longToken },
        { id: itemId('frame-overflow-tool'), type: 'toolCall', tool: 'read', source: { kind: 'builtin' }, status: 'completed',
          args: { value: longToken }, result: [{ type: 'text', text: longToken }] },
      ]
      Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, {
        ...session,
        turns: [...session.turns, { id: turnId('frame-overflow'), status: 'completed', items }],
      }) })
    }
    if (destination === 'navigation' && session) Object.assign(snapshot,{sessions:new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY,{...session,turns:Array.from({length:30},(_,index)=>({...session.turns[0]!,id:turnId(`retained-turn-${index}`),items:session.turns[0]!.items.map((item,at)=>({...item,id:itemId(`retained-item-${index}-${at}`)}))}))})})
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
  useEffect(() => {
    const api={resizeLeft:(width:number)=>store.resizePanel('sidebar',width)}
    Object.assign(window,{__hdFrameWall:api})
    return()=>{delete(window as Window & {__hdFrameWall?:typeof api}).__hdFrameWall}
  },[store])
  useEffect(() => {
    const onConnection = (event: Event) => {
      const status: unknown = (event as CustomEvent).detail
      if (status === 'open' || status === 'connecting' || status === 'reconnecting' || status === 'closed') setFrameConnection(store,status)
    }
    window.addEventListener('harnessdesk:preview-connection', onConnection)
    return () => { window.removeEventListener('harnessdesk:preview-connection', onConnection) }
  }, [store,destination])
  if (requested === 'topbar') return <TopBarProbe />
  return <StoreProvider store={store}>
    <div data-frame-id="frame-wall" data-destination={destination} className="h-screen min-h-0 overflow-hidden bg-background"><App/><PopupWall/></div>
  </StoreProvider>
}
