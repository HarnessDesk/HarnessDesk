import { useMemo } from 'react'
import { runtimeId, sessionKey, type AgentItem, type Session, type SessionId, type SessionKey, type Turn } from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { PaneProvider, StoreProvider } from '../state/context'
import { draftsOf } from '../state/drafts'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { previewStore } from './harness'
import { Frame } from './main'
import { previewSession } from './sidebar-fixture'

/**
 * A conversation whose own turn is over while the sub-agents it started are
 * still working, on the real transcript and composer.
 *
 * `?idle-stop` draws it twice: with an empty field, where Stop stands alone
 * in Send's corner, and with a message typed, where Send (which sends at
 * once — nothing is running to queue behind) sits beside Stop. The adapter's
 * `subagentsRunning` on the idle status is what keeps Stop up; here the
 * fixture sets it, as `docs/decisions.md` (Stop reaches sub-agents that
 * outlast the turn) describes the host doing.
 */
const CODEX = runtimeId('codex')
export const IDLE_STOP_KEYS = {
  empty: sessionKey(CODEX, 'idle-stop-empty' as SessionId),
  typed: sessionKey(CODEX, 'idle-stop-typed' as SessionId),
} as const

const ASK = 'Check the checkout retry against both payment providers.'
const user = (id: string, text: string): AgentItem => ({ id: id as never, type: 'userMessage', content: [{ type: 'text', text }] })
const answer = (id: string, text: string): AgentItem => ({ id: id as never, type: 'assistantMessage', phase: 'final', text })

const turns = (prefix: string): Turn[] => [{
  id: `${prefix}-1` as never,
  status: 'completed',
  items: [
    user(`${prefix}-1u`, ASK),
    {
      id: `${prefix}-1s` as never, type: 'subagent', action: 'spawn', status: 'completed',
      prompt: 'Run the retry tests against one payment provider and report what fails.',
      members: [
        { sessionId: `${prefix}-child-a`, nickname: 'Provider A check', role: 'Test', state: 'running' },
        { sessionId: `${prefix}-child-b`, nickname: 'Provider B check', role: 'Test', state: 'running' },
      ],
    },
    answer(`${prefix}-1a`, 'Two sub-agents are checking the providers. I will report when both are done.'),
  ],
}]

const conversation = (base: Session, key: SessionKey): Session => {
  const id = key.split('\u0000')[1] as SessionId
  return {
    ...base, id, runtime: CODEX, title: 'Checkout retry', cwd: '/workspace/storefront', goal: null,
    status: { type: 'idle', subagentsRunning: true },
    git: { ...base.git, branch: 'fix/checkout-retry' },
    settings: { ...base.settings, model: 'sol', cwd: '/workspace/storefront' } as Session['settings'],
    turns: turns(id), itemsLoaded: true,
  }
}

/** Both conversations, and the typed one's draft, which the composer reads as it mounts. */
export const idleStopStore = (theme: 'light' | 'dark' = 'light') => {
  const base = previewSession as unknown as Session
  const sessions = new Map(previewStore().getSnapshot().sessions)
  sessions.set(IDLE_STOP_KEYS.empty, conversation(base, IDLE_STOP_KEYS.empty))
  sessions.set(IDLE_STOP_KEYS.typed, conversation(base, IDLE_STOP_KEYS.typed))
  const store = previewStore({ sessions: sessions as never, theme })
  draftsOf(store).setLive(IDLE_STOP_KEYS.typed, { text: 'Also try a timeout instead of a 502.', attachments: [] })
  return store
}

const ConversationPane = ({ id, title, sessionKey: key }: { id: string; title: string; sessionKey: SessionKey }) => (
  <Frame id={id} title={title}>
    <div className="h-[560px]">
      <PaneProvider scope={{ paneId: `${id}-pane` as never, view: { kind: 'conversation', session: key }, sessionKey: key }}>
        <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
      </PaneProvider>
    </div>
  </Frame>
)

const IdleStopPanes = () => {
  useTheme()
  return <main className="grid gap-4 p-4">
    <ConversationPane id="idle-stop-subagents" title="Composer — the turn is over, its sub-agents are not" sessionKey={IDLE_STOP_KEYS.empty} />
    <ConversationPane id="idle-stop-typed" title="Composer — a message typed while sub-agents work" sessionKey={IDLE_STOP_KEYS.typed} />
  </main>
}

export const IdleStopFrames = () => {
  const store = useMemo(() => idleStopStore(new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'), [])
  return <StoreProvider store={store}><IdleStopPanes /></StoreProvider>
}
