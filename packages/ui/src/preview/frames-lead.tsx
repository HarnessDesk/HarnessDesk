import { useMemo } from 'react'
import { MainPages } from '../app/MainPages'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { ShellHostsProvider, ShellOutlets } from '../panels/shell-hosts'
import { Sidebar } from '../components/Sidebar'
import { emptyWorkbench } from '../state/workbench'
import { frameDestinationStore } from './frame-destination-store'
import { StoreProvider } from '../state/context'
import { createLeadState } from '../state/lead'
import { TopBarProvider } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { LeadPage } from '../components/LeadPage'
import { Chip, LeadContract, Row, Rows, Text } from '../design'
import { useTheme } from '../state/theme'
import { previewStore } from './harness'
import { LEAD_SCENES, leadRuntime, leadSceneProjection, type LeadScene } from './lead-fixture'
import type { HostMethodName, LeadWindowProjection } from '@harnessdesk/protocol'

/** Isolated fake window facade. No connect(), Keychain or vendor requests. */
const fixtureStore = (scene: LeadScene) => {
  const store = frameDestinationStore(previewStore({ leadAvailable: true, runtimes: [leadRuntime], theme: new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light' }))
  const shellRequest = store.transport.request.bind(store.transport)
  let current = leadSceneProjection(scene)
  const emit = (next: LeadWindowProjection) => { current = next; store.lead.changed({ method: 'lead/changed', params: current }) }
  store.transport.request = (async (method: HostMethodName, input: unknown) => {
    const params = input as Record<string, any>
    if (method === 'lead/settings/update') {
      if (params.credential) emit({ ...current, revision: current.revision + 1, settings: { ...current.settings, key: { ...current.settings.key, configured: params.credential.key !== null } } })
      else emit({ ...current, revision: current.revision + 1 })
      return current
    }
    if (method === 'lead/card/decide') { emit({ ...current, revision: current.revision + 1, wayOut: null, thread: { ...current.thread, cards: current.thread.cards.filter(card => card.id !== params.cardId) } }); return current }
    if (method === 'lead/thread/send') { const revision = current.revision + 1; emit({ ...current, revision, thread: { ...current.thread, messages: [...current.thread.messages, { version: 1, id: `message-${revision}`, revision, role: 'user', text: params.text }] } }); return { messageId: `message-${revision}`, revision } }
    if (method === 'lead/resume') { emit({ ...current, revision: current.revision + 1, wayOut: null }); return current }
    if (method === 'lead/thread/read' || method === 'lead/settings/read') return current
    return shellRequest(method, input as never)
  }) as typeof store.transport.request
  // A real facade, so frames exercise subscription, revision fencing and actions.
  Object.assign(store, { lead: createLeadState(store.transport, () => true) })
  emit(current)
  if (scene === 'app-shell') {
    const workbench = { ...emptyWorkbench(), navigation: { current: { kind: 'lead' as const }, back: [], forward: [] } }
    Object.assign(store.getSnapshot(), { workbench, layout: workbench.main, activeSessionKey: null, sessions: new Map(), sidebarCollapsed: false, sidebarFloating: false })
  }
  return store
}
const LeadSurface = ({ scene }: { readonly scene: LeadScene }) => {
  useTheme()
  if (scene === 'app-shell') return <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}><TopBarProvider><ShellHostsProvider>
    <Workbench pageActive pages={<MainPages onSignIn={() => {}} onNewTeam={() => {}} libraryImportIntent={0} />} sidebar={<Sidebar activeDestination="lead" onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />
    <ShellOutlets activeOwner="destination:lead" hostOwner="work" />
  </ShellHostsProvider></TopBarProvider></ShellProvider>
  return <TopBarProvider><DestinationPageScope owner={`lead-${scene}`} active><LeadPage initialSettingsOpen={scene.startsWith('settings-')} initialGoal={scene === 'goal-composer' ? 'Make the empty state keyboard accessible' : ''} /></DestinationPageScope></TopBarProvider>
}
export const LeadFrame = ({ scene }: { readonly scene: LeadScene }) => {
  const store = useMemo(() => fixtureStore(scene), [scene])
  return <section data-frame-id={`lead-${scene}`} className="flex min-w-0 flex-col gap-3">
    <h2>{`Lead · ${scene}`}</h2>
    <div className={scene === 'narrow' ? 'h-[760px] w-[320px] max-w-full overflow-hidden border bg-background' : 'h-[760px] min-w-0 overflow-hidden border bg-background'}>
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
export const LeadContractSpecimen = () => <div className="flex flex-col gap-6">{LEAD_CONTRACT_CATALOG_STATES.map(state => <div key={state} data-variant={LEAD_CONTRACT_CATALOG_VARIANTS[0]} data-size={LEAD_CONTRACT_CATALOG_SIZES[0]} data-state={state}>
  <LeadContract pending={state === 'loading'} title="Plan" revision={2} summary="Implement, check and review the keyboard path." onApprove={() => {}} onDecline={() => {}}>
    <Rows><Row title="Review keyboard focus" desc="Demo runtime · demo-model" /><Row title="Keyboard checks pass" titleChip={<Chip tone="neutral">Check</Chip>} /></Rows>
    <Rows><Row title="Allowance" control={<Text role="meta">$5 · 4 rounds</Text>} /><Row title="Approval scope" desc="Only the approved steps in /workspace/demo." /></Rows>
  </LeadContract>
</div>)}</div>
