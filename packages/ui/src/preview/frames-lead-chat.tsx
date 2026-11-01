import { useMemo } from 'react'
import { Conversation } from '../components/Conversation'
import { LeadHostNotice } from '../components/LeadMessage'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { ConversationFrame } from './ConversationFrame'
import { createLeadChatFixture } from './lead-chat-fixture'
import { Frame } from './main'

const FixtureTheme = () => { useTheme(); return null }

const LeadChatConversation = () => {
  const query = new URLSearchParams(window.location.search)
  const fixture = useMemo(() => createLeadChatFixture(query.get('lead-chat') === 'person' ? 'person' : 'lead', query.get('theme') === 'dark' ? 'dark' : 'light', query.get('scenario') === 'offline' ? 'offline' : query.get('scenario') === 'unreadable' ? 'unreadable' : query.get('scenario') === 'read-error' ? 'read-error' : query.get('scenario') === 'replay' ? 'replay' : 'normal'), [])
  return <StoreProvider store={fixture.store}>
    <FixtureTheme />
    <Frame id="lead-chat-conversation" title="Lead message and chat control">
      <div className="flex h-[760px] min-h-0 flex-col">
        <PaneProvider scope={{ paneId: 'lead-chat-preview' as never, view: { kind: 'conversation', session: fixture.key }, sessionKey: fixture.key }}>
          <ConversationFrame><Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /></ConversationFrame>
        </PaneProvider>
      </div>
    </Frame>
    <Frame id="lead-host-notice" title="Lead · saved approval notice">
      <LeadHostNotice message={{ version: 1, id: 'preview-goal-approval-notice', revision: 1, role: 'notice',
        text: 'Allowed under your rule for this goal: /workspace/demo/src/panel.tsx · 3 times' }} />
    </Frame>
  </StoreProvider>
}

export const LeadChatFrames = () => <LeadChatConversation />
