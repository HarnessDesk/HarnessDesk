import { useEffect, useLayoutEffect, useMemo } from 'react'
import { App } from '../src/app/App'
import { StoreProvider } from '../src/state/context'
import type { PageDestination } from '../src/state/destinations'
import type { AppSnapshot, AppStore } from '../src/state/store'
import { frameDestinationStore } from '../src/preview/frame-destination-store'
import { previewStore, PREVIEW_SESSION_KEY } from '../src/preview/harness'
import { teamsPageStore } from '../src/preview/teams-page-fixture'
import { installSkillPageFixture } from '../src/preview/skill-page-fixture'
import { runtimesSeed } from '../src/preview/signin-fixture'
import { flowsDestinationStore } from '../src/preview/flows-destination-fixture'
import { TEAM_START_POLICIES } from '../src/preview/team-start-fixture'
import type { FlowExecution, FlowPolicy } from '@harnessdesk/protocol'
import { runTeamStore } from '../src/preview/run-view-fixture'
import { chatsStore } from './chats'
import { renamed, withRealNames } from './real-names'

/**
 * The tour's pages: the shipping App window over the preview gallery's
 * synthetic stores, each opened on one destination at the tour's 800 × 500.
 */
/** The page's own window: navigation stays, refusals of the absent host stay quiet. */
const pageStore = (fixture: AppStore, page: PageDestination | null): AppStore => {
  const store = frameDestinationStore(withRealNames(fixture), { workspaceOutsideGit: true })
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => renamed(await request(method, params as never))) as typeof store.transport.request
  store.notice = () => {}
  if (page) store.openDestination(page)
  return store
}

/** A conversation pane in main, with the sidebar standing, as the gallery shows Teams. */
const inMain = (fixture: AppStore, view: { kind: 'conversation'; session: AppSnapshot['activeSessionKey'] } | { kind: 'room'; room: string; framePage?: 'run' }) => {
  const seed = fixture.getSnapshot()
  const main = { root: { kind: 'pane' as const, id: 'site-main', view }, focused: 'site-main', expanded: null }
  Object.assign(seed, { layout: main, workbench: { ...seed.workbench, main }, sidebarCollapsed: false, sidebarFloating: false,
    activeSessionKey: view.kind === 'conversation' ? view.session : null })
  return fixture
}

const teams = () => {
  const fixture = teamsPageStore('active')
  const session = [...fixture.getSnapshot().sessions.keys()][0] ?? null
  const store = pageStore(inMain(fixture, { kind: 'conversation', session }), null)
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'insight/goals') return renamed(await fixture.readGoalInsights((params as { goals: string[] }).goals)) as never
    if (method === 'finding/run') {
      const { goal, run } = params as { goal: string; run: string }
      return { goal, run, round: 0, finished: 0, total: 0, embargoed: false, open: 0, blocking: 0, reason: null, ceilingStop: false, stamp: 'site-empty',
        publication: 'local', rounds: [], reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null, boundPr: null, unbound: null, undecidable: null } as never
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  store.openDestination({ kind: 'teams', filter: 'active' })
  return store
}

const run = () => {
  const source = runTeamStore('running')
  const own = previewStore(source.getSnapshot())
  const fixture = new Proxy(own, { get(target, key) {
    if (key === 'flowCatalog' || key === 'flowSource' || key === 'flowExecutionSource' || key === 'readGoalInsight' || key === 'teamPeers') return Reflect.get(source, key)
    return Reflect.get(target, key)
  } }) as AppStore
  return pageStore(inMain(fixture, { kind: 'room', room: 'overview-team', framePage: 'run' }), null)
}

const library = () => {
  const fixture = inMain(previewStore(), { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  const store = pageStore(fixture, null)
  installSkillPageFixture(store, 'healthy')
  store.openDestination({ kind: 'library', section: 'skill', id: 'code-review' })
  return store
}

/**
 * Most runtimes ready, and the two kinds of attention 0.5.2 reports quietly:
 * one that could not start and one signed out. Nobody is at a limit here, so
 * the page is not led by a quota banner.
 */
const runtimes = () => {
  // One attention row, so the Ready group shares the window.
  const seed = runtimesSeed('connected') as AppSnapshot
  const keep = new Set(['codex', 'claude', 'cursor', 'gemini', 'opencode'])
  const accounts = { ...seed.accountsByRuntime,
    gemini: { ...seed.accountsByRuntime['gemini' as never], accounts: [{ kind: 'oauth', label: 'dev@example.com', email: 'dev@example.com' }] } }
  return pageStore(inMain(previewStore({ ...seed, runtimes: seed.runtimes.filter(info => keep.has(String(info.id))),
    accountsByRuntime: accounts as AppSnapshot['accountsByRuntime'],
    usage: seed.usage.map(report => ({ ...report, reached: null, lanes: report.lanes.map(lane => ({ ...lane, usedPercent: 42 })) })),
  }), { kind: 'conversation', session: null }),
  { kind: 'settings', route: { kind: 'section', section: 'runtimes', focus: null } } as PageDestination)
}

const flows = () => {
  const store = flowsDestinationStore()
  withRealNames(store)
  store.notice = () => {}
  // The page counts recorded Runs once the Teams are read; the fixture has
  // them in hand already.
  store.loadGoals = async () => {}
  store.loadTeamRunsBatch = (async (teams: readonly string[]) => ({ loaded: new Set(teams), unavailable: new Set<string>() })) as never
  // A desk that has used its Flows: each card counts the Runs recorded with it.
  const template = [...runTeamStore('complete').getSnapshot().flowExecutions.values()][0]!
  const recorded: Record<string, number> = { 'fix-and-review': 14, comparison: 9, alignment: 6, 'fan-out': 4, review: 11, 'independent-review': 3, investigation: 5, 'review-pr': 8, 'mechanical-contest': 2, 'staged-relay': 1 }
  const executions = new Map(store.getSnapshot().flowExecutions)
  for (const [id, policy] of Object.entries(TEAM_START_POLICIES)) for (let n = 0; n < (recorded[id] ?? 0); n++) {
    const run = { ...template, id: `site-${id}-${n}`, document: { ...template.document, format: 'agents', flow: policy as unknown as FlowPolicy } } as FlowExecution
    executions.set(run.id, run)
  }
  Object.assign(store.getSnapshot(), { flowExecutions: executions })
  store.openDestination({ kind: 'flows', root: null, id: null, origin: null })
  return store
}

const chats = () => chatsStore()

export const PAGE_SCENES = { 'tour-teams': teams, 'tour-run': run, 'tour-library': library, 'tour-runtimes': runtimes, 'tour-flows': flows, 'tour-chats': chats } as const
export type PageSceneName = keyof typeof PAGE_SCENES
export const isPageScene = (name: string): name is PageSceneName => Object.hasOwn(PAGE_SCENES, name)

export const usePageStore = (name: PageSceneName, theme: 'light' | 'dark') => useMemo(() => {
  const store = PAGE_SCENES[name]()
  store.setTheme(theme)
  return store
}, [name])

export const PageSceneBody = ({ store, width, height }: { store: AppStore; width: number; height: number }) => {
  useLayoutEffect(() => { store.setWindowSize(width, height) }, [store, width, height])
  // The App hands focus to its first control as it opens; on a page that is
  // a picture until the visitor reaches in, that ring is noise.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() }, 400)
    return () => window.clearTimeout(timer)
  }, [store])
  return <StoreProvider store={store}><div className="h-full min-h-0 overflow-hidden bg-background"><App /></div></StoreProvider>
}
