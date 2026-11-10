import { useMemo } from 'react'
import { MainPages } from '../app/MainPages'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { Sidebar } from '../components/Sidebar'
import { emptyWorkbench } from '../state/workbench'
import { frameDestinationStore } from './frame-destination-store'
import { StoreProvider, useSnapshot, useStore } from '../state/context'
import { createLeadState } from '../state/lead'
import { TopBarOutlet, TopBarProvider } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { leadPolicyWidens } from '../components/LeadSettings'
import { Settings } from '../components/Settings'
import { LeadDecision } from '../components/LeadDecision'
import { LeadCards } from '../components/LeadCards'
import { LeadPage } from '../components/LeadPage'
import { LeadDetails } from '../components/LeadDetails'
import { LeadAskOptions, LeadAvatar, LeadNameChoice, LeadPlanFlow, LeadTurn, LeadWorking, Text } from '../design'
import { useTheme } from '../state/theme'
import { previewStore } from './harness'
import { LEAD_SCENES, leadContextFacts, leadPresenceFixture, leadWakeFixture, leadWorkFixture, leadContract, leadMemory, leadRuntime, leadSceneProjection, leadSchedule, type LeadScene } from './lead-fixture'
import { LEAD_AUTONOMY_DEFAULTS, LEAD_LIMITS, LEAD_RULE_DEFAULTS, LEAD_RULE_SECTIONS, LEAD_RULE_TITLES, type LeadAutonomyModes, type LeadRuleSectionView, type LeadRuleVersion, type HostMethodName, type LeadWorkBoard, type LeadWindowProjection } from '@harnessdesk/protocol'

/** Isolated fake window facade. No connect(), Keychain or vendor requests. */
export const createLeadFixtureStore = (scene: LeadScene) => {
  const store = frameDestinationStore(previewStore({ leadAvailable: true, runtimes: [leadRuntime], theme: new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light' }))
  if (scene === 'settings-seeds') Object.assign(store.getSnapshot(), { workspaces: ['Widgets', 'Docs', 'Website'].map(name => ({ name, path: `/workspace/${name.toLowerCase()}`, git: { branch: 'main', sha: 'a'.repeat(40) } })) })
  if (scene === 'no-folder') Object.assign(store.getSnapshot(), { workspaces: [], workspace: null, goals: new Map(), teams: new Map(), boardEvidence: new Map(), flowExecutions: new Map(), flowRuns: new Map(), sessions: new Map() })
  if (scene === 'opening-jobs') Object.assign(store.getSnapshot(), {
    goals: new Map([['demo-team', { goal: { id: 'demo-team', root: '/workspace/demo', state: 'open', sentence: 'Restore keyboard focus' } }]]),
    flowExecutions: new Map([['stalled', { id: 'stalled', goal: 'demo-team', state: 'stalled', rounds: [] }], ['finished', { id: 'finished', goal: 'demo-team', state: 'settled', rounds: [] }]]),
  })
  const shellRequest = store.transport.request.bind(store.transport)
  let current = leadSceneProjection(scene), schedule = leadSchedule, memory = leadMemory
  let work: LeadWorkBoard = scene === 'work-ledger' ? leadWorkFixture : { version: 1, items: [], more: 0 }
  let presence = scene === 'presence' ? leadPresenceFixture() : { version: 1 as const, digest: null, asks: [], brief: { enabled: false, at: '07:30' } }
  // Autonomy and rules, as the host answers them: modes, versioned sections, and a would-have row to show.
  let modes: LeadAutonomyModes = scene === 'settings-autonomy' ? { ...LEAD_AUTONOMY_DEFAULTS, stuck: 'observe', mention: 'off' } : LEAD_AUTONOMY_DEFAULTS
  const versions: Record<string, LeadRuleVersion[]> = scene === 'settings-autonomy'
    ? { talk: [{ version: 1, text: 'Plain words. One question at a time.', at: Date.UTC(2026, 10, 2, 17, 0), how: 'edit', base: LEAD_RULE_DEFAULTS.talk }] } : {}
  const observed = scene === 'settings-autonomy' ? [{ id: 'o1', at: Date.UTC(2026, 10, 9, 18, 30), kind: 'stuck' as const, note: 'Would have said a run had gone quiet.' }] : []
  const sectionView = (id: typeof LEAD_RULE_SECTIONS[number]): LeadRuleSectionView => {
    const history = versions[id] ?? [], latest = history.at(-1), custom = !!latest && latest.how !== 'reset'
    return { id, title: LEAD_RULE_TITLES[id], text: custom ? latest!.text : LEAD_RULE_DEFAULTS[id].text, version: latest?.version ?? 0, custom, default: { ...LEAD_RULE_DEFAULTS[id] }, defaultUpdated: null, history: [...history].reverse() }
  }
  const rulesView = () => ({ version: 1 as const, sections: LEAD_RULE_SECTIONS.map(sectionView), prompt: LEAD_RULE_SECTIONS.flatMap(id => sectionView(id)).filter(one => one.custom).map(one => `${one.title}: ${one.text}`).join('\n') })
  const autonomyView = () => ({ version: 1 as const, modes, observed, deadline: null, rules: LEAD_RULE_SECTIONS.map(id => { const one = sectionView(id); return { id, title: one.title, text: one.text, custom: one.custom } }) })
  const emit = (next: LeadWindowProjection) => { current = next; store.lead.changed({ method: 'lead/changed', params: current }) }
  store.transport.request = (async (method: HostMethodName, input: unknown) => {
    const params = input as Record<string, any>
    if (method === 'lead/settings/update') {
      const revision = current.revision + 1, cards = [...current.thread.cards]
      let settings = { ...current.settings }
      if (params.credential) settings = { ...settings, key: { ...settings.key, configured: params.credential.key !== null } }
      if (params.name) settings.name = params.name
      if (params.follow) settings.follow = params.follow
      if (params.policy) {
        if (leadPolicyWidens(settings.policy, params.policy)) cards.push({ version: 1, id: `policy-${revision}`, revision: 1, type: 'permission-change', contractDigest: current.thread.contract?.digest ?? null, previous: settings.policy, proposed: params.policy })
        else settings = { ...settings, policy: params.policy }
      }
      if (params.caps) {
        if (params.caps.usdMicros > settings.caps.usdMicros || params.caps.rounds > settings.caps.rounds) cards.push({ version: 1, id: `caps-${revision}`, revision: 1, type: 'budget-change', logicalGoalId: 'synthetic-goal', contractDigest: current.thread.contract?.digest ?? null, previous: { revision: current.revision, caps: settings.caps }, proposed: params.caps })
        else settings = { ...settings, caps: params.caps }
      }
      emit({ ...current, revision, settings, thread: { ...current.thread, cards } })
      return params.name ? { version: 1, revision, settings: { name: settings.name, nameChosen: true } } : current
    }
    if (method === 'lead/approval/revoke') {
      if (params.contractDigest !== current.thread.contract?.digest) throw { code: 'lead-card-stale' }
      const revoked = current.savedApprovals?.find(rule => rule.id === params.id)
      if (!revoked) throw { code: 'lead-approval-not-live' }
      emit({ ...current, revision: current.revision + 1, savedApprovals: current.savedApprovals?.filter(rule => rule.id !== params.id), revokedApprovals: [...current.revokedApprovals ?? [], revoked] })
      return current
    }
    if (method === 'lead/action/perform') {
      if (params.contractDigest !== current.thread.contract?.digest || !current.personActions?.some(action => action.id === params.id)) throw { code: 'lead-card-stale' }
      emit({ ...current, revision: current.revision + 1, ...(params.choice === 'yes-goal' ? { savedApprovals: [...current.savedApprovals ?? [], { id: 'rule-new', target: '/workspace/demo/src/panel.tsx', count: 0 }] } : {}), personActions: current.personActions.filter(action => action.id !== params.id), thread: { ...current.thread, cards: current.thread.cards.filter(card => card.id !== params.id) } })
      return current
    }
    if (method === 'lead/card/decide') {
      const card = current.thread.cards.find(card => card.id === params.cardId)
      if (!card || card.revision !== params.expectedRevision || card.type === 'stopped' || card.contractDigest !== params.contractDigest) throw { code: 'lead-card-stale' }
      const settings = params.choice === 'approve' && card.type === 'permission-change' ? { ...current.settings, policy: card.proposed } : params.choice === 'approve' && card.type === 'budget-change' ? { ...current.settings, caps: card.proposed } : current.settings
      emit({ ...current, revision: current.revision + 1, settings, wayOut: null, thread: { ...current.thread,
        state: card.type === 'result' ? params.choice === 'accept-open-pr' ? 'following' : params.choice === 'accept' ? 'accepted' : 'declined' : current.thread.state,
        decisions: [...(current.thread.decisions ?? []), { card, choice: params.choice, position: current.thread.cardPositions?.[card.id] ?? current.revision }], cards: current.thread.cards.filter(one => one.id !== card.id) } })
      return current
    }
    if (method === 'lead/thread/send') { const revision = current.revision + 1; emit({ ...current, revision, thread: { ...current.thread, messages: [...current.thread.messages, { version: 1, id: `message-${revision}`, revision, role: 'user', text: params.text }] } }); return { messageId: `message-${revision}`, revision } }
    if (method === 'lead/stop') { const { progress: _running, ...rest } = current; emit({ ...rest, revision: current.revision + 1, savedApprovals: [], revokedApprovals: [], requestInFlight: false, wayOut: null, waitReason: null, thread: { ...current.thread, state: 'stopped', cards: [] } }); return current }
    if (method === 'lead/resume') { emit({ ...current, revision: current.revision + 1, wayOut: null }); return current }
    if (method === 'trigger/list') return { project: '/workspace/demo', revision: 1, path: '/workspace/demo/.harnessdesk/triggers.yml', exists: true, workingCopyChanged: false, problems: [], triggers: [{ id: 'failed-checks', definition: { opens: { lead: true } } }] }
    if (method === 'trigger/preview') return { lead: { summary: 'Checks failed on acme/widgets', approvalRequired: true } }
    if (method === 'lead/presence/read') return presence
    if (method === 'lead/presence/dismiss') return presence = { ...presence, digest: presence.digest?.id === params.digest ? null : presence.digest }
    if (method === 'lead/brief/read') return presence.brief
    if (method === 'lead/brief/update') { presence = { ...presence, brief: { ...presence.brief, ...(params.enabled === undefined ? {} : { enabled: params.enabled }), ...(params.at === undefined ? {} : { at: params.at }) } }; return presence.brief }
    if (method === 'lead/autonomy/read' || method === 'lead/deadline/set') return autonomyView()
    if (method === 'lead/autonomy/set') { modes = { ...modes, [params.kind]: params.mode }; return autonomyView() }
    if (method === 'lead/rules/read') return rulesView()
    if (method === 'lead/rules/update') {
      const list = versions[params.section] ??= []
      if ((list.at(-1)?.version ?? 0) !== params.expectedVersion) throw { code: 'lead-rules-stale' }
      const make = (how: LeadRuleVersion['how'], text: string): LeadRuleVersion => ({ version: (list.at(-1)?.version ?? 0) + 1, text, at: Date.now(), how, base: LEAD_RULE_DEFAULTS[params.section as 'talk'] })
      if (params.action === 'edit') list.push(make('edit', params.text))
      else if (params.action === 'reset') list.push(make('reset', LEAD_RULE_DEFAULTS[params.section as 'talk'].text))
      else if (params.action === 'rollback') list.push({ ...make('rollback', list.find(one => one.version === params.to)!.text), from: params.to })
      return rulesView()
    }
    if (method === 'lead/work/list') return work
    if (method === 'lead/work/close') {
      // As on the desk: the person's close moves the item to Done, newest first, and is never undone.
      const closed = work.items.find(item => item.id === params.id)
      if (!closed) throw { code: 'notFound' }
      if (closed.closedAt !== undefined) return work
      const done = { ...closed, stage: 'done' as const, group: 'done' as const, closedAt: Date.now(), outcome: params.outcome }
      const rest = work.items.filter(item => item.id !== params.id)
      return work = { ...work, items: [...rest.filter(item => item.group !== 'done'), done, ...rest.filter(item => item.group === 'done')] }
    }
    if (method === 'lead/wakes/read') return { revision: current.revision, wakes: scene === 'wake-ledger' ? leadWakeFixture : [] }
    if (method === 'lead/budget/raise') {
      if (params.expectedRevision !== current.revision) throw { code: 'lead-revision-stale' }
      emit({ ...current, revision: current.revision + 1, settings: { ...current.settings, caps: params.caps }, thread: { ...current.thread,
        ...(current.thread.budget && { budget: { ...current.thread.budget, caps: params.caps } }) } })
      return current
    }
    if (method === 'lead/spendLimit/set') {
      // As on the desk: the goal in hand takes the limit at once, Off as the portable ceiling, rounds untouched.
      if (params.expectedRevision !== current.revision) throw { code: 'lead-revision-stale' }
      const caps = { ...current.settings.caps, usdMicros: params.usdMicros ?? LEAD_LIMITS.maxUsdMicros }
      emit({ ...current, revision: current.revision + 1, settings: { ...current.settings, caps, spendLimitUsdMicros: params.usdMicros }, thread: { ...current.thread,
        ...(current.thread.budget && { budget: { ...current.thread.budget, caps } }) } })
      return current
    }
    if (method === 'lead/repeat/control') {
      schedule = { ...schedule, tasks: schedule.tasks.map(task => task.id !== params.taskId ? task : params.action === 'stop' ? { ...task, enabled: false } : params.action === 'pause' || params.action === 'resume' ? { ...task, paused: params.action === 'pause' } : { ...task, lastRunAt: Date.now(), runs: [...(task.runs ?? []), { slot: Date.now(), at: Date.now(), state: 'started' as const, logicalGoalId: 'repeat-run-now' }].slice(-12) }) }
      return schedule
    }
    if (method === 'lead/schedule/read') return schedule
    if (method === 'lead/schedule/update') return schedule = params.schedule
    if (method === 'lead/memory/read') return memory
    if (method === 'lead/context/read' || method === 'lead/context/compact') return leadContextFacts
    if (method === 'lead/memory/update') return memory = params.memory
    if (method === 'lead/thread/read' || method === 'lead/settings/read') {
      // A desk with no folder open: the host has no Lead journal yet and refuses both reads, as it does live.
      if (scene === 'no-folder') throw Object.assign(new Error('lead-project-missing'), { code: 'lead-project-missing' })
      return scene === 'loading' ? new Promise<never>(() => {}) : current
    }
    return shellRequest(method, input as never)
  }) as typeof store.transport.request
  // A real facade, so frames exercise subscription, revision fencing and actions.
  Object.assign(store, { lead: createLeadState(store.transport, () => true) })
  if (scene !== 'loading' && scene !== 'no-folder') emit(current)
  {
    const workbench = { ...emptyWorkbench(), navigation: { current: scene.startsWith('settings-') ? { kind: 'settings' as const, route: { kind: 'section' as const, section: 'lead' as const, focus: scene === 'settings-runs' ? 'repeat:repeat-repeat-plan' : null } } : { kind: 'lead' as const }, back: [], forward: [] } }
    Object.assign(store.getSnapshot(), { workbench, layout: workbench.main, activeSessionKey: null, sessions: new Map(), sidebarCollapsed: false, sidebarFloating: false })
  }
  return store
}
const LeadSurface = ({ scene }: { readonly scene: LeadScene }) => {
  useTheme()
  const store = useStore(), snapshot = useSnapshot(), current = snapshot.workbench.navigation.current
  if (scene === 'app-shell' || scene === 'no-folder') return <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}><TopBarProvider><ShellHostsProvider>
    <Workbench pageActive pages={<MainPages onSignIn={() => {}} onNewTeam={() => {}} libraryImportIntent={0} />} sidebar={<Sidebar activeDestination="lead" onOpenSettings={() => {}} onOpenLibrary={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />
    <ShellOutlets activeOwner="destination:lead" hostOwner="work" />
  </ShellHostsProvider></TopBarProvider></ShellProvider>
  const owner = `lead-${scene}`
  return <TopBarProvider><div className="flex h-full min-h-0 flex-col"><TopBarOutlet owner={owner} fallback={{ place: null, more: () => null }} /><div className="min-h-0 flex-1 overflow-auto"><DestinationPageScope owner={owner} active>{scene === 'work-ledger' ? <div className="flex h-full min-h-0"><div className="min-w-0 flex-1"><LeadPage focus={null} /></div><aside aria-label="Lead details" className="w-[320px] shrink-0 overflow-auto border-l"><LeadDetails /></aside></div> : current.kind === 'settings' ? <Settings route={current.route} onRoute={route => store.openDestination({ kind: 'settings', route })} onSignIn={() => {}} /> : <LeadPage focus={current.kind === 'lead' ? current.focus : null} initialGoal={scene === 'running-message' ? 'Also check keyboard focus' : scene === 'goal-composer' ? 'Make the empty state keyboard accessible' : ''} />}</DestinationPageScope></div></div></TopBarProvider>

}
export const LeadFrame = ({ scene }: { readonly scene: LeadScene }) => {
  const store = useMemo(() => createLeadFixtureStore(scene), [scene])
  return <section data-frame-id={`lead-${scene}`} className="flex min-w-0 flex-col gap-3">
    <h2>{`Lead · ${scene}`}</h2>
    <div className={scene.startsWith('settings-') ? 'h-[760px] max-h-[calc(100dvh-var(--hd-space-6)*3)] min-w-0 overflow-hidden border bg-background' : scene === 'narrow' ? 'h-[760px] w-[320px] max-w-full overflow-hidden border bg-background' : 'h-[760px] min-w-0 overflow-hidden border bg-background'}>
      <StoreProvider store={store}><LeadSurface scene={scene} /></StoreProvider>
    </div>
  </section>
}
export const LeadFrames = () => {
  const requested = new URLSearchParams(window.location.search).get('lead-synthetic')
  const scenes = LEAD_SCENES.filter(scene => scene === requested)
  return <div className="grid min-h-screen gap-6 bg-background p-4 text-foreground">{(scenes.length ? scenes : LEAD_SCENES).map(scene => <LeadFrame key={scene} scene={scene} />)}</div>
}
const LEAD_CONTRACT_CATALOG_VARIANTS = ['default'] as const
const LEAD_CONTRACT_CATALOG_SIZES = ['default'] as const
const LEAD_CONTRACT_CATALOG_STATES = ['default', 'loading'] as const

/** The catalog renders the real pattern, including narrow action wrapping. */
export const LeadContractSpecimen = () => { const own = useMemo(() => createLeadFixtureStore('pending-plan'), []); return <StoreProvider store={own}><div className="flex flex-col gap-6">{LEAD_CONTRACT_CATALOG_STATES.map(state => <div key={state} data-variant={LEAD_CONTRACT_CATALOG_VARIANTS[0]} data-size={LEAD_CONTRACT_CATALOG_SIZES[0]} data-state={state}>
  <LeadCards cards={leadSceneProjection('pending-plan').thread.cards} onDecide={async () => {}} onChanges={() => {}} onApprovals={() => {}} placement="thread" />
  <LeadAskOptions ask={{ question: 'Start a separate fix?', options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }], recommended: 'start' }} disabled={state === 'loading'} onAnswer={() => {}} />
  <LeadAskOptions ask={{ question: 'Which scope?', options: [{ id: 'focus', label: 'Fix focus only' }, { id: 'all', label: 'Include the whole form' }], recommended: 'focus' }} picked="Fix focus only" />
  <LeadDecision id="specimen" title="Approve this plan?" pending={state === 'loading'} onApprove={() => {}} onDecline={() => {}} />
</div>)}</div></StoreProvider> }
const LEAD_AVATAR_CATALOG_SIZES = ['navigation', 'turn', 'header', 'popover', 'picker'] as const
export const LeadAvatarSpecimen = () => <div className="flex flex-col gap-3">{LEAD_AVATAR_CATALOG_SIZES.map(size => <div key={size} data-variant="default" data-state="default" data-size={size} className="flex items-center gap-3"><LeadAvatar name="dex" size={size} mood="working" /><LeadAvatar name="lex" size={size} mood="working" /></div>)}<LeadNameChoice value="dex" pending={false} onChange={() => {}} /></div>

const LEAD_PLAN_FLOW_CATALOG_VARIANTS = ['default'] as const
const LEAD_PLAN_FLOW_CATALOG_SIZES = ['default'] as const
const LEAD_PLAN_FLOW_CATALOG_STATES = ['default'] as const
export const LeadPlanFlowSpecimen = () => <div data-variant={LEAD_PLAN_FLOW_CATALOG_VARIANTS[0]} data-size={LEAD_PLAN_FLOW_CATALOG_SIZES[0]} data-state={LEAD_PLAN_FLOW_CATALOG_STATES[0]}><LeadPlanFlow steps={leadContract.steps} /></div>


const LEAD_WORKING_CATALOG_VARIANTS = ['default'] as const
const LEAD_WORKING_CATALOG_SIZES = ['default'] as const
const LEAD_WORKING_CATALOG_STATES = ['default'] as const

/** First-block shapes and the pending body share the same turn contract. */
export const LeadTurnSpecimen = () => <div data-variant={LEAD_WORKING_CATALOG_VARIANTS[0]} data-size={LEAD_WORKING_CATALOG_SIZES[0]} data-state={LEAD_WORKING_CATALOG_STATES[0]} className="flex flex-col gap-4">
  <LeadTurn face={<LeadAvatar name="dex" size="turn" />}><Text as="p" role="prose">The desk has one running chat.</Text></LeadTurn>
  <LeadTurn face={<LeadAvatar name="dex" size="turn" />}><Text as="p" role="prose"><strong>运行中（1 个）</strong></Text></LeadTurn>
  <LeadTurn face={<LeadAvatar name="dex" size="turn" />}><Text as="h3" role="section">Running work</Text></LeadTurn>
  <LeadTurn face={<LeadAvatar name="dex" size="turn" />}><LeadWorking label="Reading the desk" since={Date.now() - 6000} onStop={() => {}} /></LeadTurn>
</div>
