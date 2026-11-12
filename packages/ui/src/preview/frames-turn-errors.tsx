import { useMemo } from 'react'
import { runtimeId, sessionKey, type AgentItem, type RuntimeInfo, type Session, type SessionId, type Turn, type TurnError } from '@harnessdesk/protocol'

import { Conversation } from '../components/Conversation'
import { TurnTail } from '../components/TurnTail'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { previewPrimaryRuntime, previewStore } from './harness'
import { Frame } from './main'
import { previewSession } from './sidebar-fixture'

/**
 * A failed turn and the one remedy beside it, on the real transcript.
 *
 * `?turn-errors` draws a conversation whose last turn was refused for want of
 * a sign-in, then every kind of failure the adapters name, each with the
 * action it gets (or none). The agent is the preview's own Alpha, signed in
 * to an account and metered, so every door is open.
 */
const ALPHA = runtimeId('codex')
const KEY = sessionKey(ALPHA, 'turn-errors' as SessionId)

const user = (id: string, text: string): AgentItem => ({ id: id as never, type: 'userMessage', content: [{ type: 'text', text }] })
const answer = (id: string, text: string): AgentItem => ({ id: id as never, type: 'assistantMessage', phase: 'final', text })

const ASK = 'Make the checkout client retry a 502 before giving up.'

const CASES: readonly (readonly [string, TurnError])[] = [
  ['auth', { message: 'Authentication required. Sign in again to continue.', code: 'auth' }],
  ['credits', { message: 'You have reached your usage limit. It resets later today.', code: 'credits' }],
  ['rateLimit', { message: 'Too many requests. Wait a moment, then send again.', code: 'rateLimit' }],
  ['versionGate', { message: 'This model requires a newer version of the agent.', code: 'versionGate' }],
  ['runtimeUnavailable', { message: 'Alpha exited mid-turn.', code: 'runtimeUnavailable' }],
  ['network', { message: 'connect ECONNREFUSED 127.0.0.1:443', code: 'network' }],
  ['unknown', { message: 'Internal error: the model backend timed out.', code: 'unknown' }],
  ['interrupted', { message: 'The turn was interrupted.', code: 'interrupted' }],
  ['sandboxDenied', { message: 'The sandbox denied writing outside the workspace.', code: 'sandboxDenied' }],
  ['retrying', { message: 'Too many requests.', code: 'rateLimit', retrying: true }],
]

const failed = (id: string, error: TurnError): Turn =>
  ({ id: id as never, status: 'failed', error, items: [user(`${id}-u`, ASK)], startedAt: Date.now() - 4_000, completedAt: Date.now(), durationMs: 4_000 })

const turnErrorsStore = (theme: 'light' | 'dark') => {
  const base = previewSession as unknown as Session
  const sessions = new Map(previewStore().getSnapshot().sessions)
  sessions.set(KEY, {
    ...base, id: 'turn-errors' as SessionId, runtime: ALPHA, title: 'Retry the checkout call', cwd: '/workspace/storefront', goal: null,
    status: { type: 'idle' }, itemsLoaded: true,
    turns: [
      { id: 'te-1' as never, status: 'completed', items: [user('te-1u', ASK), answer('te-1a', 'The client now retries a 502 up to three times with a growing pause.')] },
      failed('te-2', CASES[0]![1]),
    ],
  })
  const alpha = { ...previewPrimaryRuntime(), capabilities: { account: true, metered: true } } as unknown as RuntimeInfo
  return previewStore({ sessions: sessions as never, runtimes: [alpha], theme })
}

const TurnErrorPanes = () => {
  useTheme()
  const session = useMemo(() => ({ id: 'tail' as SessionId, runtime: ALPHA, cwd: '/workspace/storefront', usage: null }), [])
  return <main className="grid gap-4 p-4">
    <Frame id="turn-error-conversation" title="A failed turn — refused for a sign-in, in the conversation">
      <div className="h-[520px]">
        <PaneProvider scope={{ paneId: 'turn-errors-pane' as never, view: { kind: 'conversation', session: KEY }, sessionKey: KEY }}>
          <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
        </PaneProvider>
      </div>
    </Frame>
    <Frame id="turn-error-kinds" title="A failed turn — every kind, and the remedy each gets">
      <div className="mx-auto grid max-w-[720px] gap-4 p-6">
        {CASES.map(([name, error]) => {
          const turn = failed(`kind-${name}`, error)
          return <div key={name} data-case={name}>
            <TurnTail turn={turn} session={{ ...session, turns: [turn] } as unknown as Session} />
          </div>
        })}
      </div>
    </Frame>
  </main>
}

export const TurnErrorFrames = () => {
  const store = useMemo(() => turnErrorsStore(new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'), [])
  return <StoreProvider store={store}><TurnErrorPanes /></StoreProvider>
}
