import { DEFAULT_LANE_PREFERENCES } from '@harnessdesk/protocol'
import type { TransportEvents } from '../lib/transport'
import { AppStore, type AppSnapshot } from '../state/store'
import type { HostMethodName, HostParams, RuntimeId, SessionId } from '@harnessdesk/protocol'
import { runtimeId, sessionId, sessionKey, sessionIndexCompare, sessionIndexCursorOf } from '@harnessdesk/protocol'
import { focusedPane } from '../state/layout'
import { destinationOf } from '../state/destinations'
import { captureHealth, provenancePage, sceneCommit } from './provenance-fixture'
export const frameDestinationStore = (fixture: AppStore): AppStore => {
  const store = new AppStore('ws://localhost:0/')
  const seed: AppSnapshot = fixture.getSnapshot()
  const view = focusedPane(seed.layout).view
  const current = destinationOf(view.kind === 'conversation' || view.kind === 'room' ? view : { kind: 'conversation', session: null })
  Object.assign(store.getSnapshot(), seed, { workbench: { ...seed.workbench, navigation: { current, back: [], forward: [] } } })
  const fixtureRequest = fixture.transport.request.bind(fixture.transport)
  // Capture after the scene applies its initial facts; keep the full index
  // when the store replaces its displayed first page with a smaller slice.
  let indexedHistory: AppSnapshot['history'] | null = null
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'session/read' || method === 'session/resume') {
      const query = params as { runtime: RuntimeId; sessionId: SessionId }
      const session = store.getSnapshot().sessions.get(sessionKey(query.runtime, query.sessionId))
      if (!session) throw new Error('Synthetic session is unavailable')
      return session
    }
    if (method === 'session/index') {
      const query = params as HostParams<'session/index'>
      if (query.archived === 'only') return fixtureRequest(method, params as never)
      const rows = [...(indexedHistory ??= store.getSnapshot().history)].filter(row => !row.archived && (!query.runtimes || query.runtimes.includes(row.runtime))).sort(sessionIndexCompare)
      const start = query.cursor ? rows.findIndex(row => sessionIndexCursorOf(row) === query.cursor) + 1 : 0
      const data = rows.slice(start, start + (query.pageSize ?? 50))
      return { data, nextCursor: start + data.length < rows.length && data.length ? sessionIndexCursorOf(data[data.length - 1]!) : null }
    }
    if (method === 'team/peers') return fixture.teamPeers((params as HostParams<'team/peers'>).room)
    if (method === 'attachment/seat') return fixture.readSeatAttachments((params as HostParams<'attachment/seat'>).seat)
    if (method === 'evidence/board') {
      const { room } = params as HostParams<'evidence/board'>
      const observed = seed.boardEvidence.get(room)
      if (observed) return observed
      const project = seed.teams.get(room)?.root ?? seed.goals.get(room)?.goal.root
      if (!project) throw new Error('Synthetic room is unavailable')
      const checks = await fixture.projectChecks(project)
      return {
        room, stamp: Date.now(), cards: [], checks: checks.checks.map(check => check.name),
        refused: checks.problems.flatMap(problem => problem.check ? [{ name: problem.check, why: problem.text }] : []),
        unreadable: checks.problems.filter(problem => !problem.check).map(problem => problem.text).join('; ') || null,
      }
    }
    if (method === 'evidence/seat') {
      const query = params as HostParams<'evidence/seat'>
      return fixture.seatRecord(runtimeId(query.runtime), sessionId(query.sessionId))
    }
    if (method === 'finding/list') {
      const reading = await fixtureRequest(method, params as never)
      if (reading !== null && reading !== undefined) return reading
      const query = params as HostParams<'finding/list'>
      await fixture.loadFindings(query.goal, query.filter)
      const state = fixture.getSnapshot().findings.get(query.goal)
      if (!state) throw new Error('Synthetic findings ledger is unavailable')
      return { goal: query.goal, stamp: 'fixture-ledger', rows: state.rows, next: state.next, totals: state.totals, problem: state.problem }
    }
    if (method === 'provenance/commits') {
      const { root, shas } = params as HostParams<'provenance/commits'>
      return provenancePage(shas.map(sha => ({ ...sceneCommit('unknown'), sha })), captureHealth({ project: root }))
    }
    if (method === 'flow/executions') {
      const { team, project, active } = params as HostParams<'flow/executions'>
      const current = store.getSnapshot()
      const runs = [...current.flowExecutions.values()]
      const continued = new Set(runs.map(run => run.continues).filter(Boolean))
      return runs.filter(run => (!team || run.goal === team)
        && (!project || current.goals.get(run.goal)?.goal.root === project)
        && (active === false || !continued.has(run.id) && (run.state === 'running' || run.state === 'stalled')))
        .map(run => { const round = run.rounds.at(-1); return {
          id: run.id, team: run.goal, flow: run.document.flow.name, state: run.state,
          round: round?.n ?? null, role: round?.role ?? null, reason: run.reason,
          startedAt: current.goals.get(run.goal)?.goal.createdAt ?? 0,
        } })
    }
    if (method === 'flow/execution') {
      const run = store.getSnapshot().flowExecutions.get((params as HostParams<'flow/execution'>).run)
      if (!run) throw new Error('Synthetic Run is unavailable')
      return run
    }
    if (method === 'insight/goal') return fixture.readGoalInsight((params as HostParams<'insight/goal'>).goal)
    if (method === 'git/diffRange') {
      const { root, from, to } = params as HostParams<'git/diffRange'>
      return fixture.readWorkDiff(root, from, to)
    }
    if (method === 'flow/check/attempts') {
      const { run, card } = params as HostParams<'flow/check/attempts'>
      return fixture.readCheckAttempts(run, card)
    }
    if (method === 'finding/publications') {
      const { goal, run } = params as HostParams<'finding/publications'>
      return fixture.readFindingPublications(goal, run)
    }
    if (method === 'finding/read') {
      const { goal, finding, cursor } = params as HostParams<'finding/read'>
      return fixture.readFinding(goal, finding, cursor)
    }
    if (method === 'trigger/goal') return fixture.triggerGoal((params as HostParams<'trigger/goal'>).goal)
    if (method === 'team/messaging') {
      const { room, enabled } = params as HostParams<'team/messaging'>
      const current = store.getSnapshot().teams.get(room)
      if (!current) throw new Error('Synthetic Team is unavailable')
      const state = { ...current, messaging: enabled }
      ;(store.transport as unknown as { handlers: TransportEvents }).handlers.onNotification({ method: 'team/changed', params: { state } })
      return null
    }
    if (method === 'app/state/get') return {}
    if (method === 'app/state/set') return {}
    const query = params as { runtime: RuntimeId; root: string; project: string; account: string; plan?: string|null }
    if (method === 'runtime/account') return store.getSnapshot().accountsByRuntime[query.runtime] ?? seed.accountsByRuntime[query.runtime] ?? {accounts:[],signInMethods:[]}
    if (method === 'runtime/resources') return fixture.runtimeResources()
    if (method === 'runtime/health') return fixture.healthFor(query.runtime)
    if (method === 'runtime/limits') return fixture.limitsFor(query.runtime)
    if (method === 'runtime/options') return fixture.optionsFor(query.runtime)
    if (method === 'runtime/sessionDefaults') {
      const defaults = params as HostParams<'runtime/sessionDefaults'>
      const options = await fixture.newSessionDefaultsFor(defaults.runtime)
      return options.map(option => {
        const value = defaults.values?.[option.id]
        if (option.disabled) return option
        if (option.type === 'select' && typeof value === 'string' && option.choices.some(choice => choice.value === value)) return { ...option, currentValue: value }
        if (option.type === 'boolean' && typeof value === 'boolean') return { ...option, currentValue: value }
        return option
      })
    }
    if (method === 'usage/plan/read') return fixture.readPlan(query)
    if (method === 'acp/catalog') return fixture.agentCatalog()
    if (method === 'acp/registry') return fixture.acpRegistry()
    if (method === 'agent/list') return fixture.agentsIn(query.project)
    const detail = params as { id: string; origin: 'project' | 'user' | 'builtin'; target: Parameters<AppStore['readAuthoring']>[0]; ids: readonly string[]; agent: string; goals: readonly string[] }
    if (method === 'insight/agent') return fixture.readAgentInsight(query.root, detail.agent, detail.origin)
    if (method === 'authoring/read') return fixture.readAuthoring(detail.target)
    if (method === 'authoring/save/pending') return fixture.authoringPending()
    if (method === 'attachment/agent') return fixture.readAgentAttachments(detail.id, detail.origin)
    if (method === 'attachment/notes') return fixture.readAgentNotes(detail.id, detail.origin)
    if (method === 'agent/seat/dry') return (detail.ids ?? [...seed.agentPlans.keys()]).map(id => seed.agentPlans.get(id)).filter(Boolean)
    if (method === 'agent/seating/read') return seed.seating
    if (method === 'insight/goals') return fixture.readGoalInsights(detail.goals)
    if (method === 'finding/run') {
      const {goal,run} = params as {goal:string;run:string}
      const reading = fixture.getSnapshot().findingRuns.get(run)
      if (reading?.goal === goal) return reading
      return {goal,run,round:0,finished:0,total:0,embargoed:false,open:0,blocking:0,reason:null,ceilingStop:false,stamp:'fixture-empty',publication:'local',rounds:[],reviewersFinished:null,reviewersTotal:null,pendingExceptions:[],repair:null,boundPr:null,unbound:null,undecidable:null}
    }
    if (method === 'usage/reports' || method === 'usage/refresh') return seed.usage
    if (method === 'usage/ledger') return fixture.ledger(params as Parameters<AppStore['ledger']>[0])
    if (method === 'insight/usage') return fixture.readUsageInsight(params as Parameters<AppStore['readUsageInsight']>[0])
    if (method === 'capability/list') return seed.contributions.filter(contribution => contribution.kind === (params as {kind:string}).kind)
    if (method === 'plugin/inspect') return {id:'sample',name:'Sample plugin',permissions:['Read workspace files'],alreadyInstalled:false}
    if (method === 'plugin/list') return fixture.getSnapshot().plugins
    if (method === 'plugin/setEnabled') {
      const { pluginId, enabled } = params as {pluginId:string;enabled:boolean}
      await fixture.setPluginEnabled(pluginId, enabled)
      return undefined
    }
    if (method === 'plugin/install' || method === 'plugin/configure' || method === 'plugin/uninstall') return undefined
    if (method === 'flow/catalog') return fixture.flowCatalog(query.root)
    if (method === 'evidence/checks') return fixture.projectChecks(query.project)
    if (method === 'trigger/list') return fixture.projectTriggers(query.root)
    if (method === 'lane/preferences') return seed.lanePreferences ?? DEFAULT_LANE_PREFERENCES
    if (method === 'lane/list') return seed.lanes
    if (method === 'trigger/preferences') return fixture.triggerPreferences()
    if (method === 'history/status') return seed.historyImports[query.runtime] ?? null
    if (method === 'history/list') return await fixtureRequest(method, params as never) ?? { data: [], nextCursor: null }
    if (method === 'credentials/list') return fixture.listCredentials()
    if (method === 'runtime/hooks') return fixture.loadHooks()
    if (method === 'runtime/mcp/list') return fixture.loadMcpServers()
    if (method === 'provenance/status') return []
    if (method === 'runtime/catalog') return fixture.loadCatalog()
    if (method === 'runtime/apps/search') return {apps:[]}
    // The frame's folder is deliberately outside Git; a menu read must not
    // borrow the repository fixture used by the Changes pane.
    if (method === 'git/status' && query.root === store.getSnapshot().workspace?.path && !store.getSnapshot().workspace?.git) return null
    if (method === 'worktree/list') return store.getSnapshot().worktrees
    if (method === 'git/branches') return fixture.listBranches(query.root)
    if (method === 'runtime/installs') return null
    if (method === 'runtime/warm') return {ready:true}
    if (method === 'terminal/open') return {terminalId:'frame-pty',runtime:seed.activeRuntime}
    const reading = await fixtureRequest(method, params as never)
    if (reading !== null && reading !== undefined) return reading
    if (method === 'storage/usage') return {database:{bytes:148*1024**2,computing:false},snapshots:{count:3,bytes:420*1024**2,computing:false},cachedPreviews:{count:18,bytes:86*1024**2},worktrees:{count:24,bytes:8.6*1024**3,kept:0,computing:false}}
    if (method === 'storage/kept') return []
    if (method === 'terminal/write' || method === 'terminal/resize' || method === 'terminal/close') return null
    throw new Error(`Synthetic page fixture has no answer for ${method}`)
  }) as typeof store.transport.request
  return store
}

/** Fixture event only: publish connection state through the real store's snapshot wake. */
export const setFrameConnection = (store: AppStore,status: AppSnapshot['status']): void => {
  ;(store.transport as unknown as {handlers:TransportEvents}).handlers.onStatus(status)
}
