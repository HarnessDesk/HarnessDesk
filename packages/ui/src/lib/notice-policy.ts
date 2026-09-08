/**
 * How long a message the app has to make outside the conversation stays gone.
 *
 * Every banner used to remember its own dismissal its own way — one kept a
 * bounded set of window-stamped keys, another wrote a flag per agent — and
 * both kept it in `localStorage`, where nobody could see it or undo it.
 *
 * And where none of it survived a launch. The host binds its HTTP server on
 * port 0, so the renderer's origin is `http://127.0.0.1:<a new port>` every
 * time the app starts, and `localStorage` is per origin: every dismissal the
 * app had ever written was thrown away by the next start. That is why the
 * same banners greeted the user at every launch, and it is why nothing here
 * was worth migrating — there was never anything on the other side to carry
 * over. Anything a dismissal has to outlive a run goes to host preferences,
 * which is where the rest of this file's state lives.
 *
 * (`hd.sidebarWidth`, `hd.detailsWidth` and `hd.otherProjects` are still on
 * `localStorage` and still reset at every launch, for the same reason.)
 *
 * The fix is not a third mechanism. It is one field on the message:
 *
 * - `event` — a toast. It leaves on its own and is never remembered.
 * - `session` — something that is happening now. Dismissing it puts away this
 *   occurrence and nothing more: a dropped connection is news every time it
 *   drops, so it is never written down and never silenceable.
 * - `occurrence` — a condition. Dismissing it puts *this* instance away; it
 *   comes back when the fact is genuinely new, which for a metered lane means
 *   the next reset window.
 * - `once` — an offer. Dismissing it answers the question for good.
 *
 * And one escalation on top, which is what makes this scale past the banners
 * that exist today: a message put away twice has proved it is not news, so the
 * third time its dismiss control also offers to stop showing it. Nothing is
 * added to a card the user has not already ignored twice.
 *
 * Muting is per *kind*, not per instance. "Codex will run out before it
 * refills" and "Cursor will run out before it refills" are one sentence about
 * two agents, and someone tired of the sentence is tired of it. That also
 * keeps the Notifications page a fixed, readable list instead of one that
 * grows a row every time an agent is registered.
 */

export type NoticeLifetime = 'event' | 'session' | 'occurrence' | 'once'

/**
 * What a message is, for the purposes of remembering that it was put away.
 *
 * `key` is this instance — it carries the window, so a dismissal survives the
 * countdown in the sentence moving every minute. `kind` is the same message
 * with the instance stripped, and it is what a mute is about.
 */
export interface NoticeIdentity {
  readonly key: string
  readonly kind: string
  readonly lifetime: NoticeLifetime
}

/** What the user has told the app about one kind of message. */
export interface NoticeRecord {
  /** Times this kind has been put away. Drives the escalation, nothing else. */
  readonly count: number
  /** When that last happened, so the settings page can say how long ago. */
  readonly at: number
}

export interface NoticePolicy {
  /** Kinds the user has told the app to stop showing. */
  readonly muted: readonly string[]
  /** Per kind, how often and how recently it has been put away. */
  readonly records: Readonly<Record<string, NoticeRecord>>
  /**
   * Instances already put away, newest last.
   *
   * Bounded: these are per-window facts and the oldest stopped being true long
   * ago. A few dozen is more than enough to stop a banner nagging without
   * letting the list grow for the life of a machine.
   */
  readonly seen: readonly string[]
}

const SEEN_LIMIT = 40

/**
 * How many times a kind has to be put away before its dismiss control offers
 * to silence it. Two, so the offer only ever appears on the third sighting of
 * something the user has already twice declined to act on.
 */
export const MUTE_AFTER = 2

export const emptyNoticePolicy = (): NoticePolicy => ({ muted: [], records: {}, seen: [] })

const strings = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []

/** Preferences are a file someone can edit; read them the way a parser would. */
export const readNoticePolicy = (raw: unknown): NoticePolicy => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyNoticePolicy()
  const source = raw as Partial<Record<keyof NoticePolicy, unknown>>
  const records: Record<string, NoticeRecord> = {}
  if (typeof source.records === 'object' && source.records !== null && !Array.isArray(source.records)) {
    for (const [kind, value] of Object.entries(source.records as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Partial<NoticeRecord>
      const count = typeof record.count === 'number' && record.count > 0 ? Math.floor(record.count) : 0
      if (count === 0) continue
      records[kind] = { count, at: typeof record.at === 'number' ? record.at : 0 }
    }
  }
  return {
    muted: strings(source.muted),
    records,
    seen: strings(source.seen).slice(-SEEN_LIMIT),
  }
}

/**
 * Whether this message should stay off the screen.
 *
 * Only asked of the two lifetimes that outlive the app run. A toast and a
 * dropped connection are put away where they are shown, because there is
 * nothing about either that a later launch should still be honouring.
 */
export const isSilenced = (policy: NoticePolicy, identity: NoticeIdentity): boolean => {
  if (identity.lifetime === 'event' || identity.lifetime === 'session') return false
  if (policy.muted.includes(identity.kind)) return true
  return policy.seen.includes(identity.key)
}

/**
 * The policy after the user puts a message away.
 *
 * An offer answers its question outright — "not now" on a first-run import is
 * not a request to be asked again next launch — so `once` mutes its kind and
 * gets an entry on the Notifications page for free, which is the only honest
 * way to offer a way back. A condition only puts this instance away.
 */
export const afterDismiss = (policy: NoticePolicy, identity: NoticeIdentity, now: number): NoticePolicy => {
  if (identity.lifetime === 'event' || identity.lifetime === 'session') return policy
  const previous = policy.records[identity.kind]
  const records = {
    ...policy.records,
    [identity.kind]: { count: (previous?.count ?? 0) + 1, at: now },
  }
  if (identity.lifetime === 'once') {
    return { ...policy, records, muted: mutedWith(policy.muted, identity.kind) }
  }
  const seen = policy.seen.includes(identity.key)
    ? policy.seen
    : [...policy.seen, identity.key].slice(-SEEN_LIMIT)
  return { ...policy, records, seen }
}

const mutedWith = (muted: readonly string[], kind: string): readonly string[] =>
  muted.includes(kind) ? muted : [...muted, kind]

export const withMuted = (policy: NoticePolicy, kind: string, muted: boolean): NoticePolicy => ({
  ...policy,
  muted: muted ? mutedWith(policy.muted, kind) : policy.muted.filter((entry) => entry !== kind),
})

/**
 * Whether this message's dismiss control should also offer to silence it.
 *
 * Only for conditions: an offer is already answered for good by its own
 * dismissal, and putting a second door on it would ask the same question
 * twice. And never for something already silent.
 */
export const offersMute = (policy: NoticePolicy, identity: NoticeIdentity): boolean => {
  if (identity.lifetime !== 'occurrence') return false
  if (policy.muted.includes(identity.kind)) return false
  if (!NOTICE_KINDS.some((entry) => entry.kind === identity.kind)) return false
  return (policy.records[identity.kind]?.count ?? 0) >= MUTE_AFTER
}

/**
 * One kind of message, in the words the Notifications page shows.
 *
 * This list *is* the set of messages that can be silenced. Anything a banner
 * raises under a kind that is not here can still be dismissed, but never muted
 * — which is how the reconnection notice stays un-silenceable without needing
 * a flag of its own. A dropped link is the one thing that must always speak.
 */
export interface NoticeKind {
  readonly kind: string
  readonly lifetime: NoticeLifetime
  readonly title: string
  /** What is lost by silencing it — never a restatement of the title. */
  readonly detail: string
}

export const NOTICE_KINDS: readonly NoticeKind[] = [
  {
    kind: 'usage:pace',
    lifetime: 'occurrence',
    title: 'On course to run out',
    detail: 'An agent is spending faster than its plan will last until the next reset.',
  },
  {
    kind: 'usage:spent',
    lifetime: 'occurrence',
    title: 'Out of quota',
    detail: 'An agent has nothing left until its window resets. Silencing this does not hide the agent.',
  },
  {
    kind: 'usage:limits',
    lifetime: 'occurrence',
    title: 'Rate limit reached',
    detail: 'An agent reports a limit of its own.',
  },
  {
    kind: 'agent:signin',
    lifetime: 'occurrence',
    title: 'Agent not signed in',
    detail: 'An agent has no account connected, so its sessions cannot start. The Agents page says the same.',
  },
  {
    kind: 'agent:health',
    lifetime: 'occurrence',
    title: 'Agent unavailable',
    detail: 'An agent cannot start, with what to do about it.',
  },
  {
    kind: 'import:offer',
    lifetime: 'once',
    title: 'Import from your other agents',
    detail: 'The offer to bring over skills and servers another agent already has. The Library can import them at any time.',
  },
]

export const noticeKind = (kind: string): NoticeKind | null =>
  NOTICE_KINDS.find((entry) => entry.kind === kind) ?? null
