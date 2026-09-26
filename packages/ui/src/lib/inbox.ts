/**
 * The inbox: messages kept until they are cleared.
 *
 * A notice on a surface is about now — it leaves when its condition does. The
 * inbox is for a message worth reading later: a Goal finished overnight, an
 * update that arrived while the window was shut, anything a kind was moved to
 * "Inbox only" for. It lives in host preferences beside the notice policy,
 * never `localStorage`, which this renderer loses on every launch.
 *
 * An entry is words and a time, never a callback: what survives a relaunch
 * has to be data. An action that should survive is named by `open`, a place
 * the app knows how to go (a settings page, a Goal), and resolved when shown.
 */
export type InboxTone = 'neutral' | 'info' | 'warning' | 'danger'

export interface InboxEntry {
  readonly id: string
  /** The notice kind it came from, when it came from one. */
  readonly kind?: string
  readonly tone: InboxTone
  readonly title: string
  readonly body?: string
  readonly at: number
  readonly read: boolean
  /** Somewhere to go about it, as data: `settings:library`, `goal:<id>`. */
  readonly open?: string
  /** The Agent that sent it, when one did: its conversation, and the name it goes by. */
  readonly from?: { readonly runtime: string; readonly sessionId: string; readonly name: string }
  /** A task the sender suggests, offered as "Start as a task". */
  readonly task?: string
}

/** Enough to read back a week of a busy desk; the oldest go first. */
export const INBOX_LIMIT = 100

const TONES: readonly InboxTone[] = ['neutral', 'info', 'warning', 'danger']

const fromOf = (raw: unknown): { from: NonNullable<InboxEntry['from']> } | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const from = raw as Record<string, unknown>
  return typeof from['runtime'] === 'string' && typeof from['sessionId'] === 'string' && typeof from['name'] === 'string'
    ? { from: { runtime: from['runtime'], sessionId: from['sessionId'], name: from['name'] } }
    : null
}

export const readInbox = (raw: unknown): readonly InboxEntry[] => {
  if (!Array.isArray(raw)) return []
  const entries: InboxEntry[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Partial<Record<keyof InboxEntry, unknown>>
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.at !== 'number') continue
    entries.push({
      id: entry.id,
      ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
      tone: TONES.includes(entry.tone as InboxTone) ? (entry.tone as InboxTone) : 'neutral',
      title: entry.title,
      ...(typeof entry.body === 'string' ? { body: entry.body } : {}),
      at: entry.at,
      read: entry.read === true,
      ...(typeof entry.open === 'string' ? { open: entry.open } : {}),
      ...(fromOf(entry.from) ?? {}),
      ...(typeof entry.task === 'string' ? { task: entry.task } : {}),
    })
  }
  return entries.slice(0, INBOX_LIMIT)
}

/**
 * Keeps a message, newest first. The same `id` replaces its earlier copy
 * rather than stacking, and comes back unread: it is news again.
 */
export const kept = (inbox: readonly InboxEntry[], entry: Omit<InboxEntry, 'read'>): readonly InboxEntry[] =>
  [{ ...entry, read: false }, ...inbox.filter((existing) => existing.id !== entry.id)].slice(0, INBOX_LIMIT)

export const markedRead = (inbox: readonly InboxEntry[], id: string | null): readonly InboxEntry[] =>
  inbox.map((entry) => (id === null || entry.id === id ? (entry.read ? entry : { ...entry, read: true }) : entry))

export const unreadCount = (inbox: readonly InboxEntry[]): number => inbox.filter((entry) => !entry.read).length
