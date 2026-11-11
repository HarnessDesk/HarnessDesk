import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { runtimeId, sessionId, type LeadInbox, type LeadInboxItem } from '@harnessdesk/protocol'
import type { InboxWaiting } from '../design'
import { useSnapshot, useStore } from '../state/context'
import type { AppStore } from '../state/store'
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
    const place = item.project ? sanitizeText(item.project) : undefined
    return { id: item.id, title: sanitizeText(item.title), ...(place ? { place } : {}), ...(onOpen ? { onOpen } : {}) }
  })

/** How long a burst of desk changes is let settle before the inbox is read again, and the slowest it is read. */
const SETTLE_MS = 400
const EVERY_MS = 30_000

/** One read of the desk's inbox per store, shared by every surface that shows it, so the bell and the Lead's word read
 * the same answer at the same moment. */
interface Shared { inbox: LeadInbox | null; readonly listeners: Set<() => void>; users: number; soon?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }
const shared = new WeakMap<object, Shared>()
const entry = (store: AppStore): Shared => {
  let found = shared.get(store)
  if (!found) shared.set(store, found = { inbox: null, listeners: new Set(), users: 0 })
  return found
}
const read = (store: AppStore, one: Shared) => {
  // A store without a transport (a window still connecting, a test's partial store) reads nothing.
  const transport = store.transport
  if (!one.users || typeof transport?.request !== 'function') return
  void Promise.resolve().then(() => transport.request('lead/inbox/read', {})).then(next => {
    if (!one.users) return
    one.inbox = next
    for (const listener of one.listeners) listener()
  }).catch(() => {})
}
const noLead = () => () => {}

/**
 * What waits on the person, read from the desk (`lead/inbox/read`): the same inbox the phone lists. Read again when the
 * Lead, a Team or a conversation changes, and every half minute besides; a desk that cannot answer leaves the last
 * answer in place. Null until the desk has answered.
 */
export const useLeadInbox = (): LeadInbox | null => {
  const store = useStore(), snapshot = useSnapshot(), one = entry(store)
  const lead = useSyncExternalStore(store.lead?.subscribe ?? noLead, () => store.lead?.state)
  const inbox = useSyncExternalStore(listener => { one.listeners.add(listener); return () => { one.listeners.delete(listener) } }, () => one.inbox)
  useEffect(() => {
    one.users++
    if (one.users === 1) one.every = setInterval(() => read(store, one), EVERY_MS)
    return () => {
      one.users--
      if (!one.users) { clearInterval(one.every); clearTimeout(one.soon) }
    }
  }, [store, one])
  // What became of each question moves the inbox too: an answer from the phone is recorded before the thread moves.
  const changed = [lead?.revision, lead?.stage, lead?.personActions?.length, lead?.away?.asks, snapshot.goals, snapshot.teams, snapshot.sessions?.size, snapshot.inbox] as const
  useEffect(() => {
    clearTimeout(one.soon)
    one.soon = setTimeout(() => read(store, one), SETTLE_MS)
  }, [store, one, ...changed]) // eslint-disable-line react-hooks/exhaustive-deps
  return inbox
}

/** The bell's needs-you rows and the one count the desk gives for them. */
export const useInboxWaiting = (): { readonly rows: readonly InboxWaiting[]; readonly needs: number } => {
  const store = useStore(), inbox = useLeadInbox()
  return useMemo(() => ({
    rows: inboxWaiting(inbox, {
      lead: () => store.openDestination({ kind: 'lead' }),
      team: id => store.openGoal(id),
      chat: (runtime, session) => { void store.openSession(sessionId(session), { runtime: runtimeId(runtime) }) },
    }),
    needs: inbox?.needsYou ?? 0,
  }), [inbox, store])
}
