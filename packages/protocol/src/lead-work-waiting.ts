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
 * One name for a Team. A Team is known by its goal's id (what the ledger links, what the desk summary lists and what
 * opens it) and by the room its board is (what the Lead's tools and its replies call it). Every comparison between two
 * Team ids goes through this, so the two names never count as two Teams. An id no goal claims is returned as it is.
 */
export const leadTeamKey = (teams: Iterable<{ readonly goal: string; readonly room?: string | null }>): (id: string) => string => {
  const rooms = new Map<string, string>()
  for (const team of teams) if (team.room && team.room !== team.goal) rooms.set(team.room, team.goal)
  return id => rooms.get(id) ?? id
}

/**
 * The Teams and chats the inbox counts as needing the person that no open item on the board already stands for. The
 * Lead's header counts what the inbox counts, so listing these under Needs you keeps the header and the Work list in
 * agreement whoever started the work: the Lead, the person or a trigger. Closed items do not hide anything: work that
 * once touched a Team says nothing about what the Team waits on now. A Team is compared, and listed, by `teamOf`.
 */
export const leadWorkWaiting = (board: LeadWorkBoard | null | undefined, inbox: LeadInbox | null | undefined, teamOf: (id: string) => string = id => id): readonly LeadWorkWaiting[] => {
  const open = (board?.items ?? []).filter(card => card.closedAt === undefined)
  const held = new Set([...open.flatMap(card => card.links.chats.map(chat => `chat:${chat}`)), ...open.flatMap(card => card.links.teams.map(team => `team:${teamOf(team)}`))])
  const listed = new Set<string>()
  return (inbox?.items ?? []).flatMap((item): LeadWorkWaiting[] => {
    if (!item.needsYou || (item.kind !== 'team' && item.kind !== 'chat') || !item.target) return []
    const id = item.kind === 'team' ? teamOf(item.target) : item.target, key = `${item.kind}:${id}`
    if (held.has(key) || listed.has(key)) return []
    listed.add(key)
    return [{ kind: item.kind, id, title: item.title, ...(item.project ? { project: item.project } : {}), at: item.at }]
  })
}

/** What the Work list's badge counts, on the desktop and the phone alike: the open items and the waiting rows beside them. */
export const leadWorkOpenCount = (board: LeadWorkBoard | null | undefined, waiting: readonly LeadWorkWaiting[]): number =>
  (board?.items ?? []).filter(card => card.closedAt === undefined).length + waiting.length
