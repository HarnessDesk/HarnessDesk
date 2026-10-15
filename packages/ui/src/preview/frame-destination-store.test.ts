import { DEFAULT_LANE_PREFERENCES } from '@harnessdesk/protocol'
import { capabilityListsStore } from './capability-lists-fixture'
import { expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { PREVIEW_AGENTS, previewStore } from './harness'
import { frameDestinationStore, setFrameConnection } from './frame-destination-store'
import { overviewTeamStore } from './team-overview-fixture'
import { PREVIEW_SESSION_KEY } from './harness'
import { reviewPageStore } from './review-page-fixture'

it('admits a selected project for terminal requests without switching the fixture workspace', async () => {
  const store = frameDestinationStore(previewStore())
  const before = store.getSnapshot().workspace
  const path = '/synthetic/selected-project'
  store.openDestination({ kind: 'settings', route: { kind: 'project', root: path } })
  expect(await store.transport.request('workspace/open', { path })).toMatchObject({ path, name: 'selected-project' })
  expect(store.getSnapshot().workspace).toBe(before)
})

it('uses real store navigation, connection events and resource reads without connecting',async()=>{
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  try {
    const fixture=previewStore(),store=frameDestinationStore(fixture)
    expect(store).toBeInstanceOf(AppStore)
    const work=store.getSnapshot().workbench.navigation.current
    store.openDestination({kind:'settings',route:{kind:'section',section:'general',focus:null}})
    await store.navigateBack();expect(store.getSnapshot().workbench.navigation.current).toEqual(work)
    await store.navigateForward();expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
    expect(await store.runtimeResources()).toEqual(await fixture.runtimeResources())
    let wakes=0;const off=store.subscribe(()=>wakes++)
    setFrameConnection(store,'reconnecting');expect(store.getSnapshot().status).toBe('reconnecting');await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));expect(wakes).toBeGreaterThan(0);off()
    await store.loadLanePreferences();expect(store.getSnapshot().lanePreferences).toEqual(fixture.getSnapshot().lanePreferences ?? DEFAULT_LANE_PREFERENCES)
  } finally { clock.mockRestore() }
})

it('page reads retain seeded Agent definitions and dry-run plans when no ids are requested',async()=>{
  const entry={...PREVIEW_AGENTS[0]!,definition:{...PREVIEW_AGENTS[0]!.definition!,runtimeServers:[]}}
  const fixture=previewStore({agents:[entry]}),store=frameDestinationStore(fixture)
  await store.loadAgents()
  expect(store.getSnapshot().agents).toEqual([entry])
  expect(store.getSnapshot().agentPlans).toEqual(fixture.getSnapshot().agentPlans)
  expect(store.getSnapshot().agentPlansFailed).toBe(false)
})
it('a page plugin switch applies the fixture answer before the real store reloads plugins',async()=>{
  const fixture=previewStore(), plugin=fixture.getSnapshot().plugins[0]!
  Object.assign(fixture,{setPluginEnabled:async(pluginId:string,enabled:boolean)=>fixture.patch({plugins:fixture.getSnapshot().plugins.map(one=>one.identity.id===pluginId?{...one,enabled}:one)})})
  const store=frameDestinationStore(fixture)
  await store.setPluginEnabled(plugin.identity.id,false)
  expect(store.getSnapshot().plugins.find(one=>one.identity.id===plugin.identity.id)?.enabled).toBe(false)
  await store.setPluginEnabled(plugin.identity.id,true)
  expect(store.getSnapshot().plugins.find(one=>one.identity.id===plugin.identity.id)?.enabled).toBe(true)
})

it('the real page store reads the seeded branch list from its fixture',async()=>{
  const fixture=previewStore(),branches=[{name:'main',current:true,committedAt:1},{name:'feature/checkout',current:false,committedAt:2}]
  fixture.listBranches=async root=>{expect(root).toBe('/repo');return branches}
  expect(await frameDestinationStore(fixture).listBranches('/repo')).toEqual(branches)
})

it('page history reconciliation retains the synthetic conversations', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture)
  await store.loadHistory({ reset: true })
  await store.searchHistory('')
  expect(store.getSnapshot().history.map(row => row.id)).toEqual(fixture.getSnapshot().history.map(row => row.id))
})

it('page Chat and Details read peer and seat evidence contracts', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture)
  expect(await store.teamPeers('preview')).toEqual(await fixture.teamPeers('preview'))
  const session = fixture.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
  expect(await store.seatRecord(session.runtime, session.id)).toEqual(await fixture.seatRecord(session.runtime, session.id))
})

it('page Findings filter reads retain the fixture ledger and its Run counts', async () => {
  const fixture = overviewTeamStore('running'), store = frameDestinationStore(fixture)
  const before = fixture.getSnapshot().findings.get('overview-team')!
  for (const filter of ['open', 'blocking'] as const) {
    await store.loadFindings('overview-team', filter)
    expect(store.getSnapshot().findings.get('overview-team')).toMatchObject({ filter, rows: before.rows, error: null, totals: before.totals })
  }
  await store.loadFindingRun('overview-team', 'overview-run')
  expect(store.getSnapshot().findingRuns.get('overview-run')).toEqual(fixture.getSnapshot().findingRuns.get('overview-run'))
})

it('page Git history receives an explicit synthetic provenance batch', async () => {
  const store = frameDestinationStore(previewStore())
  const shas = ['a'.repeat(40), 'b'.repeat(40)]
  const reading = await store.readProvenance('/work/project', shas)
  expect(reading.project).toBe('/work/project')
  expect(reading.commits.map(one => one.sha)).toEqual(shas)
  expect(reading.commits.every(one => one.state === 'unattributed' && one.coverage === 'none')).toBe(true)
  expect(store.getSnapshot().captureHealth.get('/work/project')).toEqual(reading.health)
})

it('page Team history and recorded usage read the seeded run and report', async () => {
  const fixture = overviewTeamStore('running'), store = frameDestinationStore(fixture)
  await expect(store.loadTeamRuns('overview-team')).resolves.toBeUndefined()
  expect(store.getSnapshot().flowExecutions).toEqual(fixture.getSnapshot().flowExecutions)
  expect(await store.readGoalInsight('overview-team')).toEqual(await fixture.readGoalInsight('overview-team'))
})

it('page Team changes read the fixture diff and Hold changes the shared room setting', async () => {
  const fixture = overviewTeamStore('running'), store = frameDestinationStore(fixture)
  expect(await store.readWorkDiff('/work/storefront', 'base', 'head')).toEqual(await fixture.readWorkDiff('/work/storefront', 'base', 'head'))
  await store.teamMessaging('overview-team', false)
  expect(store.getSnapshot().teams.get('overview-team')?.messaging).toBe(false)
  await store.teamMessaging('overview-team', true)
  expect(store.getSnapshot().teams.get('overview-team')?.messaging).toBe(true)
})


it('page Details reads a seeded attachment observation and the explicit legacy absence', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture)
  await expect(store.readSeatAttachments('unobserved-seat')).resolves.toBeNull()
  const observed = { version: 1 as const, seat: 'observed-seat', agentDigest: 'synthetic-digest', runtime: 'fixture', build: 'fixture', epoch: 0, observedAt: 1, skillsMode: 'runtime-defaults' as const, mcpMode: 'runtime-defaults' as const, declarations: [], results: [], restored: false }
  Object.assign(fixture, { readSeatAttachments: async (seat: string) => seat === observed.seat ? observed : null })
  await expect(store.readSeatAttachments(observed.seat)).resolves.toEqual(observed)
})


it('page Run keeps seeded board evidence and explicitly answers rooms with no observed facts', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture)
  const [room, evidence] = [...fixture.getSnapshot().boardEvidence][0]!
  await store.loadBoardEvidence(room)
  expect(store.getSnapshot().boardEvidence.get(room)).toEqual(evidence)
  const overview = frameDestinationStore(overviewTeamStore('running'))
  await overview.loadBoardEvidence('overview-team')
  expect(overview.getSnapshot().boardEvidenceFailed.has('overview-team')).toBe(false)
  expect(overview.getSnapshot().boardEvidence.get('overview-team')).toMatchObject({ room: 'overview-team', cards: [], unreadable: null })
})

it('page configuration reads retain the synthetic hook, server, catalogue and credential observations', async () => {
  const fixture = capabilityListsStore(true), store = frameDestinationStore(fixture)
  for (const method of ['loadHooks', 'loadMcpServers', 'loadCatalog', 'listCredentials'] as const) {
    const observed = await fixture[method]()
    expect(observed).not.toEqual([])
    expect(await store[method]()).toEqual(observed)
  }
})


it('page imported history retains the fixture transport list and filter', async () => {
  const fixture = previewStore()
  const observed = { data: [], nextCursor: 'synthetic-next' }
  const original = fixture.transport.request.bind(fixture.transport)
  fixture.transport.request = (async (method, params) => {
    if (method === 'history/list') { expect(params).toMatchObject({ query: 'checkout' }); return observed }
    return original(method, params as never)
  }) as typeof fixture.transport.request
  const store = frameDestinationStore(fixture)
  await expect(store.transport.request('history/list', { query: 'checkout' })).resolves.toEqual(observed)
})

it('page imported history answers an unseeded collection with an empty page', async () => {
  const store = frameDestinationStore(previewStore())
  await expect(store.transport.request('history/list', { pageSize: 100, includeHidden: false })).resolves.toEqual({ data: [], nextCursor: null })
})

it('page defaults acknowledge a valid synthetic choice without changing the declared choices', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture), runtime = fixture.getSnapshot().activeRuntime!
  const before = await store.transport.request('runtime/sessionDefaults', { runtime })
  const after = await store.transport.request('runtime/sessionDefaults', { runtime, values: { approvalsReviewer: 'auto_review' } })
  const original = before.find(option => option.id === 'approvalsReviewer')!
  const chosen = after.find(option => option.id === 'approvalsReviewer')!
  expect(chosen.currentValue).toBe('auto_review')
  expect(chosen.type === 'select' && chosen.choices).toEqual(original.type === 'select' && original.choices)
})

it('keeps the frame workspace outside Git when a menu refreshes its status', async () => {
  const store = frameDestinationStore(previewStore(), { workspaceOutsideGit: true })
  const workspace = store.getSnapshot().workspace!
  expect(workspace.git).toBeUndefined()
  expect(await store.transport.request('git/status', { root: workspace.path })).toBeNull()
  await store.refreshWorkspaceGit(workspace.path)
  expect(store.getSnapshot().workspace?.git).toBeNull()
})

it('delegates Git status to the fixture unless the frame explicitly requests a folder outside Git', async () => {
  const fixture = previewStore(), store = frameDestinationStore(fixture)
  const root = store.getSnapshot().workspace!.path
  expect(await store.transport.request('git/status', { root })).toEqual(await fixture.transport.request('git/status', { root }))
})

it.each(['tree', 'empty', 'large'] as const)('retains the %s review status through a nested frame store', async scene => {
  const fixture = reviewPageStore(scene), store = frameDestinationStore(fixture)
  const root = store.getSnapshot().workspace!.path
  expect(await store.transport.request('git/status', { root })).toEqual(await fixture.transport.request('git/status', { root }))
})

it('retains the non-repository review failure through a nested frame store', async () => {
  const store = frameDestinationStore(reviewPageStore('not-repository'))
  await expect(store.transport.request('git/status', { root: store.getSnapshot().workspace!.path })).rejects.toThrow('Synthetic non-repository')
})
