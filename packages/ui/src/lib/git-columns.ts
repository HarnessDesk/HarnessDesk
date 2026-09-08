/**
 * The history table's columns: what they are called, how far they may be
 * dragged, and how a stored width is read back.
 *
 * Kept out of the pane for the reason `editor-prefs` is kept out of the
 * store: hydrating a preference written by an older build — or by a hand
 * edited file — is validation work, and both the pane and the store need the
 * same answer. A stored `sha: 3` would render a column three pixels wide with
 * no label and no way back to it, so every value is clamped rather than
 * trusted.
 */

export interface GitColumn {
  readonly label: string
  /** Below this the column stops being a column. `graph` alone may reach 0. */
  readonly min: number
  readonly max: number
  /** The width before anyone drags it; `graph` follows the lanes instead. */
  readonly initial: number | null
}

export const GIT_COLUMNS = {
  graph: { label: 'Graph', min: 0, max: 320, initial: null },
  sha: { label: 'Commit', min: 44, max: 200, initial: 62 },
  date: { label: 'Date', min: 56, max: 240, initial: 76 },
  author: { label: 'Author', min: 60, max: 320, initial: 120 },
} as const satisfies Record<string, GitColumn>

export type GitColumnName = keyof typeof GIT_COLUMNS

export type GitColumnWidths = Partial<Record<GitColumnName, number>>

export const clampColumn = (name: GitColumnName, width: number): number =>
  Math.round(Math.min(GIT_COLUMNS[name].max, Math.max(GIT_COLUMNS[name].min, width)))

/**
 * Stored widths, keeping only the columns that exist and only the values that
 * are numbers. An absent key is not a zero: it means "nobody has dragged this
 * one", which is how the graph column keeps following the lanes.
 */
export const readColumnWidths = (raw: unknown): GitColumnWidths => {
  if (typeof raw !== 'object' || raw === null) return {}
  const stored = raw as Record<string, unknown>
  const widths: Record<string, number> = {}
  for (const name of Object.keys(GIT_COLUMNS) as GitColumnName[]) {
    const value = stored[name]
    if (typeof value === 'number' && Number.isFinite(value)) widths[name] = clampColumn(name, value)
  }
  return widths as GitColumnWidths
}
