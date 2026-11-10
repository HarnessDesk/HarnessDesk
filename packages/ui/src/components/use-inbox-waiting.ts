import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { runtimeId, sessionId, type LeadInbox, type LeadInboxItem } from '@harnessdesk/protocol'
import type { InboxWaiting } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { sanitizeText } from '../lib/sanitize'

type Opens = {
  readonly lead: () => void
  readonly team: (id: string) => void
  readonly chat: (runtime: string, session: string) => void
}

/** The desk's needs-you rows as the bell lists them. Titles are the desk's, drawn as plain text. */
export const inboxWaiting = (inbox: LeadInbox | null, open: Opens): readonly InboxWaiting[] =>
  (inbox?.items ?? []).filter(item => item.needsYou).map((item: LeadInboxItem) => {
    const target = item.target ?? ''
    const at = target.indexOf(':')
    const onOpen = item.kind === 'lead' || item.kind === 'ask' ? open.lead
      : item.kind === 'team' ? () => open.team(target)
      : item.kind === 'chat' && at > 0 ? () => open.chat(target.slice(0, at), target.slice(at + 1))
      : undefined
    return { id: item.id, title: sanitizeText(item.title), ...(item.project ? { place: sanitizeText(item.project) } : {}), ...(onOpen ? { onOpen } : {}) }
  })

/** How long a burst of desk changes is let settle before the inbox is read again, and the slowest it is read. */
const SETTLE_MS = 400
const EVERY_MS = 30_000

/**
 * What waits on the person, read from the desk (`lead/inbox/read`): the same rows the phone's Inbox lists. Read again
 * when the Lead, a Team or a conversation changes, and every half minute besides; a desk that cannot answer leaves the
 * last rows in place.
 */
export const useInboxWaiting = (): readonly InboxWaiting[] => {
  const store = useStore(), snapshot = useSnapshot()
  const lead = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [inbox, setInbox] = useState<LeadInbox | null>(null)
  const changed = [lead.revision, lead.stage, snapshot.goals, snapshot.teams, snapshot.sessions.size, snapshot.inbox] as const
  useEffect(() => {
    let live = true
    const read = () => { void store.transport.request('lead/inbox/read', {}).then(next => { if (live) setInbox(next) }).catch(() => {}) }
    const soon = setTimeout(read, SETTLE_MS), every = setInterval(read, EVERY_MS)
    return () => { live = false; clearTimeout(soon); clearInterval(every) }
  }, [store, ...changed]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => inboxWaiting(inbox, {
    lead: () => store.openDestination({ kind: 'lead' }),
    team: id => store.openGoal(id),
    chat: (runtime, session) => { void store.openSession(sessionId(session), { runtime: runtimeId(runtime) }) },
  }), [inbox, store])
}
