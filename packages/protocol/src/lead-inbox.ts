/**
 * The person's inbox as the desk derives it: what waits on them, and the notices it has kept for them to read. The
 * desktop's bell and the phone's Inbox tab both list this one projection, so the two never disagree about what is in
 * it or how many things need the person.
 */

/** Where an item comes from. `lead` is the Lead itself waiting; `ask` is a question it asked with options. */
export type LeadInboxKind = 'lead' | 'ask' | 'chat' | 'team' | 'notice'

export interface LeadInboxItem {
  /** Stable across reads: `lead`, `ask:<message>`, `chat:<runtime:session>`, `team:<goal>`, `notice:<kept id>`. */
  readonly id: string
  readonly kind: LeadInboxKind
  /** Untrusted titles (a chat's, a Team's sentence) are scrubbed by the desk and drawn as plain text. */
  readonly title: string
  /** For `lead`, the host's `stageReason` slug, never model text; for a notice, its body. */
  readonly detail?: string
  /** A project's folder name, never a path. */
  readonly project?: string
  readonly at: number
  /** It waits on the person and is counted. A notice is kept to read and never counted. */
  readonly needsYou: boolean
  /** A notice's read state, the same one the desktop's bell keeps. */
  readonly read?: boolean
  /** What to open: the Lead's message for an ask, the chat or Team id for work. */
  readonly target?: string
}

export interface LeadInbox {
  readonly version: 1
  /** How many items need the person: the one count every surface shows. */
  readonly needsYou: number
  /** Needs-you items first, newest first; then kept notices, newest first. */
  readonly items: readonly LeadInboxItem[]
}

/** At most this many needs-you items and this many notices are listed. */
export const LEAD_INBOX_LIMIT = 40
