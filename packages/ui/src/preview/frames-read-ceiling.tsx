import { useMemo } from 'react'
import type { Session } from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { Frame } from './main'
import { previewStore } from './harness'
import { SIDE_BY_SIDE_KEYS, sideBySideStore } from './side-by-side-fixture'

const ReadCeilingConversation = () => {
  useTheme()
  const key = SIDE_BY_SIDE_KEYS[0]!
  return <main className="p-4">
    <Frame id="read-ceiling-conversation" title="Asked read seat — refused tool">
      <div className="h-[820px]">
        <PaneProvider scope={{ paneId: 'read-ceiling-preview' as never, view: { kind: 'conversation', session: key }, sessionKey: key }}>
          <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
        </PaneProvider>
      </div>
    </Frame>
  </main>
}

/** The real notice row, with placeholder data and the previous silent refusal. */
export const ReadCeilingFrames = () => {
  const store = useMemo(() => {
    const query = new URLSearchParams(window.location.search)
    const snapshot = sideBySideStore({ noGoal: true }).getSnapshot()
    const key = SIDE_BY_SIDE_KEYS[0]!
    const session = snapshot.sessions.get(key)!
    const items: Session['turns'][number]['items'] = [
      { id: 'read-ceiling-user' as never, type: 'userMessage', content: [{ type: 'text', text: 'Review the client and report what you find.' }] },
      { id: 'read-ceiling-tool' as never, type: 'toolCall', tool: 'Edit', source: { kind: 'builtin' }, status: 'failed', args: { file_path: '/workspace/demo/client.ts' }, error: 'Tool was denied.' },
      ...(query.get('read-ceiling') === 'before' ? [] : [
        { id: 'read-ceiling-notice' as never, type: 'notice' as const, text: 'Edit was refused by the Read only ceiling.' },
      ]),
      { id: 'read-ceiling-answer' as never, type: 'assistantMessage', phase: 'final', text: 'The tool was denied. I’ll continue reviewing the client.' },
    ]
    const sessions = new Map(snapshot.sessions)
    sessions.set(key, {
      ...session, cwd: '/workspace/demo', title: 'Review the client', status: { type: 'idle' },
      settings: { ...session.settings, cwd: '/workspace/demo', model: session.settings?.model ?? 'model-a', ceiling: { level: 'read', hold: 'asked' } },
      turns: [{ id: 'read-ceiling-turn' as never, status: 'completed', items }],
    })
    return previewStore({ ...snapshot, sessions, theme: query.get('theme') === 'dark' ? 'dark' : 'light' })
  }, [])
  return <StoreProvider store={store}><ReadCeilingConversation /></StoreProvider>
}
