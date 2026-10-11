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
 * centred. `canvas` fills the width and keeps `PaneColumn`'s dense canvas
 * inset (`--hd-space-2`) on all four edges. A canvas may name a `measure` for
 * its page blocks: the canvas keeps its frame inset while those blocks use the
 * chosen centred page measure. A dense canvas with topInset="page" replaces
 * its smaller top inset with the page's top content inset while keeping the
 * same full-width canvas frame.
 * Reading and wide pages keep the reading inset (`--hd-page-gutter`) on all
 * four edges. A surface that brings its own geometry — a terminal, a diff,
 * a graph — bleeds instead of taking a page.
 *
 * Blocks inside sit one stack gap (`--hd-card-gap`) apart; a `Section` brings
 * its own larger step. A Team's Findings drew its
 * facts against the sidebar, a button across the window and a switch in the
 * middle of it because nothing told the page what width it was.
 */
export const Page = ({ width, measure, gutter = 'page', fill = false, topInset, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> & {
  readonly width: PageWidth
  /** A centred block measure inside a full-width canvas page. */
  readonly measure?: 'reading' | 'wide'
  /** `none` lets an enclosing frame own the inset while this pattern owns its stack and measure. */
  readonly gutter?: 'page' | 'none'
  /** Fill the destination body's height so a page empty state can centre in its remaining space. */
  readonly fill?: boolean
  /** Give a dense canvas page the page's vertical content inset while keeping its canvas frame. */
  readonly topInset?: 'page'
  readonly children: ReactNode
}) => {
  const attributes = { 'data-slot': 'page', 'data-width': width, 'data-gutter': gutter, ...(measure ? { 'data-measure': measure } : {}), ...(fill ? { 'data-fill': '' } : {}), ...(topInset ? { 'data-top-inset': topInset } : {}), className: styles.page, ...props }
  const content = measure ? <div data-page-measure={measure} className={styles.measure}>{children}</div> : children
  if (gutter === 'none') return <div {...attributes}>{content}</div>
  return <PaneColumn {...(width === 'canvas' ? { inset: 'canvas' as const } : { inset: 'reading' as const, page: true })}
    style={topInset === 'page' ? { paddingTop: 'calc(var(--hd-page-gutter) - var(--hd-space-2) + var(--hd-space-px))' } : undefined} {...attributes}>{content}</PaneColumn>
}
