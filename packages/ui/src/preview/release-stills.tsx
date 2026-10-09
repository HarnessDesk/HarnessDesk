/** Public, frozen camera fixtures; every visible control is the production component. */
import { useEffect, useMemo, useState } from 'react'
import type { FlowPreview, LedgerReport } from '@harnessdesk/protocol'
import { StagedRun } from '../../site-demo/fake-run'
import { AppWindowMode } from '../components/AppWindow'
import { FlowStart, type FlowChoice } from '../components/FlowStart'
import { Sidebar } from '../components/Sidebar'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { TeamRunView } from '../components/TeamRunView'
import { TeamsWindow } from '../components/TeamsWindow'
import { Usage } from '../components/Usage'
import { LibrarySection } from '../components/Library'
import { PluginsSection } from '../components/PluginsSection'
import { Bar, Button, FormStack, PageHead, PaneColumn } from '../design'
import { runTimeline } from '../lib/run-timeline'
import { MountProvider } from '../panels/mount'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import type { AppStore } from '../state/store'
import { comparisonVerdictStore } from './comparison-verdict-fixture'
import { PREVIEW_ROOM, previewStore, store } from './harness'
import { runTeamStore, RUN_FLOW_SOURCE } from './run-view-fixture'
import { shapeFixture } from './run-shapes-fixture'
import { PROJECTS_ROOT, sidebarProjectsFixture } from './sidebar-projects-fixture'
import { SIDE_BY_SIDE_KEYS } from './side-by-side-fixture'
import { teamsPageStore } from './teams-page-fixture'
import { usagePreviewStore } from './usage-fixture'
import { STILL_HOURS, STILL_LIBRARY, STILL_PLUGINS, STILL_RUNTIMES } from './release-stills-data'
import { SITE_SCENES, SiteStills, siteStillStore } from './site-stills'

const capabilityStore = () => {
  const base = previewStore().getSnapshot()
  const own = previewStore({ plugins: STILL_PLUGINS, contributions: STILL_PLUGINS.flatMap(plugin => plugin.contributions),
    runtimes: base.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, pluginTools: true } })) })
  const request = own.transport.request.bind(own.transport)
  own.transport.request = async (method, params) => method === 'library/read' ? STILL_LIBRARY
    : method === 'audit/query' ? [] : request(method, params)
  if (!new URLSearchParams(window.location.search).has('site-clip')) return own
  let snapshot = own.getSnapshot()
  const listeners = new Set<() => void>()
  return new Proxy(own, { get(target, key) {
    if (key === 'getSnapshot') return () => snapshot
    if (key === 'subscribe') return (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
    if (key === 'setPluginEnabled') return async (id: string, enabled: boolean) => {
      snapshot = { ...snapshot, plugins: snapshot.plugins.map(plugin => plugin.identity.id === id
        ? { ...plugin, enabled } : plugin) }
      for (const listener of listeners) listener()
    }
    return Reflect.get(target, key)
  } })
}

const names = [...STILL_RUNTIMES.map(runtime => runtime.presentation.name), 'Judge']
const raceStore = () => {
  const base = comparisonVerdictStore('combined')
  const seed = base.getSnapshot()
  const board = seed.teams.get(PREVIEW_ROOM)!
  const own = previewStore({ ...seed, runtimes: STILL_RUNTIMES, teams: new Map([[board.id, { ...board, nicknames: Object.fromEntries(SIDE_BY_SIDE_KEYS.map((key, n) => [key, names[n] ?? 'Seat'])) }]]) })
  own.teamPeers = async () => (await base.teamPeers(PREVIEW_ROOM)).map((peer, n) => ({ ...peer, nickname: names[n]!, agent: names[n]!, model: n ? 'Sonnet' : 'Standard' }))
  return own
}

// The existing projects fixture uses an invented home. Keep even that home off camera.
const publicPaths = <T,>(value: T): T => {
  const home = PROJECTS_ROOT.split('/code/')[0]!
  if (typeof value === 'string') return value.replaceAll(home, '/work/demo').replace(/\/\.(?:codex|claude|harnessdesk)\/worktrees\//g, '/checkouts/') as T
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [publicPaths(key), publicPaths(entry)])) as T
  if (value instanceof Set) return new Set([...value].map(publicPaths)) as T
  if (Array.isArray(value)) return value.map(publicPaths) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, publicPaths(entry)])) as T
  return value
}

const startStore = () => {
  const own = runTeamStore('person')
  const original = own.previewFlow.bind(own)
  return new Proxy(own, { get(target, key) {
    if (key === 'previewFlow') return async (...args: Parameters<typeof own.previewFlow>): Promise<FlowPreview> => {
      const preview = await original(...args)
      return { ...preview, seats: [...preview.seats, ...Array.from({ length: 2 }, (_, index) => ({
        ...preview.seats[0]!, role: 'reviewer', index, agent: 'reviewer', isolate: true, reviews: true,
        plan: { ...preview.seats[0]!.plan, id: 'reviewer', ceiling: { level: 'read' as const, hold: 'held' as const } },
      }))] }
    }
    return Reflect.get(target, key)
  } })
}

const dashboardStore = () => {
  const own = usagePreviewStore()
  const ledger = own.ledger.bind(own)
  own.ledger = async query => {
    const report = await ledger(query) as LedgerReport
    return { ...report, hourly: STILL_HOURS, coverage: { ...report.coverage, hoursKnownFor: STILL_RUNTIMES.map(runtime => runtime.id) } }
  }
  return own
}

const StartPreview = () => {
  const [choice, setChoice] = useState<FlowChoice | null>(null)
  const initial = useMemo(() => ({ source: RUN_FLOW_SOURCE, vars: {
    task: 'Retry the checkout call on a 502', brief: 'Bound the retry attempts and keep the final failure visible.' }, attended: true }), [])
  return <PaneColumn inset="reading" className="py-6"><FormStack>
    <PageHead title="Start with a team" />
    <FlowStart root="/work/storefront" initial={initial} onChange={setChoice} />
    <Bar><Button disabled={!choice}>Start</Button><Button variant="secondary">Cancel</Button></Bar>
  </FormStack></PaneColumn>
}

const RunStill = ({ flow }: { flow: boolean }) => {
  const run = useMemo(() => new StagedRun('you'), [])
  const input = run.read()
  const snapshot = run.store.getSnapshot()
  const evidence = snapshot.boardEvidence.get(input.execution.goal)
  const [view, setView] = useState<'timeline' | 'flow'>(flow ? 'flow' : 'timeline')
  const [selected, setSelected] = useState<string | null>(null)
  const attempts = new Map([...input.attempts].map(([id, history]) => [id, history.attempts]))
  const model = runTimeline({ execution: input.execution, cards: input.cards, evidence, attempts,
    findings: snapshot.findings.get(input.execution.goal)?.rows ?? [] })
  useEffect(() => () => run.dispose(), [run])
  return <StoreProvider store={run.store}><TeamRunView execution={input.execution} origin="Started by you" model={model} number={1}
    onOpenSeat={() => {}} selectedRow={selected} onSelect={setSelected} drawFlow view={view} onView={setView} attempts={attempts} /></StoreProvider>
}

const PickedRun = () => {
  const own = useMemo(() => raceStore(), [])
  const seed = own.getSnapshot()
  const input = shapeFixture('comparison')
  const execution = [...seed.flowExecutions.values()][0]!
  const model = runTimeline({ ...input, execution, cards: seed.teams.get(PREVIEW_ROOM)!.intents, evidence: seed.boardEvidence.get(PREVIEW_ROOM) })
  const [selected, setSelected] = useState<string | null>(null)
  return <StoreProvider store={own}><TeamRunView execution={execution} origin="Started by you" model={model} number={1}
    onOpenSeat={() => {}} selectedRow={selected} onSelect={setSelected} /></StoreProvider>
}

const Body = ({ scene }: { scene: string }) => {
  useTheme()
  if (SITE_SCENES.includes(scene)) return <SiteStills scene={scene} />
  if (scene === 'library' || scene === 'plugin-permissions') return <PaneColumn inset="reading" className="py-6"><FormStack>
    {scene === 'library' && <LibrarySection />}
    <PluginsSection />
  </FormStack></PaneColumn>
  if (scene === 'teams') return <TeamsWindow onClose={() => {}} />
  if (scene === 'project-sidebar') return <div className="flex h-full">
    <div className="w-80 shrink-0"><Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenTeams={() => {}} onOpenAgents={() => {}}
      onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} /></div>
    <div className="min-w-0 flex-1"><TeamRoomPane room="team-checkout" /></div>
  </div>
  if (scene === 'run-timeline' || scene === 'run-flow') return <RunStill flow={scene === 'run-flow'} />
  if (scene === 'flow-start-preview') return <StartPreview />
  if (scene === 'run-picked') return <PickedRun />
  if (scene === 'race-tiles') return <MountProvider scope={{ area: 'main', id: 'release-race', view: { kind: 'room', room: PREVIEW_ROOM,
    sideBySide: { tiles: SIDE_BY_SIDE_KEYS.slice(0, 2), focused: SIDE_BY_SIDE_KEYS[0], modes: { [SIDE_BY_SIDE_KEYS[0]!]: 'browser' } } } }}>
    <TeamRoomPane room={PREVIEW_ROOM} />
  </MountProvider>
  return <Usage view={scene === 'dashboard-plans' ? 'plans' : 'activity'} onClose={() => {}} />
}

export const ReleaseStills = () => {
  const knobs = new URLSearchParams(window.location.search)
  const scene = knobs.get('release-stills') ?? 'teams'
  const own = useMemo(() => {
    const own = SITE_SCENES.includes(scene) ? siteStillStore(scene) : scene === 'teams' ? teamsPageStore()
      : scene === 'project-sidebar' ? previewStore(publicPaths(sidebarProjectsFixture(store.getSnapshot())))
      : scene === 'race-tiles' ? raceStore()
      : scene === 'library' || scene === 'plugin-permissions' ? capabilityStore()
      : scene === 'flow-start-preview' ? startStore() : dashboardStore()
    // Some preview proxies retain their own snapshot, so patching their base
    // cannot change the theme the mounted screen reads. Decorate that read.
    const theme = knobs.get('theme') === 'dark' ? 'dark' as const : 'light' as const
    let observed = own.getSnapshot()
    let themed = { ...observed, theme }
    return new Proxy(own, { get(target, key) {
      if (key === 'getSnapshot') return () => {
        const next = target.getSnapshot()
        if (next !== observed) { observed = next; themed = { ...next, theme } }
        return themed
      }
      return Reflect.get(target, key)
    } }) as AppStore
  }, [scene])
  return <div data-release-still={scene} className="flex h-screen flex-col bg-background text-foreground">
    <StoreProvider store={own}><AppWindowMode.Provider value="embedded"><Body scene={scene} /></AppWindowMode.Provider></StoreProvider>
  </div>
}
