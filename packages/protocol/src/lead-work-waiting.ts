import type { LeadInbox } from './lead-inbox.js'
import type { LeadWorkBoard } from './lead-work.js'

/** A Team or chat that needs the person and no open item of the Lead's work holds: the Work list names it under Needs you. */
export interface LeadWorkWaiting {
  readonly kind: 'team' | 'chat'
  /** What opens it: a Team's id, or a chat's `runtime:session`. */
  readonly id: string
  /** Untrusted: the Team's sentence or the chat's title, scrubbed by the desk and drawn as plain text. */
  readonly title: string
  /** A project's folder name, never a path. */
  readonly project?: string
  readonly at: number
}

/**
 * The Teams and chats the inbox counts as needing the person that no open item on the board already stands for. The
 * Lead's header counts what the inbox counts, so listing these under Needs you keeps the header and the Work list in
 * agreement whoever started the work: the Lead, the person or a trigger. Closed items do not hide anything: work that
 * once touched a Team says nothing about what the Team waits on now.
 */
export const leadWorkWaiting = (board: LeadWorkBoard | null | undefined, inbox: LeadInbox | null | undefined): readonly LeadWorkWaiting[] => {
  const held = new Set((board?.items ?? []).filter(card => card.closedAt === undefined).flatMap(card => [...card.links.chats, ...card.links.teams]))
  return (inbox?.items ?? []).flatMap((item): LeadWorkWaiting[] => {
    if (!item.needsYou || (item.kind !== 'team' && item.kind !== 'chat') || !item.target || held.has(item.target)) return []
    return [{ kind: item.kind, id: item.target, title: item.title, ...(item.project ? { project: item.project } : {}), at: item.at }]
  })
}
