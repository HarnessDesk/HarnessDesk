/**
 * The macOS notification kinds, as the settings page names them.
 *
 * The desktop shell's decider (`packages/desktop/electron/notifications.mjs`)
 * keeps the same four ids and the same defaults-on reading; its test pins the
 * id set, and so does this file's, so the two lists cannot drift apart
 * silently. Everything defaults on: a notification the user never asked to
 * silence should arrive.
 */

export interface SystemNotificationKind {
  readonly kind: string
  readonly title: string
  readonly detail: string
}

export const SYSTEM_NOTIFICATION_KINDS: readonly SystemNotificationKind[] = [
  {
    kind: 'turns',
    title: 'Finished turns',
    detail: 'An agent finished while you were elsewhere.',
  },
  {
    kind: 'failures',
    title: 'Failures',
    detail: 'A turn ended with an error.',
  },
  {
    kind: 'approvals',
    title: 'Approvals',
    detail: 'An agent wants to run a command, edit files, or widen its sandbox.',
  },
  {
    kind: 'needsYou',
    title: 'Needs you',
    detail: 'An agent asked you a question.',
  },
]

/** The stored switches, defensively read. Unknown shapes are an empty record. */
export const readSystemNotifications = (raw: unknown): Readonly<Record<string, boolean>> => {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Whether one switch is on: everything defaults on, and the master wins. */
export const systemNotificationOn = (
  prefs: Readonly<Record<string, boolean>>,
  key: string,
): boolean => {
  if (prefs['enabled'] === false) return false
  return prefs[key] !== false
}
