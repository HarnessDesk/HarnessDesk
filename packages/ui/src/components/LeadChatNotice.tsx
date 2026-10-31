import { useEffect, useState, useSyncExternalStore } from 'react'
import { leadDisplayName, type RuntimeId, type SessionId } from '@harnessdesk/protocol'

import { ActionError, ComposerNotice, ConfirmDialog, Text } from '../design'
import { useStore } from '../state/context'
import { useLeadName } from './use-lead-name'

const noLeadSubscription = () => () => {}

/** Button-only control of a Lead-managed chat, with explicit recovery of an unreadable record. */
export const LeadChatNotice = ({ runtime, sessionId }: { runtime: RuntimeId; sessionId: SessionId }) => {
  const store = useStore()
  const chosenName = useLeadName()
  const name = chosenName ? leadDisplayName(chosenName) : 'Lead'
  const id = `${runtime}:${sessionId}`
  const holder = useSyncExternalStore(store.lead?.subscribe ?? noLeadSubscription, () => store.lead?.state.chats.find(chat => chat.id === id)?.holder ?? null)
  const problem = useSyncExternalStore(store.lead?.subscribe ?? noLeadSubscription, () => store.lead?.state.chatControlProblem ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [confirmReset, setConfirmReset] = useState(false)
  useEffect(() => { setError(null); setConfirmReset(false) }, [id])
  useEffect(() => { if (problem?.kind !== 'invalid') setConfirmReset(false) }, [problem?.kind])
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setError(null); setBusy(true)
    try { await work(); setConfirmReset(false) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  if (!holder && problem?.kind !== 'invalid') return null
  return <>
    {problem?.kind === 'unavailable' && <ComposerNotice message={{ id: `lead-chat-project-${id}`, tone: 'warning', title: 'Lead project folder needs attention.', body: problem.message,
      action: { label: 'Try again', onSelect: () => void run(() => store.lead.readChatControl()) } }} />}
    {problem?.kind === 'transient' && <ComposerNotice message={{ id: `lead-chat-retry-${id}`, tone: 'neutral', title: 'Lead chat control could not be read.', body: problem.message,
      action: { label: 'Try again', onSelect: () => void run(() => store.lead.readChatControl()) } }} />}
    {problem?.kind === 'invalid'
      ? <ComposerNotice message={{ id: `lead-chat-${id}`, tone: 'warning', title: 'Lead chat control is unavailable.', body: problem.message,
        action: { label: 'Reset chat control', onSelect: () => { if (!busy) { setError(null); setConfirmReset(true) } } } }} />
      : holder === 'lead'
        ? <ComposerNotice message={{ id: `lead-chat-${id}`, tone: 'info', title: `${name} is managing this chat.`, action: { label: 'Take over', onSelect: () => void run(() => store.lead.takeOverChat(id)) } }} />
        : holder === 'person' ? <ComposerNotice message={{ id: `lead-chat-${id}`, tone: 'neutral', title: 'You have this chat.', action: { label: `Hand back to ${name}`, onSelect: () => void run(() => store.lead.handBackChat(id)) } }} /> : null}
    {error && !confirmReset && <ActionError>{error}</ActionError>}
    {confirmReset && problem?.kind === 'invalid' && <ConfirmDialog title="Reset chat control?" confirmLabel="Reset chat control" tone="destructive" busy={busy}
      onConfirm={() => { if (store.lead.state.chatControlProblem?.kind === 'invalid') void run(() => store.lead.resetChatControl()) }} onCancel={() => setConfirmReset(false)}>
      <Text role="prose">Clears the Lead chat control record for all projects, including person holds and verified message labels. The Lead can manage these chats again.</Text>
      {error && <ActionError>{error}</ActionError>}
    </ConfirmDialog>}
  </>
}
