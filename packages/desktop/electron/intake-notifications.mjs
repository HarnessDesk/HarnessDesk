/**
 * Named waits on unattended work, delivered outside the app — decided away
 * from Electron so `node --test` can exercise every rule.
 *
 * The host announces each `trigger/attention` once it is durable, whether
 * or not a window is open; this module subscribes to the host directly, not
 * through a renderer, so a closed window never loses one. The rules:
 *
 * - **One attempt per attention.** An id is tried once. A reconnect or a
 *   restart replays unresolved waits by the same id; a replayed id whose
 *   answer is already recorded, or that was already tried here, is not tried
 *   again — never a second alert for the same wait.
 * - **The person's switches and the OS decide.** The master switch and the
 *   kind's own switch (`triggerAttention`, `triggerSkipped`, both on unless
 *   turned off), then whether the OS will show notifications at all.
 * - **Never claim what did not happen.** Shown, the host records it
 *   `delivered`; off, refused or failed, it records `unavailable` — and the
 *   wait stays in the app's Needs you either way.
 * - **A resolved wait is not news**, except a skipped firing, which asks
 *   nothing of anyone and is said once.
 */

/** The two kinds, with what the settings page should call them. */
export const INTAKE_NOTIFICATION_KINDS = [
  {
    kind: 'triggerAttention',
    title: 'Unattended work that needs you',
    detail: 'A Goal a trigger opened is waiting on you, or stopped.',
  },
  {
    kind: 'triggerSkipped',
    title: 'Skipped trigger firings',
    detail: 'A trigger saw something and did not start work, with why.',
  },
]

const LIMIT = 140

const trim = (text) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > LIMIT ? `${line.slice(0, LIMIT - 1)}…` : line
}

const wants = (prefs, kind) => {
  if (!prefs || typeof prefs !== 'object') return true
  if (prefs.enabled === false) return false
  return prefs[kind] !== false
}

const TITLES = {
  message: 'A held message needs you',
  approval: 'Unattended work is waiting for approval',
  question: 'Unattended work asked a question',
  'person-step': 'Unattended work needs your step',
  member: 'Unattended work is waiting on a member',
  budget: 'Unattended work stopped',
  source: 'A trigger stopped watching',
  publication: 'A review was kept on the desk',
  skipped: 'A trigger skipped a firing',
}

/**
 * One `trigger/attention` in, one OS notification (or nothing) out, and the
 * host told what became of it.
 *
 * - `prefs()` reads the person's notification switches (`systemNotifications`).
 * - `supported()` answers whether the OS will show a notification at all.
 * - `show({ title, body, goal })` draws it; throwing means it was refused.
 * - `report(id, 'delivered' | 'unavailable')` records the answer on the host.
 */
export const createIntakeNotifier = ({ prefs, supported, show, report }) => {
  const tried = new Set()
  return async (notification) => {
    if (notification?.method !== 'trigger/attention') return null
    const attention = notification.params?.attention
    if (!attention || typeof attention.id !== 'string') return null
    if (tried.has(attention.id) || attention.notification !== 'pending') return null
    const skipped = attention.kind === 'skipped'
    if (!skipped && attention.resolvedAt !== null) return null
    tried.add(attention.id)
    const kind = skipped ? 'triggerSkipped' : 'triggerAttention'
    let outcome = 'unavailable'
    try {
      if (wants(await prefs(), kind) && supported()) {
        await show({ title: TITLES[attention.kind] ?? 'A trigger needs you', body: trim(attention.sentence), goal: attention.goal ?? null })
        outcome = 'delivered'
      }
    } catch {
      outcome = 'unavailable'
    }
    await report(attention.id, outcome)
    return outcome
  }
}
