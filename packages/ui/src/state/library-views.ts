/**
 * The Library's own view choices, remembered per section for one app run.
 *
 * A section is a different element each time it is shown, so leaving for
 * Changes and returning used to reset the filter, the search, the chip and
 * the list/matrix choice. These are the person's reading choices, not facts
 * about the library, so the store holds them for as long as the window is
 * open — in memory only, never written to preferences.
 */

export type LibraryViewFilter = 'all' | 'problems' | 'partial' | 'hollow' | 'differs' | 'unreachable' | 'unused' | 'off'
export type LibraryViewChip = 'all' | 'needs-you' | 'one-runtime' | 'nobody'
/** The sections that keep their own choices; Changes reads its own state. */
export type LibraryViewSection = 'skill' | 'mcp'

export interface LibraryViewState {
  readonly filter: LibraryViewFilter
  readonly query: string
  readonly chip: LibraryViewChip
  /** MCP keeps its List/Matrix choice. */
  readonly view: 'list' | 'matrix'
  /** Skills keep their Cards/Matrix choice. */
  readonly skillView: 'cards' | 'matrix'
}

export const emptyLibraryView = (): LibraryViewState => ({ filter: 'all', query: '', chip: 'all', view: 'list', skillView: 'cards' })
