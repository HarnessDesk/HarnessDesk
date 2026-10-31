import { useSyncExternalStore } from 'react'
import { leadDisplayName, type RuntimeId, type SessionId } from '@harnessdesk/protocol'

import { ComposerNotice } from '../design'
import { useStore } from '../state/context'
import { useLeadName } from './use-lead-name'

/**
 * Who directs this chat, when the Lead has written to it. The host enforces
 * the hold; this only says which way it stands and offers the one switch.
 * Nothing renders for a chat the Lead never touched.
 */
const noLeadSubscription = () => () => {}

export const LeadChatNotice = ({ runtime, sessionId }: { runtime: RuntimeId; sessionId: SessionId }) => {
  const store = useStore()
  const chosenName = useLeadName()
  const name = chosenName ? leadDisplayName(chosenName) : 'Lead'
  const id = `${runtime}:${sessionId}`
  const holder = useSyncExternalStore(store.lead?.subscribe ?? noLeadSubscription, () => store.lead?.state.chats.find(chat => chat.id === id)?.holder ?? null)
  if (!holder) return null
  return holder === 'lead'
    ? <ComposerNotice message={{ id: `lead-chat-${id}`, tone: 'info', title: `${name} is managing this chat.`, action: { label: 'Take over', onSelect: () => void store.lead.takeOverChat(id).catch(() => {}) } }} />
    : <ComposerNotice message={{ id: `lead-chat-${id}`, tone: 'neutral', title: 'You have this chat.', action: { label: `Hand back to ${name}`, onSelect: () => void store.lead.handBackChat(id).catch(() => {}) } }} />
}
