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
  const fixture = useMemo(() => createLeadChatFixture(query.get('lead-chat') === 'person' ? 'person' : 'lead', query.get('theme') === 'dark' ? 'dark' : 'light', query.get('scenario') === 'offline' ? 'offline' : query.get('scenario') === 'unreadable' ? 'unreadable' : query.get('scenario') === 'read-error' ? 'read-error' : query.get('scenario') === 'replay' ? 'replay' : query.get('scenario') === 'interrupted' ? 'interrupted' : 'normal'), [])
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
    <Frame id="lead-trigger-notice" title="Lead · a goal a trigger opened">
      <LeadHostNotice message={{ version: 1, id: 'preview-trigger-notice', revision: 1, role: 'notice', text: 'Request on pull request #12 from a collaborator (write access)',
        trigger: { source: 'pull-request', event: 'mentioned', subject: 'acme/storefront#12', from: 'collaborator', words: 'Can the Lead look at the failing checkout test?', url: 'https://github.com/acme/storefront/pull/12' } }} />
    </Frame>
  </StoreProvider>
}

export const LeadChatFrames = () => <LeadChatConversation />
