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
 * centred. `canvas` has no measure, for a board that fills the width. Every
 * kind keeps one gutter (`--hd-page-gutter`) on every side, so a page's blocks
 * start on the same edge as its view bar and the window bar's title; a surface
 * that brings its own geometry — a terminal, a diff, a graph — bleeds instead
 * of taking a page. The gutter is `PaneColumn`'s reading inset on all four
 * edges — the same edge every reading column in the app keeps — so the page
 * adds only its measure.
 *
 * Blocks inside sit one dense step apart, the gap between a label and the card
 * it names; a `Section` brings its own larger step. A Team's Findings drew its
 * facts against the sidebar, a button across the window and a switch in the
 * middle of it because nothing told the page what width it was.
 */
export const Page = ({ width, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> & {
  readonly width: PageWidth
  readonly children: ReactNode
}) => (
  <PaneColumn inset="reading" page data-slot="page" data-width={width} className={styles.page} {...props}>
    {children}
  </PaneColumn>
)
