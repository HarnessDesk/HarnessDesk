import { useMemo } from 'react'
import {
  CARRY_ON_PHASES,
  runtimeId,
  sessionKey,
  type AgentItem,
  type CarryOnItem,
  type Session,
  type SessionId,
  type SessionKey,
  type Turn,
} from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { ItemView } from '../components/Items'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { previewStore } from './harness'
import { Frame } from './main'
import { previewSession } from './sidebar-fixture'

/**
 * A conversation carried on past a usage limit, on the real transcript.
 *
 * `?carry-on` draws three conversations — a switch to another account of the
 * same agent, the old side of a handoff to another agent and its new side —
 * and every phase of the marker on its own. Accounts are nicknames ("work",
 * "personal"), which is all the marker ever carries; no email reaches it.
 */
const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude')
export const CARRY_ON_KEYS = {
  switched: sessionKey(CODEX, 'carry-on-switch' as SessionId),
  left: sessionKey(CODEX, 'carry-on-left' as SessionId),
  arrived: sessionKey(CLAUDE, 'carry-on-arrived' as SessionId),
} as const

const at = (minutes: number): number => Date.now() + minutes * 60_000
/** A reset later today, on the hour's quarter, so the frame reads like a real one. */
const RESET = (() => { const date = new Date(at(150)); date.setMinutes(Math.floor(date.getMinutes() / 15) * 15, 0, 0); return date.getTime() })()

const user = (id: string, text: string): AgentItem => ({ id: id as never, type: 'userMessage', content: [{ type: 'text', text }] })
const answer = (id: string, text: string): AgentItem => ({ id: id as never, type: 'assistantMessage', phase: 'final', text })
const command = (id: string, line: string, exitCode = 0): AgentItem =>
  ({ id: id as never, type: 'command', command: line, cwd: '/workspace/storefront', origin: 'agent', status: exitCode === 0 ? 'completed' : 'failed', actions: [], output: '', exitCode, durationMs: 4_200 })
const marker = (id: string, fields: Omit<CarryOnItem, 'id' | 'type'>): CarryOnItem => ({ id: id as never, type: 'carryOn', ...fields })

/* The preview's own agent names, as every public frame uses (rule 8 holds for fixtures too). */
const WORK = { name: 'Alpha', account: 'work', model: 'Model A' }
const PERSONAL = { name: 'Alpha', account: 'personal', model: 'Model A' }
const OTHER_AGENT = { name: 'Beta', model: 'Model B' }

const ASK = 'Make the checkout client retry a 502 before giving up.'
const COVER = 'Now cover the final failed attempt in the tests.'
const LIMIT = { message: 'You have reached your usage limit. It resets later today.', code: 'credits' } as const

const before = (prefix: string): Turn[] => [
  { id: `${prefix}-1` as never, status: 'completed', items: [user(`${prefix}-1u`, ASK), command(`${prefix}-1c`, 'pnpm test checkout'), answer(`${prefix}-1a`, 'The client now retries a 502 up to three times with a growing pause; the existing tests pass.')] },
  { id: `${prefix}-2` as never, status: 'failed', error: LIMIT, items: [user(`${prefix}-2u`, COVER), command(`${prefix}-2c`, 'pnpm test checkout --run')] },
]

const conversation = (base: Session, key: SessionKey, title: string, turns: Turn[]): Session => {
  const [runtime, id] = key.split('\u0000') as [string, string]
  return {
    ...base, id: id as SessionId, runtime: runtimeId(runtime), title, cwd: '/workspace/storefront', goal: null, status: { type: 'idle' },
    git: { ...base.git, branch: 'fix/checkout-retry' }, settings: { ...base.settings, model: runtime === CLAUDE ? 'opus' : 'sol', cwd: '/workspace/storefront' } as Session['settings'], turns, itemsLoaded: true,
  }
}

/** The store under all three conversations, with the conversation turns the marker sits between. */
export const carryOnStore = (theme: 'light' | 'dark' = 'light') => {
  const base = previewSession as unknown as Session
  const sessions = new Map(previewStore().getSnapshot().sessions)
  const switched = before('sw')
  switched[1] = { ...switched[1]!, items: [...switched[1]!.items] }
  sessions.set(CARRY_ON_KEYS.switched, conversation(base, CARRY_ON_KEYS.switched, 'Retry the checkout call', [
    ...switched,
    { id: 'sw-3' as never, status: 'completed', items: [
      user('sw-3u', 'Continue from where you stopped.'),
      marker('sw-3m', { phase: 'switched', cause: 'credits', mode: 'sameThread', from: WORK, to: PERSONAL, resetsAt: RESET }),
      command('sw-3c', 'pnpm test checkout --run'),
      answer('sw-3a', 'Added a case where all three attempts return 502: the caller gets the last response and no fourth request is sent.'),
    ] },
  ]))
  const left = before('lf')
  left[1] = { ...left[1]!, items: [...left[1]!.items, marker('lf-m', { phase: 'left', cause: 'credits', mode: 'handoff', from: WORK, to: OTHER_AGENT, resetsAt: RESET, link: { runtime: CLAUDE, sessionId: 'carry-on-arrived' as SessionId } })] }
  sessions.set(CARRY_ON_KEYS.left, conversation(base, CARRY_ON_KEYS.left, 'Retry the checkout call', left))
  sessions.set(CARRY_ON_KEYS.arrived, conversation(base, CARRY_ON_KEYS.arrived, 'Retry the checkout call', [
    { id: 'ar-1' as never, status: 'completed', items: [
      marker('ar-m', { phase: 'arrived', cause: 'credits', mode: 'handoff', from: WORK, to: OTHER_AGENT, resetsAt: RESET, link: { runtime: CODEX, sessionId: 'carry-on-left' as SessionId } }),
      user('ar-u', COVER),
      command('ar-c', 'git status --short'),
      answer('ar-a', 'The retry change is in the working tree. I added the final-attempt case; all checkout tests pass.'),
    ] },
  ]))
  return previewStore({ sessions: sessions as never, theme })
}

const PHASE_ITEMS: readonly CarryOnItem[] = CARRY_ON_PHASES.map((phase) => marker(`phase-${phase}`, {
  phase,
  cause: phase === 'stopped' ? 'rateLimit' : 'credits',
  from: WORK,
  ...(phase === 'switched' ? { to: { ...PERSONAL, model: 'Model A Mini' }, note: 'Model A is not on this account; using Model A Mini' } : {}),
  ...(phase === 'left' || phase === 'arrived' ? { to: OTHER_AGENT, link: { runtime: phase === 'left' ? CLAUDE : CODEX, sessionId: 'carry-on-other' as SessionId } } : {}),
  // The notes as the host writes them: phrases, which the marker reads as sentences.
  ...(phase === 'stopped' ? { note: 'stopped at the person’s answer' } : { resetsAt: RESET }),
  ...(phase === 'exhausted' ? { note: 'no other account or agent has room' } : {}),
}))

/* The ways a stop reads: the person's answer, no reset known, and a move that found the conversation in use elsewhere. */
const STOPPED_ITEMS: readonly CarryOnItem[] = [
  marker('stopped-answer', { phase: 'stopped', cause: 'credits', from: WORK, resetsAt: RESET, note: 'stopped at the person’s answer' }),
  marker('stopped-no-reset', { phase: 'stopped', cause: 'credits', from: WORK, note: 'no reset time known' }),
  marker('stopped-open', {
    phase: 'stopped', cause: 'credits', mode: 'sameThread', from: WORK, to: PERSONAL, resetsAt: RESET,
    note: 'The person’s message went first. The conversation is also open on Alpha · personal, where it was in use.',
    link: { runtime: CODEX, sessionId: 'carry-on-switch' as SessionId },
  }),
]

const ConversationPane = ({ id, title, sessionKey: key }: { id: string; title: string; sessionKey: SessionKey }) => (
  <Frame id={id} title={title}>
    <div className="h-[760px]">
      <PaneProvider scope={{ paneId: `${id}-pane` as never, view: { kind: 'conversation', session: key }, sessionKey: key }}>
        <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
      </PaneProvider>
    </div>
  </Frame>
)

const CarryOnPanes = () => {
  useTheme()
  return <main className="grid gap-4 p-4">
    <ConversationPane id="carry-on-switched" title="Carry on — another account of the same agent" sessionKey={CARRY_ON_KEYS.switched} />
    <ConversationPane id="carry-on-left" title="Carry on — handed to another agent (the old conversation)" sessionKey={CARRY_ON_KEYS.left} />
    <ConversationPane id="carry-on-arrived" title="Carry on — handed to another agent (the new conversation)" sessionKey={CARRY_ON_KEYS.arrived} />
    <Frame id="carry-on-phases" title="Carry on — every phase of the marker">
      <div className="mx-auto grid max-w-[720px] gap-6 p-6">
        {PHASE_ITEMS.map((item) => <ItemView key={item.id} item={item} />)}
      </div>
    </Frame>
    <Frame id="carry-on-stopped" title="Carry on — how a stop reads">
      <div className="mx-auto grid max-w-[720px] gap-6 p-6">
        {STOPPED_ITEMS.map((item) => <ItemView key={item.id} item={item} />)}
      </div>
    </Frame>
  </main>
}

export const CarryOnFrames = () => {
  const store = useMemo(() => carryOnStore(new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'), [])
  return <StoreProvider store={store}><CarryOnPanes /></StoreProvider>
}
