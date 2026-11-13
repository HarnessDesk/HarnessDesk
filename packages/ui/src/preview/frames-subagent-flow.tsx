import { useMemo } from 'react'
import { runtimeId, sessionKey, type AgentItem, type Session, type SessionId, type SessionKey, type SessionSummary, type SubagentItem, type Turn } from '@harnessdesk/protocol'
import { Agents } from '../components/Agents'
import { Conversation } from '../components/Conversation'
import { SessionTree } from '../components/SessionTree'
import { AgentFlowCard, AgentLanes, RailSection, Text, type AgentFlowChild, type AgentLane } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { previewStore } from './harness'
import { Frame } from './main'
import { previewSession } from './sidebar-fixture'

/**
 * Sub-agents a conversation started, on the four surfaces that draw them:
 * the transcript's card, the strip over the composer, the sidebar's nested
 * rows and the Agents panel's lanes.
 *
 * Two conversations: one whose agent started three children and is waiting
 * on two of them (the shape one runtime reports — a call per spawn, then a
 * wait that names several), and one whose children have all finished, one
 * of them failed (the shape another reports — an item per child, replaced as
 * it moves). `?subagent-flow` draws them; the explorer's Agent flow board
 * draws the pattern alone.
 */
const WORKING = runtimeId('codex')
const FINISHED = runtimeId('claude')
export const SUBAGENT_FLOW_KEYS = {
  working: sessionKey(WORKING, 'subagent-flow-working' as SessionId),
  finished: sessionKey(FINISHED, 'subagent-flow-finished' as SessionId),
} as const

const user = (id: string, text: string): AgentItem => ({ id: id as never, type: 'userMessage', content: [{ type: 'text', text }] })
const answer = (id: string, text: string): AgentItem => ({ id: id as never, type: 'assistantMessage', phase: 'final', text })
const call = (id: string, action: string, status: SubagentItem['status'], members: SubagentItem['members'], extra: Partial<SubagentItem> = {}): SubagentItem =>
  ({ id: id as never, type: 'subagent', action, status, members, ...extra })
const usage = (total: number) => ({ totalTokens: total, inputTokens: total - 900, cachedInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 0 })

/** Fixed offsets from the moment the frame is drawn, so the clocks read the same on every capture. */
const workingTurns = (now: number): Turn[] => [{
  id: 'subagent-flow-working-1' as never,
  status: 'inProgress',
  items: [
    user('w-u', 'Find why checkout retries twice, and check both payment providers.'),
    call('w-s1', 'spawnAgent', 'completed', [{ sessionId: 'sf-child-trace', nickname: 'Trace the retry', role: 'explorer', state: 'pendingInit', model: 'sol' }],
      { prompt: 'Read the checkout retry path and say where the second attempt starts.', startedAt: now - 252_000, completedAt: now - 251_000 }),
    call('w-s2', 'spawnAgent', 'completed', [{ sessionId: 'sf-child-a', nickname: 'Provider A check', role: 'worker', state: 'pendingInit', model: 'sol' }],
      { prompt: 'Run the retry tests against provider A and report what fails.', startedAt: now - 248_000, completedAt: now - 247_000 }),
    call('w-s3', 'spawnAgent', 'completed', [{ sessionId: 'sf-child-b', nickname: 'Provider B check', role: 'worker', state: 'pendingInit', model: 'sol' }],
      { prompt: 'Run the retry tests against provider B and report what fails.', startedAt: now - 246_000, completedAt: now - 245_000 }),
    call('w-w1', 'wait', 'completed', [{ sessionId: 'sf-child-trace', state: 'completed', usage: usage(18_400) }],
      { startedAt: now - 240_000, completedAt: now - 131_000 }),
    answer('w-a1', 'The retry starts in the payment client, not the cart. Waiting on both provider checks.'),
    call('w-w2', 'wait', 'inProgress', [
      { sessionId: 'sf-child-a', state: 'running', usage: usage(9_200) },
      { sessionId: 'sf-child-b', state: 'running', usage: usage(6_100) },
    ], { startedAt: now - 120_000 }),
  ],
}]

const finishedTurns = (now: number): Turn[] => [{
  id: 'subagent-flow-finished-1' as never,
  status: 'completed',
  items: [
    user('f-u', 'Review the storefront change for accessibility and for performance.'),
    call('f-1', 'spawn', 'completed', [{ sessionId: 'toolu_sf_a11y', nickname: 'Accessibility review', role: 'reviewer', state: 'completed', openable: false, usage: usage(31_000) }],
      { prompt: 'Review the changed screens for keyboard reach and contrast.', startedAt: now - 600_000, completedAt: now - 412_000 }),
    call('f-2', 'spawn', 'failed', [{ sessionId: 'toolu_sf_perf', nickname: 'Performance review', role: 'reviewer', state: 'failed', openable: false, usage: usage(12_500) }],
      { prompt: 'Profile the product page before and after the change.', startedAt: now - 598_000, completedAt: now - 540_000 }),
    answer('f-a', 'The accessibility review passed. The performance review stopped: the profiler could not start.'),
  ],
}]

const conversation = (base: Session, key: SessionKey, runtime: Session['runtime'], busy: boolean, turns: Turn[], title: string): Session => ({
  ...base, id: key.split('\u0000')[1] as SessionId, runtime, title, cwd: '/workspace/storefront', goal: null,
  status: busy ? { type: 'active', activeFlags: [] } as Session['status'] : { type: 'idle' },
  git: { ...base.git, branch: 'fix/checkout-retry' },
  settings: { ...base.settings, cwd: '/workspace/storefront' } as Session['settings'],
  turns, itemsLoaded: true,
})

export const subagentFlowStore = (theme: 'light' | 'dark' = 'light', now = Date.now()) => {
  const base = previewSession as unknown as Session
  const seed = previewStore().getSnapshot()
  const sessions = new Map(seed.sessions)
  sessions.set(SUBAGENT_FLOW_KEYS.working, conversation(base, SUBAGENT_FLOW_KEYS.working, WORKING, true, workingTurns(now), 'Checkout retry'))
  sessions.set(SUBAGENT_FLOW_KEYS.finished, conversation(base, SUBAGENT_FLOW_KEYS.finished, FINISHED, false, finishedTurns(now), 'Storefront review'))
  return previewStore({ sessions: sessions as never, theme })
}

/** The sidebar on a store of its own: one project, the two conversations and two plain neighbours, nothing else. */
export const subagentFlowSidebarStore = (theme: 'light' | 'dark' = 'light', now = Date.now()) => {
  const seed = subagentFlowStore(theme, now).getSnapshot()
  const root = '/workspace/storefront'
  const summary = (one: Session, updatedAt: number): SessionSummary => ({
    id: one.id, runtime: one.runtime, title: one.title, preview: null, cwd: root, status: one.status, createdAt: 1, updatedAt, git: null, repo: null,
  })
  const plain = (id: string, title: string, updatedAt: number): SessionSummary => ({
    id: id as SessionId, runtime: WORKING, title, preview: null, cwd: root, status: { type: 'idle' }, createdAt: 1, updatedAt, git: null, repo: null,
  })
  const history = [
    summary(seed.sessions.get(SUBAGENT_FLOW_KEYS.working)!, now),
    summary(seed.sessions.get(SUBAGENT_FLOW_KEYS.finished)!, now - 1),
    plain('subagent-flow-plain-1', 'Product page copy', now - 2),
    plain('subagent-flow-plain-2', 'Release notes', now - 3),
  ]
  return previewStore({
    ...seed, workspace: { path: root, name: 'storefront', lastOpenedAt: 1 }, workspaces: [{ path: root, name: 'storefront', lastOpenedAt: 1 }],
    history, activeSessionKey: null, teams: new Map(), goals: new Map(), flowExecutions: new Map(), foldersGone: new Map(),
    tasks: new Map(), queues: new Map(), inbox: [], approvals: [],
    listPrefs: { ...seed.listPrefs, pinned: [root], pinnedSessions: [], collapsed: [], othersOpen: false },
  })
}

const scope = (id: string, key: SessionKey) => ({ paneId: `${id}-pane` as never, view: { kind: 'conversation' as const, session: key }, sessionKey: key })

const ConversationPane = ({ id, title, sessionKey: key }: { id: string; title: string; sessionKey: SessionKey }) => (
  <Frame id={id} title={title}>
    <div className="flex h-[640px] min-h-0 flex-col">
      <PaneProvider scope={scope(id, key)}>
        <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
      </PaneProvider>
    </div>
  </Frame>
)

const AgentsPane = ({ id, title, sessionKey: key }: { id: string; title: string; sessionKey: SessionKey }) => (
  <Frame id={id} title={title}>
    <div className="flex w-96 min-h-0 flex-col">
      <PaneProvider scope={scope(id, key)}><Agents query="" onFoot={() => {}} /></PaneProvider>
    </div>
  </Frame>
)

const SubagentFlowPanes = ({ sidebar }: { sidebar: ReturnType<typeof subagentFlowSidebarStore> }) => {
  useTheme()
  return <main className="grid gap-4 p-4">
    <ConversationPane id="subagent-flow-working" title="Three sub-agents: one done, two still working, the agent waiting on them" sessionKey={SUBAGENT_FLOW_KEYS.working} />
    <ConversationPane id="subagent-flow-finished" title="Every sub-agent finished, one failed" sessionKey={SUBAGENT_FLOW_KEYS.finished} />
    <div className="flex flex-wrap items-start gap-4">
      <Frame id="subagent-flow-sidebar" title="The sidebar names the children still working"><div className="w-72"><StoreProvider store={sidebar}><RailSection stretch="list"><SessionTree now={Date.now()} /></RailSection></StoreProvider></div></Frame>
      <AgentsPane id="subagent-flow-agents" title="Agents panel — who ran when" sessionKey={SUBAGENT_FLOW_KEYS.working} />
      <AgentsPane id="subagent-flow-agents-finished" title="Agents panel — all finished" sessionKey={SUBAGENT_FLOW_KEYS.finished} />
    </div>
  </main>
}

export const SubagentFlowFrames = () => {
  const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
  const store = useMemo(() => subagentFlowStore(theme), [theme])
  const sidebar = useMemo(() => subagentFlowSidebarStore(theme), [theme])
  return <StoreProvider store={store}><SubagentFlowPanes sidebar={sidebar} /></StoreProvider>
}

// ---------------------------------------------------------------- the pattern alone

const CHILDREN: readonly AgentFlowChild[] = [
  { id: 'trace', name: 'Trace the retry', role: 'explorer', phase: 'done', phaseWord: 'Done', prompt: 'Read the checkout retry path and say where the second attempt starts.', facts: 'sol · 1m 52s · 18.4K tokens', onOpen: () => {} },
  { id: 'a', name: 'Provider A check', role: 'worker', phase: 'working', phaseWord: 'Working', prompt: 'Run the retry tests against provider A.', facts: 'sol · 4m 8s · 9.2K tokens', onOpen: () => {} },
  { id: 'b', name: 'Provider B check — a long name that has to give way to its facts', role: 'worker', phase: 'working', phaseWord: 'Working', facts: 'sol · 4m 6s', onOpen: () => {} },
]
const FINISHED_CHILDREN: readonly AgentFlowChild[] = [
  { id: 'r1', name: 'Accessibility review', role: 'reviewer', phase: 'done', phaseWord: 'Done', facts: '3m 8s · 31K tokens' },
  { id: 'r2', name: 'Performance review', role: 'reviewer', phase: 'failed', phaseWord: 'Failed', facts: '58s · 12.5K tokens' },
  { id: 'r3', name: 'Copy review', phase: 'stopped', phaseWord: 'Stopped', facts: '12s' },
]
const T0 = 0
const LANES: readonly AgentLane[] = [
  { id: 'trace', name: 'Trace the retry', phase: 'done', phaseWord: 'Done · 1m 52s', start: T0, end: T0 + 121_000, onPick: () => {} },
  { id: 'a', name: 'Provider A check', phase: 'working', phaseWord: 'Working · 4m 8s', start: T0 + 4_000, end: T0 + 252_000, onPick: () => {} },
  { id: 'b', name: 'Provider B check', phase: 'working', phaseWord: 'Working · 4m 6s', start: T0 + 6_000, end: T0 + 252_000 },
  { id: 'c', name: 'Lint', phase: 'failed', phaseWord: 'Failed · 2s', start: T0 + 30_000, end: T0 + 32_000 },
]

/** The pattern with every phase, a long name, a fan-in line and a clock: `AgentFlow` on the explorer. */
export const AgentFlowBoard = () => (
  <div className="flex max-w-2xl flex-col gap-8">
    <section data-catalog-state="working" className="flex flex-col gap-2">
      <Text role="section">Started three; the agent waits on two</Text>
      <AgentFlowCard title="Started 3 sub-agents" summary={['2 working', '1 done']} facts="4m 12s · 33.7K tokens" working trouble={false} waiting="Waiting for 2 agents" children={CHILDREN} />
    </section>
    <section data-catalog-state="default" className="flex flex-col gap-2">
      <Text role="section">All finished: done, failed and stopped</Text>
      <AgentFlowCard title="Started 3 sub-agents" summary={['1 done', '1 failed', '1 stopped']} facts="3m 8s · 43.5K tokens" working={false} trouble children={FINISHED_CHILDREN} />
    </section>
    <section data-catalog-state="populated" className="flex flex-col gap-2">
      <Text role="section">Who ran when, on one clock</Text>
      <AgentLanes lanes={LANES} from={T0} to={T0 + 252_000} startLabel="0s" endLabel="4m 12s · now" />
    </section>
  </div>
)
