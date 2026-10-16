/** Standing diff choices, persisted through the host's app/state with other UI preferences. */
export interface DiffPrefs {
  readonly wrap: boolean
  readonly highlightWords: boolean
  readonly hideWhitespace: boolean
  readonly showFiles: boolean
  readonly groupByFolder: boolean
}
export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  wrap: true, highlightWords: true, hideWhitespace: false, showFiles: true, groupByFolder: false,
}
export const readDiffPrefs = (raw: unknown): DiffPrefs => {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<DiffPrefs>
  return Object.fromEntries(Object.entries(DEFAULT_DIFF_PREFS).map(([key, fallback]) => [
    key, typeof source[key as keyof DiffPrefs] === 'boolean' ? source[key as keyof DiffPrefs] : fallback,
  ])) as unknown as DiffPrefs
}
