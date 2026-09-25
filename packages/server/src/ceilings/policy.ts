export type UnheldPolicy = 'seat' | 'refuse'

export const UNHELD_PREFERENCE = 'unheldCeilings'
export const DEFAULT_UNHELD: UnheldPolicy = 'seat'

/**
 * What this machine does with a runtime that can only *ask* a ceiling of its
 * agent, under the existing `unheldCeilings` key: `watched` for a Seat a
 * person is watching, `unattended` for a Seat on a Goal a trigger opened.
 */
export interface UnheldCeilingsPreference {
  readonly watched?: UnheldPolicy
  readonly unattended?: UnheldPolicy
}

export const unheldPolicy = (preferences: Readonly<Record<string, unknown>>): UnheldPolicy => {
  const stored = preferences[UNHELD_PREFERENCE]
  if (typeof stored !== 'object' || stored === null) return DEFAULT_UNHELD
  const watched = (stored as { watched?: unknown }).watched
  return watched === 'seat' || watched === 'refuse' ? watched : DEFAULT_UNHELD
}

/**
 * The same choice for a Goal nobody is watching. It defaults to refuse: an
 * absent, malformed or unknown value refuses, and only an explicit person
 * preference of `seat` seats and says so. The watched setting never answers
 * for it, and trigger YAML, event text or a message cannot set it.
 */
export const unattendedPolicy = (preferences: Readonly<Record<string, unknown>>): UnheldPolicy => {
  const stored = preferences[UNHELD_PREFERENCE]
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return 'refuse'
  return (stored as Record<string, unknown>).unattended === 'seat' ? 'seat' : 'refuse'
}
