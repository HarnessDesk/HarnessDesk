import type { HTMLAttributes, ReactNode } from 'react'

import { PaneColumn } from './PaneColumn'
import styles from './Page.module.css'

/** What a page holds decides its measure: words, a table, or a surface of its own. */
export type PageWidth = 'reading' | 'wide' | 'canvas'

/**
 * A page's column — the one way a page sets its width and its margins.
 *
 * A screen says what kind of page it is and passes its blocks; it does not
 * write a max-width, a padding or an outer margin of its own. `reading` is the
 * app's reading measure (`--hd-column`), centred: a conversation, a setting, a
 * round's findings. `wide` is for tables and card grids (`--hd-page-wide`),
 * centred. `canvas` has no measure, for a board that fills the width, and
 * keeps `PaneColumn`'s dense canvas inset (`--hd-space-2`) on all four edges.
 * Reading and wide pages keep the reading inset (`--hd-page-gutter`) on all
 * four edges. A surface that brings its own geometry — a terminal, a diff,
 * a graph — bleeds instead of taking a page.
 *
 * Blocks inside sit one stack gap (`--hd-card-gap`) apart; a `Section` brings
 * its own larger step. A Team's Findings drew its
 * facts against the sidebar, a button across the window and a switch in the
 * middle of it because nothing told the page what width it was.
 */
export const Page = ({ width, gutter = 'page', fill = false, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> & {
  readonly width: PageWidth
  /** `none` lets an enclosing frame own the inset while this pattern owns its stack and measure. */
  readonly gutter?: 'page' | 'none'
  /** Fill the destination body's height so a page empty state can centre in its remaining space. */
  readonly fill?: boolean
  readonly children: ReactNode
}) => {
  const attributes = { 'data-slot': 'page', 'data-width': width, 'data-gutter': gutter, ...(fill ? { 'data-fill': '' } : {}), className: styles.page, ...props }
  if (gutter === 'none') return <div {...attributes}>{children}</div>
  return <PaneColumn {...(width === 'canvas' ? { inset: 'canvas' as const } : { inset: 'reading' as const, page: true })} {...attributes}>{children}</PaneColumn>
}
