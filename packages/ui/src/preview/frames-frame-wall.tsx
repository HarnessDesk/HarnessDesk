import { installEditorMainFixture } from './editor-main-fixture'
import { installExplorerFixture } from './editor-explorer-fixture'
import { PREVIEW_FINDINGS } from './findings-fixture'
import { dashboardDestinationStore } from './dashboard-destination-fixture'
import { agentsDestinationStore } from './agents-destination-fixture'
import { pluginsDestinationStore } from './plugins-destination-fixture'
import { reviewPageStore, type ReviewScene } from './review-page-fixture'
import { signInSeed } from './signin-fixture'
import { App } from '../app/App'
import { frameDestinationStore, setFrameConnection } from './frame-destination-store'
import { framePageIds, framePageRoute } from './frame-page-route'
import { shortcutFor } from '../lib/shortcuts'
import { toggleTerminal } from '../components/TerminalToggle'
import { sidebarGeometryFixture } from './sidebar-geometry-fixture'
import { runTeamStore, equivalentRunFixture, type RunScene } from './run-view-fixture'
import { sidebarStructureFixture } from './sidebar-structure-fixture'
import { useEffect, useMemo, useState } from 'react'
import { approvalId, contributionId, pluginInstanceId, GLOBAL_SCOPE, itemId, runtimeId, sessionKey, turnId, type AcpRegistryAgentInfo, type CapabilityContribution, type UiContribution, type AgentItem, type BackgroundTask, type ConfigOption, type HostMethodName, type RuntimeId } from '@harnessdesk/protocol'
import { installPanelComponent } from '../slots/PanelBlocks'

installPanelComponent()
import { gitWorktrees } from './git-fixture'
import { TopBar, Chip, Button, Menu, MenuItem } from '../design'
import { AgentIcon, PlusIcon, PlanIcon, DiffIcon, HistoryIcon, GlobeIcon, PanelIcon } from '../components/Icons'
import { PopupWall } from './popup-wall'
import { triggerGoalStatus } from './intake-fixture'
import { type Section } from '../components/Settings'
import { Sidebar } from '../components/Sidebar'
import { sidebarStorefrontRecencyFixture } from './sidebar-projects-fixture'
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
import { libraryAuditFixtureStore } from './library-audit-fixture'

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
    case 'navigation': {
      const fixture = previewStore(new URLSearchParams(location.search).has('frame-recency')
        ? sidebarStorefrontRecencyFixture(previewStore().getSnapshot()) : undefined)
      return showing(fixture, { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    }
    case 'conversation': return popupContent(showing(previewStore(new URLSearchParams(window.location.search).has('sidebar-geometry')
      ? sidebarGeometryFixture(previewStore().getSnapshot()) : undefined), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY))
    case 'draft': return popupContent(showing(previewStore(), { kind: 'conversation', session: null }, null))
    case 'team-run-recorded': return showing(frameRunStore('running'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-not-reached': return showing(frameRunStore('empty'), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-equivalent': return showing(frameEquivalentRunStore(), { kind: 'room', room: 'overview-team' }, null)
    case 'team-run-repeated': return showing(frameRunStore('many'), { kind: 'room', room: 'overview-team' }, null)
    case 'team': return showing(overviewTeamStore((new URLSearchParams(location.search).has('frame-fix8-stop') || new URLSearchParams(location.search).has('frame-fix9-stop') || new URLSearchParams(location.search).has('frame-fix10-stop')) ? 'needs-you' : 'running'), { kind: 'room', room: 'overview-team' }, null)
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
  const themeStore = useStore()
  useTheme()
  const requested = new URLSearchParams(location.search).get('frame-wall')
  const destination: Destination = FRAME_WALL_DESTINATIONS.find((one) => one === requested) ?? 'conversation'
  const query = new URLSearchParams(location.search)
  const requestedTheme = query.get('theme')
  useEffect(() => {
    if (requestedTheme === 'light' || requestedTheme === 'dark') themeStore.setTheme(requestedTheme)
  }, [requestedTheme, themeStore])
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
      : destination === 'conversation' && query.get('frame-fix5-no-changes') === '1'
        ? frameDestinationStore(reviewPageStore('empty'))
      : destination === 'library' && (query.get('frame-library-state') === 'autopilot' || query.get('frame-library-state') === 'import')
        ? frameDestinationStore(showing(libraryAuditFixtureStore(query.get('frame-library-state') as 'autopilot' | 'import'), { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY))
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
    if (destination === 'conversation' && query.has('frame-editor')) installEditorMainFixture(next)
    if (destination === 'conversation' && query.has('frame-explorer')) installExplorerFixture(next, query.get('frame-explorer')!)
    if (destination === 'team-receipt' && query.get('frame-fix8-receipt-finding') === '1') {
      const goal = snapshot.goals.get('overview-team')!
      const finding = { ...PREVIEW_FINDINGS[0]!, ownerGoal: goal.goal.id, origin: { ...PREVIEW_FINDINGS[0]!.origin, goal: goal.goal.id } }
      Object.assign(snapshot, { goals: new Map(snapshot.goals).set(goal.goal.id, { ...goal, receipt: {
        ...goal.receipt!, findings: { version: 1, evidence: [], findings: [finding], overrides: [] },
      } }), findings: new Map() })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'finding/list') return { goal: goal.goal.id, stamp: 'receipt-ledger', rows: [finding],
          next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null }
        return request(method, params as never)
      }) as typeof next.transport.request
    }
    if (destination === 'team' && query.get('frame-fix9-no-findings') === '1') {
      Object.assign(snapshot, { goals: new Map(), flowExecutions: new Map() })
    }
    if (destination === 'team-receipt' && query.get('frame-fix9-findings') === '1') {
      const goal = snapshot.goals.get('overview-team')!
      const run = snapshot.flowExecutions.get('overview-run')!
      const findings = Array.from({ length: 5 }, (_, i) => ({ ...PREVIEW_FINDINGS[0]!,
        id: `kept-finding-${i}`, title: i === 0 ? 'Accepted repair' : `Advisory finding ${i}`,
        ownerGoal: goal.goal.id, origin: { ...PREVIEW_FINDINGS[0]!.origin, goal: goal.goal.id, run: run.id },
        blocking: i === 0, lifecycle: { state: i === 0 ? 'repaired' as const : 'open' as const, confirmed: i === 0, repairs: [] },
      }))
      const view: import('@harnessdesk/protocol').FindingRunView = { run: run.id, goal: goal.goal.id,
        round: 4, finished: 4, total: 24, embargoed: false, open: 0, blocking: 0, reason: 'The run was stopped before this was posted, so it stays on the desk.',
        ceilingStop: false, stamp: 'stopped-review', publication: 'partial', rounds: [], reviewersFinished: 1, reviewersTotal: 1,
        pendingExceptions: [], repair: null, boundPr: null, unbound: null,
        undecidable: 'This Team is wrapped. Its findings are history here; carry them into an open Team to decide them.' }
      Object.assign(snapshot, { goals: new Map(snapshot.goals).set(goal.goal.id, { ...goal, receipt: {
        ...goal.receipt!, findings: { version: 1, evidence: [], findings, overrides: [] },
      } }), findings: new Map(), flowExecutions: new Map([[run.id, { ...run, findings: { version: 1, budget: { rounds: 24, withoutProgress: 3 }, closedRounds: [1, 2, 3, 4], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null }, state: 'stopped', end: { kind: 'stopped', by: 'person' } }]]),
        findingRuns: new Map([[run.id, view]]) })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => method === 'finding/run' ? view : request(method, params as never)) as typeof next.transport.request
    }
    if (destination === 'team' && (query.get('frame-fix8-stop') === '1' || query.get('frame-fix9-stop') === '1' || query.get('frame-fix10-stop') === '1')) {
      Object.assign(snapshot, { approvals: snapshot.approvals.map(({ key, approval }) => ({ key, approval: {
        id: approval.id, sessionId: approval.sessionId, requestedAt: approval.requestedAt, type: 'command', command: query.get('frame-fix10-stop') === '1' ? 'ls -la' : 'echo synthetic', cwd: '/work/storefront', actions: [],
        options: [{ id: 'allow', label: 'Allow', intent: 'approve' }, { id: 'deny', label: 'Deny', intent: 'deny' }],
      } })) })
      if (query.get('frame-fix9-stop') === '1' || query.get('frame-fix10-stop') === '1') {
        const goal = snapshot.goals.get('overview-team')!
        const run = snapshot.flowExecutions.get('overview-run')!
        const member = { ...goal.members[1]!, agent: { ...goal.members[1]!.agent!, name: 'Researcher' }, role: 'researcher' }
        if (query.get('frame-fix10-stop') === '1') {
          const key = sessionKey(member.session.runtime, member.session.sessionId)
          const session = snapshot.sessions.get(key)!
          Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(key, { ...session, status: { type: 'active' },
            turns: [{ id: turnId('pending-command'), status: 'inProgress', startedAt: Date.now() - 60_000, items: [{
              id: itemId('pending-list'), type: 'command', origin: 'agent', command: 'ls -la', cwd: '/work/storefront', status: 'inProgress',
              actions: [{ type: 'listFiles', command: 'ls -la', path: '/work/storefront' }],
            }] }] }) })
        }
        Object.assign(snapshot, { goals: new Map(snapshot.goals).set(goal.goal.id, { ...goal, members: [member] }),
          flowExecutions: new Map([[run.id, { ...run, rounds: [{ ...run.rounds[0]!, n: 1, role: 'researcher', seats: [member.id], cards: [2] }],
            findings: { version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } }]]) })
      }
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method !== 'flow/execution/stop') return request(method, params as never)
        const run = snapshot.flowExecutions.get((params as { run: string }).run)!
        const events = next.transport as unknown as { handlers: { onEvent(runtime: import('@harnessdesk/protocol').RuntimeId, event: import('@harnessdesk/protocol').AgentEvent): void; onNotification(notification: import('@harnessdesk/protocol').WireNotification): void } }
        for (const { key, approval } of snapshot.approvals) events.handlers.onEvent(snapshot.sessions.get(key)!.runtime, { type: 'approval/resolved', sessionId: approval.sessionId,
          approvalId: approval.id, resolution: { outcome: 'abandoned', reason: 'Run stopped' } })
        if (query.get('frame-fix9-stop') === '1' || query.get('frame-fix10-stop') === '1') {
          const goal = snapshot.goals.get(run.goal)!
          const pastMembers = goal.members.map(seat => ({ ...seat, closed: { at: Date.now(), why: 'released' as const } }))
          events.handlers.onNotification({ method: 'goal/changed', params: { view: { ...goal, members: [], pastMembers } } })
          events.handlers.onNotification({ method: 'team/changed', params: { state: { ...goal.board, members: [] } } })
        }
        return { ...run, ...(query.get('frame-fix10-stop') === '1' ? { endedAt: Date.now(), currentEndedAt: Date.now() } : {}), state: 'stopped', reason: 'The person stopped this run.', end: { kind: 'stopped', by: 'person' },
          rounds: run.rounds.map(round => ({ ...round, state: 'closed' })) }
      }) as typeof next.transport.request
    }
    if (destination === 'dashboard' && query.get('frame-fix8-unattributed') === '1') {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        const report = await request(method, params as never)
        return method === 'insight/usage' ? { ...report as object, breakdowns: [], gaps: [], sources: [] } : report
      }) as typeof next.transport.request
    }
    if (destination === 'dashboard' && query.get('frame-fix8-ledger') === '1') {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method !== 'usage/ledger') return request(method, params as never)
        const days = (params as { days: number }).days, runtime = snapshot.activeRuntime!
        const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const daily = Array.from({ length: days }, (_, i) => i).filter(i => ![1, 3, 5].includes(i % 7)).map(i => ({
          day: new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime(), runtime,
          cost: i % 4 === 0 ? 0 : (i + 1) / 10, tokens: 100, requests: 1,
        })).sort((a, b) => a.day - b.day)
        return { days, currency: 'USD', totalCost: daily.reduce((sum, day) => sum + day.cost, 0), totalTokens: daily.length * 100,
          provenance: 'mixed', coverage: { priced: daily.length - 1, unpriced: 1, unmetered: 0, estimated: 0,
            daysCovered: daily.length, daysRequested: days, coveredDays: daily.map(day => day.day), earliestDay: daily[0]?.day },
          daily, rows: [{ key: 'fixture', label: 'Recorded work', runtime, cost: daily.reduce((sum, day) => sum + day.cost, 0), tokens: 100 * daily.length, hasUnpriced: true }], scannedAt: Date.now() }
      }) as typeof next.transport.request
    }

    if (destination === 'dashboard' && query.get('frame-fix9-silent') === '1') {
      Object.assign(snapshot, { accountsByRuntime: Object.fromEntries(snapshot.runtimes.map(info => [info.id, { accounts: [], signInMethods: [] }])) })
    }

    if (destination === 'dashboard' && query.has('frame-fix9-project')) {
      const workspace = { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1, repo: { root: '/work/storefront' } }
      Object.assign(snapshot, { workspace: query.get('frame-fix9-project') === 'none' ? null : workspace })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        const report = await request(method, params as never)
        if (method !== 'insight/usage') return report
        const one = report as import('@harnessdesk/protocol').InsightReport
        return { ...one, breakdowns: [], recordedSpend: [], sources: [], gaps: [],
          totals: Object.fromEntries(Object.entries(one.totals).map(([key, value]) => [key, { ...value, value: 0 }])) }
      }) as typeof next.transport.request
    }

    if (destination === 'dashboard' && query.get('frame-fix9-hours') === '1') {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method !== 'usage/ledger') return request(method, params as never)
        const runtime = snapshot.activeRuntime!, day = new Date(); day.setHours(0, 0, 0, 0)
        return { days: (params as { days: number }).days, currency: 'USD', totalCost: 0, totalTokens: 300, provenance: 'metered',
          daily: [{ day: day.getTime(), runtime, cost: 0, tokens: 100 }, { day: day.getTime(), runtime, cost: 0, tokens: 200 }],
          hourly: [{ runtime, weekday: day.getDay(), hour: 10, requests: 1, tokens: 100 }], rows: [], scannedAt: Date.now(),
          coverage: { priced: 2, unpriced: 0, unmetered: 0, estimated: 0, hoursKnownFor: [runtime], coveredDays: [day.getTime()], daysCovered: 1, daysRequested: 365 } }
      }) as typeof next.transport.request
    }

    if (destination === 'dashboard' && query.get('frame-fix10-ledger') === 'partial') {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method !== 'usage/ledger') return request(method, params as never)
        const days = (params as { days: number }).days, runtime = snapshot.activeRuntime!
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const day = (back: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime()
        const coveredDays = [3, 4, 6].filter(back => back < days).map(day)
        const daily = [3, 4, 6].filter(back => back < days).map((back, index) => ({ day: day(back), runtime, cost: [10.01, 9.03, 4.05][index]!, tokens: 10 }))
        const totalCost = daily.reduce((sum, row) => sum + row.cost, 0)
        return { days, currency: 'USD', totalCost, totalTokens: daily.length * 10, provenance: 'metered',
          coverage: { priced: daily.length, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: coveredDays.length, daysRequested: days, coveredDays, earliestDay: day(6) },
          daily, rows: [{ key: 'recorded', label: 'Recorded work', runtime, cost: totalCost, tokens: daily.length * 10, hasUnpriced: false }], scannedAt: Date.now() }
      }) as typeof next.transport.request
    }

    if (destination === 'dashboard' && query.has('frame-fix9-ledger')) {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method !== 'usage/ledger') return request(method, params as never)
        const days = (params as { days: number }).days, runtime = snapshot.activeRuntime!
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const coveredDays = Array.from({ length: days }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime())
          .filter((_, i) => query.get('frame-fix9-ledger') !== 'mixed' || i > 2)
        const daily = coveredDays.map(day => ({ day, runtime, cost: query.get('frame-fix9-ledger') === 'mixed' ? 2 : 0, tokens: 10, requests: 1 }))
        return { days, currency: 'USD', totalCost: daily.reduce((sum, one) => sum + one.cost, 0), totalTokens: daily.length * 10,
          provenance: 'metered', coverage: { priced: daily.length, unpriced: 0, unmetered: 0, estimated: 0,
            daysCovered: coveredDays.length, daysRequested: days, coveredDays, earliestDay: Math.min(...coveredDays) },
          daily, rows: [{ key: 'recorded', label: 'Recorded work', runtime, cost: daily.reduce((sum, one) => sum + one.cost, 0), tokens: daily.length * 10, hasUnpriced: false }], scannedAt: Date.now() }
      }) as typeof next.transport.request
    }

    if (destination === 'conversation' && query.get('frame-palette-files') === '1') {
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method: HostMethodName, params: unknown, options?: { signal?: AbortSignal }) => {
        if (method === 'workspace/files') {
          const needle = (params as { query: string }).query.toLowerCase()
          return needle.includes('sweep-index')
            ? [{ path: '/work/storefront/src/sweep-index.ts', relativePath: 'src/sweep-index.ts', kind: 'file' as const, score: 100 }]
            : []
        }
        return request(method, params as never, options)
      }) as typeof next.transport.request
    }
    if (destination.startsWith('settings') && query.get('frame-fix9-signout') === '1') {
      const base = snapshot.runtimes[0]!
      const info = { ...base, capabilities: { ...base.capabilities, account: true }, presentation: { ...base.presentation, name: 'Fixture agent' } }
      Object.assign(snapshot, { runtimes: [info], activeRuntime: info.id, health: null, healthByRuntime: {}, usage: [],
        accountsByRuntime: { [info.id]: { accounts: [], signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }] } } })
    }
    if (query.get('frame-settings-round4') === '1') {
      const base = snapshot.runtimes[0]!
      const names = ['Runtime 1', 'Runtime 2', 'Runtime 3', 'Runtime 4', 'Runtime 5', 'Runtime 6',
        'Runtime 07', 'Runtime 08', 'Runtime 09', 'Runtime 10', 'Runtime 11', 'Runtime 12'] as const
      const ids: readonly RuntimeId[] = ['codex', 'claude', 'cursor', 'gemini', 'deepseek', 'windsurf',
        'round4-runtime-07', 'round4-runtime-08', 'round4-runtime-09', 'round4-runtime-10',
        'round4-runtime-11', 'round4-runtime-12'] as RuntimeId[]
      const versions = ['0.149.0', '1.0.0', null, null, null, '1.0.0', null, null, null, null, null, null] as const
      const levels = ['read', 'edit', 'publish', 'merge'] as const
      const runtimes = names.map((name, index) => {
        const held = index === 0 ? new Set(['read', 'edit'])
          : index === 1 ? new Set<string>()
            : new Set(levels.filter((_, levelIndex) => (index + levelIndex) % 2 === 0))
        const ceilings = Object.fromEntries(levels.filter(level => held.has(level)).map(level => [level, {
          settings: [], how: 'Held by this preview runtime.',
        }]))
        return {
          ...base,
          id: ids[index]!,
          name,
          version: versions[index],
          ceilings,
          capabilities: { ...base.capabilities, account: index === 5 || base.capabilities.account, listHistory: index < 6, extensionStore: index === 0 },
          presentation: { ...base.presentation, name },
        }
      })
      const healthByRuntime = { ...snapshot.healthByRuntime }
      delete healthByRuntime[ids[5]!]
      Object.assign(snapshot, {
        runtimes,
        activeRuntime: ids[0],
        skills: [{
          name: 'preview-skill',
          displayName: 'Preview Skill',
          description: 'A synthetic instruction bundle for the Settings preview.',
          shortDescription: 'Synthetic preview entry.',
          enabled: true,
          path: '~/.config/harnessdesk/skills/preview-skill',
          scope: 'user',
        }],
        healthByRuntime,
        accountsByRuntime: { ...snapshot.accountsByRuntime, [ids[5]!]: {
          accounts: [],
          signInMethods: [{ id: 'browser', label: 'Sign in in your browser', flow: 'browser' }],
        } },
      })
    }
    if (destination === 'conversation' && query.get('frame-fix5-runtime-unavailable') === '1') {
      const seed = signInSeed('refused')
      const runtimes = seed.runtimes!.slice(1, 6)
      const selected = runtimes[0]!
      const accounts = { ...seed.accountsByRuntime }
      accounts[runtimes[3]!.id] = accounts[runtimes[2]!.id]!
      Object.assign(snapshot, {
        runtimes: runtimes.map(runtime => ({
          ...runtime,
          capabilities: { ...runtime.capabilities, account: true },
        })),
        activeRuntime: selected.id,
        accountsByRuntime: accounts,
        healthByRuntime: {
          ...snapshot.healthByRuntime,
          [selected.id]: {
            state: 'unavailable', reason: 'notInstalled',
            message: 'The selected runtime cannot start.',
            remediation: 'Install it in Settings, then try again.',
          },
        },
      })
    }
    if (query.get('frame-short-title') === '1') {
      const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)
      if (!session) throw new Error('the short-title conversation fixture is missing its session')
      Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, {
        ...session, title: 'Extract the address form', status: { type: 'idle' }, turns: [],
      }) })
    }
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
    if (query.get('frame-fix8-signin') === '1') {
      const [first, second] = snapshot.runtimes
      const failed = { state: 'unavailable' as const, reason: 'missing' as const, message: 'The agent cannot start.', remediation: 'Choose a working installation.' }
      Object.assign(snapshot, { runtimes: [first!, { ...second!, capabilities: { ...second!.capabilities, account: true } }], activeRuntime: first!.id, health: failed,
        healthByRuntime: { [first!.id]: failed, [second!.id]: { state: 'ready' } },
        accountsByRuntime: { ...snapshot.accountsByRuntime, [second!.id]: { ...snapshot.accountsByRuntime[second!.id]!, accounts: [], signInMethods: snapshot.accountsByRuntime[first!.id]!.signInMethods } },
      })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        const runtime = (params as { runtime: RuntimeId }).runtime
        if (method === 'runtime/health') return snapshot.healthByRuntime[runtime]
        if (method === 'runtime/account') return snapshot.accountsByRuntime[runtime]
        return request(method, params as never)
      }) as typeof next.transport.request
    }
    if (query.get('frame-fix8-palette') === '1') {
      const entry = snapshot.agents!.find(one => one.definition)!
      const agent = { ...entry, id: 'unavailable-reviewer', path: '/app/agents/unavailable-reviewer/AGENT.md',
        definition: { ...entry.definition!, id: 'unavailable-reviewer', name: 'Unavailable reviewer' } }
      const plan = { id: agent.id, from: 'prefer' as const, winner: null, blocked: null, candidates: [], ceiling: { level: 'read' as const, hold: 'asked' as const } }
      Object.assign(snapshot, { agents: [agent], agentPlans: new Map([[agent.id, plan]]) })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'agent/list') return [agent]
        if (method === 'agent/seat/dry') return [plan]
        return request(method, params as never)
      }) as typeof next.transport.request
    }
    if (destination === 'draft' && query.get('frame-fix8-worktree') === '1') {
      Object.assign(snapshot, { workspace: { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1,
        git: { branch: 'main' }, repo: { root: '/work/storefront', worktree: false } } })
    }
    if (destination === 'draft' && query.get('frame-fix8-permission-profile') === '1') {
      Object.assign(snapshot, { draftOptions: [{ id: 'permissions', type: 'select', category: '_permissions', label: 'Permissions', currentValue: ':workspace', choices: [
        { value: ':read-only', label: 'Read only' }, { value: ':workspace', label: 'Workspace write' },
        { value: ':danger-full-access', label: 'Full access', risk: 'high', description: 'Can change any file.' },
        { value: 'ci', label: 'ci', group: 'Profiles', description: 'Checks files using the project configuration.' },
      ] }, { id: 'approvals', type: 'select', category: '_permissions', label: 'Approvals', currentValue: 'on-request', choices: [{ value: 'on-request', label: 'When it asks' }] }] })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'runtime/sessionDefaults') return snapshot.draftOptions!.map(option => ({ ...option,
          currentValue: (params as { values?: Record<string, string> }).values?.[option.id] ?? option.currentValue,
        }))
        return request(method, params as never)
      }) as typeof next.transport.request
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
      const fullComposerRow = query.get('frame-fix6-folder') !== null
      const solLow = query.get('frame-fix6-model') === 'sol-low'
      const modelValue = solLow ? 'gpt-6.1-sol' : 'gpt-5.5'
      const modelLabel = solLow ? 'GPT-6.1-Sol' : 'GPT-5.5'
      const effortValue = solLow ? 'low' : 'medium'
      const effortLabel = solLow ? 'Low' : 'medium'
      const composerValues: ConfigOption[] = [
        { id: 'sandbox', type: 'select', category: '_permissions', label: 'Sandbox', currentValue: 'workspace-write', choices: [
          { value: 'workspace-write', label: 'Workspace write' },
          ...(fullComposerRow ? [{ value: 'read-only', label: 'Read only' }] : []),
        ] },
        { id: 'mode', type: 'select', category: 'mode', label: 'Mode', currentValue: 'default', choices: [
          { value: 'default', label: 'Default' },
          ...(fullComposerRow ? [{ value: 'plan', label: 'Plan' }] : []),
        ] },
        { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: modelValue, choices: [
          { value: modelValue, label: modelLabel },
        ] },
        { id: 'reasoning_effort', type: 'select', category: 'thought_level', label: 'Reasoning effort', currentValue: effortValue, choices: [
          { value: effortValue, label: effortLabel },
        ] },
        ...(fullComposerRow ? [{ id: 'format', type: 'boolean' as const, category: 'other' as const, label: 'Summary format', currentValue: true }] : []),
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
    if (destination === 'draft' && query.get('frame-fix5-storefront') === '1') {
      const workspace = { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }
      Object.assign(snapshot, { workspace, workspaces: [workspace], activeSessionKey: null, sessions: new Map() })
    }
    const fix6Folder = query.get('frame-fix6-folder')
    if (destination === 'draft' && (fix6Folder === 'storefront' || fix6Folder === 'pricing-service')) {
      const workspace = { path: `/work/${fix6Folder}`, name: fix6Folder, lastOpenedAt: 1 }
      Object.assign(snapshot, { workspace, workspaces: [workspace], activeSessionKey: null, sessions: new Map() })
    }
    if (destination === 'draft' && query.get('frame-fix5-long-folder') === '1') {
      const path = '/work/this-is-a-very-long-storefront-folder-name'
      const workspace = { path, name: path.split('/').at(-1)!, lastOpenedAt: 1 }
      Object.assign(snapshot, { workspace, workspaces: [workspace], activeSessionKey: null, sessions: new Map() })
    }
    if (destination === 'draft' && query.has('frame-fix8-readiness')) {
      const state = query.get('frame-fix8-readiness')
      const health = state === 'starting' ? { state: 'starting' as const } : {
        state: 'unavailable' as const, reason: 'unreadable' as const,
        message: 'The agent failed its version check.', remediation: 'Choose a working installation in Settings.',
      }
      Object.assign(snapshot, { health, healthByRuntime: { ...snapshot.healthByRuntime, [snapshot.activeRuntime!]: health } })
    }
    const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)
    if (destination === 'conversation' && session && query.get('frame-fix5-command-approval') === '1') {
      Object.assign(snapshot, {
        approvals: [{
          key: PREVIEW_SESSION_KEY,
          approval: {
            id: approvalId('frame-command-approval'),
            sessionId: session.id,
            requestedAt: 1,
            type: 'command',
            command: 'ls -la',
            cwd: '/work/storefront',
            options: [
              { id: 'deny', label: 'Deny', intent: 'deny' },
              { id: 'session', label: 'Allow for this session', intent: 'approveAlways' },
              { id: 'allow', label: 'Allow', intent: 'approve' },
            ],
          },
        }],
      })
    }
    if (destination === 'conversation' && session && (query.get('frame-fix8-command-waiting') === '1' || query.get('frame-fix9-command-waiting') === '1')) {
      const command = { id: itemId('waiting-command'), type: 'command' as const, command: query.get('frame-fix9-command-waiting') === '1' ? 'ls -la' : 'echo synthetic', cwd: '/work/storefront',
        origin: 'agent' as const, status: 'inProgress' as const, actions: query.get('frame-fix9-command-waiting') === '1' ? [{ type: 'listFiles' as const, command: 'ls -la', path: '/work/storefront' }] : [], startedAt: Date.now() - 1000 }
      Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, { ...session,
        status: { type: 'active' as const }, turns: [{ id: turnId('waiting-turn'), status: 'inProgress' as const, items: [command] }],
      }), approvals: [{ key: PREVIEW_SESSION_KEY, approval: { id: approvalId('waiting-approval'), sessionId: session.id,
        turnId: turnId('waiting-turn'), itemId: command.id, requestedAt: Date.now(), type: 'command', command: command.command,
        cwd: command.cwd, actions: [], options: [{ id: 'allow', label: 'Allow', intent: 'approve' }, { id: 'deny', label: 'Deny', intent: 'deny' }],
      } }] })
    }
    if (destination === 'conversation' && session && query.get('frame-fix5-live-title') === '1') {
      const task = 'List the storefront files and tell me where the product cards are implemented.'
      const live = {
        ...session,
        title: null,
        preview: null,
        turns: [{
          id: turnId('frame-fix5-live-title'),
          status: 'completed' as const,
          items: [{ id: itemId('frame-fix5-live-title'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: task }] }],
        }],
      }
      const stale = { ...live, title: 'Untitled session', preview: null }
      Object.assign(snapshot, {
        sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, live),
        history: [stale],
        historyIdentity: [stale],
      })
    }
    if (destination === 'conversation' && session && query.get('frame-fix5-missing-runtime') === '1') {
      const runtime = runtimeId('synthetic-missing-runtime')
      const key = sessionKey(runtime, session.id)
      const saved = {
        ...session,
        runtime,
        title: 'Judge the storefront layout',
        cwd: '/work/storefront',
        status: { type: 'idle' as const },
        createdAt: 1,
        updatedAt: 2,
        turns: [],
        itemsLoaded: false,
      }
      const summary = { ...saved, status: { type: 'notLoaded' as const } }
      Object.assign(snapshot, {
        sessions: new Map([[key, saved]]),
        history: [summary],
        historyIdentity: [summary],
        activeSessionKey: key,
      })
      showing(next, { kind: 'conversation', session: key }, key)
    }
    if (destination === 'conversation' && session && query.get('frame-fix8-kept') === '1') {
      const kept = { ...session, title: 'Kept conversation', itemsLoaded: true, deskCopy: true,
        turns: [{ id: turnId('kept-turn'), status: 'completed' as const, items: [
          { id: itemId('kept-message'), type: 'assistantMessage' as const, text: 'First kept message' },
        ] }] }
      Object.assign(snapshot, { sessions: new Map([[PREVIEW_SESSION_KEY, { ...kept, turns: [], itemsLoaded: false }]]),
        teams: new Map(), goals: new Map(), workspaces: [],
        healthByRuntime: { ...snapshot.healthByRuntime, [session.runtime]: {
          state: 'unavailable' as const, reason: 'unreadable' as const, message: 'The agent failed its version check.',
          remediation: 'Choose a working installation in Settings.',
        } }, history: [{ ...kept, status: { type: 'notLoaded' as const } }], historyIdentity: [{ ...kept, status: { type: 'notLoaded' as const } }],
      })
      // Keep the supplied history stable when the sidebar mounts its empty filter.
      next.searchHistory = async () => {}
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'session/read') return kept
        if (method === 'session/resume') throw new Error('The agent failed its version check.')
        return request(method, params as never)
      }) as typeof next.transport.request
    }
    if (destination === 'conversation' && session && query.get('frame-fix6-runtime-unavailable') === '1') {
      const message = 'A runtime was found at /work/fixture/bin/agent, but did not report its version.'
      const unavailable = {
        ...session,
        title: 'Review the fixture changes',
        createdAt: 1,
        updatedAt: 2,
        status: { type: 'idle' as const },
        turns: [],
        itemsLoaded: true,
      }
      Object.assign(snapshot, {
        theme: query.get('theme') === 'dark' ? 'dark' : 'light',
        activeRuntime: session.runtime,
        activeSessionKey: PREVIEW_SESSION_KEY,
        sessions: new Map(snapshot.sessions).set(PREVIEW_SESSION_KEY, unavailable),
        healthByRuntime: {
          ...snapshot.healthByRuntime,
          [session.runtime]: { state: 'unavailable' as const, reason: 'unreadable' as const, message },
        },
      })
      showing(next, { kind: 'conversation', session: PREVIEW_SESSION_KEY }, PREVIEW_SESSION_KEY)
    }
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
    if (destination === 'conversation' && query.get('frame-fix8-filter') === '1') {
      const runtime = snapshot.activeRuntime!
      const history = ['Lead', 'Review'].map((title, index) => ({ id: `filter-${index}`, runtime, title, preview: null,
        cwd: `/work/storefront/.worktrees/${title.toLowerCase()}`, repo: { root: '/work/storefront', worktree: true },
        status: { type: 'notLoaded' as const }, createdAt: 1, updatedAt: 2 }))
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'session/index') return { data: history, nextCursor: null }
        if (method === 'session/search') return { data: [], nextCursor: null }
        return request(method, params as never)
      }) as typeof next.transport.request
      Object.assign(snapshot, { sessions: new Map(), teams: new Map(), goals: new Map(),
        workspace: { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }, workspaces: [] })
      void next.loadHistory({ reset: true })
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
    // Seed the real store's private history page before a capture can observe
    // the sidebar's debounced empty search restoring that page.
    const ready = store.loadHistory({ reset: true })
    const api={ready, editorState: () => store.getSnapshot().editorState, resizeLeft:(width:number)=>store.resizePanel('sidebar',width), finishStoppedTurn: () => {
      const snapshot = store.getSnapshot(), goal = snapshot.goals.get('overview-team')
      const member = goal?.pastMembers?.[0]
      if (!member || new URLSearchParams(location.search).get('frame-fix10-stop') !== '1') return
      const key = sessionKey(member.session.runtime, member.session.sessionId), session = snapshot.sessions.get(key)!
      const events = store.transport as unknown as { handlers: { onEvent(runtime: RuntimeId, event: import('@harnessdesk/protocol').AgentEvent): void } }
      events.handlers.onEvent(session.runtime, { type: 'turn/completed', sessionId: session.id,
        turn: { ...session.turns.at(-1)!, status: 'interrupted', completedAt: Date.now() } })
      events.handlers.onEvent(session.runtime, { type: 'session/status', sessionId: session.id, status: { type: 'idle' } })
    }}
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
