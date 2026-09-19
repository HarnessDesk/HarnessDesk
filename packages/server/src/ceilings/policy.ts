export type UnheldPolicy = 'seat' | 'refuse'

export const UNHELD_PREFERENCE = 'unheldCeilings'
export const DEFAULT_UNHELD: UnheldPolicy = 'seat'

export const unheldPolicy = (preferences: Readonly<Record<string, unknown>>): UnheldPolicy => {
  const stored = preferences[UNHELD_PREFERENCE]
  if (typeof stored !== 'object' || stored === null) return DEFAULT_UNHELD
  const watched = (stored as { watched?: unknown }).watched
  return watched === 'seat' || watched === 'refuse' ? watched : DEFAULT_UNHELD
}
